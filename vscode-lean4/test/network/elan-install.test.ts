import * as assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { commands } from 'vscode'
import { elanDefaultToolchain } from '../helpers/elan'
import { rmAsync } from '../helpers/fs'
import { choose, dismiss, withPrompts } from '../helpers/prompts'
import { afterEachReset } from '../helpers/teardown'
import { requireIsolatedTestHome } from '../helpers/testHome'
import { removeTestElanFromWindowsUserPath } from '../helpers/windowsUserPath'

// The elan installer puts elan into `<ELAN_HOME>/bin`, but it does not change
// the PATH of this process. Thus we prepend that folder to PATH, so that the
// extension and the tests find the new elan. All network files run in the same
// process, and this file runs first (`scripts/cliTestNames.mjs`), so the other files
// also use this elan.
if (process.env.ELAN_HOME) {
    process.env.PATH = `${path.join(process.env.ELAN_HOME, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`
}

describe('Elan installation (real network)', function () {
    this.timeout(10 * 60_000)

    let elanHome: string

    before(async function () {
        // We delete ELAN_HOME, so it must be in the isolated test home.
        ;({ elanHome } = requireIsolatedTestHome({ requireElanHome: true }))
        // The extension just activated, and it can still run an `elan` command.
        await rmAsync(elanHome)
    })

    // The installer adds the test home to the PATH of the user in the registry
    // (`windowsUserPath.ts`).
    after(function () {
        if (process.platform === 'win32') {
            removeTestElanFromWindowsUserPath()
        }
    })

    afterEach(afterEachReset)

    it('installs Elan when the user accepts the install prompt', async () => {
        await withPrompts(
            [
                choose(/^This command will install Lean's version manager Elan\./, 'Install Elan'),
                // Choosing an answer here would write a global VS Code setting.
                dismiss(/^Lean installation successful!/),
            ],
            async () => {
                await commands.executeCommand('lean4.setup.installElan')
            },
        )

        const elanBin = path.join(elanHome, 'bin', process.platform === 'win32' ? 'elan.exe' : 'elan')
        assert.ok(fs.existsSync(elanBin), `elan binary should exist at ${elanBin} after install`)
        let version: string
        try {
            version = execFileSync(elanBin, ['--version'], { env: process.env, stdio: 'pipe' }).toString().trim()
        } catch (e) {
            const err = e as Error & { stderr?: Buffer }
            throw new Error(`installed elan failed to report --version: ${err.message}\n${err.stderr ?? ''}`)
        }
        assert.match(version, /^elan\s/)

        // The install script sets `leanprover/lean4:stable` as the default toolchain.
        assert.strictEqual(elanDefaultToolchain(), 'leanprover/lean4:stable')
    })
})
