import * as assert from 'node:assert'
import * as path from 'node:path'
import { Diagnostic, Uri, commands, workspace } from 'vscode'
import { activateExtension } from '../helpers/activation'
import { openInEditor } from '../helpers/editors'
import { hasError, waitForDiagnostics } from '../helpers/lsp'
import { dumpStateIfFailed } from '../helpers/teardown'
import { DIAGS_TIMEOUT_MS, RESTART_DIAGS_TIMEOUT_MS } from '../helpers/timeouts'

// `Restart.lean` shows a new number for each elaboration (`IO.monoNanosNow`).
// Thus a test can see that a restart elaborated the file again. The
// diagnostics alone cannot show this: the extension can merge the empty
// diagnostics of the restart with the new diagnostics.
function elaborationId(diags: Diagnostic[]): string | undefined {
    for (const d of diags) {
        const match = /elaboration (\d+)/.exec(d.message)
        if (match) return match[1]
    }
    return undefined
}

describe('Language server — launch and restart', function () {
    this.timeout(DIAGS_TIMEOUT_MS + RESTART_DIAGS_TIMEOUT_MS + 60_000)

    let main: Uri
    let restart: Uri

    before(async () => {
        await activateExtension()

        const folder = workspace.workspaceFolders?.[0]
        assert.ok(folder, 'a workspace folder must be open')
        main = Uri.file(path.join(folder.uri.fsPath, 'Main.lean'))
        restart = Uri.file(path.join(folder.uri.fsPath, 'Restart.lean'))
    })

    // Not `afterEachReset`, which closes the editors: if the next test opens
    // the file again, the server elaborates it again. That elaboration can
    // still run when the next test restarts, and look like the restart.
    afterEach(function () {
        return dumpStateIfFailed(this)
    })

    it('launches the server and produces an error diagnostic on the fixture', async () => {
        await openInEditor(main)
        const diags = await waitForDiagnostics(main, hasError, DIAGS_TIMEOUT_MS, 'initial')
        assert.ok(hasError(diags))
    })

    // A restart that does nothing fails these tests: only a new elaboration
    // gives a new number.
    for (const command of ['lean4.restartFile', 'lean4.restartServer']) {
        it(`elaborates the current file again after \`${command}\``, async () => {
            await openInEditor(restart)
            const before = elaborationId(
                await waitForDiagnostics(
                    restart,
                    d => elaborationId(d) !== undefined,
                    DIAGS_TIMEOUT_MS,
                    `before ${command}`,
                ),
            )
            await commands.executeCommand(command)
            await waitForDiagnostics(
                restart,
                d => {
                    const id = elaborationId(d)
                    return id !== undefined && id !== before
                },
                RESTART_DIAGS_TIMEOUT_MS,
                `after ${command}`,
            )
        })
    }
})
