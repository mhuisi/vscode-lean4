import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// The names of the `.test.ts` files in `test/<dir>`. Reads the `.ts` files, so
// that it works before `compile-tests`.
function testNames(dir) {
    return readdirSync(resolve(here, '..', 'test', dir))
        .filter(f => f.endsWith('.test.ts'))
        .map(f => f.replace(/\.test\.ts$/, ''))
        .sort()
}

// The names of the files in `test/vscode-test-cli/`, for the `cli-*` labels.
export const cliTestNames = testNames('vscode-test-cli')

// The files in `test/network/`, in the order of the run. All files run in the
// same VS Code, and some change the state of the next files:
// - `elan-install` installs the elan that the other files use.
// - `toolchain-updates` uninstalls toolchains, and the extension then uses the
//   old toolchain for the rest of the session ("Use Old Version"). Thus it is last.
export const networkTestNames = ['elan-install', 'project-init-flow', 'toolchain-updates']

const unlisted = testNames('network').filter(name => !networkTestNames.includes(name))
const missing = networkTestNames.filter(name => !testNames('network').includes(name))
if (unlisted.length > 0 || missing.length > 0) {
    throw new Error(
        'scripts/cliTestNames.mjs: `networkTestNames` must list each file of test/network/ ' +
            `(not listed: ${unlisted.join(', ') || '<none>'}; no file: ${missing.join(', ') || '<none>'})`,
    )
}
