import * as sinon from 'sinon'
import { LogOutputChannel, OutputChannel, window } from 'vscode'

// The text that the extension wrote to each output channel, for the state dump
// of `teardown.ts`. The test output has all text (`record`). Thus the dump has
// only the last `CAPTURE_LIMIT` characters of each channel. Else the extension
// host keeps all text (for example the Mathlib build of the network tests),
// and each dump writes all of it again.
const CAPTURE_LIMIT = 1024 * 1024

// `removed` is the number of characters that we removed from the start of `text`.
type Capture = { text: string; removed: number }
const captured = new Map<string, Capture>()

let stub: sinon.SinonStub | undefined
const wrappedChannels = new WeakSet<object>()

function record(name: string, text: string): void {
    const capture = captured.get(name) ?? { text: '', removed: 0 }
    capture.text += text
    // We cut the text only when it has twice the limit, so that we do not copy
    // it at each write.
    if (capture.text.length > 2 * CAPTURE_LIMIT) {
        capture.removed += capture.text.length - CAPTURE_LIMIT
        capture.text = capture.text.slice(-CAPTURE_LIMIT)
    }
    captured.set(name, capture)
    const ensureTrailingNewline = text.endsWith('\n') ? '' : '\n'
    process.stdout.write(`[output:${name}] ${text}${ensureTrailingNewline}`)
}

// Wraps the writer methods of `channel` so that its writes (a) accumulate in
// `captured` and (b) stream to stdout. Idempotent per channel.
//
// `LogOutputChannel` (vscode 1.74+) extends `OutputChannel` with `info` /
// `warn` / `debug` / `trace` / `error` writers; we wrap those too.
export function captureOutputChannel(name: string, channel: OutputChannel): void {
    if (wrappedChannels.has(channel)) return
    wrappedChannels.add(channel)
    if (!captured.has(name)) captured.set(name, { text: '', removed: 0 })

    const wrapWriter = (method: string, framing: (text: string) => string) => {
        const origMethod = (channel as unknown as Record<string, unknown>)[method]
        if (typeof origMethod !== 'function') return
        ;(channel as unknown as Record<string, unknown>)[method] = function (...callArgs: unknown[]) {
            const text = String(callArgs[0] ?? '')
            record(name, framing(text))
            return (origMethod as (...args: unknown[]) => unknown).apply(channel, callArgs)
        }
    }
    // Manual enumeration of writer methods on `OutputChannel` and
    // `LogOutputChannel`. Add any new writer to this list when bumping
    // `@types/vscode`.
    wrapWriter('append', t => t)
    wrapWriter('appendLine', t => t + '\n')
    wrapWriter('replace', t => `[replace]\n${t}\n`)
    // The writers of `LogOutputChannel` format their own line with a level
    // prefix. We record only the text, so that the prefix does not occur two times.
    wrapWriter('trace', t => `[trace] ${t}\n`)
    wrapWriter('debug', t => `[debug] ${t}\n`)
    wrapWriter('info', t => `[info] ${t}\n`)
    wrapWriter('warn', t => `[warn] ${t}\n`)
    wrapWriter('error', t => `[error] ${t}\n`)
}

// Wraps `vscode.window.createOutputChannel` so that `captureOutputChannel`
// sees every channel that is created later. Idempotent. The extension can
// create its channel before this runs (it activates at startup), so
// `activateExtension` also captures the channel from the exports.
export function startOutputChannelCapture(): void {
    if (stub) return
    const orig = window.createOutputChannel.bind(window)
    const fake = ((name: string, optionsOrLanguage?: { readonly log: true } | string) => {
        const channel = (orig as (n: string, o?: unknown) => OutputChannel & Partial<LogOutputChannel>)(
            name,
            optionsOrLanguage,
        )
        captureOutputChannel(name, channel)
        return channel
    }) as typeof window.createOutputChannel
    stub = sinon.stub(window, 'createOutputChannel').callsFake(fake)
}

// The last `CAPTURE_LIMIT` characters of each channel since the start of the
// VS Code instance. One instance runs all files of a label of `.vscode-test.mjs`.
export function getOutputChannelContents(): Record<string, string> {
    return Object.fromEntries(
        [...captured].map(([name, { text, removed }]) => {
            const cut = Math.max(0, text.length - CAPTURE_LIMIT)
            const missing = removed + cut
            const tail = text.slice(cut)
            return [name, missing === 0 ? tail : `[${missing} older characters are only in the test output]\n${tail}`]
        }),
    )
}
