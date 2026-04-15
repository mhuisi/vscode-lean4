import * as fs from 'node:fs'

// `fs.rmSync` with `recursive`, `force` and retries. On Windows, a file that
// a process just ran (for example `lean.exe`) stays locked for a short time,
// and deleting it fails with `EPERM`. The retries wait up to about 5 s.
// `scripts/*.mjs` cannot import this file, so `rmOptions` in
// `scripts/testHome.mjs` repeats the options.
export function rmSync(target: string, options?: fs.RmOptions): void {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100, ...options })
}

// Like `rmSync`, but asynchronous, and the retries wait up to about 30 s. Use it
// for a folder with programs that the extension can still run, for example a
// mock toolchain or ELAN_HOME. `rmSync` blocks the extension host while it
// waits, so the extension cannot process the end of these programs.
export async function rmAsync(target: string): Promise<void> {
    // Node.js waits `retryDelay` longer before each retry: 100 ms, 200 ms, ..., 2.4 s.
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 24, retryDelay: 100 })
}
