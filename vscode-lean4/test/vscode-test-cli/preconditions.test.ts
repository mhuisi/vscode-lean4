import * as assert from 'node:assert'
import * as path from 'node:path'
import { Uri, commands, workspace } from 'vscode'
import { activateExtension } from '../helpers/activation'
import { openInEditor, showInEditor } from '../helpers/editors'
import { FIXTURES, assertNotInProject, scaffoldFromFixture } from '../helpers/fixtures'
import { MOCK_TOOLCHAIN_REMOVAL_TIMEOUT_MS, withMockToolchain } from '../helpers/mockToolchain'
import { CaptureOptions, dismiss, waitForPrompt, withPrompts } from '../helpers/prompts'
import { afterEachReset } from '../helpers/teardown'
import { withTimeout } from '../helpers/timeouts'

const PROMPT_TIMEOUT_MS = 60_000
// Opening a file usually takes less than a second.
const OPEN_TIMEOUT_MS = 30_000

// Runs `open` and waits for the prompt that matches `message`. Any other
// prompt fails the test, unless `dismissRemaining` is set.
async function expectPromptOnOpen(open: () => Promise<unknown>, message: RegExp, options: CaptureOptions = {}) {
    await withPrompts(
        [dismiss(message)],
        async ({ log }) => {
            await withTimeout(open(), OPEN_TIMEOUT_MS, 'the editor of the file')
            await waitForPrompt(log, p => message.test(p.message), PROMPT_TIMEOUT_MS, String(message))
        },
        options,
    )
}

describe('Setup preconditions', function () {
    // Each step has its own timeout, which names the step. The timeout of the
    // test is longer than the sum of the steps, so that the step timeout fires first.
    this.timeout(OPEN_TIMEOUT_MS + PROMPT_TIMEOUT_MS + MOCK_TOOLCHAIN_REMOVAL_TIMEOUT_MS + 30_000)

    before(activateExtension)

    afterEach(afterEachReset)

    it('`lean4.troubleshooting.showSetupInformation` produces a diagnostic report', async () => {
        const report = /^\*\*Operating system\*\*/
        await withPrompts([dismiss(report)], async ({ log }) => {
            await commands.executeCommand('lean4.troubleshooting.showSetupInformation')
            const { message } = await waitForPrompt(log, p => report.test(p.message), PROMPT_TIMEOUT_MS, 'report')
            assert.match(message, /^\*\*Git installed\*\*: true$/m)
            assert.match(message, /^\*\*Elan\*\*: .*\(version: \d+\.\d+\.\d+\)$/m)
            assert.match(message, /^\*\*Lean\*\*: .*\(version: \d+\.\d+\.\d+/m)
            assert.match(message, /^\*\*Installed Lean versions\*\*: .*leanprover\/lean4/m)
        })
    })

    it('warns about restricted single-file mode when opening an untitled Lean document', async () => {
        await expectPromptOnOpen(
            async () => showInEditor(await workspace.openTextDocument({ language: 'lean4' })),
            /^Lean 4 server is operating in restricted single file mode\./,
        )
    })

    it('warns when opening a detached Lean file with no enclosing project', async () => {
        assertNotInProject(path.join(FIXTURES, 'detached'))
        await expectPromptOnOpen(
            () => openInEditor(Uri.file(path.join(FIXTURES, 'detached', 'Standalone.lean'))),
            /^Opened folder does not contain a valid Lean 4 project\./,
        )
    })

    it('errors when opening a project folder that has a lakefile but no lean-toolchain', async () => {
        await expectPromptOnOpen(
            () => openInEditor(Uri.file(path.join(FIXTURES, 'lakefile-no-toolchain', 'Main.lean'))),
            /has a Lakefile, but lacks a 'lean-toolchain' file\./,
        )
    })

    // The mock toolchains print a chosen version. Their names are also in the
    // `lean-toolchain` files of the fixtures.
    it('errors when the project pins a Lean 3 toolchain', async () => {
        await withMockToolchain(
            'mock-lean3',
            { leanVersion: 'Lean (version 3.51.1, commit deadbeef, Release)' },
            async () => {
                const projectDir = scaffoldFromFixture('mock-lean3-project', 'lean3-')
                await expectPromptOnOpen(
                    () => openInEditor(Uri.file(path.join(projectDir, 'Main.lean'))),
                    /^Opened project is using Lean 3 \(version: 3\.51\.1\)\./,
                )
            },
        )
    })

    it('warns when the project pins a pre-4.0 Lean 4 toolchain', async () => {
        await withMockToolchain(
            'mock-ancient-lean4',
            { leanVersion: 'Lean (version 4.0.0-rc1, commit deadbeef, Release)' },
            async () => {
                const projectDir = scaffoldFromFixture('mock-ancient-lean4-project', 'ancient-')
                await expectPromptOnOpen(
                    () => openInEditor(Uri.file(path.join(projectDir, 'Main.lean'))),
                    /^Opened project is using a Lean 4 version \(4\.0\.0-rc1\) from before the first Lean 4 stable release/,
                    // A pre-4.0 version is not fatal, so the extension starts a server.
                    // The fixture has no lakefile, so the server is `lean --server` of the
                    // mock toolchain. The mock `lean` only prints its version, so the
                    // server fails, and the extension shows several error prompts about it.
                    { dismissRemaining: true },
                )
            },
        )
    })
})
