import { InfoviewApi, RpcConnected, RpcConnectParams, RpcKeepAliveParams } from '@leanprover/infoview-api'
import { CancellationTokenSource, Disposable, Uri, Webview, WebviewPanel, window } from 'vscode'
import * as ls from 'vscode-languageserver-protocol'
import { LeanClient } from './leanclient'
import { EditorRpcApi, Rpc } from './rpc'
import { LeanClientProvider } from './utils/clientProvider'
import { parseExtUri } from './utils/exturi'
import { viewColumnOfInfoView } from './utils/viewColumn'

const keepAlivePeriodMs = 10000

async function rpcConnect(client: LeanClient, uri: ls.DocumentUri): Promise<string> {
    const connParams: RpcConnectParams = { uri }
    const result: RpcConnected = await client.sendRequest('$/lean/rpc/connect', connParams)
    return result.sessionId
}

class RpcSessionAtPos implements Disposable {
    keepAliveInterval?: NodeJS.Timeout
    client: LeanClient

    constructor(
        client: LeanClient,
        public sessionId: string,
        public uri: ls.DocumentUri,
    ) {
        this.client = client
        this.keepAliveInterval = setInterval(async () => {
            const params: RpcKeepAliveParams = { uri, sessionId }
            try {
                await client.sendNotification('$/lean/rpc/keepAlive', params)
            } catch (e) {
                if (this.keepAliveInterval) clearInterval(this.keepAliveInterval)
            }
        }, keepAlivePeriodMs)
    }

    dispose() {
        if (this.keepAliveInterval) clearInterval(this.keepAliveInterval)
        // TODO: at this point we could close the session
    }
}

/**
 * Adds a subscription to `method` to the counted `subscriptions`.
 * Only the first subscription to a method calls `subscribe`.
 */
function subscribeCounted(
    subscriptions: Map<string, [number, Disposable]>,
    method: string,
    subscribe: () => Disposable,
): void {
    const el = subscriptions.get(method)
    if (el) {
        subscriptions.set(method, [el[0] + 1, el[1]])
        return
    }
    subscriptions.set(method, [1, subscribe()])
}

/** Removes a subscription to `method` from the counted `subscriptions`, and disposes of the last one. */
function unsubscribeCounted(subscriptions: Map<string, [number, Disposable]>, method: string): void {
    const el = subscriptions.get(method)
    if (!el) throw new Error(`trying to unsubscribe from '${method}' with no active subscriptions`)
    const [count, subscription] = el
    if (count === 1) {
        subscription.dispose()
        subscriptions.delete(method)
    } else {
        subscriptions.set(method, [count - 1, subscription])
    }
}

/** The methods of {@link EditorRpcApi} that act on the editor and not on a Lean server. */
export type EditorActions = Pick<
    EditorRpcApi,
    'saveConfig' | 'copyToClipboard' | 'insertText' | 'applyEdit' | 'showDocument' | 'restartFile'
>

/**
 * The webview panel of the InfoView, and the state that lives as long as the panel:
 * the requests, notification subscriptions and RPC sessions of the InfoView.
 * The panel implements the methods of {@link EditorRpcApi} that act on a Lean server,
 * and calls the {@link EditorActions} for the other methods.
 */
export class InfoviewPanel implements Disposable {
    /** The API of the InfoView in the panel. */
    readonly api: InfoviewApi
    private readonly panel: WebviewPanel
    private readonly rpc: Rpc
    /** Set when the panel is closed. */
    private disposed: boolean = false

    // Subscriptions are counted and only disposed of when count becomes 0.
    private serverNotifSubscriptions: Map<string, [number, Disposable]> = new Map()
    private clientNotifSubscriptions: Map<string, [number, Disposable]> = new Map()

    private rpcSessions: Map<string, RpcSessionAtPos> = new Map()

    /**
     * The ID to assign to the next client request made by the infoview
     * (see {@link EditorRpcApi.startClientRequest}).
     * Only used for cancellation. Unrelated to LSP request IDs. */
    private freshClientRequestId: number = 0
    /**
     * Maps in-flight client request IDs (as in {@link freshClientRequestId})
     * to tuples [Response, Cancellation token]. */
    private clientRequests: Map<number, [Promise<any>, CancellationTokenSource]> = new Map()

    /**
     * Opens the panel.
     * @param html the HTML of the panel, given the webview of the panel.
     * @param onDidDispose called when the panel is closed.
     */
    constructor(
        private clientProvider: LeanClientProvider,
        editorActions: EditorActions,
        html: (webview: Webview) => string,
        onDidDispose: (panel: InfoviewPanel) => void,
    ) {
        this.panel = window.createWebviewPanel(
            'lean4_infoview',
            'Lean InfoView',
            { viewColumn: viewColumnOfInfoView(), preserveFocus: true },
            {
                enableFindWidget: true,
                retainContextWhenHidden: true,
                enableScripts: true,
                enableCommandUris: true,
            },
        )

        // Note that an extension can send data to its webviews using webview.postMessage().
        // This method sends any JSON serializable data to the webview. The message is received
        // inside the webview through the standard message event.
        // The receiving of these messages is done inside webview\index.ts where it
        // calls window.addEventListener('message',...
        this.rpc = new Rpc(m => {
            try {
                void this.panel.webview.postMessage(m)
            } catch (e) {
                // ignore any disposed object exceptions
            }
        })
        const editorApi: EditorRpcApi = { ...editorActions, ...this.serverApi() }
        this.rpc.register(editorApi)

        // Similarly, we can received data from the webview by listening to onDidReceiveMessage.
        this.panel.webview.onDidReceiveMessage(m => {
            try {
                this.rpc.messageReceived(m)
            } catch {
                // ignore any disposed object exceptions
            }
        })
        this.api = this.rpc.getApi()
        this.panel.onDidDispose(() => {
            this.disposed = true
            this.clearNotificationHandlers()
            this.closeRpcSessions(null)
            for (const [, tk] of this.clientRequests.values()) tk.cancel()
            this.clientRequests = new Map()
            onDidDispose(this)
        })
        this.panel.webview.html = html(this.panel.webview)
    }

    /** Shows the panel without moving the focus to it. */
    reveal(): void {
        this.panel.reveal(undefined, true)
    }

    /** Closes the panel. */
    dispose(): void {
        this.panel.dispose()
    }

    /** Closes the RPC sessions with the Lean server of `client`, or all RPC sessions for `null`. */
    closeRpcSessions(client: LeanClient | null): void {
        for (const [sessionId, sess] of this.rpcSessions) {
            if (client === null || sess.client === client) {
                sess.dispose()
                this.rpcSessions.delete(sessionId)
            }
        }
    }

    private clearNotificationHandlers() {
        for (const [, [, subscription]] of this.clientNotifSubscriptions) subscription.dispose()
        this.clientNotifSubscriptions.clear()
        for (const [, [, subscription]] of this.serverNotifSubscriptions) subscription.dispose()
        this.serverNotifSubscriptions.clear()
    }

    /** The methods of {@link EditorRpcApi} that act on a Lean server. */
    private serverApi(): Omit<EditorRpcApi, keyof EditorActions> {
        return {
            startClientRequest: async (uri: string, method: string, params: any): Promise<number> => {
                const extUri = parseExtUri(uri)
                if (extUri === undefined) {
                    throw Error(`Unexpected URI scheme: ${Uri.parse(uri).scheme}`)
                }

                const client = this.clientProvider.findClient(extUri)
                if (client) {
                    const tk = new CancellationTokenSource()
                    const id = this.freshClientRequestId
                    this.freshClientRequestId += 1
                    const promise = client.sendRequest(method, params, tk.token)
                    this.clientRequests.set(id, [promise, tk])
                    return id
                }
                throw Error('No active Lean client.')
            },
            awaitClientRequest: async (id: number): Promise<any> => {
                const p = this.clientRequests.get(id)
                if (p) {
                    // NOTE: `await` finishes first (or throws),
                    // then the entry is deleted,
                    // and then the function returns.
                    try {
                        return await p[0]
                    } finally {
                        this.clientRequests.delete(id)
                    }
                }
                // NOTE: we rely on details of `editorApiOfRpc` for correctness:
                // we assume that `awaitClientRequest` is called exactly once
                // regardless of whether cancellation occurs,
                // so this error should never be thrown.
                throw Error(`Internal error: invalid client request ID '${id}'`)
            },
            cancelClientRequest: async (id: number): Promise<void> => {
                const p = this.clientRequests.get(id)
                if (p) p[1].cancel()
            },
            sendClientNotification: async (uri: string, method: string, params: any): Promise<void> => {
                const extUri = parseExtUri(uri)
                if (extUri === undefined) {
                    return
                }

                const client = this.clientProvider.findClient(extUri)
                if (client) {
                    await client.sendNotification(method, params)
                }
            },
            subscribeServerNotifications: async method => {
                // NOTE(WN): For non-custom notifications we cannot call LanguageClient.onNotification
                // here because that *overwrites* the notification handler rather than registers an extra one.
                // So we have to add a bunch of event emitters to `LeanClient.`
                subscribeCounted(this.serverNotifSubscriptions, method, () => {
                    const forward = (params: any) => void this.api.gotServerNotification(method, params)
                    if (method === 'textDocument/publishDiagnostics') {
                        return this.clientProvider.diagnosticsChanged(forward)
                    }
                    if (method.startsWith('$')) {
                        return this.clientProvider.customNotification(n => {
                            if (n.method === method) forward(n.params)
                        })
                    }
                    throw new Error(`subscription to ${method} server notifications not implemented`)
                })
            },
            unsubscribeServerNotifications: async method => {
                unsubscribeCounted(this.serverNotifSubscriptions, method)
            },
            subscribeClientNotifications: async method => {
                subscribeCounted(this.clientNotifSubscriptions, method, () => {
                    const forward = (params: any) => void this.api.sentClientNotification(method, params)
                    if (method === 'textDocument/didChange') {
                        return this.clientProvider.didChange(forward)
                    }
                    if (method === 'textDocument/didClose') {
                        return this.clientProvider.didClose(forward)
                    }
                    throw new Error(`Subscription to '${method}' client notifications not implemented`)
                })
            },
            unsubscribeClientNotifications: async method => {
                unsubscribeCounted(this.clientNotifSubscriptions, method)
            },
            createRpcSession: async uri => {
                const extUri = parseExtUri(uri)
                if (extUri === undefined) {
                    throw Error(`Unexpected URI scheme: ${Uri.parse(uri).scheme}`)
                }
                const client = this.clientProvider.findClient(extUri)
                if (client === undefined) {
                    throw Error('No active Lean client.')
                }
                const sessionId = await rpcConnect(client, uri)
                const session = new RpcSessionAtPos(client, sessionId, uri)
                if (this.disposed) {
                    session.dispose()
                    throw Error('InfoView disconnected while connecting to RPC session.')
                }
                this.rpcSessions.set(sessionId, session)
                return sessionId
            },
            closeRpcSession: async sessionId => {
                const session = this.rpcSessions.get(sessionId)
                if (session) {
                    this.rpcSessions.delete(sessionId)
                    session.dispose()
                }
            },
        }
    }
}
