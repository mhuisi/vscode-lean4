import * as sinon from 'sinon'
import { window } from 'vscode'
import { trackStubs } from './stubs'
import { pollFor } from './timeouts'

// A rule from `choose` or `dismiss`: it answers the prompt whose message
// matches `message`.
export interface PromptRule {
    kind: 'rule'
    message: RegExp
    button: string | undefined
    optional: boolean
}

// A scripted answer:
// - A `PromptRule` answers a prompt whose message matches. Rules can match
//   prompts in any order. This is the best form.
// - A string or RegExp selects the button with that label. A function gets the
//   message and the button labels, and returns the label of a button or
//   `undefined` to dismiss. These answers are used in order, for prompts that
//   no rule matches.
export type Answer = PromptRule | string | RegExp | ((message: string, items: string[]) => string | undefined)

export interface PromptLog {
    kind: 'info' | 'warn' | 'error'
    message: string
    items: string[]
    chose: string | undefined
}

export interface CaptureOptions {
    /** When true, prompts that no answer matches are dismissed. Default
     * false: such a prompt fails the test, so that a new notification does
     * not go unnoticed. */
    dismissRemaining?: boolean
}

// Answers the prompt whose message matches `message` with `button`.
export function choose(message: RegExp, button: string): PromptRule {
    return { kind: 'rule', message, button, optional: false }
}

// Dismisses the prompt whose message matches `message`. With `optional`, the
// prompt does not have to appear, and it can appear more than one time. This
// is for prompts that come from a background event: such a prompt can come
// after the test, or again for the next event (for example, two events of a
// file watcher for one write).
export function dismiss(message: RegExp, { optional = false }: { optional?: boolean } = {}): PromptRule {
    return { kind: 'rule', message, button: undefined, optional }
}

function isRule(answer: Answer): answer is PromptRule {
    return typeof answer === 'object' && !(answer instanceof RegExp)
}

// Replaces `window.show{Information,Warning,Error}Message` with stubs that give
// the scripted answers, and writes each prompt to stdout.
//
// Most notifications of the extension are not awaited, so the stubs cannot
// fail the test by throwing. Instead, they dismiss the prompt and record the
// problem in `violations`. `withPrompts` turns them into a test failure.
function capturePrompts(
    answers: Answer[],
    options: CaptureOptions,
): { log: PromptLog[]; violations: string[]; unusedAnswers: () => Answer[]; restore: () => void } {
    const { dismissRemaining = false } = options
    const log: PromptLog[] = []
    const violations: string[] = []
    const unused = [...answers]
    // The optional rules that answered a prompt. They can answer more prompts.
    const usedOptional: PromptRule[] = []

    // An unused rule comes first, so that an optional rule does not take the
    // prompts of a later rule with the same message. Then a used optional
    // rule, and last an answer for prompts that no rule matches.
    const take = (message: string): Answer | undefined => {
        const ruleIndex = unused.findIndex(a => isRule(a) && a.message.test(message))
        if (ruleIndex !== -1) {
            const rule = unused.splice(ruleIndex, 1)[0] as PromptRule
            if (rule.optional) usedOptional.push(rule)
            return rule
        }
        const again = usedOptional.find(rule => rule.message.test(message))
        if (again !== undefined) return again
        const i = unused.findIndex(a => !isRule(a))
        return i === -1 ? undefined : unused.splice(i, 1)[0]
    }

    const apply = (answer: Answer, message: string, items: string[]): string | undefined => {
        if (isRule(answer)) return answer.button
        if (typeof answer === 'function') return answer(message, items)
        if (answer instanceof RegExp) {
            const match = items.find(i => answer.test(i))
            if (match === undefined) throw new Error(`no button matches ${answer}`)
            return match
        }
        return answer
    }

    const resolve = (kind: PromptLog['kind'], message: string, rest: unknown[]) => {
        // Callers pass either `showXMessage(msg, ...strings)` or
        // `showXMessage(msg, options, ...MessageItems)`. MessageItems are
        // objects with a `.title` field.
        const messageItems = rest.filter(
            (r): r is { title: string } =>
                typeof r === 'object' && r !== null && typeof (r as { title?: unknown }).title === 'string',
        )
        const stringItems = rest.filter((r): r is string => typeof r === 'string')
        const items: string[] = messageItems.length > 0 ? messageItems.map(m => m.title) : stringItems
        const description = `${kind} prompt ${JSON.stringify(message)} [${items.join(' | ')}]`

        let chose: string | undefined
        const answer = take(message)
        if (answer === undefined) {
            if (!dismissRemaining) {
                violations.push(`unexpected ${description}: no answer matches it`)
            }
        } else {
            try {
                chose = apply(answer, message, items)
                if (chose !== undefined && !items.includes(chose)) {
                    throw new Error(`the answer ${JSON.stringify(chose)} is not a button`)
                }
            } catch (e) {
                violations.push(`wrong answer for ${description}: ${(e as Error).message}`)
                chose = undefined
            }
        }

        log.push({ kind, message, items, chose })
        console.log(`[prompt ${kind}] ${JSON.stringify(message)} [${items.join(' | ')}] -> ${chose ?? '<dismissed>'}`)
        if (chose !== undefined && messageItems.length > 0) {
            return Promise.resolve(messageItems.find(m => m.title === chose))
        }
        return Promise.resolve(chose)
    }

    const stubs = [
        sinon
            .stub(window, 'showInformationMessage')
            .callsFake(((m: string, ...rest: unknown[]) => resolve('info', m, rest)) as any),
        sinon
            .stub(window, 'showWarningMessage')
            .callsFake(((m: string, ...rest: unknown[]) => resolve('warn', m, rest)) as any),
        sinon
            .stub(window, 'showErrorMessage')
            .callsFake(((m: string, ...rest: unknown[]) => resolve('error', m, rest)) as any),
    ]

    return {
        log,
        violations,
        unusedAnswers: () => unused,
        restore: trackStubs(stubs),
    }
}

// Poll a prompt log until a prompt matching `predicate` appears, or
// `timeoutMs` elapses. The failure message includes every captured prompt so
// you can tell at a glance whether the prompt never fired, fired with the
// wrong content, or fired after the deadline.
export async function waitForPrompt(
    log: PromptLog[],
    predicate: (entry: PromptLog) => boolean,
    timeoutMs: number,
    label: string,
): Promise<PromptLog> {
    return pollFor(
        () => log.find(predicate),
        timeoutMs,
        () => `prompt (${label}); captured prompts:\n` + log.map(p => `  [${p.kind}] ${p.message}`).join('\n'),
    )
}

// The error for a `body` that failed after a violation. The violation is
// often the cause (for example, the stub dismissed a prompt whose text
// changed), so the error names the violations before the error of `body`.
export function bodyFailure(script: string, violations: string[], e: unknown): unknown {
    if (violations.length === 0) return e
    const bodyError = e instanceof Error ? (e.stack ?? e.message) : String(e)
    return new Error(`${script} failed:\n  ${violations.join('\n  ')}\nThen the body failed:\n${bodyError}`)
}

// Runs `body` with the prompt stubs of `capturePrompts`, and restores them.
// The call fails if a prompt got no answer or a wrong answer, or if an answer
// is left over at the end of `body`.
export async function withPrompts<T>(
    answers: Answer[],
    body: (capture: { log: PromptLog[] }) => Promise<T>,
    options: CaptureOptions = {},
): Promise<T> {
    const capture = capturePrompts(answers, options)
    try {
        const result = await body(capture).catch(e => {
            throw bodyFailure('prompt script', capture.violations, e)
        })
        for (const answer of capture.unusedAnswers()) {
            if (!(isRule(answer) && answer.optional)) {
                capture.violations.push(`no prompt used the answer ${isRule(answer) ? answer.message : String(answer)}`)
            }
        }
        if (capture.violations.length > 0) {
            throw new Error(`prompt script failed:\n  ${capture.violations.join('\n  ')}`)
        }
        return result
    } finally {
        capture.restore()
    }
}
