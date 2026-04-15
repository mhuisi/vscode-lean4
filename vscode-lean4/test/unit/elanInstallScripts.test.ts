import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// `src/utils/leanInstaller.ts` runs the scripts of `scripts/elan-install/`, and
// the CI action `setup-elan` runs them as files. Thus the scripts contain the
// default toolchain as text, and not the value of `elanStableChannel`. This
// test finds a difference. `src/utils/elan.ts` imports `vscode`, so the test
// reads it as text.
describe('scripts/elan-install', () => {
    const extensionDir = path.join(__dirname, '..', '..')
    const elanTs = fs.readFileSync(path.join(extensionDir, 'src', 'utils', 'elan.ts'), 'utf8')
    const stableChannel = /export const elanStableChannel = '([^']+)'/.exec(elanTs)?.[1]

    it.each(['install-unix.sh', 'install-windows.ps1'])('%s installs `elanStableChannel`', script => {
        expect(stableChannel, '`elanStableChannel` in src/utils/elan.ts').toBeDefined()
        const text = fs.readFileSync(path.join(extensionDir, 'scripts', 'elan-install', script), 'utf8')
        // `--default-toolchain` in the Unix script, `-DefaultToolchain` in the Windows script.
        const toolchain = /-(?:-default-toolchain|DefaultToolchain) (\S+)/.exec(text)?.[1]
        expect(toolchain).toBe(stableChannel)
    })
})
