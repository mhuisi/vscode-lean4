/// <reference types="wdio-vscode-service" />
import { browser, expect } from '@wdio/globals'
import {
    collapseAllMessages,
    expandAllMessages,
    expectBodyStays,
    insertText,
    isInfoViewOpen,
    moveCursorTo,
    openFixtureFile,
    pinCurrentPosition,
    replaceLine,
    revertAllEditors,
    runCommand,
    waitForBody,
    waitForErrorCount,
    waitForInfoView,
    withInfoView,
} from '../helpers/wdio'

describe('InfoView', function () {
    // Fixture layout (0-indexed):
    //   5: `  rfl`  — goal `1 + 1 = 2`
    //   8: `  rfl`  — goal `2 + 2 = 4`

    // All tests use one VS Code. If a test fails, it can leave the file changed,
    // the InfoView closed, or a pinned or paused display, so clean up after each test.
    // The InfoView keeps "All Messages" open when the file changes, so close it too:
    // else the text of the InfoView contains all messages of the next file.
    afterEach(async () => {
        try {
            await revertAllEditors()
            await runCommand('notifications.clearAll')
            if (!(await isInfoViewOpen())) {
                await runCommand('lean4.toggleInfoview')
                await browser.waitUntil(isInfoViewOpen, { timeout: 30_000, interval: 500 })
            }
            await withInfoView(async () => {
                // Query again after each click: a click re-renders the InfoView,
                // so old element handles can be stale.
                const selectors = [
                    'a[data-id="toggle-paused"].codicon-debug-continue',
                    'a[data-id="toggle-pinned"].codicon-pinned',
                    'a[data-id="unpause-all-messages"]',
                ]
                for (const selector of selectors) {
                    for (let i = 0; i < 10 && (await browser.$(selector).isExisting()); i++) {
                        await browser.$(selector).click()
                    }
                }
                await collapseAllMessages()
            })
        } catch (e) {
            // Best-effort cleanup; must not hide the failure of the test.
            console.warn(`[wdio] cleanup after the test failed: ${e}`)
        }
    })

    it('renders the goal of the first theorem', async () => {
        await openFixtureFile('Main.lean')
        await moveCursorTo(5, 2)
        // The first test also waits for the server to start and to load `Init`.
        await waitForInfoView(t => t.includes('1 + 1 = 2'), { label: 'goal `1 + 1 = 2`', timeout: 2 * 60_000 })
    })

    it('updates the goal when the cursor moves to a different tactic position', async () => {
        await openFixtureFile('Main.lean')
        await moveCursorTo(5, 2)
        await waitForInfoView(t => t.includes('1 + 1 = 2'), {
            label: 'goal `1 + 1 = 2` rendered at starting cursor',
            timeout: 2 * 60_000,
        })

        // Move to the second `rfl`.
        await moveCursorTo(8, 2)
        await waitForInfoView(t => t.includes('2 + 2 = 4') && !t.includes('1 + 1 = 2'), {
            label: 'goal updated to `2 + 2 = 4`',
            timeout: 60_000,
        })

        // And back again.
        await moveCursorTo(5, 2)
        await waitForInfoView(t => t.includes('1 + 1 = 2') && !t.includes('2 + 2 = 4'), {
            label: 'goal updated back to `1 + 1 = 2`',
            timeout: 60_000,
        })
    })

    // Errors.lean layout (0-indexed):
    //   5: `  rfl`              — fails, because `1 + 1` is not definitionally equal to `3`
    //   7: `#check (1 + 1 : Nat)` — always emits info `1 + 1 : Nat`
    it('shows the error message when the cursor is on the failing tactic', async () => {
        await openFixtureFile('Errors.lean')
        await moveCursorTo(5, 2)
        // The goal `1 + 1 = 3` is visible without the message, so look for the
        // text of the error.
        await waitForInfoView(t => t.includes('is not definitionally equal to the right-hand side'), {
            label: 'error message of `rfl` visible',
            timeout: 2 * 60_000,
        })
    })

    it('shows the `#check` info message when the cursor is on the command', async () => {
        await openFixtureFile('Errors.lean')
        await moveCursorTo(7, 0)
        await waitForInfoView(t => /1 \+ 1 : Nat/.test(t), {
            label: '`1 + 1 : Nat` info message visible',
            timeout: 2 * 60_000,
        })
    })

    it('tracks the active editor when switching tabs', async () => {
        await openFixtureFile('Main.lean')
        await moveCursorTo(5, 2)
        await waitForInfoView(t => t.includes('1 + 1 = 2'), {
            label: 'Main.lean cursor goal rendered',
            timeout: 2 * 60_000,
        })

        await openFixtureFile('Errors.lean')
        await moveCursorTo(7, 0)
        await waitForInfoView(t => /1 \+ 1 : Nat/.test(t), {
            label: 'Errors.lean cursor info rendered',
            timeout: 2 * 60_000,
        })

        // Switch back to Main.lean — its cursor is still on line 5.
        await openFixtureFile('Main.lean')
        await waitForInfoView(t => t.includes('1 + 1 = 2') && !t.includes('1 + 1 = 3'), {
            label: 'InfoView switched back to Main.lean',
            timeout: 60_000,
        })

        // Switch back to Errors.lean, whose cursor is on the `#check` line.
        await openFixtureFile('Errors.lean')
        await waitForInfoView(t => /1 \+ 1 : Nat/.test(t) && !t.includes('1 + 1 = 2'), {
            label: 'InfoView switched back to Errors.lean',
            timeout: 60_000,
        })
    })

    it('can be closed and reopened via the toggle command', async () => {
        await openFixtureFile('Errors.lean')
        await moveCursorTo(7, 0)
        await waitForInfoView(t => /1 \+ 1 : Nat/.test(t), {
            label: 'InfoView shows `#check` info before toggle',
            timeout: 2 * 60_000,
        })

        await runCommand('lean4.toggleInfoview')
        await browser.waitUntil(async () => !(await isInfoViewOpen()), {
            timeout: 30_000,
            interval: 500,
            timeoutMsg: 'InfoView tab still present after toggle',
        })

        await runCommand('lean4.toggleInfoview')
        await browser.waitUntil(isInfoViewOpen, {
            timeout: 30_000,
            interval: 500,
            timeoutMsg: 'InfoView tab never reappeared after second toggle',
        })
        await waitForInfoView(t => /1 \+ 1 : Nat/.test(t), {
            label: 'InfoView restored after second toggle',
            timeout: 60_000,
        })
    })

    // Hover.lean layout (0-indexed):
    //   3: `example (n : Nat) : n + 0 = n := by`
    //   4: `  sorry`  — goal `n + 0 = n` with hoverable identifiers
    it('shows a popup when hovering an identifier in a goal, including nested hovers', async () => {
        await openFixtureFile('Hover.lean')
        await moveCursorTo(4, 2)

        await waitForInfoView(t => /n \+ 0 = n/.test(t), {
            label: 'goal `n + 0 = n` rendered',
            timeout: 2 * 60_000,
        })

        await withInfoView(async () => {
            // Tooltips have the class `tooltip`.
            const natTarget = await browser.$("//span[normalize-space(text())='Nat']")
            await natTarget.waitForExist({ timeout: 10_000 })
            await natTarget.moveTo()

            const firstTooltip = await browser.$('.tooltip')
            await firstTooltip.waitForExist({ timeout: 15_000 })
            await expect((await firstTooltip.getText()).length).toBeGreaterThan(0)

            // The `Nat` tooltip shows its signature, which contains the
            // identifier `Type`. Hover it to open a nested tooltip.
            const typeTarget = await browser.$(
                "//div[contains(@class,'tooltip')]//span[normalize-space(text())='Type']",
            )
            await typeTarget.waitForExist({ timeout: 10_000 })
            await typeTarget.moveTo()

            await browser.waitUntil(async () => (await browser.$$('.tooltip')).length >= 2, {
                timeout: 15_000,
                interval: 250,
                timeoutMsg: 'expected a nested tooltip to appear',
            })
        })
    })

    it('shows an "All Messages" panel listing every diagnostic in the file', async () => {
        await openFixtureFile('Errors.lean')
        // On line 0, there are no messages at the cursor, so the messages can
        // only come from "All Messages". It is closed by default.
        await moveCursorTo(0, 0)
        await waitForInfoView(() => true, { label: 'the InfoView' })
        await withInfoView(async () => {
            await expandAllMessages()
            await waitForBody(
                t => t.includes('is not definitionally equal') && /1 \+ 1 : Nat/.test(t),
                'both messages of Errors.lean in All Messages',
                3 * 60_000,
            )
        })
    })

    it('pausing "All Messages" freezes the list; unpausing updates it', async () => {
        await openFixtureFile('Errors.lean')
        await moveCursorTo(0, 0)
        await waitForInfoView(() => true, { label: 'the InfoView' })
        await withInfoView(async () => {
            await expandAllMessages()
            await waitForBody(t => t.includes('is not definitionally equal'), 'the error in All Messages', 3 * 60_000)
            const pauseBtn = await browser.$('a[data-id="pause-all-messages"]')
            await pauseBtn.waitForExist({ timeout: 10_000 })
            await pauseBtn.click()
            await browser.$('a[data-id="unpause-all-messages"]').waitForExist({ timeout: 10_000 })
        })

        // Fix the error. The InfoView gets the new diagnostics after VS Code, so
        // first wait until it shows the new goal at the cursor. Then the paused
        // list must keep the old error.
        await replaceLine(4, 'example : 1 + 1 = 2 := by')
        await waitForErrorCount('Errors.lean', 0)
        await moveCursorTo(5, 2)
        await waitForInfoView(t => t.includes('Errors.lean:6:2') && t.includes('1 + 1 = 2'), {
            label: 'the new goal at the cursor',
        })
        await withInfoView(async () => {
            await expectBodyStays(t => t.includes('is not definitionally equal'), 'the old error in the paused list')
            await browser.$('a[data-id="unpause-all-messages"]').click()
            await waitForBody(
                t => !t.includes('is not definitionally equal') && /1 \+ 1 : Nat/.test(t),
                'All Messages without the error, with the `#check` message',
            )
        })
    })

    it('pinning a goal keeps it visible after the cursor moves; unpinning removes it', async () => {
        await openFixtureFile('Main.lean')
        await moveCursorTo(5, 2)
        await waitForInfoView(t => t.includes('1 + 1 = 2'), {
            label: 'goal `1 + 1 = 2` rendered before pinning',
            timeout: 2 * 60_000,
        })

        await withInfoView(async () => {
            // The codicon class shows the state: `codicon-pin` (not pinned) or `codicon-pinned`.
            const pinBtn = await browser.$('a[data-id="toggle-pinned"].codicon-pin')
            await pinBtn.waitForExist({ timeout: 10_000 })
            await pinBtn.click()
            await browser.waitUntil(async () => (await browser.$('body').getText()).includes('(pinned)'), {
                timeout: 10_000,
                interval: 250,
                timeoutMsg: 'expected `(pinned)` label after pin click',
            })
        })

        await moveCursorTo(8, 2)
        // The pinned goal and the goal at the cursor.
        await waitForInfoView(t => t.includes('1 + 1 = 2') && t.includes('2 + 2 = 4'), {
            label: 'pinned and cursor goals both visible',
            timeout: 60_000,
        })

        await withInfoView(async () => {
            const unpinBtn = await browser.$('a[data-id="toggle-pinned"].codicon-pinned')
            await unpinBtn.waitForExist({ timeout: 10_000 })
            await unpinBtn.click()
        })

        await waitForInfoView(t => t.includes('2 + 2 = 4') && !t.includes('1 + 1 = 2') && !t.includes('(pinned)'), {
            label: 'pinned goal disappears after unpin',
            timeout: 60_000,
        })
    })

    it('pausing a goal freezes it; unpausing lets it track the cursor again', async () => {
        await openFixtureFile('Main.lean')
        await moveCursorTo(5, 2)
        await waitForInfoView(t => t.includes('1 + 1 = 2'), {
            label: 'goal `1 + 1 = 2` rendered before pausing',
            timeout: 2 * 60_000,
        })

        await withInfoView(async () => {
            const pauseBtn = await browser.$('a[data-id="toggle-paused"].codicon-debug-pause')
            await pauseBtn.waitForExist({ timeout: 10_000 })
            await pauseBtn.click()
            await browser.waitUntil(async () => (await browser.$('body').getText()).includes('(paused)'), {
                timeout: 10_000,
                interval: 250,
                timeoutMsg: 'expected `(paused)` label after pause click',
            })
        })

        // While the display is paused, the goal must not change for 2 s.
        await moveCursorTo(8, 2)
        await withInfoView(async () => {
            await expectBodyStays(
                t => t.includes('1 + 1 = 2') && !t.includes('2 + 2 = 4'),
                'the paused goal `1 + 1 = 2`',
            )

            const unpauseBtn = await browser.$('a[data-id="toggle-paused"].codicon-debug-continue')
            await unpauseBtn.waitForExist({ timeout: 10_000 })
            await unpauseBtn.click()
        })

        await waitForInfoView(t => t.includes('2 + 2 = 4') && !t.includes('(paused)'), {
            label: 'goal updates to `2 + 2 = 4` after unpause',
            timeout: 60_000,
        })
    })

    // Trace.lean layout (0-indexed):
    //   3: `set_option trace.Elab.step true in`
    //   4: `#check (0 : Nat)`  — produces a message containing trace data
    it('toggles the trace-search widget on a message that carries trace data', async () => {
        await openFixtureFile('Trace.lean')
        // On the `#check`, the message with the trace is a message at the cursor.
        await moveCursorTo(4, 0)

        await waitForInfoView(t => t.includes('[Elab.step]'), {
            label: 'the trace message at the cursor',
            timeout: 3 * 60_000,
        })

        await withInfoView(async () => {
            // The icon appears only if the server supports `highlightMatchesProvider`.
            const showSearch = await browser.$('a[data-id="show-trace-search"]')
            await showSearch.waitForExist({ timeout: 60_000 })
            await showSearch.click()

            const searchInput = await browser.$('.trace-search')
            await searchInput.waitForExist({ timeout: 10_000 })

            const hideSearch = await browser.$('a[data-id="hide-trace-search"]')
            await hideSearch.waitForExist({ timeout: 10_000 })
            // The icon is an empty `<a>` with a `::before` glyph, so a wdio click at its
            // center can hit another element. Thus click with JavaScript. `el` is `any`:
            // the test tsconfig has no `dom` library.
            await browser.execute((el: any) => el.click(), hideSearch)

            await browser.waitUntil(async () => !(await browser.$('.trace-search').isExisting()), {
                timeout: 10_000,
                interval: 250,
                timeoutMsg: 'trace-search widget still present after hide',
            })
        })
    })

    // GoToDef.lean layout (0-indexed):
    //   3: `def foo : Nat := 42`
    //   6: `  sorry`  — goal `foo = 42`
    it('jumps the editor to the definition when ctrl-clicking an identifier in a goal', async () => {
        await openFixtureFile('GoToDef.lean')
        await moveCursorTo(6, 2)

        await waitForInfoView(t => /foo\s*=\s*42/.test(t), {
            label: 'goal `foo = 42` rendered',
            timeout: 2 * 60_000,
        })

        await withInfoView(async () => {
            const fooSpan = await browser.$("//span[normalize-space(text())='foo']")
            await fooSpan.waitForExist({ timeout: 10_000 })

            await browser.performActions([
                {
                    type: 'key',
                    id: 'keyboard',
                    actions: [{ type: 'keyDown', value: '\uE009' }], // Control
                },
            ])
            try {
                await fooSpan.click()
            } finally {
                // Else Control stays pressed for the next tests.
                await browser.performActions([
                    {
                        type: 'key',
                        id: 'keyboard',
                        actions: [{ type: 'keyUp', value: '\uE009' }],
                    },
                ])
            }
        })

        // The language server finds the definition, so poll the cursor of the editor.
        await browser.waitUntil(
            async () => {
                const { path, line } = await browser.executeWorkbench(async vscode => {
                    const editor = vscode.window.activeTextEditor
                    return { path: editor?.document.uri.path ?? '', line: editor?.selection.active.line ?? -1 }
                })
                return path.endsWith('/GoToDef.lean') && line === 3
            },
            {
                timeout: 30_000,
                interval: 500,
                timeoutMsg: 'expected editor cursor to land on `def foo` (GoToDef.lean, line 3)',
            },
        )
    })

    // Crash.lean, zero-indexed line 3: `#eval "worker alive"`.
    it('reports a crashed worker and recovers after `lean4.restartFile`', async () => {
        await openFixtureFile('Crash.lean')
        await moveCursorTo(3, 0)
        await waitForInfoView(t => t.includes('"worker alive"'), { label: 'the `#eval` result', timeout: 2 * 60_000 })

        // The worker stops with the exit code 3. Lean reports all exit codes other
        // than 0, 1 and 2 as a crash (`workerCrashed`). A segmentation fault is not
        // reliable here: on Linux, a core dump can delay the end of the worker for a long time.
        // The InfoView shows the crash only when a request is pending at the time
        // of the crash. Lean keeps the requests for a crashed worker without an
        // answer until the worker restarts. Thus the `IO.sleep` delays the crash,
        // so that the request for the new cursor position is pending before the crash.
        await replaceLine(3, '#eval show IO Unit from do IO.sleep 3000; IO.Process.exit 3')
        // Move the cursor, as a user does when they type. The InfoView then asks
        // the server for the new position, and this request reports the crash.
        // Without the move, the InfoView shows the crash only if "All Messages" is open.
        await moveCursorTo(3, 1)
        await waitForInfoView(t => t.includes('The Lean Server has stopped processing this file'), {
            label: 'the message about the crashed worker',
        })

        await replaceLine(3, '#eval "worker alive"')
        await runCommand('lean4.restartFile')
        await waitForInfoView(t => t.includes('"worker alive"') && !t.includes('stopped processing'), {
            label: 'the `#eval` result after the restart',
        })
    })

    // Pin.lean, zero-indexed line 2: `#eval [1, 1+1, 1+1+1]`, line 3: `#eval "second"`.
    it('a pinned position survives edits above it and an undo', async () => {
        await openFixtureFile('Pin.lean')
        await moveCursorTo(2, 0)
        await waitForInfoView(t => t.includes('[1, 2, 3]'), { label: 'the `#eval` result', timeout: 2 * 60_000 })
        await pinCurrentPosition()

        // Two new lines above the pinned position. Then the cursor goes to the
        // second `#eval`, so that only the pin can show `[1, 2, 3]`. The InfoView
        // keeps the old text until it has the new state, so also wait for the
        // positions (one-indexed lines) in the headers of the pin and the cursor.
        await insertText(0, 0, '-- a\n-- b\n')
        await moveCursorTo(5, 0)
        await waitForInfoView(
            t =>
                t.includes('Pin.lean:5:0 (pinned)') &&
                t.includes('Pin.lean:6:0') &&
                t.includes('"second"') &&
                t.includes('[1, 2, 3]') &&
                !t.includes('Incorrect position'),
            { label: 'the pinned result after the edit' },
        )

        await runCommand('undo')
        await moveCursorTo(3, 0)
        await waitForInfoView(
            t =>
                t.includes('Pin.lean:3:0 (pinned)') &&
                t.includes('Pin.lean:4:0') &&
                t.includes('"second"') &&
                t.includes('[1, 2, 3]') &&
                !t.includes('Incorrect position'),
            { label: 'the pinned result after the undo' },
        )
    })

    it('a pinned position survives a switch to another file and back', async () => {
        await openFixtureFile('Pin.lean')
        await moveCursorTo(2, 0)
        await waitForInfoView(t => t.includes('[1, 2, 3]'), { label: 'the `#eval` result', timeout: 2 * 60_000 })
        await pinCurrentPosition()

        await openFixtureFile('Main.lean')
        await moveCursorTo(5, 2)
        await waitForInfoView(
            t => t.includes('Pin.lean:3:0 (pinned)') && t.includes('1 + 1 = 2') && t.includes('[1, 2, 3]'),
            { label: 'the pin of Pin.lean next to the goal of Main.lean' },
        )

        await runCommand('workbench.action.closeActiveEditor')
        // The focus does not go back to Pin.lean by itself. On the second
        // `#eval`, only the pin can show `[1, 2, 3]`.
        await openFixtureFile('Pin.lean')
        await moveCursorTo(3, 0)
        await waitForInfoView(
            t =>
                t.includes('Pin.lean:3:0 (pinned)') &&
                t.includes('Pin.lean:4:0') &&
                t.includes('"second"') &&
                t.includes('[1, 2, 3]') &&
                !t.includes('1 + 1 = 2'),
            { label: 'the pin after Main.lean is closed' },
        )
    })
})
