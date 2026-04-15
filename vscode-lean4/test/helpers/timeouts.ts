// Timeouts for the integration tests. They assume that the toolchain is
// installed (`scripts/testHome.mjs` installs it before the tests start). The
// network tests have their own, longer timeouts.

// For diagnostics after a file opens or the server restarts.
export const DIAGS_TIMEOUT_MS = 60_000
export const RESTART_DIAGS_TIMEOUT_MS = 60_000

// For an edit of the abbreviation rewriter. It normally takes some milliseconds.
export const ABBREVIATION_TIMEOUT_MS = 3000

// For a Lean client to start (`openAndAwaitClient`).
export const CLIENT_READY_MS = 60_000

// Polls `fn()` every 200 ms until it returns a value other than `undefined`,
// and returns that value. Fails after `timeoutMs`. A function `label` is
// called only on failure, so it can describe the last observed state.
export async function pollFor<T>(
    fn: () => T | undefined | Promise<T | undefined>,
    timeoutMs: number,
    label: string | (() => string),
): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const v = await withTimeout(Promise.resolve(fn()), Math.max(deadline - Date.now(), 0), label)
        if (v !== undefined) return v
        if (Date.now() >= deadline) break
        await new Promise(r => setTimeout(r, Math.min(200, Math.max(deadline - Date.now(), 0))))
    }
    const labelStr = typeof label === 'function' ? label() : label
    throw new Error(`timed out after ${timeoutMs}ms waiting for ${labelStr}`)
}

// Waits for `promise`, but fails after `timeoutMs`.
export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    label: string | (() => string),
): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const labelStr = typeof label === 'function' ? label() : label
            reject(new Error(`timed out after ${timeoutMs}ms waiting for ${labelStr}`))
        }, timeoutMs)
    })
    try {
        return await Promise.race([promise, timeout])
    } finally {
        clearTimeout(timer)
    }
}
