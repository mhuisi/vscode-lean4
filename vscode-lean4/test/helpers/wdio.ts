/// <reference types="wdio-vscode-service" />
import { browser } from '@wdio/globals'
import { DIAGS_TIMEOUT_MS } from './timeouts'

// The `<title>` of the InfoView webview (`src/infoview.ts`).
const INFOVIEW_TITLE = 'InfoView'

// Opens the frame of the InfoView webview. The caller must `close()` it before
// it uses the workbench again. `browser.getTitle()` gives the title of the
// top frame, so we read the `<title>` element.
async function findInfoView(): Promise<{ close: () => Promise<void> }> {
    // A failed `view.open()` can leave the driver inside a frame, and then
    // `getAllWebviews` finds nothing. Thus always start at the top frame.
    await browser.switchToFrame(null)
    const workbench = await browser.getWorkbench()
    const failures: string[] = []
    for (const view of await workbench.getAllWebviews()) {
        let title: string
        try {
            await view.open()
            title = (await browser.$('title').getHTML(false)).trim()
        } catch (e) {
            // Another webview can have no `<title>` (for example the manual
            // view), so we continue with the next webview.
            failures.push(String(e))
            await browser.switchToFrame(null)
            continue
        }
        if (title === INFOVIEW_TITLE) {
            return { close: () => view.close() }
        }
        await view.close()
    }
    throw new Error(
        `InfoView webview not found (no webview reported a document title of ${JSON.stringify(INFOVIEW_TITLE)})` +
            failures.map(f => `\n  could not read a webview: ${f}`).join(''),
    )
}

// Opens `fileName` of the workspace folder in the first editor group (else it
// can open in the group of the InfoView). Not as a preview tab: the next file
// would replace a preview tab, and then a test that switches between files
// would close and open them again.
export async function openFixtureFile(fileName: string): Promise<void> {
    await browser.executeWorkbench(async (vscode, fileName: string) => {
        const [folder] = vscode.workspace.workspaceFolders ?? []
        const uri = vscode.Uri.joinPath(folder.uri, fileName)
        const doc = await vscode.workspace.openTextDocument(uri)
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false })
    }, fileName)
}

// `line` and `column` are zero-indexed.
export async function moveCursorTo(line: number, column: number): Promise<void> {
    await browser.executeWorkbench(
        async (vscode, line: number, column: number) => {
            const editor = vscode.window.activeTextEditor
            if (!editor) throw new Error('no active editor')
            const pos = new vscode.Position(line, column)
            editor.selection = new vscode.Selection(pos, pos)
            editor.revealRange(new vscode.Range(pos, pos))
        },
        line,
        column,
    )
}

// Reverts the changes in all files. VS Code has no command for this, so we
// revert the files one at a time in the active editor.
export async function revertAllEditors(): Promise<void> {
    await browser.executeWorkbench(async vscode => {
        for (const doc of vscode.workspace.textDocuments) {
            if (!doc.isDirty || doc.isUntitled) continue
            await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One })
            await vscode.commands.executeCommand('workbench.action.files.revert')
        }
    })
}

export async function runCommand(id: string): Promise<void> {
    await browser.executeWorkbench(async (vscode, id: string) => {
        await vscode.commands.executeCommand(id)
    }, id)
}

// Polls the text of the InfoView until `predicate` holds.
export async function waitForInfoView(
    predicate: (text: string) => boolean,
    { label, timeout = DIAGS_TIMEOUT_MS }: { label: string; timeout?: number },
): Promise<void> {
    // The last text of the InfoView, or the last error, for the message of a timeout.
    let last = '<none>'
    try {
        await browser.waitUntil(
            async () => {
                let close: (() => Promise<void>) | undefined
                try {
                    ;({ close } = await findInfoView())
                    const text = await browser.$('body').getText()
                    last = `text of the InfoView:\n${text}`
                    return predicate(text)
                } catch (e) {
                    // The InfoView is not open yet.
                    last = `error: ${e}`
                    return false
                } finally {
                    if (close) await close()
                }
            },
            { timeout, interval: 1000 },
        )
    } catch (e) {
        // `timeoutMsg` is a string that wdio reads before the wait, so it cannot contain `last`.
        throw new Error(`timed out waiting for InfoView: ${label}: ${e}\nThe last ${last}`)
    }
}

// Whether a tab shows the InfoView (view type `lean4_infoview`, with a prefix
// from VS Code). The tab API also works before the webview has content.
export async function isInfoViewOpen(): Promise<boolean> {
    return browser.executeWorkbench(async vscode => {
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('lean4_infoview')) {
                    return true
                }
            }
        }
        return false
    })
}

// Runs `fn` in the frame of the InfoView. Fails if the InfoView is not open:
// if it can still be opening, call `waitForInfoView` first.
export async function withInfoView<T>(fn: () => Promise<T>): Promise<T> {
    const { close } = await findInfoView()
    try {
        return await fn()
    } finally {
        await close()
        // A click in the webview moves the focus to it. Without an active
        // editor, `moveCursorTo` fails.
        await browser.executeWorkbench(async vscode => {
            await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup')
        })
    }
}

// Inside `withInfoView`: polls the text of the InfoView.
export async function waitForBody(
    predicate: (text: string) => boolean,
    label: string,
    timeout = DIAGS_TIMEOUT_MS,
): Promise<void> {
    await browser.waitUntil(async () => predicate(await browser.$('body').getText()), {
        timeout,
        interval: 250,
        timeoutMsg: `timed out waiting for ${label}`,
    })
}

// Inside `withInfoView`: fails if `predicate` does not hold for the text of
// the InfoView at any time during `durationMs`. For a display that must not change.
export async function expectBodyStays(
    predicate: (text: string) => boolean,
    label: string,
    durationMs = 2000,
): Promise<void> {
    const deadline = Date.now() + durationMs
    for (;;) {
        const text = await browser.$('body').getText()
        if (!predicate(text)) {
            throw new Error(`expected ${label} for ${durationMs} ms, but the InfoView changed to:\n${text}`)
        }
        if (Date.now() >= deadline) return
        await browser.pause(200)
    }
}

const ALL_MESSAGES_XPATH = "//details[.//summary[contains(., 'All Messages')]]"

// Inside `withInfoView`: opens the "All Messages" section if it is closed.
export async function expandAllMessages(): Promise<void> {
    const details = await browser.$(ALL_MESSAGES_XPATH)
    await details.waitForExist({ timeout: DIAGS_TIMEOUT_MS })
    if ((await details.getAttribute('open')) === null) {
        await details.$('summary').click()
    }
}

// Inside `withInfoView`: closes the "All Messages" section if it is open. The
// InfoView keeps the section open when the file changes, and then the text of
// the InfoView contains all messages of the file.
export async function collapseAllMessages(): Promise<void> {
    const details = await browser.$(ALL_MESSAGES_XPATH)
    if ((await details.isExisting()) && (await details.getAttribute('open')) !== null) {
        await details.$('summary').click()
    }
}

// Replaces line `line` (zero-indexed) of the active editor with `text`.
export async function replaceLine(line: number, text: string): Promise<void> {
    await browser.executeWorkbench(
        async (vscode, line: number, text: string) => {
            const editor = vscode.window.activeTextEditor
            if (!editor) throw new Error('no active editor')
            await editor.edit((b: { replace(range: unknown, text: string): void }) =>
                b.replace(editor.document.lineAt(line).range, text),
            )
        },
        line,
        text,
    )
}

// Waits until `fileName` in the workspace folder has `count` error diagnostics.
export async function waitForErrorCount(fileName: string, count: number): Promise<void> {
    let last: number | undefined
    try {
        await browser.waitUntil(
            async () => {
                last = await browser.executeWorkbench(async (vscode, fileName: string) => {
                    const [folder] = vscode.workspace.workspaceFolders ?? []
                    const uri = vscode.Uri.joinPath(folder.uri, fileName)
                    return vscode.languages
                        .getDiagnostics(uri)
                        .filter((d: { severity: number }) => d.severity === vscode.DiagnosticSeverity.Error).length
                }, fileName)
                return last === count
            },
            { timeout: DIAGS_TIMEOUT_MS, interval: 500 },
        )
    } catch (e) {
        // `timeoutMsg` is a string that wdio reads before the wait, so it cannot contain `last`.
        throw new Error(`expected ${count} errors in ${fileName}; the last count was ${last ?? '<none>'}: ${e}`)
    }
}

// Inserts `text` at `line` and `column` (zero-indexed) of the active editor.
export async function insertText(line: number, column: number, text: string): Promise<void> {
    await browser.executeWorkbench(
        async (vscode, line: number, column: number, text: string) => {
            const editor = vscode.window.activeTextEditor
            if (!editor) throw new Error('no active editor')
            await editor.edit((b: { insert(position: unknown, text: string): void }) =>
                b.insert(new vscode.Position(line, column), text),
            )
        },
        line,
        column,
        text,
    )
}

// Pins the InfoView state at the cursor.
export async function pinCurrentPosition(): Promise<void> {
    await withInfoView(async () => {
        const pinBtn = await browser.$('a[data-id="toggle-pinned"].codicon-pin')
        await pinBtn.waitForExist({ timeout: 10_000 })
        await pinBtn.click()
        await waitForBody(t => t.includes('(pinned)'), '`(pinned)` label after the pin click', 10_000)
    })
}
