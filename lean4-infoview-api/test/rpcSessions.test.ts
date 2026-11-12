import { describe, expect, it, vi } from 'vitest'
import type { ServerCapabilities, TextDocumentPositionParams } from 'vscode-languageserver-protocol'
import { LeanServerCapabilities } from '../src/infoviewApi'
import { RpcErrorCode } from '../src/lspTypes'
import { RpcServerIface, RpcSessions } from '../src/rpcSessions'

const uri = 'file:///Test.lean'
const pos: TextDocumentPositionParams = { textDocument: { uri }, position: { line: 1, character: 0 } }
const caps: ServerCapabilities<LeanServerCapabilities> = {
    experimental: { rpcProvider: { rpcWireFormat: 'v1' } },
}

const crashed = { code: RpcErrorCode.WorkerCrashed, message: 'Server process crashed' }

/** An {@link RpcServerIface} whose `createRpcSession` and `call` run `connect` and `call`. */
function mockIface(connect: () => Promise<string>, call: () => Promise<any>) {
    const iface = {
        createRpcSession: vi.fn(connect),
        closeRpcSession: vi.fn(),
        call: vi.fn(call),
        release: vi.fn(),
    } satisfies RpcServerIface
    return iface
}

describe('RpcSessions', () => {
    it('keeps a session whose worker stopped during a call until the file changes', async () => {
        const iface = mockIface(
            async () => 'session 1',
            async () => {
                throw crashed
            },
        )
        const sessions = new RpcSessions(iface)

        const sess = sessions.connect(pos, caps)
        await expect(sess.call('m', {})).rejects.toBe(crashed)
        expect(sessions.connect(pos, caps)).toBe(sess)
        await expect(sess.call('m', {})).rejects.toBe(crashed)
        expect(iface.call).toHaveBeenCalledTimes(1)
        expect(iface.createRpcSession).toHaveBeenCalledTimes(1)
        expect(iface.closeRpcSession).toHaveBeenCalledTimes(1)
        expect(iface.closeRpcSession).toHaveBeenCalledWith('session 1')

        sessions.discardFailedSessionForFile(uri)
        expect(sessions.connect(pos, caps)).not.toBe(sess)
        expect(iface.createRpcSession).toHaveBeenCalledTimes(2)
    })

    it('keeps a session whose worker stopped before it connected until the file changes', async () => {
        const exited = { code: RpcErrorCode.WorkerExited, message: 'Server process exited' }
        const iface = mockIface(
            async () => {
                throw exited
            },
            async () => 'unused',
        )
        const sessions = new RpcSessions(iface)

        const sess = sessions.connect(pos, caps)
        await expect(sess.call('m', {})).rejects.toBe(exited)
        expect(sessions.connect(pos, caps)).toBe(sess)
        await expect(sess.call('m', {})).rejects.toBe(exited)
        expect(iface.createRpcSession).toHaveBeenCalledTimes(1)
        expect(iface.call).not.toHaveBeenCalled()

        sessions.discardFailedSessionForFile(uri)
        expect(sessions.connect(pos, caps)).not.toBe(sess)
        expect(iface.createRpcSession).toHaveBeenCalledTimes(2)
    })

    it('reconnects at once when the server asks for it', async () => {
        const needsReconnect = { code: RpcErrorCode.RpcNeedsReconnect, message: 'Outdated RPC session' }
        const iface = mockIface(
            async () => 'session',
            async () => {
                throw needsReconnect
            },
        )
        const sessions = new RpcSessions(iface)

        const sess = sessions.connect(pos, caps)
        await expect(sess.call('m', {})).rejects.toBe(needsReconnect)
        expect(sessions.connect(pos, caps)).not.toBe(sess)
        expect(iface.createRpcSession).toHaveBeenCalledTimes(2)
    })

    it('keeps a session when other calls fail', async () => {
        const failure = { code: RpcErrorCode.InternalError, message: 'failure' }
        const iface = mockIface(
            async () => 'session',
            async () => {
                throw failure
            },
        )
        const sessions = new RpcSessions(iface)

        const sess = sessions.connect(pos, caps)
        await expect(sess.call('m', {})).rejects.toBe(failure)
        sessions.discardFailedSessionForFile(uri)
        expect(sessions.connect(pos, caps)).toBe(sess)
        expect(iface.createRpcSession).toHaveBeenCalledTimes(1)
        expect(iface.closeRpcSession).not.toHaveBeenCalled()
    })

    it('closes a session whose worker stopped when the file closes', async () => {
        const iface = mockIface(
            async () => {
                throw crashed
            },
            async () => 'unused',
        )
        const sessions = new RpcSessions(iface)

        const sess = sessions.connect(pos, caps)
        await expect(sess.call('m', {})).rejects.toBe(crashed)
        sessions.closeSessionForFile(uri)
        expect(sessions.connect(pos, caps)).not.toBe(sess)
        // The session was never created, so there is nothing to close.
        await Promise.resolve()
        expect(iface.closeRpcSession).not.toHaveBeenCalled()
    })
})
