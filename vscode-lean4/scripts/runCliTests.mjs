import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addPackageBinsToPath, exitLike, runChild, runSignalHandlers, stoppedBy } from './childProcess.mjs'
import { cliTestNames, networkTestNames } from './cliTestNames.mjs'
import { printSummary } from './runSummary.mjs'
import { prepareTestHome, rmOptions } from './testHome.mjs'
import { fetchStableVersions } from './vscodeVersions.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Runs `vscode-test --label <label>` for each label, one at a time. Without
// arguments, it runs all `cli-*` labels. Arguments select labels, for example
// `cli-abbreviation` or `network`. Separate runs give an exit code per label,
// so that the summary at the end can show which labels failed.
//
// Before the first label, the script prepares the test home and deletes the
// state dumps of the last run. `.vscode-test.mjs` does not do this, because
// tools that only read the configuration also load it.

const allLabels = ['network', ...cliTestNames.map(name => `cli-${name}`)]
const requested = process.argv.slice(2)
const unknown = requested.filter(label => !allLabels.includes(label))
if (unknown.length > 0) {
    console.error(`unknown label(s): ${unknown.join(', ')}`)
    console.error(`known labels: ${allLabels.join(', ')}`)
    process.exit(2)
}
// The network suite deletes `.elan`, and at its end the current stable
// toolchain is not installed (`cliTestNames.mjs`). Thus it runs after the
// `cli-*` labels, also if the arguments give another order.
const cliLabels =
    requested.length > 0 ? requested.filter(label => label !== 'network') : cliTestNames.map(name => `cli-${name}`)
const labels = requested.includes('network') ? [...cliLabels, 'network'] : cliLabels
// `.vscode-test.mjs` has the configuration `network` only with this variable.
if (labels.includes('network')) {
    process.env.LEAN4_TEST_NETWORK = '1'
}
addPackageBinsToPath()

// If a compiled test file is missing (for example a new `.test.ts` without
// `compile-tests`), `vscode-test` runs no files and passes. The paths are
// the `files` of `.vscode-test.mjs`.
const outDir = path.resolve(__dirname, '..', 'out', 'test')
const compiledFiles = label =>
    label === 'network'
        ? networkTestNames.map(name => path.join(outDir, 'network', `${name}.test.js`))
        : [path.join(outDir, 'vscode-test-cli', `${label.slice('cli-'.length)}.test.js`)]
const notCompiled = labels.flatMap(compiledFiles).filter(file => !fs.existsSync(file))
if (notCompiled.length > 0) {
    console.error(`compiled test files not found (run \`npm run compile-tests\`):\n  ${notCompiled.join('\n  ')}`)
    process.exit(2)
}

const cliOutputDir = path.resolve(__dirname, '..', 'vscode-test-cli-output')
fs.rmSync(cliOutputDir, rmOptions)
fs.mkdirSync(cliOutputDir, { recursive: true })

// The network suite installs elan itself, and its first test deletes `.elan`.
// Thus it needs no toolchain from the setup, and a run with only the network
// suite can start without elan. The `cli-*` labels need elan.
prepareTestHome({ seedElan: cliLabels.length > 0, requireElan: cliLabels.length > 0 })

// With `stable`, vscode-test asks the update server for each label
// (`.vscode-test.mjs` explains the problem). Thus we get the newest stable
// version one time, with retries. If we cannot get it (for example offline),
// we let vscode-test use `stable`. An empty value counts as not set.
if (!process.env.LEAN4_VSCODE_VERSION) {
    try {
        process.env.LEAN4_VSCODE_VERSION = (await fetchStableVersions())[0]
    } catch (e) {
        console.warn(`[vscode-test] cannot get the current VS Code stable version, using \`stable\`: ${e}`)
    }
}

// The summary uses only the end of the output (`extractFailureDetail`), and
// the tests write all output channels to stdout. Thus we keep at most the
// last `CAPTURE_LIMIT` characters (plus one chunk) of each label.
const CAPTURE_LIMIT = 1024 * 1024

// Writes the output of the child to stdout, and keeps its end for the summary
// of a failed label.
async function runLabel(label) {
    const t0 = Date.now()
    const chunks = []
    let capturedLength = 0
    const capture = chunk => {
        const text = chunk.toString()
        chunks.push(text)
        capturedLength += text.length
        while (capturedLength - chunks[0].length >= CAPTURE_LIMIT) {
            capturedLength -= chunks.shift().length
        }
    }
    // On Windows, `cmd.exe` runs `vscode-test.cmd`. After a Ctrl-C, it asks
    // "Terminate batch job (Y/N)?" and reads stdin. With an open stdin pipe,
    // no answer comes and the run hangs. With `ignore`, it reads end-of-file.
    const { status } = await runChild(
        'vscode-test',
        ['--label', label],
        { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] },
        child => {
            child.stdout.on('data', chunk => {
                process.stdout.write(chunk)
                capture(chunk)
            })
            child.stderr.on('data', chunk => {
                process.stderr.write(chunk)
                capture(chunk)
            })
        },
    )
    return { name: label, status, elapsedMs: Date.now() - t0, captured: status === 0 ? '' : chunks.join('') }
}

// After a stop during the setup (for example during `elan toolchain install`),
// we start no label.
await runSignalHandlers()
const results = []
for (const label of labels) {
    if (stoppedBy()) break
    results.push(await runLabel(label))
}

// The failure details of a label: the part of the output from "M failing"
// on. The colors of mocha are removed first. "N passing" must come before
// "M failing", so that a line in a stack trace does not match. If mocha did
// not print a summary (for example after a crash), the last 50 lines.
const ANSI_ESCAPE = /\x1b\[[\d;]*[A-Za-z]/g
function extractFailureDetail(captured) {
    const lines = captured.replace(ANSI_ESCAPE, '').split('\n')
    const passingIdx = lines.findIndex(line => /^\s+\d+ passing\b/.test(line))
    if (passingIdx >= 0) {
        const failingIdx = lines.findIndex((line, i) => i > passingIdx && /^\s+\d+ failing\s*$/.test(line))
        if (failingIdx >= 0) return lines.slice(failingIdx).join('\n').trim()
    }
    return lines.slice(-50).join('\n').trim()
}

const failed = printSummary('vscode-test-cli summary', 'labels', results)

for (const r of failed) {
    console.log('─'.repeat(40))
    console.log(`failure detail: ${r.name}`)
    console.log('─'.repeat(40))
    console.log(extractFailureDetail(r.captured))
    console.log('')
}

exitLike({ status: failed.length > 0 ? 1 : 0, signal: null })
