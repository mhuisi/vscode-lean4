import { exitLike, runChild, runSignalHandlers, stoppedBy } from '../vscode-lean4/scripts/childProcess.mjs'
import { printSummary } from '../vscode-lean4/scripts/runSummary.mjs'
import { prepareTestHome } from '../vscode-lean4/scripts/testHome.mjs'

// Runs all test suites, also after a failure, so that one run shows all
// failures. Prints a summary at the end.
//
// All suites need the same build: the unit tests and the type check use the
// `dist/` folders of the packages, and the VS Code suites also use the
// extension and the compiled tests. Thus this script builds one time, before
// the first suite, and runs the npm scripts of the VS Code suites with
// `--ignore-scripts`, which skips the `pretest:*` builds. If the build fails,
// the other suites still run, but the VS Code suites do not. This script also
// prepares the test home one time: the run scripts of the suites see
// `LEAN4_TEST_HOME` and do not reset it again.

async function runSuite(suite) {
    const t0 = Date.now()
    // On Windows, npm is a `.cmd` file, which needs a shell.
    const { status } = await runChild('npm', suite.args, { stdio: 'inherit', shell: process.platform === 'win32' })
    return { name: suite.name, status, elapsedMs: Date.now() - t0 }
}

const vscodeSuite = (name, script) => ({
    name,
    args: ['run', script, '--workspace=lean4', '--ignore-scripts'],
    needsBuild: true,
})

const suites = [
    { name: 'build for tests', args: ['run', 'build-for-tests', '--workspace=lean4'], isBuild: true },
    { name: 'unit (vitest)', args: ['run', 'test:unit'] },
    // The `test` scripts of the packages type-check their tests.
    { name: 'type check (tsc)', args: ['run', 'test', '--workspaces', '--if-present'] },
    { name: 'grammar', args: ['run', 'test:grammar', '--workspace=lean4'] },
    vscodeSuite('vscode-test-cli', 'test:vscode-test-cli'),
    vscodeSuite('wdio', 'test:wdio'),
]

const results = []
// Why the VS Code suites cannot run, if they cannot.
let vscodeSuitesBlocked
for (const suite of suites) {
    if (suite.needsBuild && !vscodeSuitesBlocked && !stoppedBy() && !process.env.LEAN4_TEST_HOME) {
        try {
            prepareTestHome()
        } catch (e) {
            console.error(`cannot prepare the test home: ${e instanceof Error ? e.message : e}`)
            vscodeSuitesBlocked = 'no test home'
        }
        // After a stop during the setup (for example during `elan toolchain
        // install`), we start no suite.
        await runSignalHandlers()
    }
    if (stoppedBy()) {
        results.push({ name: suite.name, status: 1, elapsedMs: 0, note: `not run: stopped by ${stoppedBy()}` })
        continue
    }
    if (suite.needsBuild && vscodeSuitesBlocked) {
        results.push({ name: suite.name, status: 1, elapsedMs: 0, note: `not run: ${vscodeSuitesBlocked}` })
        continue
    }
    console.log('')
    console.log('═'.repeat(60))
    console.log(`▶ ${suite.name}`)
    console.log('═'.repeat(60))
    const result = await runSuite(suite)
    results.push(result)
    if (suite.isBuild && result.status !== 0) {
        vscodeSuitesBlocked = 'the build failed'
    }
}

const failed = printSummary('test suite summary', 'suites', results)

exitLike({ status: failed.length > 0 ? 1 : 0, signal: null })
