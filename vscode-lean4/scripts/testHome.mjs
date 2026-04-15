import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// The isolated HOME of a test run, so that elan toolchains, git configuration
// and other files in $HOME do not touch the real home folder.
//
// The test home is `~/.cache/lean4-vscode-tests/home`, or
// `LEAN4_TEST_HOME_OVERRIDE` if it is set (CI). At the start of each run, we
// delete everything in it except `.elan`, so that runs reuse the downloaded
// toolchains. We do not use `os.tmpdir()`: some distros mount `/tmp` as a
// tmpfs that is too small for a Lean toolchain.
//
// `getTestHome()` only computes the paths. `.vscode-test.mjs` and
// `wdio.conf.mjs` use it, because tools that only read a test configuration
// also load these files (for example `vscode-test --list-configuration`).
// `prepareTestHome()` changes files. Only the scripts that start a run call it:
// `runAllTests.mjs`, `runCliTests.mjs`, `runWdio.mjs` and `prepareTestHome.mjs`.

// Name of the file that marks a folder as a test home. We delete the contents
// of a folder only if it has this file (or contains nothing but `.elan`).
// `test/helpers/testHome.ts` requires it too.
export const testHomeMarker = '.lean4-test-home'

export const defaultTestHome = path.join(os.userInfo().homedir, '.cache', 'lean4-vscode-tests', 'home')

// The toolchain that the setup installs and makes the elan default.
// The CI job `test-nightly` sets `leanprover/lean4:nightly`.
const seedToolchain = process.env.LEAN4_TEST_TOOLCHAIN ?? 'leanprover/lean4:stable'

// The options of `fs.rmSync` for the run scripts. They are the same as in
// `test/helpers/fs.ts`, which explains the retries.
export const rmOptions = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }

// Prepares the test home for a run: deletes everything in it except `.elan`,
// removes the toolchain links of stopped runs, writes the marker file, and
// installs the toolchain (unless `seedElan` is false). Sets `LEAN4_TEST_HOME`
// in `process.env`. Child processes see it and do not prepare the home again,
// so a run prepares the home only one time.
// If `elan` is not on PATH, the setup fails, unless `requireElan` is false.
// Only a run with the network suite sets it to false, because the network
// suite installs elan itself.
export function prepareTestHome({ seedElan: seed = true, requireElan = true } = {}) {
    const inherited = Boolean(process.env.LEAN4_TEST_HOME)
    const { testHome, baseEnv } = getTestHome()
    fs.mkdirSync(testHome, { recursive: true })
    assertNotRealHome(testHome)
    if (inherited) {
        // Only the run scripts set `LEAN4_TEST_HOME`, after they prepared the folder.
        if (!fs.existsSync(path.join(testHome, testHomeMarker))) {
            throw new Error(
                `LEAN4_TEST_HOME (${testHome}) has no ${testHomeMarker} file. ` +
                    'Unset LEAN4_TEST_HOME, and use LEAN4_TEST_HOME_OVERRIDE to select the test home.',
            )
        }
    } else {
        resetTestHome(testHome)
        // `requireIsolatedTestHome({ requireElanHome: true })` needs the folder,
        // also in the network suite, which does not seed elan.
        fs.mkdirSync(baseEnv.ELAN_HOME, { recursive: true })
        removeToolchainLinks(baseEnv.ELAN_HOME)
    }
    process.env.LEAN4_TEST_HOME = testHome
    if (!inherited && seed) {
        seedElan(baseEnv, requireElan)
    }
    return { testHome, baseEnv }
}

// The value of the environment variable `name`, or `undefined` if it is unset
// or empty. The run scripts and VS Code have different working folders, so a
// relative path is an error.
function absolutePathFromEnv(name) {
    const value = process.env[name]
    if (!value) return undefined
    if (!path.isAbsolute(value)) {
        throw new Error(`${name} must be an absolute path, but it is ${JSON.stringify(value)}`)
    }
    return value
}

// Returns the test home and the environment of the processes that use it.
// Changes no files.
export function getTestHome() {
    const testHome = path.resolve(
        absolutePathFromEnv('LEAN4_TEST_HOME') ?? absolutePathFromEnv('LEAN4_TEST_HOME_OVERRIDE') ?? defaultTestHome,
    )
    const baseEnv = {
        HOME: testHome,
        USERPROFILE: testHome,
        ELAN_HOME: path.join(testHome, '.elan'),
        LEAN4_TEST_HOME: testHome,
        XDG_CONFIG_HOME: path.join(testHome, '.config'),
        XDG_CACHE_HOME: path.join(testHome, '.cache'),
        // Git must not look for a repository above the test home. In CI, the
        // test home is inside the checkout of this repository.
        GIT_CEILING_DIRECTORIES: testHome,
        // Ignore `/etc/gitconfig` (for example `commit.gpgsign`). On Windows,
        // the system configuration of Git for Windows sets up HTTPS, so we keep it.
        ...(process.platform === 'win32' ? {} : { GIT_CONFIG_NOSYSTEM: '1' }),
    }
    return { testHome, baseEnv }
}

function assertNotRealHome(testHome) {
    const realHome = fs.realpathSync(os.userInfo().homedir)
    const rel = path.relative(fs.realpathSync(testHome), realHome)
    // `rel` is empty if both are the same folder. It does not go up if the
    // real home is inside the test home.
    if (rel === '' || !(rel.startsWith('..') || path.isAbsolute(rel))) {
        throw new Error(`refusing to use ${testHome} as the test home: it is the real home folder or contains it`)
    }
}

function resetTestHome(testHome) {
    const entries = fs.readdirSync(testHome)
    const isTestHome = entries.includes(testHomeMarker) || entries.every(e => e === '.elan')
    if (!isTestHome) {
        throw new Error(
            `refusing to use ${testHome} as the test home: it is not empty and it has no ${testHomeMarker} file`,
        )
    }
    for (const entry of entries) {
        if (entry !== '.elan' && entry !== testHomeMarker) {
            fs.rmSync(path.join(testHome, entry), rmOptions)
        }
    }
    fs.writeFileSync(
        path.join(testHome, testHomeMarker),
        'This folder is the HOME of the vscode-lean4 tests. Each test run deletes everything in it except `.elan`.\n',
    )
}

// The tests link toolchains only for the time of one test (see
// `test/helpers/mockToolchain.ts`). A run that stopped before its cleanup
// leaves the link, and the next run sees it in `elan toolchain list`. A link
// to a mock toolchain also points to a folder that `resetTestHome` deleted.
// Installed toolchains are normal folders, so we remove only the links.
// `fs.unlinkSync` also removes a junction on Windows.
function removeToolchainLinks(elanHome) {
    const toolchainsDir = path.join(elanHome, 'toolchains')
    if (!fs.existsSync(toolchainsDir)) return
    for (const entry of fs.readdirSync(toolchainsDir)) {
        const entryPath = path.join(toolchainsDir, entry)
        if (fs.lstatSync(entryPath).isSymbolicLink()) {
            fs.unlinkSync(entryPath)
        }
    }
}

// Makes `seedToolchain` the default toolchain of the test home and installs it
// before the tests start, so that the first test does not have to wait for the
// download. We set the default in each run: a run that stopped before its
// cleanup can leave another default (`version-management.test.ts`).
// If elan is not on PATH and `requireElan` is false, we do nothing.
function seedElan(baseEnv, requireElan) {
    const env = { ...process.env, ...baseEnv }
    const elan = args => execFileSync('elan', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })

    // Let elan write `settings.toml`: its schema changes between elan versions.
    // A file without a `version` key is from an old elan, so we write it again.
    const settingsPath = path.join(baseEnv.ELAN_HOME, 'settings.toml')
    if (fs.existsSync(settingsPath) && !/^\s*version\s*=/m.test(fs.readFileSync(settingsPath, 'utf8'))) {
        fs.rmSync(settingsPath, rmOptions)
    }
    try {
        elan(['default', seedToolchain])
    } catch (e) {
        if (e.code === 'ENOENT') {
            if (!requireElan) return
            throw new Error(
                '`elan` is not on PATH. The tests need elan (https://github.com/leanprover/elan). ' +
                    'Install it, or run the network suite, which installs elan into the test home.',
            )
        }
        throw new Error(`\`elan default ${seedToolchain}\` failed (ELAN_HOME=${baseEnv.ELAN_HOME}): ${output(e)}`)
    }
    try {
        elan(['toolchain', 'install', seedToolchain])
    } catch (e) {
        // `elan toolchain install` fails if the toolchain is already installed.
        // Other failures (for example no network) are not fatal: the tests can
        // still use a toolchain that is already installed.
        if (!/is already installed/.test(output(e))) {
            console.warn(`warning: \`elan toolchain install ${seedToolchain}\` failed: ${output(e)}`)
        }
    }
}

function output(e) {
    return [e.stderr?.toString().trim(), e.stdout?.toString().trim(), e.message].filter(Boolean).join('\n')
}
