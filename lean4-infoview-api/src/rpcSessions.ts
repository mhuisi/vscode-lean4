import type {
    DocumentUri,
    Position,
    ServerCapabilities,
    TextDocumentPositionParams,
} from 'vscode-languageserver-protocol'
import { ClientRequestOptions, LeanServerCapabilities } from './infoviewApi'
import { RpcCallParams, RpcErrorCode, RpcPtr, RpcReleaseParams } from './lspTypes'

/**
 * Abstraction of the functionality needed
 * to establish RPC sessions in the Lean server
 * and to make RPC calls.
 * See the Lean module `Lean.Server.Rpc.Basic`.
 *
 * This interface can be implemented both in the infoview
 * (relaying LSP messages from the webview to the extension),
 * as well as in the extension itself
 * (directly sending LSP messages via the
 * `vscode-languageserver-node` library (TODO)).
 */
export interface RpcServerIface {
    /**
     * Creates an RPC session for the given URI and returns the session ID.
     * The implementation of {@link RpcServerIface} takes care
     * to send any required keepalive notifications.
     */
    createRpcSession(uri: DocumentUri): Promise<string>
    /** Closes an RPC session created with {@link createRpcSession}. */
    closeRpcSession(sessionId: string): void
    /** Sends an RPC call to the Lean server. */
    call(request: RpcCallParams, options?: ClientRequestOptions): Promise<any>
    /** Sends an RPC reference release notification to the server. */
    release(request: RpcReleaseParams): void
}

/**
 * An {@link RpcSessionForFile} with `call` specialized to a specific position `p`.
 *
 * Morally, this bundles an RPC session
 * with the set of RPC methods
 * available at the position `p`.
 *
 * It is okay to mix RPC references
 * between different {@link RpcSessionAtPos} objects
 * created from the same {@link RpcSessionForFile}.
 */
export interface RpcSessionAtPos {
    /**
     * Invoke an RPC method in the Lean server.
     *
     * @param method fully qualified name of the method to call.
     * @param params arguments to the invoked method.
     * @param options additional configuration for the request.
     * @returns a promise that resolves to the returned value, or an error in case the call fails.
     */
    call<T, S>(method: string, params: T, options?: ClientRequestOptions): Promise<S>
}

/**
 * Manages a connection to an RPC session
 * that has been opened for a given file
 * (in the Lean server's worker process for that file).
 *
 * An RPC session keeps track of a set of RPC references
 * that are mutually intelligible,
 * in the sense that any RPC method can be called
 * with any number of references from this set.
 * On the other hand,
 * it is not possible to mix RPC references
 * between different sessions.
 */
class RpcSessionForFile {
    sessionId: Promise<string>
    /**
     * If present, stores a fatal exception
     * indicating that the RPC session can no longer be used.
     * For example: the worker crashed
     */
    failed?: any

    refsToRelease: RpcPtr<any>[] = []
    finalizers: FinalizationRegistry<RpcPtr<any>>

    /** Essentially a cache for {@link at}. See {@link at} for why we need this. */
    sessionsAtPos: Map<string, RpcSessionAtPos> = new Map()

    constructor(
        public uri: DocumentUri,
        public sessions: RpcSessions,
        private serverCapabilities: ServerCapabilities<LeanServerCapabilities>,
    ) {
        this.sessionId = (async () => {
            try {
                return await sessions.iface.createRpcSession(uri)
            } catch (ex) {
                this.failWithoutClosing(ex, isWorkerStoppedError(ex))
                throw ex
            }
        })()
        this.sessionId.catch(() => {}) // silence uncaught exception warning

        // Here we hook into the JS GC and send release-reference notifications
        // whenever the GC finalizes a number of `RpcPtr`s. Requires ES2021.
        let releaseTimeout: number | undefined
        this.finalizers = new FinalizationRegistry(ptr => {
            if (this.failed) return
            this.refsToRelease.push(ptr)

            // We release eagerly instead of delaying when this many refs become garbage
            const maxBatchSize = 100
            if (this.refsToRelease.length > maxBatchSize) {
                void this.releaseNow()
                clearTimeout(releaseTimeout)
                releaseTimeout = undefined
            } else if (releaseTimeout === undefined) {
                releaseTimeout = window.setTimeout(() => {
                    void this.releaseNow()
                    releaseTimeout = undefined
                }, 100)
            }
        })
    }

    async releaseNow() {
        const sessionId = await this.sessionId
        if (this.failed || this.refsToRelease.length === 0) return
        this.sessions.iface.release({
            uri: this.uri,
            sessionId,
            refs: this.refsToRelease,
        })
        this.refsToRelease = []
    }

    /**
     * Traverses an object received from the RPC server
     * and registers all contained references
     * for future garbage collection.
     *
     * The function implements a form of "conservative garbage collection"
     * where it treats any subobject `{'__rpcref': v}` as a potential RPC reference.
     * Therefore `__rpcref` should not be used as a field name on the Lean side
     * to prevent false positives.
     *
     * Earlier versions of the extension
     * had manually written registration functions for every type,
     * but those are a lot of boilerplate.
     * If we change back to that approach,
     * we should generate them automatically.
     * It would also be possible to move to a new RPC wire format
     * that specifies which values are references using metadata.
     */
    registerRefs(o: any) {
        if (o instanceof Object) {
            let isRef = false
            if (this.serverCapabilities.experimental?.rpcProvider?.rpcWireFormat === 'v1') {
                if (Object.keys(o as {}).length === 1 && '__rpcref' in o && typeof o.__rpcref === 'string') {
                    this.finalizers.register(o as {}, RpcPtr.copy(o as RpcPtr<any>))
                    isRef = true
                }
            } else {
                if (Object.keys(o as {}).length === 1 && 'p' in o && typeof o.p === 'string') {
                    this.finalizers.register(o as {}, RpcPtr.copy(o as RpcPtr<any>))
                    isRef = true
                }
            }
            if (!isRef) {
                for (const v of Object.values(o)) this.registerRefs(v)
            }
        } else if (o instanceof Array) {
            for (const e of o) this.registerRefs(e)
        }
    }

    /**
     * Marks this session as failed.
     * With `keepInSessions`, {@link RpcSessions.connect} keeps returning this session,
     * so that its calls fail at once instead of creating new sessions.
     */
    private failWithoutClosing(reason: any, keepInSessions: boolean): void {
        this.failed = reason
        // NOTE(WN): the sessions map is keyed by URI rather than ID and by the time this
        // function executes, a new session for the same file may already have been added.
        // So we should only delete the stored session if it's still this one.
        if (!keepInSessions && this.sessions.sessions.get(this.uri) === this) {
            this.sessions.sessions.delete(this.uri)
        }
    }

    fail(reason: any, keepInSessions: boolean = false) {
        const wasFailed = !!this.failed
        this.failWithoutClosing(reason, keepInSessions)
        if (!wasFailed) {
            void this.sessionId.then(
                id => this.sessions.iface.closeRpcSession(id),
                () => {}, // No session was created.
            )
        }
    }

    /**
     * Invoke an RPC method in the Lean server.
     *
     * To compute the set of RPC methods that can be called,
     * the server finds the environment `e` at the source code location `this.uri:position`.
     * The callable methods are then all the builtin ones,
     * and all constants in `e` marked with `@[server_rpc_method]`
     * (i.e., the `@[server_rpc_method]` declarations made above `this.uri:position`).
     *
     * @param position within the file identified by {@link uri}, used to resolve the set of available RPC methods.
     * @param method fully qualified name of the method to call.
     * @param params arguments to the invoked method.
     * @param options additional configuration for the request.
     * @returns a promise that resolves to the returned value, or to an error in case the call fails.
     */
    async call(position: Position, method: string, params: any, options?: ClientRequestOptions): Promise<any> {
        const sessionId = await this.sessionId
        if (this.failed) throw this.failed
        const tdpp: TextDocumentPositionParams = { position, textDocument: { uri: this.uri } }
        try {
            const result = await this.sessions.iface.call({ method, params, sessionId, ...tdpp }, options)
            this.registerRefs(result)
            // HACK: most of our types are `T | undefined` so try to return something matching that interface
            if (result === null) return undefined
            return result
        } catch (ex: any) {
            if (isWorkerStoppedError(ex)) {
                this.fail(ex, true)
            } else if (ex?.code === RpcErrorCode.RpcNeedsReconnect) {
                this.fail(ex)
            }
            throw ex
        }
    }

    /**
     * Returns this session with {@link call} specialized to `position` within the file.
     * This is guaranteed to return the same (by reference) object
     * if called multiple times with the same (by deep comparison) position,
     * on the same {@link RpcSessionForFile}.
     * It can therefore be used as a React dep.
     */
    at(position: Position): RpcSessionAtPos {
        // As JS tradition dictates, we use stringification for deep comparison of `Position`s in a `Map`.
        const posStr = `${position.line}:${position.character}`
        if (this.sessionsAtPos.has(posStr)) return this.sessionsAtPos.get(posStr) as RpcSessionAtPos
        const atPos: RpcSessionAtPos = {
            call: (method, params, options) => this.call(position, method, params, options),
        }
        this.sessionsAtPos.set(posStr, atPos)
        return atPos
    }
}

/**
 * Whether `ex` says that the file worker of the session has stopped.
 * The Lean server only starts a new worker for the file when the file changes.
 */
function isWorkerStoppedError(ex: any): boolean {
    return ex?.code === RpcErrorCode.WorkerCrashed || ex?.code === RpcErrorCode.WorkerExited
}

// Docstrings on exported types mention this type.
export type { RpcSessionForFile }

/** Manages RPC sessions for multiple files. */
export class RpcSessions {
    /**
     * Contains the {@link RpcSessionForFile} objects that {@link connect} returns.
     *
     * When the file worker of a session stops (e.g. it crashes),
     * the failed session stays in this map until {@link discardFailedSessionForFile} is called,
     * so that its calls fail at once instead of creating a new session for the stopped worker.
     * Any other failed {@link RpcSessionForFile} is removed from this map,
     * and the {@link connect} method will then automatically reconnect
     * the next time it is called.
     */
    sessions: Map<DocumentUri, RpcSessionForFile> = new Map()

    constructor(public iface: RpcServerIface) {}

    private connectCore(
        uri: DocumentUri,
        serverCapabilities: ServerCapabilities<LeanServerCapabilities>,
    ): RpcSessionForFile {
        if (this.sessions.has(uri)) return this.sessions.get(uri) as RpcSessionForFile
        const sess = new RpcSessionForFile(uri, this, serverCapabilities)
        this.sessions.set(uri, sess)
        return sess
    }

    /**
     * Returns an {@link RpcSessionAtPos} for the given document and position.
     * Calling {@link connect} multiple times will return the same
     * session (with the same session ID).
     * A new session is only created if the session is closed manually (the file is closed),
     * if the server asks for a reconnect,
     * or if the file worker stopped and {@link discardFailedSessionForFile} was called since.
     */
    connect(
        pos: TextDocumentPositionParams,
        serverCapabilities: ServerCapabilities<LeanServerCapabilities>,
    ): RpcSessionAtPos {
        return this.connectCore(pos.textDocument.uri, serverCapabilities).at(pos.position)
    }

    /**
     * Removes the session for the given URI if it failed,
     * so that {@link connect} creates a new session the next time it is called.
     * Call it when the file changes: the Lean server then starts a new file worker
     * for a file whose worker stopped.
     */
    discardFailedSessionForFile(uri: DocumentUri): void {
        if (this.sessions.get(uri)?.failed) this.sessions.delete(uri)
    }

    /** Closes the session for the given URI. */
    closeSessionForFile(uri: DocumentUri): void {
        void this.sessions.get(uri)?.fail('file closed')
    }

    closeAllSessions(): void {
        for (const k of [...this.sessions.keys()]) this.closeSessionForFile(k)
    }

    dispose(): void {
        this.closeAllSessions()
    }
}
