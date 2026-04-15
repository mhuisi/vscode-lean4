import type { Context, Hook, Runnable, Suite } from 'mocha'
import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { DiagnosticSeverity, languages, window, workspace } from 'vscode'
import { activateExtension } from './activation'
import { closeAllEditors } from './editors'
import { getOutputChannelContents, startOutputChannelCapture } from './outputChannels'
import { restoreLeftoverStubs } from './stubs'

// The folder for the state dumps. `runCliTests.mjs` deletes it once per run,
// not for each file: each test file runs in its own VS Code. A run from the
// debug configuration keeps the dumps of the last runs.
// The path assumes that this file is `out/test/helpers/teardown.js`.
const EXPECTED_DIRNAME_SUFFIX = path.join('out', 'test', 'helpers')
assert.ok(
    __dirname.endsWith(EXPECTED_DIRNAME_SUFFIX),
    `teardown.ts loaded from ${__dirname}; expected a path ending in ${EXPECTED_DIRNAME_SUFFIX}. ` +
        'The OUTPUT_DIR `../../../` hop count below assumes that layout.',
)
const OUTPUT_DIR = path.resolve(__dirname, '../../../vscode-test-cli-output')
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

// If the test (or a `beforeEach` hook) failed, writes the text state of the
// workbench to `<test name>.json`: the diagnostics of all files, the editors,
// and the output channels.
export async function dumpStateIfFailed(ctx: Context): Promise<void> {
    const test = ctx.currentTest
    if (test?.state === 'failed') {
        writeStateDump(test)
    }
    // If a `beforeEach` hook failed, the test did not run and its state is
    // undefined. Dump the state for the failed hook instead.
    for (let suite = test?.parent; suite; suite = suite.parent) {
        dumpFailedHooks(suite)
    }
}

const dumpedHooks = new WeakSet<Hook>()

function dumpFailedHooks(suite: Suite) {
    // `_beforeAll` and `_beforeEach` are internal fields of mocha's `Suite`.
    const internal = suite as unknown as { _beforeAll: Hook[]; _beforeEach: Hook[] }
    for (const hook of [...internal._beforeAll, ...internal._beforeEach]) {
        if (hook.state === 'failed' && !dumpedHooks.has(hook)) {
            dumpedHooks.add(hook)
            writeStateDump(hook)
        }
    }
}

// mocha's reporters set `err` on failed tests and hooks.
function writeStateDump(test: Runnable & { err?: Error }) {
    const safe = `${test.parent?.title ?? ''} ${test.title}`
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase()
    const file = path.join(OUTPUT_DIR, `${safe}.json`)

    const allDiagnostics = languages.getDiagnostics().map(([uri, diags]) => ({
        uri: uri.toString(),
        diagnostics: diags.map(d => ({
            severity: DiagnosticSeverity[d.severity],
            message: d.message,
            range: [d.range.start, d.range.end],
            source: d.source,
        })),
    }))

    const active = window.activeTextEditor
    const dump = {
        test: {
            title: test.title,
            parent: test.parent?.title,
            error: test.err?.stack ?? test.err?.message,
        },
        diagnostics: allDiagnostics,
        activeEditor: active && {
            uri: active.document.uri.toString(),
            cursor: active.selection.active,
            text: active.document.getText(),
        },
        visibleEditors: window.visibleTextEditors.map(e => ({
            uri: e.document.uri.toString(),
            viewColumn: e.viewColumn,
            cursor: e.selection.active,
        })),
        openDocuments: workspace.textDocuments.map(d => ({
            uri: d.uri.toString(),
            languageId: d.languageId,
            isDirty: d.isDirty,
            lineCount: d.lineCount,
        })),
        outputChannels: getOutputChannelContents(),
    }

    try {
        fs.writeFileSync(file, JSON.stringify(dump, null, 2))
        console.log(`[state-dump] wrote ${file}`)
    } catch (e) {
        console.error(`[state-dump] failed to write ${file}: ${(e as Error).message}`)
    }
}

// Use as `afterEach(afterEachReset)`. It needs mocha's `this`, so it is not an arrow function.
export async function afterEachReset(this: Context): Promise<void> {
    await dumpStateIfFailed(this)
    await closeAllEditors()
}

// Every test file imports this module, so the hooks that follow are root hooks
// for every file. Capture output channels from the start, and make sure that
// the extension is active, so that its output channel is captured even in
// files that do not call `activateExtension` (the extension activates at
// startup anyway).
startOutputChannelCapture()
before(async function () {
    await activateExtension()
})
// After a timeout, the body of the test still runs, and its stubs are still
// active (`stubs.ts`). The root `afterEach` hook runs after the hooks of the
// suites, also in files that do not use `afterEachReset`.
afterEach(function () {
    const leftover = restoreLeftoverStubs()
    if (leftover > 0) {
        console.log(`[stubs] restored ${leftover} stub group(s) that the test did not restore`)
    }
})
// A failed `before` hook skips the `afterEach` hooks of its suite.
after(function () {
    const visit = (suite: Suite) => {
        dumpFailedHooks(suite)
        suite.suites.forEach(visit)
    }
    visit(this.test!.parent!)
})
