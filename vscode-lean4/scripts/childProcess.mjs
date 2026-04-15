import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// Starts the child processes of the run scripts (`headless.mjs`,
// `runCliTests.mjs`, `runWdio.mjs` and `runAllTests.mjs` in the root).
//
// If a run script gets SIGINT, SIGTERM or SIGHUP, it passes the signal on to
// all processes of its child, waits until the child ends, and then ends with
// the same signal. Else VS Code can keep running on the test home, and the
// next run deletes the test home while VS Code still uses it. On Linux and
// macOS, the child gets its own process group, so that the signal also reaches
// processes that do not pass it on (for example `xvfb-run`). As a result, the
// SIGHUP of a closed terminal reaches only the run script, and not the group
// of the child. Windows has no such signals: there, Ctrl-C reaches all
// processes of the console.

const ownGroup = process.platform !== 'win32'

let current
let stopSignal

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
        stopSignal = signal
        if (current !== undefined && ownGroup) {
            try {
                process.kill(-current.pid, signal)
            } catch {
                // The process group has ended.
            }
        }
    })
}

// Puts the `node_modules/.bin` folders of `vscode-lean4/` and of the repository
// root at the start of PATH, as npm does for its scripts. Thus a run script
// also finds `vscode-test` and `wdio` when you start it with `node`. On
// Windows, `process.env` ignores the case of names, so this also changes `Path`.
export function addPackageBinsToPath() {
    const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const bins = [path.join(packageDir, 'node_modules', '.bin'), path.join(packageDir, '..', 'node_modules', '.bin')]
    process.env.PATH = [...bins, process.env.PATH].filter(Boolean).join(path.delimiter)
}

// The signal that stopped the run, or `undefined`. The run scripts start no
// further child after a stop.
export function stoppedBy() {
    return stopSignal
}

// Lets the signal handlers run. A signal that comes during synchronous work
// (for example `execFileSync` in `prepareTestHome`) reaches its handler only
// when the event loop runs. Thus, after such work, a run script calls this
// before it reads `stoppedBy()` and starts the next child.
export function runSignalHandlers() {
    return new Promise(resolve => setImmediate(resolve))
}

// Runs `command` like `spawn` and resolves with `{ status, signal }` when it
// has ended and its output streams have closed. `onSpawn` gets the child, for
// example to read its output. If the command cannot start (for example, it is
// not on PATH), prints the cause and resolves with status 1.
export function runChild(command, args, options = {}, onSpawn = () => {}) {
    return new Promise(resolve => {
        let done = false
        const finish = result => {
            if (done) return
            done = true
            current = undefined
            resolve(result)
        }
        const child = spawn(command, args, { ...options, detached: ownGroup })
        current = child
        onSpawn(child)
        child.on('error', e => {
            console.error(`cannot run \`${command}\`: ${e.message}`)
            finish({ status: 1, signal: null })
        })
        // 'close', not 'exit': the output streams can still have data after 'exit'.
        child.on('close', (code, signal) => finish({ status: code ?? 1, signal }))
    })
}

// Ends this process with the signal that stopped the run or the child, if
// there is one, and else with `status`.
export function exitLike({ status, signal }) {
    const endSignal = stopSignal ?? signal
    if (endSignal) {
        process.removeAllListeners(endSignal)
        process.kill(process.pid, endSignal)
        return
    }
    process.exit(status)
}
