import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Uri, commands } from 'vscode'
import { activateExtension } from '../helpers/activation'
import { openAndAwaitClient } from '../helpers/client'
import { withOpenDialog, withSaveDialog } from '../helpers/dialogs'
import { closeAllEditors } from '../helpers/editors'
import { FIXTURES, assertNotInProject } from '../helpers/fixtures'
import { gitText } from '../helpers/git'
import { hasInfoIncluding, waitForDiagnostics } from '../helpers/lsp'
import { dismiss, withPrompts } from '../helpers/prompts'
import { afterEachReset } from '../helpers/teardown'
import { makeTestWorkDir } from '../helpers/testHome'
import { CLIENT_READY_MS, DIAGS_TIMEOUT_MS } from '../helpers/timeouts'

// The Mathlib variants are network tests.
describe('Project initialization commands', function () {
    this.timeout(5 * 60_000)

    before(activateExtension)

    afterEach(afterEachReset)

    it('`lean4.project.createStandaloneProject` produces a committed project that elaborates', async () => {
        const workDir = makeTestWorkDir('standalone-project-')
        const projectFolder = path.join(workDir, 'StandaloneProject')

        await withSaveDialog(Uri.file(projectFolder), async ({ log: saveLog }) => {
            // Opening the new project folder would restart the extension host.
            await withPrompts(
                [dismiss(/^Project initialized\. Open new project folder 'StandaloneProject'\?$/)],
                async () => {
                    await commands.executeCommand('lean4.project.createStandaloneProject')

                    assert.strictEqual(saveLog.length, 1)
                    assert.ok(fs.existsSync(projectFolder), `project folder was not created: ${projectFolder}`)
                    assert.ok(
                        fs.existsSync(path.join(projectFolder, 'lean-toolchain')),
                        'lean-toolchain file should exist',
                    )
                    const hasLakefile =
                        fs.existsSync(path.join(projectFolder, 'lakefile.toml')) ||
                        fs.existsSync(path.join(projectFolder, 'lakefile.lean'))
                    assert.ok(hasLakefile, 'lakefile.toml or lakefile.lean should exist')
                    assert.ok(
                        fs.existsSync(path.join(projectFolder, '.git')),
                        '.git directory should exist (initial commit was made)',
                    )

                    assert.match(
                        gitText(projectFolder, 'log', '--oneline'),
                        /Initial commit/,
                        'initial commit should be present in git log',
                    )

                    // Prove that the new project elaborates.
                    const basicLean = path.join(projectFolder, 'StandaloneProject', 'Basic.lean')
                    assert.ok(fs.existsSync(basicLean), `expected ${basicLean} to exist after lake init`)
                    const sentinel = 'standalone-eval-ok'
                    fs.appendFileSync(basicLean, `\n#eval "${sentinel}"\n`)
                    const basicUri = Uri.file(basicLean)
                    try {
                        await openAndAwaitClient(basicUri, CLIENT_READY_MS)
                        await waitForDiagnostics(
                            basicUri,
                            hasInfoIncluding(sentinel),
                            DIAGS_TIMEOUT_MS,
                            'StandaloneProject #eval output',
                        )
                    } finally {
                        await closeAllEditors()
                    }
                },
            )
        })
    })

    it('`lean4.project.open` reports an error when the selected folder is not a Lean 4 project', async () => {
        assertNotInProject(path.join(FIXTURES, 'detached'))
        const detachedDir = Uri.file(path.join(FIXTURES, 'detached'))
        await withOpenDialog([detachedDir], async ({ log: openLog }) => {
            await withPrompts([dismiss(/^The selected folder is not a valid Lean 4 project folder\./)], async () => {
                await commands.executeCommand('lean4.project.open')
                assert.strictEqual(openLog.length, 1)
            })
        })
    })
})
