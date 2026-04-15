import * as assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { Diagnostic, Uri, languages, workspace } from 'vscode'
import { activateExtension } from '../helpers/activation'
import { clientForFolder } from '../helpers/client'
import { openInEditor } from '../helpers/editors'
import { FIXTURES } from '../helpers/fixtures'
import { waitForDiagnostics } from '../helpers/lsp'
import { withLinkedToolchain } from '../helpers/mockToolchain'
import { afterEachReset } from '../helpers/teardown'
import { DIAGS_TIMEOUT_MS } from '../helpers/timeouts'

// `.vscode-test.mjs` opens `multi-root/multi-root.code-workspace` for this file.
// Folder `a` uses the stable toolchain. Folder `b` uses `lean4-test-alt`, a link
// to the same toolchain under another name. Each `Main.lean` shows the value
// of `ELAN_TOOLCHAIN`, which elan sets to the name of the toolchain it runs.
const ROOT = path.join(FIXTURES, 'multi-root')
const ALT_TOOLCHAIN = 'lean4-test-alt'

function elanToolchainInfo(uri: Uri): string | undefined {
    return languages.getDiagnostics(uri).find(d => d.message.startsWith('some "'))?.message
}

describe('Multi-root workspace', function () {
    // The test waits two times for diagnostics.
    this.timeout(2 * DIAGS_TIMEOUT_MS + 60_000)

    before(activateExtension)

    afterEach(afterEachReset)

    it('starts one client per folder, each with the toolchain of its folder', async () => {
        assert.deepStrictEqual(
            workspace.workspaceFolders?.map(f => f.name),
            ['a', 'b'],
            'the multi-root workspace should be open',
        )
        // The toolchain folder that folder `a` uses.
        const target = execFileSync('lean', ['--print-prefix'], { cwd: path.join(ROOT, 'a'), env: process.env })
            .toString()
            .trim()
        await withLinkedToolchain(ALT_TOOLCHAIN, target, async () => {
            const a = Uri.file(path.join(ROOT, 'a', 'Main.lean'))
            const b = Uri.file(path.join(ROOT, 'b', 'Main.lean'))
            const hasToolchainInfo = (diags: Diagnostic[]) => diags.some(d => d.message.startsWith('some "'))
            await openInEditor(a)
            await waitForDiagnostics(a, hasToolchainInfo, DIAGS_TIMEOUT_MS, 'ELAN_TOOLCHAIN of a')
            await openInEditor(b)
            await waitForDiagnostics(b, hasToolchainInfo, DIAGS_TIMEOUT_MS, 'ELAN_TOOLCHAIN of b')

            assert.doesNotMatch(elanToolchainInfo(a) ?? '', new RegExp(ALT_TOOLCHAIN))
            assert.strictEqual(elanToolchainInfo(b), `some "${ALT_TOOLCHAIN}"`)

            assert.ok(await clientForFolder(path.join(ROOT, 'a')), 'folder a should have a client')
            assert.ok(await clientForFolder(path.join(ROOT, 'b')), 'folder b should have a client')
        })
    })
})
