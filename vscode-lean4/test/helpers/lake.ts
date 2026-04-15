import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Runs `lake ...args` in `cwd` and returns its stdout. `execFile`, not
// `execFileSync`: a build or a download takes minutes, and a synchronous call
// blocks the extension host for that time. Stops lake after `timeoutMs`. Fails
// with stdout and stderr in the message: Lake writes most errors to stdout.
export async function lake(cwd: string, args: string[], timeoutMs: number): Promise<string> {
    try {
        const { stdout } = await execFileAsync('lake', args, {
            cwd,
            env: process.env,
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            timeout: timeoutMs,
        })
        return stdout
    } catch (e) {
        const err = e as Error & { stdout?: string; stderr?: string }
        throw new Error(
            `\`lake ${args.join(' ')}\` failed in ${cwd}: ${err.message}\n` +
                `stdout:\n${err.stdout ?? ''}\nstderr:\n${err.stderr ?? ''}`,
        )
    }
}
