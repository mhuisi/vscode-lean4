import { defineConfig } from '@vscode/test-cli'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cliTestNames, networkTestNames } from './scripts/cliTestNames.mjs'
import { getTestHome } from './scripts/testHome.mjs'

// This file must not change files: tools that only read the configuration
// also load it (`vscode-test --list-configuration`, which the debug
// configuration of `.vscode/launch.json` uses). `scripts/runCliTests.mjs`
// prepares the test home and deletes the output of the last run.

// We do not change VS Code's --extensions-dir: @vscode/test-cli installs
// `installExtensions` (below) into its cache dir (`.vscode-test/extensions`)
// and would not see them in another dir.
const { testHome, baseEnv } = getTestHome()

// Not relative to the working folder: js-debug lists this configuration
// (`--list-configuration`) in the working folder of VS Code.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test', 'fixtures')

// Without this flag, Electron uses Wayland if `WAYLAND_DISPLAY` is set, also
// inside `xvfb-run`. The environment variable `ELECTRON_OZONE_PLATFORM_HINT`
// is not sufficient.
const linuxHeadlessArgs = process.platform === 'linux' ? ['--ozone-platform=x11'] : []

// Each label gets its own VS Code user data in the test home, so that a
// setting that the extension writes (for example after a prompt) does not
// affect other labels or later runs.
const launchArgs = label => [
    '--disable-workspace-trust',
    `--user-data-dir=${path.join(testHome, 'vscode-user-data', label)}`,
    ...linuxHeadlessArgs,
]

// `scripts/runCliTests.mjs` and the CI action `cache-vscode` set
// `LEAN4_VSCODE_VERSION` to the newest stable version. With an exact version,
// vscode-test asks the update server only if this version is not installed.
// With `stable`, it asks for each label, and a network error stops the label:
// @vscode/test-electron 2.4.1 cannot find an installed version as a fallback.
// An empty value counts as not set.
const common = {
    version: process.env.LEAN4_VSCODE_VERSION || 'stable',
    mocha: { ui: 'bdd', timeout: 120_000, color: true },
    env: baseEnv,
    // @vscode/test-cli does not install the `extensionPack` of the extension.
    installExtensions: ['tombi-toml.tombi'],
}

// For the network tests: a download of a toolchain can take minutes. The
// `cli-*` files set their own timeouts where the default is too short.
const longRunning = { ...common.mocha, timeout: 15 * 60_000 }

// The workspace that VS Code opens for a test file. `adhoc` opens no folder.
const workspaceOf = name => {
    if (name === 'adhoc') return {}
    if (name === 'multi-root')
        return { workspaceFolder: path.join(fixtures, 'multi-root', 'multi-root.code-workspace') }
    return { workspaceFolder: path.join(fixtures, 'lean-project') }
}

// The network suite deletes `.elan` in the test home and downloads several GB.
// `vscode-test` without `--label` runs all configurations, and the Extension
// Test Runner of VS Code lists all of them. Thus the configuration `network`
// exists only if `LEAN4_TEST_NETWORK` is `1`. `scripts/runCliTests.mjs` sets it
// for the label `network`.
const networkConfigs =
    process.env.LEAN4_TEST_NETWORK === '1'
        ? [
              {
                  label: 'network',
                  // Mocha runs the files in this order. `cliTestNames.mjs` explains it.
                  files: networkTestNames.map(name => `out/test/network/${name}.test.js`),
                  workspaceFolder: path.join(fixtures, 'empty-workspace'),
                  ...common,
                  launchArgs: launchArgs('network'),
                  mocha: longRunning,
              },
          ]
        : []

// Each file of `test/vscode-test-cli/` runs in its own VS Code instance, so
// that open documents, Lean clients and output cannot affect other files.
// `cliTestNames.mjs` finds new test files.
export default defineConfig([
    ...cliTestNames.map(name => ({
        label: `cli-${name}`,
        files: `out/test/vscode-test-cli/${name}.test.js`,
        ...workspaceOf(name),
        ...common,
        launchArgs: launchArgs(`cli-${name}`),
    })),
    ...networkConfigs,
])
