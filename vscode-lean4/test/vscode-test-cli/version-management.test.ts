import * as assert from 'node:assert'
import { commands } from 'vscode'
import { elan, elanDefaultToolchain } from '../helpers/elan'
import { choose, dismiss, withPrompts } from '../helpers/prompts'
import { withQuickPicks } from '../helpers/quickPicks'
import { afterEachReset } from '../helpers/teardown'
import { requireIsolatedTestHome } from '../helpers/testHome'

describe('Version management commands', function () {
    this.timeout(60_000)

    // The tests change the elan default, and all test files of a run use the same
    // `ELAN_HOME`. Thus `afterEach` restores the original default.
    let originalDefault: string | undefined

    before(async function () {
        requireIsolatedTestHome({ requireElanHome: true })
        await elan(['--version'])
        originalDefault = elanDefaultToolchain()
    })

    // Before `afterEachReset`: if a hook fails, mocha skips the hooks after it.
    afterEach(async function () {
        if (originalDefault === undefined) {
            return
        }
        await elan(['default', originalDefault])
    })
    afterEach(afterEachReset)

    it('`lean4.setup.selectDefaultToolchain` sets the chosen toolchain as default when confirmed', async () => {
        // Start from another default, so that a command that does nothing fails
        // the test.
        await elan(['default', 'leanprover/lean4:v4.0.0'])
        assert.strictEqual(
            elanDefaultToolchain(),
            'leanprover/lean4:v4.0.0',
            'precondition: seeded default is in place',
        )

        await withQuickPicks([/^Always use most recent stable version$/], async () => {
            await withPrompts(
                [
                    choose(
                        /^This operation will set the 'leanprover\/lean4:stable' Lean release channel to be the global default/,
                        'Proceed',
                    ),
                    dismiss(/^Default Lean version 'leanprover\/lean4:stable' set successfully\.$/),
                    // The picker also lists the Lean versions of `https://release.lean-lang.org/`.
                    // If the request fails, the picker shows only the installed versions.
                    dismiss(/^Could not fetch Lean versions/, { optional: true }),
                ],
                async () => {
                    await commands.executeCommand('lean4.setup.selectDefaultToolchain')
                },
            )
        })
        assert.strictEqual(elanDefaultToolchain(), 'leanprover/lean4:stable')
    })
})
