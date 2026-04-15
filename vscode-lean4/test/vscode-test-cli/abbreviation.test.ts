import * as assert from 'node:assert'
import { commands, workspace } from 'vscode'
import { activateExtension } from '../helpers/activation'
import { showInEditor } from '../helpers/editors'
import { afterEachReset } from '../helpers/teardown'
import { ABBREVIATION_TIMEOUT_MS, pollFor } from '../helpers/timeouts'
import { backspace, expectTextSettles, typeChars, waitForText } from '../helpers/typing'

// The tests use untitled Lean documents and need no toolchain.
describe('Abbreviation feature', function () {
    this.timeout(10_000)

    before(activateExtension)

    afterEach(afterEachReset)

    it('replaces a typed abbreviation on the non-alphabetic terminator', async () => {
        const doc = await workspace.openTextDocument({ language: 'lean4' })
        await showInEditor(doc)
        // `\to` is also the start of longer abbreviations (`\top`), so only the
        // terminator can trigger the replacement.
        await typeChars('\\to')
        await expectTextSettles(doc, '\\to')
        await typeChars(' ')
        const text = await waitForText(doc, t => t === '→ ', ABBREVIATION_TIMEOUT_MS, 'to')
        assert.strictEqual(text, '→ ')
    })

    it('replaces via the explicit lean4.input.convert command', async () => {
        const doc = await workspace.openTextDocument({ language: 'lean4' })
        await showInEditor(doc)
        await typeChars('\\to')
        await commands.executeCommand('lean4.input.convert')
        const text = await waitForText(doc, t => t.includes('→'), ABBREVIATION_TIMEOUT_MS, 'to')
        assert.strictEqual(text, '→')
    })

    it('auto-closes delimiter abbreviations and places the cursor between them', async () => {
        // `\<>` becomes `⟨$CURSOR⟩`: the rewriter replaces it at once (it is the only
        // abbreviation with this prefix) and moves the cursor to `$CURSOR`. The cursor
        // moves after the edit event, so we poll for it.
        const doc = await workspace.openTextDocument({ language: 'lean4' })
        const editor = await showInEditor(doc)
        await typeChars('\\<>')
        const text = await waitForText(doc, t => t.includes('⟨'), ABBREVIATION_TIMEOUT_MS, 'auto-close')
        assert.strictEqual(text, '⟨⟩')
        await pollFor(
            () => (editor.selection.active.character === 1 ? true : undefined),
            ABBREVIATION_TIMEOUT_MS,
            () =>
                'cursor to settle between the brackets at column 1 ' +
                `(currently line ${editor.selection.active.line}, column ${editor.selection.active.character})`,
        )
        assert.strictEqual(editor.selection.active.line, 0)
    })

    // After the user deletes the leading `\`, the rewriter must not replace
    // the next text that the user types.
    it('cancels an in-progress abbreviation when the leading backslash is backspaced away', async () => {
        const doc = await workspace.openTextDocument({ language: 'lean4' })
        await showInEditor(doc)
        await typeChars('\\al')
        await backspace(3)
        await typeChars('alpha ')
        await expectTextSettles(doc, 'alpha ')
    })

    // No abbreviation starts with `$`, so the rewriter must not change the text.
    it('leaves a non-matching abbreviation literal in the buffer', async () => {
        const doc = await workspace.openTextDocument({ language: 'lean4' })
        await showInEditor(doc)
        const literal = '\\$nope '
        await typeChars(literal)
        await expectTextSettles(doc, literal)
    })
})
