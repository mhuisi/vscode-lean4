import * as assert from 'node:assert'
import * as sinon from 'sinon'
import { QuickPick, QuickPickItem, QuickPickOptions, window } from 'vscode'
import { bodyFailure } from './prompts'
import { trackStubs } from './stubs'

// The toolchain pickers list all Lean versions, so stdout shows only the
// first and the last items. `log` has all items.
const LOG_HEAD_ITEMS = 5
const LOG_TAIL_ITEMS = 2
function formatLabelsForLog(labels: string[]): string {
    if (labels.length <= LOG_HEAD_ITEMS + LOG_TAIL_ITEMS + 1) {
        return `[${labels.join(' | ')}]`
    }
    const head = labels.slice(0, LOG_HEAD_ITEMS).join(' | ')
    const tail = labels.slice(-LOG_TAIL_ITEMS).join(' | ')
    const elided = labels.length - LOG_HEAD_ITEMS - LOG_TAIL_ITEMS
    return `[${head} | … (${elided} more) … | ${tail}]`
}

export interface QuickPickLog {
    title: string | undefined
    items: string[]
    chose: string | string[] | undefined
}

export type QuickPickAnswer =
    | string
    | RegExp
    | ((items: QuickPickItem[], options: QuickPickOptions | undefined) => QuickPickItem | QuickPickItem[] | undefined)

export interface CaptureQuickPicksOptions {
    /** When true, quick-picks that fire after the answer queue is empty are
     * dismissed. Default false: such a pick fails the test. Mirrors
     * `dismissRemaining` in `prompts.ts`. */
    dismissRemaining?: boolean
}

// Replaces `window.showQuickPick` with a stub that gives the scripted answers.
// Strings and RegExps match against `QuickPickItem.label`. With `canPickMany`,
// a RegExp selects all items that match, and the pick returns an array. A
// function answer that returns `undefined` dismisses the pick. Supports both
// VS Code overloads: `showQuickPick(string[], ...)` and
// `showQuickPick(QuickPickItem[], ...)`. Like in `prompts.ts`, problems go
// into `violations`, and `withQuickPicks` turns them into a test failure.
function captureQuickPicks(
    answers: QuickPickAnswer[],
    options: CaptureQuickPicksOptions,
): {
    log: QuickPickLog[]
    violations: string[]
    remainingAnswers: () => number
    restore: () => void
} {
    const { dismissRemaining = false } = options
    const log: QuickPickLog[] = []
    const violations: string[] = []
    const queue = [...answers]

    const stub = sinon.stub(window, 'showQuickPick').callsFake((async (itemsOrThenable: any, pickOptions?: any) => {
        const rawItems: (QuickPickItem | string)[] = (await itemsOrThenable) as (QuickPickItem | string)[]
        // For the overload with strings, use items with only a label, and
        // return strings at the end.
        const stringOverload = rawItems.length > 0 && typeof rawItems[0] === 'string'
        const items: QuickPickItem[] = stringOverload
            ? (rawItems as string[]).map(label => ({ label }))
            : (rawItems as QuickPickItem[])
        const labels = items.map(i => i.label)
        const description = `quick-pick ${JSON.stringify(pickOptions?.title ?? '')} ${formatLabelsForLog(labels)}`
        if (queue.length === 0 && !dismissRemaining) {
            violations.push(`unexpected ${description}: no answer is left in the queue`)
        }
        const next = queue.shift()

        let chosenItems: QuickPickItem | QuickPickItem[] | undefined
        if (typeof next === 'function') {
            // An error thrown here goes to the extension (see below). Thus an
            // error of the function, for example a failed `assert`, is a violation.
            try {
                chosenItems = next(items, pickOptions)
            } catch (e) {
                violations.push(`wrong answer for ${description}: the answer function failed: ${String(e)}`)
                chosenItems = undefined
            }
        } else if (next instanceof RegExp) {
            // Multiple selection: all items that match. Else: the first one.
            chosenItems = pickOptions?.canPickMany
                ? items.filter(i => next.test(i.label))
                : items.find(i => next.test(i.label))
        } else if (typeof next === 'string') chosenItems = items.find(i => i.label === next)

        const matchesNothing = Array.isArray(chosenItems) ? chosenItems.length === 0 : chosenItems === undefined
        if ((typeof next === 'string' || next instanceof RegExp) && matchesNothing) {
            violations.push(`wrong answer for ${description}: no item matches ${String(next)}`)
            chosenItems = undefined
        }

        if (pickOptions?.canPickMany && chosenItems !== undefined && !Array.isArray(chosenItems)) {
            chosenItems = [chosenItems]
        }
        // Without `canPickMany`, VS Code returns one item, never an array. The
        // stub dismisses the pick: an error thrown here goes to the extension,
        // which can ignore it.
        if (!pickOptions?.canPickMany && Array.isArray(chosenItems)) {
            violations.push(
                `wrong answer for ${description}: the answer gave ${chosenItems.length} items, ` +
                    `but the pick has no \`canPickMany\`: ${JSON.stringify(chosenItems.map(i => i.label))}`,
            )
            chosenItems = undefined
        }

        const chose = Array.isArray(chosenItems) ? chosenItems.map(i => i.label) : chosenItems?.label
        log.push({ title: pickOptions?.title, items: labels, chose })
        console.log(
            `[quickPick] ${JSON.stringify(pickOptions?.title ?? '')} ` +
                `${formatLabelsForLog(labels)} -> ${
                    Array.isArray(chose) ? `[${chose.join(' | ')}]` : (chose ?? '<dismissed>')
                }`,
        )
        if (stringOverload) {
            return Array.isArray(chosenItems) ? chosenItems.map(i => i.label) : (chosenItems?.label as any)
        }
        return chosenItems as any
    }) as any)

    return { log, violations, remainingAnswers: () => queue.length, restore: trackStubs([stub]) }
}

// Runs `body` with the stub of `captureQuickPicks`, and restores it. The call
// fails if a quick pick got no answer or a wrong answer, or if an answer is
// left over at the end of `body`.
export async function withQuickPicks<T>(
    answers: QuickPickAnswer[],
    body: (capture: { log: QuickPickLog[] }) => Promise<T>,
    options: CaptureQuickPicksOptions = {},
): Promise<T> {
    const capture = captureQuickPicks(answers, options)
    try {
        const result = await body(capture).catch(e => {
            throw bodyFailure('quick-pick script', capture.violations, e)
        })
        const remaining = capture.remainingAnswers()
        if (remaining > 0) {
            capture.violations.push(`${remaining} scripted answer(s) were not used`)
        }
        if (capture.violations.length > 0) {
            throw new Error(`quick-pick script failed:\n  ${capture.violations.join('\n  ')}`)
        }
        return result
    } finally {
        capture.restore()
    }
}

// Stubs `window.createQuickPick` for code that uses the stateful API (as
// opposed to the one-shot `showQuickPick`). Returns a fake pick whose `show()`
// picks the first item matching `selectLabel`, fires `onDidChangeActive` and
// `onDidChangeSelection` for that item, and then runs every registered
// `onDidAccept` handler. Call `accepted()` after the command under test: it
// resolves once all accept handlers settle, and it rejects at once if the
// command never called `show()`. Call `restore()` at the end, in a `finally`.
// The stub never fires `onDidChangeValue`, `onDidHide` and the button events.
export function stubStatefulQuickPick(selectLabel: string): {
    stub: sinon.SinonStub
    accepted: () => Promise<void>
    restore: () => void
} {
    let resolveAccept: () => void
    let rejectAccept: (e: unknown) => void
    const acceptedPromise = new Promise<void>((res, rej) => {
        resolveAccept = res
        rejectAccept = rej
    })
    let shown = false
    const accepted = () =>
        shown ? acceptedPromise : Promise.reject(new Error('the quick pick from `createQuickPick` was never shown'))
    const register =
        <T>(list: ((arg: T) => any)[]) =>
        (cb: (arg: T) => any) => {
            list.push(cb)
            return {
                dispose: () => {
                    const idx = list.indexOf(cb)
                    if (idx !== -1) list.splice(idx, 1)
                },
            }
        }
    const acceptCbs: (() => any)[] = []
    const selectionCbs: ((items: readonly QuickPickItem[]) => any)[] = []
    const activeCbs: ((items: readonly QuickPickItem[]) => any)[] = []
    const valueCbs: ((value: string) => any)[] = []
    const hideCbs: (() => any)[] = []
    const triggerButtonCbs: ((arg: any) => any)[] = []
    const triggerItemButtonCbs: ((arg: any) => any)[] = []
    const fakeQuickPick: any = {
        items: [] as readonly QuickPickItem[],
        selectedItems: [] as readonly QuickPickItem[],
        activeItems: [] as readonly QuickPickItem[],
        value: '',
        title: '',
        placeholder: '',
        ignoreFocusOut: false,
        matchOnDescription: false,
        matchOnDetail: false,
        onDidChangeValue: register(valueCbs),
        onDidAccept: register(acceptCbs),
        onDidHide: register(hideCbs),
        onDidChangeActive: register(activeCbs),
        onDidChangeSelection: register(selectionCbs),
        onDidTriggerButton: register(triggerButtonCbs),
        onDidTriggerItemButton: register(triggerItemButtonCbs),
        show() {
            shown = true
            // Select later: the extension can set `items` after `show()`.
            // As in VS Code, the change events come before the accept event.
            Promise.resolve()
                .then(() => {
                    const match = fakeQuickPick.items.find((i: QuickPickItem) => i.label === selectLabel)
                    assert.ok(match, `expected a quick-pick item labeled ${JSON.stringify(selectLabel)}`)
                    const selection: readonly QuickPickItem[] = [match]
                    fakeQuickPick.activeItems = selection
                    fakeQuickPick.selectedItems = selection
                })
                .then(() => Promise.all(activeCbs.map(cb => cb(fakeQuickPick.activeItems))))
                .then(() => Promise.all(selectionCbs.map(cb => cb(fakeQuickPick.selectedItems))))
                .then(() => Promise.all(acceptCbs.map(cb => cb())))
                .then(resolveAccept, rejectAccept)
        },
        hide: () => {},
        dispose: () => {},
    }
    const stub = sinon.stub(window, 'createQuickPick').returns(fakeQuickPick as unknown as QuickPick<QuickPickItem>)
    return { stub, accepted, restore: trackStubs([stub]) }
}
