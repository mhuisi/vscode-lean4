import * as assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Uri, commands } from 'vscode'
import { getClientProvider, openAndAwaitClient } from '../helpers/client'
import { withSaveDialog } from '../helpers/dialogs'
import { closeAllEditors } from '../helpers/editors'
import { gitText } from '../helpers/git'
import { lake } from '../helpers/lake'
import { hasError, hasInfoIncluding, waitForDiagnostics } from '../helpers/lsp'
import { dismiss, withPrompts } from '../helpers/prompts'
import { stubStatefulQuickPick } from '../helpers/quickPicks'
import { afterEachReset } from '../helpers/teardown'
import { makeTestWorkDir, requireIsolatedTestHome } from '../helpers/testHome'
import { withTimeout } from '../helpers/timeouts'

// The Mathlib project can need another toolchain, and the cache download takes minutes.
const TOOLCHAIN_INSTALL_TIMEOUT_MS = 10 * 60_000

describe('Mathlib project initialization (real network)', function () {
    this.timeout(60 * 60_000)

    let workDir: string

    before(function () {
        requireIsolatedTestHome()
        try {
            execFileSync('elan', ['--version'], { env: process.env, stdio: 'ignore' })
        } catch (e) {
            assert.fail(`\`elan\` is not available on PATH: ${(e as Error).message}`)
        }
        workDir = makeTestWorkDir('project-init-')
    })

    afterEach(afterEachReset)

    // Closed editors do not stop the servers. `toolchain-updates.test.ts` runs
    // next in the same VS Code and uninstalls toolchains, and on Windows, the
    // file of a running server cannot be deleted. Thus stop the servers.
    after(async function () {
        let clientProvider
        try {
            // `lean4EnabledFeatures` resolves only after a Lean file was opened.
            clientProvider = await withTimeout(getClientProvider(), 10_000, 'the Lean 4 features')
        } catch {
            return
        }
        for (const client of clientProvider.getClients()) {
            await client.stop()
        }
    })

    it('`lean4.project.createMathlibProject` produces a project that depends on Mathlib', async () => {
        const projectFolder = path.join(workDir, 'MathlibProject')

        await withSaveDialog(Uri.file(projectFolder), async ({ log: saveLog }) => {
            await withPrompts([dismiss(/^Project initialized\. Open new project folder '.*'\?$/)], async () => {
                await commands.executeCommand('lean4.project.createMathlibProject')

                assert.strictEqual(saveLog.length, 1)
                assert.ok(fs.existsSync(projectFolder), `project folder was not created: ${projectFolder}`)

                const toolchainPath = path.join(projectFolder, 'lean-toolchain')
                assert.ok(fs.existsSync(toolchainPath), 'lean-toolchain file should exist')

                // The version that Mathlib uses.
                const toolchain = fs.readFileSync(toolchainPath, 'utf8').trim()
                assert.ok(toolchain.length > 0, 'lean-toolchain should not be empty')

                const lakefileToml = path.join(projectFolder, 'lakefile.toml')
                const lakefileLean = path.join(projectFolder, 'lakefile.lean')
                const lakefilePath = fs.existsSync(lakefileToml)
                    ? lakefileToml
                    : fs.existsSync(lakefileLean)
                      ? lakefileLean
                      : undefined
                assert.ok(lakefilePath, 'lakefile.toml or lakefile.lean should exist')
                const lakefile = fs.readFileSync(lakefilePath, 'utf8')
                assert.match(lakefile, /mathlib/i, 'lakefile should declare a mathlib dependency')

                assert.ok(
                    fs.existsSync(path.join(projectFolder, 'lake-manifest.json')),
                    'lake-manifest.json should exist (dependencies were resolved)',
                )
                assert.ok(
                    fs.existsSync(path.join(projectFolder, '.lake', 'packages', 'mathlib')),
                    'mathlib package should have been fetched into .lake/packages/',
                )

                assert.ok(
                    fs.existsSync(path.join(projectFolder, '.git')),
                    '.git directory should exist (initial commit was made)',
                )
                assert.match(gitText(projectFolder, 'log', '--oneline'), /Initial commit/)

                // Prove that the project elaborates with Mathlib. The files of the
                // `math` template of Lake do not import Mathlib, so we add a file
                // that does. If the import fails, Lean does not elaborate the `#eval`.
                // We import the root module: the paths of the other modules change.
                const checkLean = path.join(projectFolder, 'MathlibCheck.lean')
                const sentinel = 'mathlib-eval-ok'
                fs.writeFileSync(checkLean, `import Mathlib\n\n#eval "${sentinel}"\n`)
                const checkUri = Uri.file(checkLean)
                try {
                    await openAndAwaitClient(checkUri, TOOLCHAIN_INSTALL_TIMEOUT_MS)
                    await waitForDiagnostics(
                        checkUri,
                        d => hasInfoIncluding(sentinel)(d) && !hasError(d),
                        TOOLCHAIN_INSTALL_TIMEOUT_MS,
                        'MathlibCheck.lean: `#eval` output after `import Mathlib`, and no error',
                    )
                } finally {
                    await closeAllEditors()
                }
            })
        })
    })

    it('`lean4.project.clone` downloads the Mathlib preset into a working project', async () => {
        const projectFolder = path.join(workDir, 'ClonedMathlib')

        const { stub: createQuickPick, accepted, restore } = stubStatefulQuickPick('Mathlib')
        try {
            await withSaveDialog(Uri.file(projectFolder), async ({ log: saveLog }) => {
                await withPrompts([dismiss(/^Project initialized\. Open new project folder '.*'\?$/)], async () => {
                    await commands.executeCommand('lean4.project.clone')
                    await accepted()

                    assert.strictEqual(createQuickPick.callCount, 1)
                    assert.strictEqual(saveLog.length, 1)
                    assert.ok(fs.existsSync(projectFolder), `project folder was not created: ${projectFolder}`)

                    assert.ok(
                        fs.existsSync(path.join(projectFolder, '.git')),
                        '.git directory should exist (git clone succeeded)',
                    )
                    assert.ok(
                        fs.existsSync(path.join(projectFolder, 'lean-toolchain')),
                        'lean-toolchain file should exist (this is a Lean project)',
                    )
                    assert.ok(
                        fs.existsSync(path.join(projectFolder, 'lakefile.lean')) ||
                            fs.existsSync(path.join(projectFolder, 'lakefile.toml')),
                        'mathlib lakefile should exist',
                    )
                    assert.ok(
                        fs.existsSync(path.join(projectFolder, 'lake-manifest.json')),
                        'lake-manifest.json should exist (resolveDeps ran)',
                    )
                    assert.ok(
                        fs.existsSync(path.join(projectFolder, 'Mathlib')),
                        'Mathlib/ source directory should exist after cloning',
                    )

                    const remote = gitText(projectFolder, 'config', '--get', 'remote.origin.url').trim()
                    assert.match(remote, /leanprover-community\/mathlib4/, 'remote should point at mathlib4')
                })
            })
        } finally {
            restore()
        }
    })

    it('`lean4.project.fetchCache` succeeds on a freshly scaffolded Mathlib project', async () => {
        const projectName = 'FetchCacheProject'
        const projectFolder = path.join(workDir, projectName)

        // `lake new` does not accept a path, so run it in the parent folder.
        await lake(workDir, ['new', projectName, 'math'], TOOLCHAIN_INSTALL_TIMEOUT_MS)
        // No `lake update`: the command resolves the dependencies, as for a user.

        // `lake new X math` makes `X.lean`, not `Main.lean`.
        const leanEntryFile = fs
            .readdirSync(projectFolder)
            .find(name => name.endsWith('.lean') && !name.startsWith('lakefile'))
        assert.ok(
            leanEntryFile,
            `expected a top-level .lean file in ${projectFolder}; got: ${fs.readdirSync(projectFolder).join(', ')}`,
        )
        const mainUri = Uri.file(path.join(projectFolder, leanEntryFile))

        await openAndAwaitClient(mainUri, TOOLCHAIN_INSTALL_TIMEOUT_MS)

        try {
            await withPrompts([dismiss(/^Mathlib build artifact cache fetched successfully\.$/)], async () => {
                await commands.executeCommand('lean4.project.fetchCache')
            })
        } finally {
            await closeAllEditors()
        }
    })
})
