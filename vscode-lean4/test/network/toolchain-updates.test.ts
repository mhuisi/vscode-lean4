import * as assert from 'node:assert'
import type { LeanCommandRunner } from '../../src/utils/leanCmdRunner'
import { activateExtension } from '../helpers/activation'
import { elan, elanCachedResolution, elanInstallToolchain, elanInstalledToolchains } from '../helpers/elan'
import { choose, withPrompts } from '../helpers/prompts'
import { afterEachReset } from '../helpers/teardown'
import { requireIsolatedTestHome } from '../helpers/testHome'

// An old stable release. When the current stable version is not installed,
// elan falls back to the newest installed stable version, which must be this one.
// `elan dump-state` skips pre-releases, so the tests fail if the current
// stable version is a pre-release.
const OLD_STABLE = 'leanprover/lean4:v4.20.0'
const STABLE_CHANNEL = 'leanprover/lean4:stable'
const UPDATE_PROMPT_RE = /Do you wish to install the new Lean version/

// Uninstalls the current stable version, so that elan reports an update for
// `stable`. First removes other stable versions, so that the fallback is OLD_STABLE.
async function seedDivergence(): Promise<{ current: string; fallback: string }> {
    await elanInstallToolchain(OLD_STABLE)
    await elanInstallToolchain(STABLE_CHANNEL)
    await elan(['default', STABLE_CHANNEL])

    const current = await elanCachedResolution(STABLE_CHANNEL)
    assert.ok(current, 'expected a cached resolution for stable after install')

    const stray = (await elanInstalledToolchains()).filter(
        t => t.startsWith('leanprover/lean4:') && t !== OLD_STABLE && t !== current,
    )
    if (stray.length > 0) {
        await elan(['toolchain', 'uninstall', ...stray])
    }
    await elan(['toolchain', 'uninstall', current])

    const fallback = await elanCachedResolution(STABLE_CHANNEL)
    assert.strictEqual(
        fallback,
        OLD_STABLE,
        `expected elan to drop the cached resolution of 'stable' to ${OLD_STABLE} after uninstalling ` +
            `'${current}' (pruned strays: ${stray.length === 0 ? '<none>' : stray.join(', ')}); ` +
            `got '${fallback ?? '<none>'}'`,
    )
    return { current, fallback }
}

async function isInstalled(toolchain: string): Promise<boolean> {
    return (await elanInstalledToolchains()).includes(toolchain)
}

// The tests use the `LeanCommandRunner` of the extension. It remembers a "Use
// Old Version" decision for the rest of the session, so the test that makes
// this decision must be the last one, and this file must be the last network
// file (`scripts/cliTestNames.mjs`).
describe('Toolchain update flows (real network)', function () {
    this.timeout(30 * 60_000)

    let runner: LeanCommandRunner

    before(async function () {
        requireIsolatedTestHome({ requireElanHome: true })
        runner = (await activateExtension()).alwaysEnabledFeatures.leanCommandRunner
    })

    afterEach(afterEachReset)

    it('`UpdateAutomatically` mode installs the resolved toolchain without prompting', async () => {
        const { current } = await seedDivergence()
        assert.strictEqual(await isInstalled(current), false, 'precondition: resolved toolchain is uninstalled')
        await withPrompts([], async () => {
            const decision = await runner.decideToolchain({
                channel: undefined,
                context: 'auto-update-test',
                cwdUri: undefined,
                toolchainUpdateMode: 'UpdateAutomatically',
                waitingPrompt: 'Fetching Lean version information',
            })
            assert.strictEqual(
                decision.kind,
                'RunWithActiveToolchain',
                `expected runner to update transparently; got ${JSON.stringify(decision)}`,
            )
            assert.strictEqual(await isInstalled(current), true, `expected ${current} to be (re)installed`)
        })
    })

    it('manual prompt → "Update Lean Version" installs the resolved toolchain', async () => {
        const { current } = await seedDivergence()
        assert.strictEqual(await isInstalled(current), false, 'precondition: resolved toolchain is uninstalled')
        await withPrompts([choose(UPDATE_PROMPT_RE, 'Update Lean Version')], async ({ log }) => {
            const decision = await runner.decideToolchain({
                channel: undefined,
                context: 'update-accept-test',
                cwdUri: undefined,
                toolchainUpdateMode: 'PromptAboutUpdate',
                waitingPrompt: 'Fetching Lean version information',
            })
            assert.strictEqual(
                decision.kind,
                'RunWithActiveToolchain',
                `expected runner to update after confirmation; got ${JSON.stringify(decision)}`,
            )
            const fired = log.filter(p => UPDATE_PROMPT_RE.test(p.message))
            assert.strictEqual(fired.length, 1, 'update prompt should have fired exactly once')
            assert.strictEqual(fired[0].chose, 'Update Lean Version')
            assert.strictEqual(
                await isInstalled(current),
                true,
                `expected ${current} to be (re)installed after user confirmed`,
            )
        })
    })

    it('manual prompt → "Use Old Version" keeps the cached toolchain; the decision is sticky', async () => {
        const { current, fallback } = await seedDivergence()
        await withPrompts([choose(UPDATE_PROMPT_RE, 'Use Old Version')], async ({ log }) => {
            const decision = await runner.decideToolchain({
                channel: undefined,
                context: 'update-decline-test',
                cwdUri: undefined,
                toolchainUpdateMode: 'PromptAboutUpdate',
                waitingPrompt: 'Fetching Lean version information',
            })
            assert.deepStrictEqual(
                decision,
                { kind: 'RunWithSpecificToolchain', toolchain: fallback },
                `expected runner to stick with the cached fallback; got ${JSON.stringify(decision)}`,
            )
            const fired = log.filter(p => UPDATE_PROMPT_RE.test(p.message))
            assert.strictEqual(fired.length, 1, 'update prompt should have fired exactly once')
            assert.strictEqual(fired[0].chose, 'Use Old Version')
            assert.strictEqual(
                await isInstalled(current),
                false,
                `resolved toolchain ${current} should NOT be installed after user declined`,
            )

            // The runner remembers the decision and does not ask again.
            const before = log.length
            const second = await runner.decideToolchain({
                channel: undefined,
                context: 'sticky-probe',
                cwdUri: undefined,
                toolchainUpdateMode: 'PromptAboutUpdate',
                waitingPrompt: 'Fetching Lean version information',
            })
            assert.deepStrictEqual(
                second,
                { kind: 'RunWithSpecificToolchain', toolchain: fallback },
                `expected sticky fallback; got ${JSON.stringify(second)}`,
            )
            assert.strictEqual(log.length, before, 'no new prompts should fire during the sticky re-probe')
        })
    })
})
