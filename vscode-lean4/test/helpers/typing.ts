import { commands, TextDocument, workspace } from 'vscode'

// Types `text` one character at a time with the `type` command, like a user.
export async function typeChars(text: string): Promise<void> {
    for (const ch of text) {
        await commands.executeCommand('type', { text: ch })
        await new Promise(resolve => setImmediate(resolve))
    }
}

// Presses Backspace `count` times (`deleteLeft`).
export async function backspace(count: number = 1): Promise<void> {
    for (let i = 0; i < count; i++) {
        await commands.executeCommand('deleteLeft')
        await new Promise(resolve => setImmediate(resolve))
    }
}

// Waits until `predicate(document.getText())` holds, or throws after `timeoutMs`.
// Logs the observed text on each document change.
export async function waitForText(
    doc: TextDocument,
    predicate: (text: string) => boolean,
    timeoutMs = 2000,
    label = 'text',
): Promise<string> {
    return new Promise((resolve, reject) => {
        const check = () => {
            const text = doc.getText()
            if (predicate(text)) {
                sub.dispose()
                clearTimeout(timer)
                resolve(text)
                return true
            }
            return false
        }
        const sub = workspace.onDidChangeTextDocument(e => {
            if (e.document !== doc) return
            console.log(`[${label}] ${JSON.stringify(doc.getText())}`)
            check()
        })
        const timer = setTimeout(() => {
            sub.dispose()
            reject(
                new Error(`[${label}] timed out after ${timeoutMs}ms; last text was ${JSON.stringify(doc.getText())}`),
            )
        }, timeoutMs)
        check()
    })
}

// For tests that check that the rewriter does NOT change the text: the
// rewriter edits the document asynchronously after a change, so we wait until
// the text is `expected` and then check that it stays so for a moment.
export async function expectTextSettles(doc: TextDocument, expected: string, settleMs = 500): Promise<void> {
    await waitForText(doc, t => t === expected, settleMs, 'settle')
    await new Promise(resolve => setTimeout(resolve, settleMs))
    if (doc.getText() !== expected) {
        throw new Error(
            `expected the text to stay ${JSON.stringify(expected)}, but it is ${JSON.stringify(doc.getText())}`,
        )
    }
}
