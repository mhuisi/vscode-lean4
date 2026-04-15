import * as assert from 'node:assert'
import * as path from 'node:path'
import { Uri, languages, workspace } from 'vscode'
import { activateExtension } from '../helpers/activation'
import { clientForFolder } from '../helpers/client'
import { openInEditor, showInEditor } from '../helpers/editors'
import { FIXTURES, assertNotInProject } from '../helpers/fixtures'
import { hasError, hasErrorIncluding, hasInfoIncluding, waitForDiagnostics } from '../helpers/lsp'
import { afterEachReset } from '../helpers/teardown'
import { DIAGS_TIMEOUT_MS } from '../helpers/timeouts'

describe('Language server — launch modes', function () {
    // Some tests wait two times for diagnostics.
    this.timeout(2 * DIAGS_TIMEOUT_MS + 60_000)

    before(activateExtension)

    afterEach(afterEachReset)

    it('serves two files from separate projects with independent diagnostics', async () => {
        const a = Uri.file(path.join(FIXTURES, 'lean-project', 'Main.lean'))
        const b = Uri.file(path.join(FIXTURES, 'lean-project-b', 'Main.lean'))

        // The two files have different errors.
        const errorOfA = hasErrorIncluding('"not a Nat"')
        const errorOfB = hasErrorIncluding('OfNat Bool 42')
        await openInEditor(a)
        await waitForDiagnostics(a, errorOfA, DIAGS_TIMEOUT_MS, 'project-a')
        await openInEditor(b)
        await waitForDiagnostics(b, errorOfB, DIAGS_TIMEOUT_MS, 'project-b')
        // The server of B must not have cleared or changed the diagnostics of A.
        assert.ok(errorOfA(languages.getDiagnostics(a)), 'the diagnostics of project A should still have its error')

        // One client per project folder.
        assert.ok(await clientForFolder(path.join(FIXTURES, 'lean-project')), 'a client should exist for project A')
        assert.ok(await clientForFolder(path.join(FIXTURES, 'lean-project-b')), 'a client should exist for project B')
    })

    it('uses the inner project when a file lives inside a nested project', async () => {
        const outer = Uri.file(path.join(FIXTURES, 'nested-project', 'Main.lean'))
        const inner = Uri.file(path.join(FIXTURES, 'nested-project', 'inner', 'Inner.lean'))

        await openInEditor(outer)
        await waitForDiagnostics(outer, hasErrorIncluding('"outer error"'), DIAGS_TIMEOUT_MS, 'nested-outer')
        await openInEditor(inner)
        // `Inner.lean` shows the name of the working folder of the server that
        // elaborates it. The server of the outer project runs already, so if it
        // also elaborated the file, its message would come first.
        const diags = await waitForDiagnostics(inner, hasInfoIncluding('"inner"'), DIAGS_TIMEOUT_MS, 'nested-inner')
        assert.deepStrictEqual(
            diags.map(d => d.message),
            ['"inner"'],
            'only the server of the inner project should elaborate Inner.lean',
        )

        // The extension starts a client for the inner folder only if it finds
        // that the inner file belongs to the inner project.
        const outerFolder = path.join(FIXTURES, 'nested-project')
        assert.ok(await clientForFolder(outerFolder), 'a client should exist for the outer project')
        assert.ok(await clientForFolder(path.join(outerFolder, 'inner')), 'a client should exist for the inner project')
    })

    it('launches a server for an untitled Lean document', async () => {
        const doc = await workspace.openTextDocument({
            language: 'lean4',
            content: 'example : Nat := "untitled error"\n',
        })
        await showInEditor(doc)
        const diags = await waitForDiagnostics(doc.uri, hasError, DIAGS_TIMEOUT_MS, 'untitled')
        assert.ok(hasError(diags))
    })

    it('launches a server for a detached on-disk file without an enclosing project', async () => {
        assertNotInProject(path.join(FIXTURES, 'detached'))
        const uri = Uri.file(path.join(FIXTURES, 'detached', 'Standalone.lean'))
        await openInEditor(uri)
        const diags = await waitForDiagnostics(uri, hasError, DIAGS_TIMEOUT_MS, 'detached')
        assert.ok(hasError(diags))
    })
})
