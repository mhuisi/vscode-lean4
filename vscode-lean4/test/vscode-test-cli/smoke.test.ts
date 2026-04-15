import * as assert from 'node:assert'
import { commands } from 'vscode'
import { activateExtension } from '../helpers/activation'
import { afterEachReset } from '../helpers/teardown'

describe('extension activation', () => {
    afterEach(afterEachReset)

    it('activates the lean4 extension and registers its commands', async () => {
        const exports = await activateExtension()
        assert.ok(exports.alwaysEnabledFeatures.outputChannel, 'the exports should contain the output channel')
        const registered = await commands.getCommands(true)
        // Commands of features that the extension always activates.
        for (const command of ['lean4.input.convert', 'lean4.troubleshooting.showSetupInformation']) {
            assert.ok(registered.includes(command), `the command ${command} should be registered`)
        }
    })
})
