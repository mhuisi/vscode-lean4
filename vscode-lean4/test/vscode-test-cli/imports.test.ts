import * as assert from 'node:assert'
import * as path from 'node:path'
import { Location, LocationLink, Uri, commands, workspace } from 'vscode'
import { activateExtension } from '../helpers/activation'
import { openAndAwaitClient } from '../helpers/client'
import { scaffoldFromFixture } from '../helpers/fixtures'
import { lake } from '../helpers/lake'
import { hasInfoIncluding, waitForDiagnostics } from '../helpers/lsp'
import { afterEachReset } from '../helpers/teardown'
import { CLIENT_READY_MS, DIAGS_TIMEOUT_MS } from '../helpers/timeouts'

// `lakefile-lean-project` has a `lakefile.lean`, and its `Main.lean` imports
// `Pkg.Greeting` from the same package. The server does not build imports, so
// we build the package first. The import resolves only if the server runs in
// the root folder of the package.
describe('Imports in a lakefile.lean project', function () {
    this.timeout(CLIENT_READY_MS + 2 * DIAGS_TIMEOUT_MS)

    let main: Uri

    before(async function () {
        await activateExtension()
        const projectDir = scaffoldFromFixture('lakefile-lean-project', 'lakefile-lean-')
        await lake(projectDir, ['build'], CLIENT_READY_MS)
        main = Uri.file(path.join(projectDir, 'Main.lean'))
    })

    afterEach(afterEachReset)

    it('elaborates a file that imports a module of the same package', async () => {
        await openAndAwaitClient(main, CLIENT_READY_MS)
        await waitForDiagnostics(main, hasInfoIncluding('"hello from Pkg"'), DIAGS_TIMEOUT_MS, '#eval Pkg.greeting')
    })

    it('goes to the definition of an imported declaration', async () => {
        await openAndAwaitClient(main, CLIENT_READY_MS)
        await waitForDiagnostics(main, hasInfoIncluding('"hello from Pkg"'), DIAGS_TIMEOUT_MS, '#eval Pkg.greeting')
        const doc = await workspace.openTextDocument(main)
        const position = doc.positionAt(doc.getText().indexOf('Pkg.greeting') + 'Pkg.'.length)
        const locations =
            (await commands.executeCommand<(Location | LocationLink)[]>(
                'vscode.executeDefinitionProvider',
                main,
                position,
            )) ?? []
        assert.strictEqual(locations.length, 1, 'expected one definition')
        const target = 'targetUri' in locations[0] ? locations[0].targetUri : locations[0].uri
        assert.strictEqual(path.relative(path.dirname(main.fsPath), target.fsPath), path.join('Pkg', 'Greeting.lean'))
    })
})
