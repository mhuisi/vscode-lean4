import {
    ContextMenuEntry,
    InfoviewApi,
    InfoviewConfig,
    LeanFileProgressParams,
    RpcConnected,
    RpcConnectParams,
    RpcKeepAliveParams,
    ServerStoppedReason,
    TextInsertKind,
} from '@leanprover/infoview-api'
import { join } from 'path'
import {
    CancellationTokenSource,
    commands,
    Diagnostic,
    Disposable,
    env,
    ExtensionContext,
    Position,
    Range,
    Selection,
    TextEditor,
    TextEditorRevealType,
    Uri,
    WebviewPanel,
    window,
    workspace,
} from 'vscode'
import * as ls from 'vscode-languageserver-protocol'
import {
    getEditorLineHeight,
    getInfoViewAutoOpen,
    getInfoViewConfig,
    getInfoViewStyle,
    minIfProd,
    prodOrDev,
    saveInfoViewConfig,
} from './config'
import { LeanClient } from './leanclient'
import { EditorRpcApi, Rpc } from './rpc'
import { LeanClientProvider } from './utils/clientProvider'
import { c2pConverter, LeanPublishDiagnosticsParams, p2cConverter } from './utils/converters'
import { ExtUri, parseExtUri, toExtUri } from './utils/exturi'
import { lean, LeanEditor } from './utils/leanEditorProvider'
import { displayNotification } from './utils/notifs'
import { viewColumnOfActiveTextEditor, viewColumnOfInfoView } from './utils/viewColumn'

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

/**
 * For each context menu entry of the InfoView, the argument of its command `lean4.infoview.<entry>`
 * that contains the ID of the element that the user clicked.
 */
const contextMenuIdArgs: Record<ContextMenuEntry, string> = {
    goToDefinition: 'interactiveCodeTagId',
    select: 'selectableLocationId',
    unselect: 'unselectableLocationId',
    unselectAll: 'selectedLocationsId',
    pause: 'pauseId',
    unpause: 'unpauseId',
    pin: 'pinId',
    unpin: 'unpinId',
    refresh: 'refreshId',
    pauseAllMessages: 'pauseAllMessagesId',
    unpauseAllMessages: 'unpauseAllMessagesId',
    copyState: 'copyStateId',
    copyMessage: 'copyMessageId',
    goToPinnedLocation: 'goToPinnedLocationId',
    goToMessageLocation: 'goToMessageLocationId',
    hideTraceSearch: 'hideTraceSearchId',
    showTraceSearch: 'showTraceSearchId',
    displayTargetBeforeAssumptions: 'displayTargetBeforeAssumptionsId',
    displayAssumptionsBeforeTarget: 'displayAssumptionsBeforeTargetId',
    hideTypeAssumptions: 'hideTypeAssumptionsId',
    showTypeAssumptions: 'showTypeAssumptionsId',
    hideInstanceAssumptions: 'hideInstanceAssumptionsId',
    showInstanceAssumptions: 'showInstanceAssumptionsId',
    hideInaccessibleAssumptions: 'hideInaccessibleAssumptionsId',
    showInaccessibleAssumptions: 'showInaccessibleAssumptionsId',
    hideLetValues: 'hideLetValuesId',
    showLetValues: 'showLetValuesId',
    hideGoalNames: 'hideGoalNamesId',
    showGoalNames: 'showGoalNamesId',
    emphasizeFirstGoal: 'emphasizeFirstGoalId',
    deemphasizeFirstGoal: 'deemphasizeFirstGoalId',
    saveSettings: 'saveSettingsId',
}

export class InfoProvider implements Disposable {
    /** Instance of the panel, if it is open. Otherwise `undefined`. */
    private webviewPanel?: WebviewPanel & { rpc: Rpc; api: InfoviewApi }
    /** The InfoProvider's subscriptions, to be cleaned up when it is disposed. */
    private subscriptions: Disposable[] = []

    private stylesheet: string = ''
    private autoOpened: boolean = false

    // Subscriptions are counted and only disposed of when count becomes 0.
    private serverNotifSubscriptions: Map<string, [number, Disposable]> = new Map()
    private clientNotifSubscriptions: Map<string, [number, Disposable]> = new Map()

    private rpcSessions: Map<string, RpcSessionAtPos> = new Map()

    // the key is the LeanClient.getClientFolder()
    private clientsFailed: Map<string, ServerStoppedReason> = new Map()

    /**
     * The ID to assign to the next client request made by the infoview
     * (see {@link editorApi.startClientRequest}).
     * Only used for cancellation. Unrelated to LSP request IDs. */
    private freshClientRequestId: number = 0
    /**
     * Maps in-flight client request IDs (as in {@link freshClientRequestId})
     * to tuples [Response, Infoview subscription (should be disposed when infoview closes), Cancellation token]. */
    private clientRequests: Map<number, [Promise<any>, Disposable, CancellationTokenSource]> = new Map()

    private editorApi: EditorRpcApi = {
        saveConfig: async (config: InfoviewConfig) => saveInfoViewConfig(config),
        startClientRequest: async (uri: string, method: string, params: any): Promise<number> => {
            const extUri = parseExtUri(uri)
            if (extUri === undefined) {
                throw Error(`Unexpected URI scheme: ${Uri.parse(uri).scheme}`)
            }

            const client = this.clientProvider.findClient(extUri)
            if (client) {
                const tk = new CancellationTokenSource()
                const sub: Disposable = {
                    dispose() {
                        tk.cancel()
                    },
                }
                const id = this.freshClientRequestId
                this.freshClientRequestId += 1
                const promise = client.sendRequest(method, params, tk.token)
                this.clientRequests.set(id, [promise, sub, tk])
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
            if (p) p[2].cancel()
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
                const forward = (params: any) => void this.webviewPanel?.api.gotServerNotification(method, params)
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
                const forward = (params: any) => void this.webviewPanel?.api.sentClientNotification(method, params)
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
        copyToClipboard: async text => {
            await env.clipboard.writeText(text)
            displayNotification('Information', `Copied to clipboard: ${text}`)
        },
        insertText: async (text, kind, tdpp) => {
            let uri: ExtUri | undefined
            let pos: Position | undefined
            if (tdpp) {
                uri = toExtUri(p2cConverter.asUri(tdpp.textDocument.uri))
                if (uri === undefined) {
                    return
                }
                pos = p2cConverter.asPosition(tdpp.position)
            }
            await this.handleInsertText(text, kind, uri, pos)
        },
        applyEdit: async (e: ls.WorkspaceEdit) => {
            const we = await p2cConverter.asWorkspaceEdit(e)

            const edits = we.entries()
            if (edits.length !== 1) {
                return
            }
            const [uri, _] = edits[0]
            const extUri = toExtUri(uri)
            if (extUri === undefined) {
                return
            }
            const leanEditor = lean.getVisibleLeanEditorsByUri(extUri).at(0)
            if (leanEditor === undefined) {
                return
            }
            await window.showTextDocument(leanEditor.editor.document, leanEditor.editor.viewColumn, false)

            await workspace.applyEdit(we)
        },
        showDocument: async show => {
            const uri = parseExtUri(show.uri)
            if (uri === undefined) {
                return
            }
            void this.revealEditorSelection(uri, p2cConverter.asRange(show.selection))
        },
        restartFile: async uri => {
            const extUri = parseExtUri(uri)
            if (extUri === undefined) {
                return
            }
            this.clientProvider.restartFile(extUri)
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
            if (!this.webviewPanel) {
                session.dispose()
                throw Error('InfoView disconnected while connecting to RPC session.')
            } else {
                this.rpcSessions.set(sessionId, session)
                return sessionId
            }
        },
        closeRpcSession: async sessionId => {
            const session = this.rpcSessions.get(sessionId)
            if (session) {
                this.rpcSessions.delete(sessionId)
                session.dispose()
            }
        },
    }

    constructor(
        private clientProvider: LeanClientProvider,
        private context: ExtensionContext,
    ) {
        this.updateStylesheet()

        this.subscriptions.push(
            clientProvider.clientAdded(client => {
                void this.onClientAdded(client)
            }),
            clientProvider.clientRemoved(client => {
                void this.onClientRemoved(client)
            }),
            clientProvider.clientStopped(([client, activeClient, reason]) => {
                void this.onActiveClientStopped(client, activeClient, reason)
            }),
            lean.onDidChangeActiveLeanEditor(() => this.sendPosition()),
            lean.onDidChangeLeanEditorSelection(() => this.sendPosition()),
            workspace.onDidChangeConfiguration(async _e => {
                // regression; changing the style needs a reload. :/
                this.updateStylesheet()
                await this.sendConfig()
            }),
            lean.onDidChangeLeanDocument(() => this.sendPosition()),
            lean.registerLeanEditorCommand('lean4.displayGoal', leanEditor => this.openPreview(leanEditor)),
            commands.registerCommand('lean4.toggleInfoview', () => this.toggleInfoview()),
            lean.registerLeanEditorCommand('lean4.displayList', async leanEditor => {
                await this.openPreview(leanEditor)
                await this.webviewPanel?.api.requestedAction({ kind: 'toggleAllMessages' })
            }),
            lean.registerLeanEditorCommand('lean4.infoView.copyToComment', () =>
                this.webviewPanel?.api.requestedAction({ kind: 'copyToComment' }),
            ),
            commands.registerCommand('lean4.infoView.toggleUpdating', () =>
                this.webviewPanel?.api.requestedAction({ kind: 'togglePaused' }),
            ),
            commands.registerCommand('lean4.infoView.toggleExpectedType', () =>
                this.webviewPanel?.api.requestedAction({ kind: 'toggleExpectedType' }),
            ),
            lean.registerLeanEditorCommand('lean4.infoView.toggleStickyPosition', () =>
                this.webviewPanel?.api.requestedAction({ kind: 'togglePin' }),
            ),
        )

        for (const [entry, idArg] of Object.entries(contextMenuIdArgs) as [ContextMenuEntry, string][]) {
            this.subscriptions.push(
                commands.registerCommand(`lean4.infoview.${entry}`, args =>
                    this.webviewPanel?.api.clickedContextMenu({ entry, id: args[idArg] }),
                ),
            )
        }
    }

    private async onClientRestarted(client: LeanClient) {
        await this.webviewPanel?.api.serverStopped(undefined) // clear any server stopped state
        const folderUri = client.getClientFolder()
        if (this.clientsFailed.has(folderUri.toString())) {
            this.clientsFailed.delete(folderUri.toString())
        }
        await this.initInfoView(lean.activeLeanEditor, client)
    }

    private async onClientAdded(client: LeanClient) {
        this.subscriptions.push(
            client.restarted(async () => {
                // This event is triggered both the first time the server starts
                // as well as when the server restarts.

                this.clearRpcSessions(client)

                // Need to fully re-initialize this newly restarted client with all the
                // existing subscriptions and resend position info and so on so the
                // infoview updates properly.
                await this.onClientRestarted(client)
            }),
            client.didSetLanguage(() => this.onLanguageChanged()),
        )

        // Note that when new client is first created it still fires client.restarted
        // event, so all onClientRestarted can happen there so we don't do it twice.
    }

    onClientRemoved(client: LeanClient) {
        // NOTE: we could index subscriptions made in `onClientAdded` by the client, and remove here
    }

    async onActiveClientStopped(client: LeanClient, activeClient: boolean, reason: ServerStoppedReason) {
        // Will show a message in case the active client stops
        // add failed client into a list (will be removed in case the client is restarted)
        if (activeClient) {
            // means that client and active client are the same and just show the error message
            await this.webviewPanel?.api.serverStopped(reason)
        }

        // remember this client is in a stopped state
        const key = client.getClientFolder()
        await this.sendPosition()
        if (!this.clientsFailed.has(key.toString())) {
            this.clientsFailed.set(key.toString(), reason)
        }
    }

    // Called when the extension is deactivated.
    dispose(): void {
        // Calls `webviewPanel.onDidDispose` to cleanup the infoview's subscriptions.
        this.webviewPanel?.dispose()
        for (const s of this.subscriptions) s.dispose()
    }

    private updateStylesheet() {
        // Here we add extra CSS variables which depend on the editor configuration,
        // but are not exposed by default.
        // Ref: https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content

        const extraCSS = `
            html {
                --vscode-editor-line-height: ${getEditorLineHeight()}px;
            }
        `
        const configCSS = getInfoViewStyle()
        this.stylesheet = extraCSS + configCSS
    }

    private async autoOpen(): Promise<boolean> {
        if (!this.webviewPanel && !this.autoOpened && getInfoViewAutoOpen() && lean.activeLeanEditor !== undefined) {
            // remember we've auto opened during this session so if user closes it it remains closed.
            this.autoOpened = true
            return await this.openPreview(lean.activeLeanEditor)
        }
        return false
    }

    private clearNotificationHandlers() {
        for (const [, [, subscription]] of this.clientNotifSubscriptions) subscription.dispose()
        this.clientNotifSubscriptions.clear()
        for (const [, [, subscription]] of this.serverNotifSubscriptions) subscription.dispose()
        this.serverNotifSubscriptions.clear()
    }

    private clearRpcSessions(client: LeanClient | null) {
        const remaining = new Map()
        for (const [sessionId, sess] of this.rpcSessions) {
            if (client === null || sess.client === client) {
                sess.dispose()
            } else {
                remaining.set(sessionId, sess)
            }
        }
        this.rpcSessions = remaining
    }

    private async toggleInfoview() {
        if (this.webviewPanel) {
            this.webviewPanel.dispose()
            // the onDispose handler sets this.webviewPanel = undefined
        } else if (lean.activeLeanEditor !== undefined) {
            await this.openPreview(lean.activeLeanEditor)
        } else {
            displayNotification(
                'Error',
                'No active Lean editor tab. Make sure to focus the Lean editor tab for which you wish to open the infoview.',
            )
        }
    }

    private async openPreview(leanEditor: LeanEditor): Promise<boolean> {
        if (this.webviewPanel) {
            this.webviewPanel.reveal(undefined, true)
        } else {
            const webviewPanel = window.createWebviewPanel(
                'lean4_infoview',
                'Lean InfoView',
                { viewColumn: viewColumnOfInfoView(), preserveFocus: true },
                {
                    enableFindWidget: true,
                    retainContextWhenHidden: true,
                    enableScripts: true,
                    enableCommandUris: true,
                },
            ) as WebviewPanel & { rpc: Rpc; api: InfoviewApi }

            // Note that an extension can send data to its webviews using webview.postMessage().
            // This method sends any JSON serializable data to the webview. The message is received
            // inside the webview through the standard message event.
            // The receiving of these messages is done inside webview\index.ts where it
            // calls window.addEventListener('message',...
            webviewPanel.rpc = new Rpc(m => {
                try {
                    void webviewPanel.webview.postMessage(m)
                } catch (e) {
                    // ignore any disposed object exceptions
                }
            })
            webviewPanel.rpc.register(this.editorApi)

            // Similarly, we can received data from the webview by listening to onDidReceiveMessage.
            webviewPanel.webview.onDidReceiveMessage(m => {
                try {
                    webviewPanel.rpc.messageReceived(m)
                } catch {
                    // ignore any disposed object exceptions
                }
            })
            webviewPanel.api = webviewPanel.rpc.getApi()
            webviewPanel.onDidDispose(() => {
                this.webviewPanel = undefined
                this.clearNotificationHandlers()
                this.clearRpcSessions(null) // should be after `webviewPanel = undefined`
                for (const [_1, d, _2] of this.clientRequests.values()) d.dispose()
                this.clientRequests = new Map()
            })
            this.webviewPanel = webviewPanel
            webviewPanel.webview.html = this.initialHtml()

            const client = this.clientProvider.findClient(leanEditor.documentExtUri)
            await this.initInfoView(leanEditor, client)
        }
        return true
    }

    private async initInfoView(leanEditor: LeanEditor | undefined, client: LeanClient | undefined) {
        if (leanEditor !== undefined) {
            const loc = this.getLocation(leanEditor)
            if (loc) {
                await this.webviewPanel?.api.initialize(loc)
            }
        }
        // The infoview gets information about file progress, diagnostics, etc.
        // by listening to notifications.  Send these notifications when the infoview starts
        // so that it has up-to-date information.
        if (client?.initializeResult) {
            await this.sendConfig()
            await this.webviewPanel?.api.serverStopped(undefined) // clear any server stopped state
            await this.webviewPanel?.api.serverRestarted(client.initializeResult)
            await this.sendDiagnostics(client)
            await this.sendProgress(client)
            await this.sendPosition()
        }
    }

    private async sendConfig() {
        await this.webviewPanel?.api.changedInfoviewConfig(getInfoViewConfig())
    }

    private static async getDiagnosticParams(
        uri: Uri,
        diagnostics: readonly Diagnostic[],
    ): Promise<LeanPublishDiagnosticsParams> {
        const params: LeanPublishDiagnosticsParams = {
            uri: c2pConverter.asUri(uri),
            diagnostics: await c2pConverter.asDiagnostics(diagnostics as Diagnostic[]),
        }
        return params
    }

    private async sendDiagnostics(client: LeanClient) {
        const panel = this.webviewPanel
        if (panel) {
            client.getDiagnostics()?.forEach(async (uri, diags) => {
                const params = await InfoProvider.getDiagnosticParams(uri, diags)
                await panel.api.gotServerNotification('textDocument/publishDiagnostics', params)
            })
        }
    }

    private async sendProgress(client: LeanClient) {
        if (!this.webviewPanel) return
        for (const [uri, processing] of client.progress) {
            const params: LeanFileProgressParams = {
                textDocument: {
                    uri: c2pConverter.asUri(uri.asUri()),
                    version: 0, // HACK: The infoview ignores this
                },
                processing,
            }
            await this.webviewPanel?.api.gotServerNotification('$/lean/fileProgress', params)
        }
    }

    private onLanguageChanged() {
        this.autoOpen()
            .then(async () => {
                await this.sendConfig()
                await this.sendPosition()
            })
            .catch(() => {})
    }

    private getLocation(leanEditor: LeanEditor): ls.Location | undefined {
        const selection = leanEditor.editor.selection
        return {
            uri: leanEditor.documentExtUri.toString(),
            range: {
                start: selection.start,
                end: selection.end,
            },
        }
    }

    private async sendPosition() {
        const editor = lean.activeLeanEditor
        if (editor === undefined) {
            return
        }
        const loc = this.getLocation(editor)
        const uri = editor.documentExtUri
        if (this.clientsFailed.size > 0) {
            const client = this.clientProvider.findClient(uri)
            if (client) {
                const reason = this.clientsFailed.get(client.getClientFolder().toString())
                if (reason) {
                    // send stopped event
                    await this.webviewPanel?.api.serverStopped(reason)
                } else {
                    await this.updateStatus(loc)
                }
            }
        } else {
            await this.updateStatus(loc)
        }
    }

    private async updateStatus(loc: ls.Location | undefined): Promise<void> {
        await this.webviewPanel?.api.serverStopped(undefined) // clear any server stopped state
        await this.autoOpen()
        await this.webviewPanel?.api.changedCursorLocation(loc)
    }

    private async revealEditorSelection(uri: ExtUri, selection?: Range) {
        let editor: TextEditor | undefined = lean.getVisibleLeanEditorsByUri(uri).at(0)?.editor
        if (editor === undefined) {
            editor = await window.showTextDocument(uri.asUri(), {
                viewColumn: viewColumnOfActiveTextEditor(),
                preserveFocus: false,
            })
        }
        if (selection !== undefined) {
            editor.revealRange(selection, TextEditorRevealType.InCenterIfOutsideViewport)
            editor.selection = new Selection(selection.start, selection.end)
            // ensure the text document has the keyboard focus.
            await window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false })
        }
    }

    private async handleInsertText(
        text: string,
        kind: TextInsertKind,
        uri?: ExtUri | undefined,
        pos?: Position | undefined,
    ) {
        let leanEditor: LeanEditor | undefined
        if (uri) {
            leanEditor = lean.getVisibleLeanEditorsByUri(uri).at(0)
        } else {
            leanEditor = lean.activeLeanEditor
        }
        if (leanEditor === undefined) {
            return
        }
        const editor = leanEditor.editor
        pos = pos ? pos : editor.selection.active
        if (kind === 'above') {
            // in this case, assume that we actually want to insert at the same
            // indentation level as the neighboring text
            const current_line = editor.document.lineAt(pos.line)
            const spaces = current_line.firstNonWhitespaceCharacterIndex
            const margin_str = [...Array(spaces).keys()].map(x => ' ').join('')
            let new_command = text.replace(/\n/g, '\n' + margin_str)
            new_command = `${margin_str}${new_command}\n`
            const insertPosition = current_line.range.start

            await editor.edit(builder => {
                builder.insert(insertPosition, new_command)
            })
        } else {
            await editor.edit(builder => {
                if (pos) builder.insert(pos, text)
            })
            editor.selection = new Selection(pos, pos)
        }
        // ensure the text document has the keyboard focus.
        await window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false })
    }

    private getLocalPath(path: string): string | undefined {
        if (this.webviewPanel) {
            return this.webviewPanel.webview.asWebviewUri(Uri.file(join(this.context.extensionPath, path))).toString()
        }
        return undefined
    }

    private initialHtml() {
        const libPostfix = `.${prodOrDev}${minIfProd}.js`
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8" />
                <meta http-equiv="Content-type" content="text/html;charset=utf-8">
                <title>InfoView</title>
                <style>${this.stylesheet}</style>
                <link rel="stylesheet" href="${this.getLocalPath('dist/lean4-infoview/index.css')}">
            </head>
            <body>
                <div id="react_root"></div>
                <script
                    data-importmap-leanprover-infoview="${this.getLocalPath(`dist/lean4-infoview/index${libPostfix}`)}"
                    data-importmap-react="${this.getLocalPath(`dist/lean4-infoview/react${libPostfix}`)}"
                    data-importmap-react-jsx-runtime="${this.getLocalPath(`dist/lean4-infoview/react-jsx-runtime${libPostfix}`)}"
                    data-importmap-react-dom="${this.getLocalPath(`dist/lean4-infoview/react-dom${libPostfix}`)}"
                    src="${this.getLocalPath('dist/webview.js')}"></script>
            </body>
            </html>`
    }
}
