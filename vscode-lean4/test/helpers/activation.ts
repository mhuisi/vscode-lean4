import * as assert from 'node:assert'
import { extensions } from 'vscode'
import type { Exports } from '../../src/exports'
import { captureOutputChannel, startOutputChannelCapture } from './outputChannels'

// Activates the extension and captures its output channel (see `outputChannels.ts`).
export async function activateExtension(): Promise<Exports> {
    startOutputChannelCapture()
    const ext = extensions.getExtension('leanprover.lean4')
    assert.ok(ext, 'leanprover.lean4 extension must be installed in the test host')
    const exports = (await ext.activate()) as Exports
    captureOutputChannel('Lean: Editor', exports.alwaysEnabledFeatures.outputChannel)
    return exports
}
