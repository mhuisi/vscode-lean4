import { RpcCallParams, RpcReleaseParams, RpcSessionAtPos, RpcSessions } from '@leanprover/infoview-api'
import * as React from 'react'
import type {
    DidChangeTextDocumentParams,
    DidCloseTextDocumentParams,
    DocumentUri,
    TextDocumentPositionParams,
} from 'vscode-languageserver-protocol'
import { CapabilityContext, EditorContext, EnvPosContext } from './contexts'
import { DocumentPosition, useClientNotificationEffect, useEvent } from './util'

const RpcSessionsContext = React.createContext<RpcSessions | undefined>(undefined)

/**
 * Provides a {@link RpcSessionsContext} to the children.
 * The {@link RpcSessions} object stored there manages RPC sessions in the Lean server.
 */
export function WithRpcSessions({ children }: { children: React.ReactNode }) {
    const ec = React.useContext(EditorContext)
    const [sessions] = React.useState<RpcSessions>(
        () =>
            new RpcSessions({
                createRpcSession: (uri: DocumentUri) => ec.api.createRpcSession(uri),
                closeRpcSession: (uri: DocumentUri) => ec.api.closeRpcSession(uri),
                call: (params: RpcCallParams, options) =>
                    ec.api.sendClientRequest(params.textDocument.uri, '$/lean/rpc/call', params, options),
                release: (params: RpcReleaseParams) =>
                    void ec.api.sendClientNotification(params.uri, '$/lean/rpc/release', params),
            }),
    )
    React.useEffect(() => {
        // Clean up the sessions on unmount
        return () => sessions.dispose()
    }, [sessions])

    useClientNotificationEffect(
        'textDocument/didChange',
        (params: DidChangeTextDocumentParams) => {
            sessions.discardFailedSessionForFile(params.textDocument.uri)
        },
        [sessions],
    )

    useClientNotificationEffect(
        'textDocument/didClose',
        (params: DidCloseTextDocumentParams) => {
            sessions.closeSessionForFile(params.textDocument.uri)
        },
        [sessions],
    )

    // TODO: only restart files for the server that stopped
    useEvent(ec.events.serverRestarted, () => sessions.closeAllSessions())

    return <RpcSessionsContext.Provider value={sessions}>{children}</RpcSessionsContext.Provider>
}

function errorRpcSession(err: string): RpcSessionAtPos {
    return {
        call: async () => {
            throw new Error(err)
        },
    }
}

export function useRpcSessionAtTdpp(pos: TextDocumentPositionParams): RpcSessionAtPos {
    const rsc = React.useContext(RpcSessionsContext)
    const cap = React.useContext(CapabilityContext)
    if (!rsc) return errorRpcSession('no RPC context set')
    if (!cap) return errorRpcSession('no capability context set')
    return rsc.connect(pos, cap)
}

export function useRpcSessionAtPos(pos: DocumentPosition): RpcSessionAtPos {
    return useRpcSessionAtTdpp(DocumentPosition.toTdpp(pos))
}

/** @deprecated use {@link useRpcSession} instead */
/*
 * NOTE(WN): This context cannot be removed as of 2024-05-27 since existing widgets use it.
 * For backwards compatibility, it must be set to the correct value by infoview code.
 * A future major release of @leanprover/infoview could remove this context
 * after it has been deprecated for a sufficiently long time.
 */
export const RpcContext = React.createContext<RpcSessionAtPos>(errorRpcSession('no RPC context set'))

/**
 * Retrieve an RPC session at {@link EnvPosContext},
 * if the context is set.
 * Otherwise return a dummy session that throws on any RPC call.
 */
export function useRpcSession(): RpcSessionAtPos {
    const pos = React.useContext(EnvPosContext)
    // Cannot deduplicate with `useRpcSessionAtTdpp`
    // because we'd only call it when `pos !== undefined`
    // but hooks must be called unconditionally.
    const rsc = React.useContext(RpcSessionsContext)
    const cap = React.useContext(CapabilityContext)
    if (!pos) return errorRpcSession('no position context set')
    if (!rsc) return errorRpcSession('no RPC context set')
    if (!cap) return errorRpcSession('no capability context set')
    return rsc.connect(DocumentPosition.toTdpp(pos), cap)
}
