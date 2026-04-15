// The sinon stubs of the helpers that replace a `window` function for the
// time of a test step (`prompts.ts`, `quickPicks.ts`, `dialogs.ts`).
//
// Mocha does not stop a test body that timed out. Thus the `finally` of such a
// helper restores its stubs only when the body ends, often during a later
// test. Until then, the next stub of the same function fails ("already
// wrapped"), and prompts of later tests get the answers of the old test. The
// root `afterEach` hook of `teardown.ts` restores the stubs that a test left.
//
// The restore function of `trackStubs` does nothing after the first call. A
// second `restore()` of a sinon stub puts back the function that it replaced,
// and thus would remove the stub of a later test.

const unrestored = new Set<() => void>()

// Returns a function that restores `stubs` one time.
export function trackStubs(stubs: { restore(): void }[]): () => void {
    let restored = false
    const restore = () => {
        if (restored) return
        restored = true
        unrestored.delete(restore)
        for (const stub of stubs) stub.restore()
    }
    unrestored.add(restore)
    return restore
}

// Restores the stubs that are not restored yet. Returns their number of
// `trackStubs` calls.
export function restoreLeftoverStubs(): number {
    const leftover = [...unrestored]
    for (const restore of leftover) restore()
    return leftover.length
}
