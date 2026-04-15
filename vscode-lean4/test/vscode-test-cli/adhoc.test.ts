import * as assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Location, LocationLink, Uri, commands, workspace } from 'vscode'
import { activateExtension } from '../helpers/activation'
import { openInEditor, showInEditor } from '../helpers/editors'
import { assertNotInProject } from '../helpers/fixtures'
import { hasInfoIncluding, waitForDiagnostics } from '../helpers/lsp'
import { dismiss, withPrompts } from '../helpers/prompts'
import { afterEachReset } from '../helpers/teardown'
import { makeTestWorkDir } from '../helpers/testHome'
import { DIAGS_TIMEOUT_MS } from '../helpers/timeouts'

// `.vscode-test.mjs` opens no folder for this file (ad-hoc mode).

// Files outside a project show one of these warnings, some time after they open.
const singleFileWarnings = [
    dismiss(/^Lean 4 server is operating in restricted single file mode\./, { optional: true }),
    dismiss(/^Opened folder does not contain a valid Lean 4 project\./, { optional: true }),
]

// The folder name of the default toolchain, for example `leanprover--lean4---v4.35.0`.
// The test home has no `lean-toolchain` file, so `lean` uses the default toolchain there.
function defaultToolchainFolder(): string {
    const dir = makeTestWorkDir('default-toolchain-')
    return path.basename(execFileSync('lean', ['--print-prefix'], { cwd: dir, env: process.env }).toString().trim())
}

describe('Ad-hoc mode (no folder open)', function () {
    this.timeout(DIAGS_TIMEOUT_MS + 60_000)

    before(activateExtension)

    afterEach(afterEachReset)

    it('runs an untitled Lean document on the default toolchain', async () => {
        const expected = defaultToolchainFolder()
        await withPrompts(singleFileWarnings, async () => {
            const doc = await workspace.openTextDocument({ language: 'lean4', content: '#eval IO.appPath\n' })
            await showInEditor(doc)
            await waitForDiagnostics(doc.uri, hasInfoIncluding(expected), DIAGS_TIMEOUT_MS, 'IO.appPath (untitled)')
        })
    })

    it('runs a file outside of any project on the default toolchain', async () => {
        const expected = defaultToolchainFolder()
        const dir = makeTestWorkDir('detached-')
        assertNotInProject(dir)
        const file = path.join(dir, 'Detached.lean')
        fs.writeFileSync(file, '#eval IO.appPath\n')
        const uri = Uri.file(file)
        await withPrompts(singleFileWarnings, async () => {
            await openInEditor(uri)
            await waitForDiagnostics(uri, hasInfoIncluding(expected), DIAGS_TIMEOUT_MS, 'IO.appPath (detached)')
        })
    })

    it('goes to a definition in the sources of the toolchain', async () => {
        await withPrompts(singleFileWarnings, async () => {
            const doc = await workspace.openTextDocument({ language: 'lean4', content: '#check Lean.versionString\n' })
            await showInEditor(doc)
            await waitForDiagnostics(
                doc.uri,
                hasInfoIncluding('Lean.versionString : String'),
                DIAGS_TIMEOUT_MS,
                '#check',
            )
            const position = doc.positionAt(doc.getText().indexOf('versionString'))
            const locations =
                (await commands.executeCommand<(Location | LocationLink)[]>(
                    'vscode.executeDefinitionProvider',
                    doc.uri,
                    position,
                )) ?? []
            assert.strictEqual(locations.length, 1, 'expected one definition')
            const target = 'targetUri' in locations[0] ? locations[0].targetUri : locations[0].uri
            assert.match(target.fsPath.replaceAll('\\', '/'), /\/\.elan\/toolchains\/[^/]+\/src\/lean\//)
        })
    })
})
