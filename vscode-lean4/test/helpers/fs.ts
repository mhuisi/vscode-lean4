import * as fs from 'node:fs'

// `fs.rmSync` with `recursive`, `force` and retries. On Windows, a file that
// a process just ran (for example `lean.exe`) stays locked for a short time,
// and deleting it fails with `EPERM`. The retries wait up to about 5 s.
// `scripts/*.mjs` cannot import this file, so `rmOptions` in
// `scripts/testHome.mjs` repeats the options.
export function rmSync(target: string, options?: fs.RmOptions): void {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100, ...options })
}

// The error codes of `fs.promises.rm` that Node.js retries with `maxRetries`.
const RM_RETRY_CODES = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'])

// Like `rmSync`, but asynchronous, and the retries wait up to `timeoutMs`. Use it
// for a folder with programs that the extension can still run, for example a
// mock toolchain or ELAN_HOME. `rmSync` blocks the extension host while it
// waits, so the extension cannot process the end of these programs.
// After the timeout, it throws the error of the last attempt. This error names
// the file that is locked.
export async function rmAsync(target: string, timeoutMs: number = 30_000): Promise<void> {
    // We do not use `maxRetries` of Node.js: Node.js uses it again for each
    // subfolder, so a lock that does not end makes the wait much longer.
    const deadline = Date.now() + timeoutMs
    for (let delay = 100; ; delay = Math.min(2 * delay, 2000)) {
        try {
            await fs.promises.rm(target, { recursive: true, force: true })
            return
        } catch (e) {
            const code = (e as NodeJS.ErrnoException).code
            if (code === undefined || !RM_RETRY_CODES.has(code) || Date.now() + delay > deadline) {
                throw e
            }
        }
        await new Promise(resolve => setTimeout(resolve, delay))
    }
}
