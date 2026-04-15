import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { QuickPickItem, QuickPickItemKind, Uri, commands } from 'vscode'
import { activateExtension } from '../helpers/activation'
import { openAndAwaitClient } from '../helpers/client'
import { openInEditor } from '../helpers/editors'
import { elanCachedResolution } from '../helpers/elan'
import { FIXTURES, scaffoldFromFixture } from '../helpers/fixtures'
import { git, gitText, initGitRepo } from '../helpers/git'
import { lake } from '../helpers/lake'
import { choose, dismiss, withPrompts } from '../helpers/prompts'
import { withQuickPicks } from '../helpers/quickPicks'
import { afterEachReset } from '../helpers/teardown'
import { CLIENT_READY_MS } from '../helpers/timeouts'

// Selects all files in the file quick pick of `fetchOpenFileCaches`.
const allFiles = [
    (items: readonly { label: string; kind?: QuickPickItemKind }[]) =>
        items.filter(i => i.kind !== QuickPickItemKind.Separator),
]

// Tests that change a project use a copy in the test home (`scaffoldFromFixture`).
// We do not delete the copies: VS Code keeps watching the opened folders, and
// the next test run deletes them.
describe('Project action commands', function () {
    this.timeout(15 * 60_000)

    before(activateExtension)

    afterEach(afterEachReset)

    describe('on a buildable project', function () {
        let projectDir: string
        let buildDir: string
        let executable: string

        beforeEach(async () => {
            projectDir = scaffoldFromFixture('buildable-project', 'lean4-build-')
            buildDir = path.join(projectDir, '.lake', 'build')
            executable = path.join(buildDir, 'bin', process.platform === 'win32' ? 'Main.exe' : 'Main')
            await openAndAwaitClient(Uri.file(path.join(projectDir, 'Main.lean')), CLIENT_READY_MS)
            assert.ok(!fs.existsSync(executable), 'precondition: the executable must not exist before the build')
        })

        it('`lean4.project.build` builds the project successfully', async () => {
            await withPrompts([dismiss(/^Project built successfully\.$/)], async () => {
                await commands.executeCommand('lean4.project.build')
            })
            assert.ok(fs.existsSync(executable), `${executable} should exist after the build`)
        })

        it('`lean4.project.clean` deletes build artifacts when confirmed and does not rebuild when declined', async () => {
            await withPrompts([dismiss(/^Project built successfully\.$/)], async () => {
                await commands.executeCommand('lean4.project.build')
            })
            assert.ok(fs.existsSync(executable), 'precondition: the executable exists after the build')

            await withPrompts(
                [
                    choose(/^Delete all build artifacts\?$/, 'Proceed'),
                    choose(/^Project cleaned successfully\. Do you wish to rebuild the project\?$/, 'Do Not Rebuild'),
                ],
                async () => {
                    await commands.executeCommand('lean4.project.clean')
                },
            )
            assert.ok(!fs.existsSync(buildDir), '.lake/build/ should be gone after clean')
        })
    })

    describe('on a non-Mathlib project', function () {
        beforeEach(async () => {
            await openAndAwaitClient(Uri.file(path.join(FIXTURES, 'lean-project', 'Main.lean')), CLIENT_READY_MS)
        })

        const unavailable = dismiss(/^This command cannot be used in non-Mathlib projects\.$/)

        for (const cmd of ['fetchCache', 'fetchFileCache', 'fetchAllOpenFileCaches'] as const) {
            it(`\`lean4.project.${cmd}\` reports that the command is unavailable`, async () => {
                await withPrompts([unavailable], async () => {
                    await commands.executeCommand(`lean4.project.${cmd}`)
                })
            })
        }

        it('`lean4.project.fetchOpenFileCaches` picks open files then reports unavailable', async () => {
            await withQuickPicks(allFiles, async () => {
                await withPrompts([unavailable], async () => {
                    await commands.executeCommand('lean4.project.fetchOpenFileCaches')
                })
            })
        })
    })

    // The `mock-mathlib-cache` fixture has a `lean_exe` named `cache` that
    // appends its arguments as one line to `cache-invoked.txt`. The extension
    // first runs `lake exe cache` without arguments to find out whether the
    // project has a cache command, and then runs `lake exe cache get [files]`.
    //
    // Two files are open, so that the commands for the current file, for all
    // open files and for the picked files give different calls. `FakeCache.lean`
    // opens first, in a tab that `Main.lean` does not replace. `Main.lean` is
    // the current file.
    describe('on a mock-Mathlib project', function () {
        let projectDir: string

        // The calls of the `cache` executable. The order of the files of one
        // call comes from the order of the open documents, so we sort them.
        const cacheCalls = () =>
            fs
                .readFileSync(path.join(projectDir, 'cache-invoked.txt'), 'utf8')
                .split(/\r?\n/)
                .slice(0, -1)
                .map(line => {
                    const [command, ...files] = line.split(' ')
                    return [command, ...files.sort()].join(' ')
                })

        beforeEach(async () => {
            projectDir = scaffoldFromFixture('mock-mathlib-cache', 'lean4-mockcache-')
            await openInEditor(Uri.file(path.join(projectDir, 'FakeCache.lean')), { preview: false })
            await openAndAwaitClient(Uri.file(path.join(projectDir, 'Main.lean')), CLIENT_READY_MS)
        })

        const successCases = [
            { cmd: 'fetchCache', message: /^Mathlib build artifact cache fetched successfully\.$/, args: 'get' },
            {
                cmd: 'fetchFileCache',
                message: /^Mathlib build artifact cache for open file\(s\) fetched successfully\.$/,
                args: 'get Main.lean',
            },
            {
                cmd: 'fetchAllOpenFileCaches',
                message: /^Mathlib build artifact cache for open file\(s\) fetched successfully\.$/,
                args: 'get FakeCache.lean Main.lean',
            },
        ]
        for (const { cmd, message, args } of successCases) {
            it(`\`lean4.project.${cmd}\` runs \`lake exe cache ${args}\` and reports success`, async () => {
                await withPrompts([dismiss(message)], async () => {
                    await commands.executeCommand(`lean4.project.${cmd}`)
                })
                assert.deepStrictEqual(cacheCalls(), ['', args])
            })
        }

        // The quick pick offers both files. We pick only the file that is not
        // the current file, so that the call shows that the command uses the pick.
        it('`lean4.project.fetchOpenFileCaches` offers the open files and fetches only the picked file', async () => {
            const pickFakeCache = (items: readonly QuickPickItem[]) => {
                const files = items.filter(i => i.kind !== QuickPickItemKind.Separator)
                assert.deepStrictEqual(
                    files.map(i => i.label),
                    ['Main.lean', 'FakeCache.lean'],
                    'the visible file comes first, then the other open files',
                )
                return files.filter(i => i.label === 'FakeCache.lean')
            }
            await withQuickPicks([pickFakeCache], async () => {
                await withPrompts(
                    [dismiss(/^Mathlib build artifact cache for open file\(s\) fetched successfully\.$/)],
                    async () => {
                        await commands.executeCommand('lean4.project.fetchOpenFileCaches')
                    },
                )
            })
            assert.deepStrictEqual(cacheCalls(), ['', 'get FakeCache.lean'])
        })
    })

    describe('in a throwaway project', function () {
        let projectDir: string

        before(function () {
            projectDir = scaffoldFromFixture('lean-project', 'lean4-selecttc-')
        })

        it('`lean4.project.selectProjectToolchain` writes the chosen toolchain', async () => {
            await openAndAwaitClient(Uri.file(path.join(projectDir, 'Main.lean')), CLIENT_READY_MS)
            const toolchainPath = path.join(projectDir, 'lean-toolchain')
            const original = fs.readFileSync(toolchainPath, 'utf8').trim()

            // Pick the installed version of `original` (for example `v4.35.0` for
            // `stable`). It differs from the current content of `lean-toolchain`,
            // so a command that does nothing fails the test. Other installed
            // toolchains can be leftovers of other tests. The extension marks
            // installed toolchains with `(installed)`.
            const resolved = await elanCachedResolution(original)
            assert.ok(resolved, `precondition: elan has no installed version for ${original}`)
            let pickedLabel: string | undefined
            await withQuickPicks(
                [
                    items => {
                        const installed = items.find(i => i.description === '(installed)' && i.label === resolved)
                        assert.ok(
                            installed,
                            `expected the installed toolchain ${resolved}; got [${items.map(i => i.label).join(' | ')}]`,
                        )
                        pickedLabel = installed.label
                        return installed
                    },
                ],
                async () => {
                    await withPrompts(
                        [
                            choose(
                                /^This operation will set '.*' to be the Lean version of the Lean project/,
                                'Proceed',
                            ),
                            dismiss(/^Project Lean version update successful\.$/),
                            // The file watcher of the client shows this prompt some time after the change.
                            dismiss(/Do you wish to restart the Lean server\?$/, { optional: true }),
                            // See `version-management.test.ts`.
                            dismiss(/^Could not fetch Lean versions/, { optional: true }),
                        ],
                        async () => {
                            await commands.executeCommand('lean4.project.selectProjectToolchain')
                        },
                    )
                },
            )
            assert.strictEqual(fs.readFileSync(toolchainPath, 'utf8'), pickedLabel)
        })
    })

    // `consumer/lakefile.toml` requires `dep` with `git = "../dep"`. Both halves
    // are copied into the same folder, so the relative URL resolves.
    describe('with a local git dependency', function () {
        let depDir: string
        let consumerDir: string

        before(async function () {
            const pairDir = scaffoldFromFixture('local-dep-pair', 'lean4-updatedep-')
            depDir = path.join(pairDir, 'dep')
            consumerDir = path.join(pairDir, 'consumer')
            initGitRepo(depDir)
            await lake(consumerDir, ['update'], CLIENT_READY_MS)
        })

        it('`lean4.project.updateDependency` updates the selected local dep', async () => {
            const manifestPath = path.join(consumerDir, 'lake-manifest.json')
            const readDepRev = (): string => {
                const manifest: { packages: { name: string; rev: string }[] } = JSON.parse(
                    fs.readFileSync(manifestPath, 'utf8'),
                )
                const dep = manifest.packages.find(p => p.name === 'dep')
                assert.ok(dep, `'dep' package not found in ${manifestPath}`)
                return dep.rev
            }
            const beforeRev = readDepRev()

            // Make a new commit, so that the update has a new revision to find.
            fs.writeFileSync(path.join(depDir, 'Bump.lean'), '-- bump\n')
            git(depDir, 'add', '.')
            git(depDir, 'commit', '-m', 'Bump for updateDependency test')
            const expectedRev = gitText(depDir, 'rev-parse', 'HEAD').trim()
            assert.notStrictEqual(expectedRev, beforeRev)

            await openAndAwaitClient(Uri.file(path.join(consumerDir, 'Consumer.lean')), CLIENT_READY_MS)
            await withQuickPicks(['dep'], async () => {
                await withPrompts(
                    [choose(/^This command will update dep to its most recent version\./, 'Proceed')],
                    async () => {
                        await commands.executeCommand('lean4.project.updateDependency')
                    },
                )
            })
            assert.strictEqual(readDepRev(), expectedRev)
        })

        // Lake reads a channel such as `leanprover/lean4:stable` as a name that it
        // cannot compare with a version. Thus `lake update` keeps the Lean version
        // of the consumer, and the extension asks if it must use the version of
        // the dep. The new version is the installed version of the channel, so
        // that the restart of the server downloads nothing.
        it('`lean4.project.updateDependency` changes the Lean version to that of the dep', async () => {
            const consumerToolchainPath = path.join(consumerDir, 'lean-toolchain')
            const consumerToolchain = fs.readFileSync(consumerToolchainPath, 'utf8').trim()
            const depToolchain = await elanCachedResolution(consumerToolchain)
            assert.ok(depToolchain, `elan has no installed version of ${consumerToolchain}`)
            assert.notStrictEqual(depToolchain, consumerToolchain)
            fs.writeFileSync(path.join(depDir, 'lean-toolchain'), `${depToolchain}\n`)
            git(depDir, 'commit', '-am', 'Change the Lean version of dep')

            await openAndAwaitClient(Uri.file(path.join(consumerDir, 'Consumer.lean')), CLIENT_READY_MS)
            await withQuickPicks(['dep'], async () => {
                await withPrompts(
                    [
                        choose(/^This command will update dep to its most recent version\./, 'Proceed'),
                        choose(
                            /^The Lean version '.*' of the open project differs from the Lean version '.*' of dep\./,
                            'Update Lean Version',
                        ),
                        // The file watcher of the client sees the new `lean-toolchain`.
                        dismiss(/^Project Lean version \(`lean-toolchain`\) of 'consumer' has changed\./, {
                            optional: true,
                        }),
                    ],
                    async () => {
                        await commands.executeCommand('lean4.project.updateDependency')
                    },
                )
            })
            assert.strictEqual(fs.readFileSync(consumerToolchainPath, 'utf8'), depToolchain)
        })
    })
})
