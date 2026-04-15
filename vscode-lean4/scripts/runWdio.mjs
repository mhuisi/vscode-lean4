import { Browser, detectBrowserPlatform, getInstalledBrowsers } from '@puppeteer/browsers'
import { download } from '@vscode/test-electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addPackageBinsToPath, exitLike, runChild, runSignalHandlers, stoppedBy } from './childProcess.mjs'
import { prepareTestHome, rmOptions } from './testHome.mjs'
import { resolveVSCodeVersions } from './vscodeVersions.mjs'

// Runs `wdio run ./wdio.conf.mjs`. Before that, it does the one-time work of a
// run. `wdio.conf.mjs` does not do this, because wdio loads the configuration
// in each process, and the launcher opens its log files in `wdio-output/`
// before the `onPrepare` hook runs.

const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// `cachePath` and `cacheDir` in `wdio.conf.mjs`.
const cachePath = path.join(extensionPath, '.wdio-vscode-service')

// `versions.txt` of wdio-vscode-service has an entry for each version that a
// run asked for: the VS Code version and the major version of its Chromedriver,
// for example `{ "1.144.0": { "vscode": "1.144.0", "chromedriver": "150" } }`.
// The format is internal to wdio-vscode-service. If it changes, we find no
// entries, and wdio-vscode-service and wdio get the versions from the network.
function cachedWdioVersions() {
    try {
        const versions = JSON.parse(fs.readFileSync(path.join(cachePath, 'versions.txt'), 'utf8'))
        return typeof versions === 'object' && versions !== null ? versions : {}
    } catch {
        return {}
    }
}

// Compares two versions such as `1.144.0` or `150.0.7871.24` by their numbers.
function compareVersions(a, b) {
    const x = a.split('.').map(Number)
    const y = b.split('.').map(Number)
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const difference = (x[i] ?? 0) - (y[i] ?? 0)
        if (difference !== 0) return difference
    }
    return 0
}

// The newest Chromedriver in the cache whose major version is `major`, or
// `undefined`. wdio downloads Chromedriver with `@puppeteer/browsers`, so we
// read the cache with the same package.
async function cachedChromedriver(major) {
    const platform = detectBrowserPlatform()
    const drivers = (await getInstalledBrowsers({ cacheDir: cachePath })).filter(
        installed =>
            installed.browser === Browser.CHROMEDRIVER &&
            installed.platform === platform &&
            installed.buildId.split('.')[0] === major &&
            // A stopped download can leave a folder without the executable.
            fs.existsSync(installed.executablePath),
    )
    return drivers.sort((a, b) => compareVersions(a.buildId, b.buildId)).at(-1)?.executablePath
}

addPackageBinsToPath()
prepareTestHome()

// The output of the last run, and the VS Code user data of the last run.
// `wdio.conf.mjs` explains the folders.
fs.rmSync(path.join(extensionPath, 'wdio-output'), rmOptions)
fs.rmSync(path.join(cachePath, 'storage', 'settings'), rmOptions)

// wdio-vscode-service maps `stable` to the version that it downloaded first,
// and never looks for a newer one. Thus we give it the current stable version
// (`vscodeVersions.mjs` explains the choice). If we cannot get it (for example
// offline), we give it the newest exact version in `versions.txt`. For that
// version, wdio-vscode-service makes no network request. If there is no such
// entry, we give `stable`. An empty value counts as not set, here and for
// `LEAN4_WDIO_VSCODE_BINARY`.
if (!process.env.LEAN4_WDIO_VSCODE_VERSION) {
    try {
        process.env.LEAN4_WDIO_VSCODE_VERSION = (await resolveVSCodeVersions()).wdio
    } catch (e) {
        const cached = Object.keys(cachedWdioVersions())
            .filter(version => /^\d+(\.\d+)*$/.test(version))
            .sort(compareVersions)
            .at(-1)
        process.env.LEAN4_WDIO_VSCODE_VERSION = cached ?? 'stable'
        console.warn(
            `[wdio] cannot get the current VS Code stable version, using ${cached ?? '`stable`'} from the cache: ${e}`,
        )
    }
}

// wdio-vscode-service makes no network requests if its `versions.txt` has the
// version and the VS Code bundle exists. Without the option `binary`, it looks
// for the bundle in `vscode-<platform>-<arch>-<version>`. But on Windows,
// @vscode/test-electron downloads the bundle to `vscode-win32-x64-archive-<version>`.
// Thus each run on Windows asks for the versions of VS Code and Chromedriver, and
// a network error stops the suite. We get the executable with the same download
// function and give it to `wdio.conf.mjs`. For an installed exact version, this
// function makes no request.
const vscodeVersion = process.env.LEAN4_WDIO_VSCODE_VERSION
if (!process.env.LEAN4_WDIO_VSCODE_BINARY && vscodeVersion !== 'stable') {
    try {
        process.env.LEAN4_WDIO_VSCODE_BINARY = await download({
            version: vscodeVersion,
            cachePath,
        })
    } catch (e) {
        console.warn(`[wdio] cannot get VS Code ${vscodeVersion}, wdio-vscode-service gets it: ${e}`)
    }
}

// wdio-vscode-service gives wdio only the major version of Chromedriver (the
// entry `chromedriver` of `versions.txt`). For a major version, wdio asks the
// Chrome for Testing server for the newest build, also if a driver is in its
// cache, and a network error stops the suite. Thus we look for a cached driver
// of that major version, and give it to wdio as `CHROMEDRIVER_PATH`. If there
// is none (for example in the first run with a new VS Code version), wdio
// downloads it into `cacheDir` of `wdio.conf.mjs`. To use another driver, set
// `CHROMEDRIVER_PATH`.
if (!process.env.CHROMEDRIVER_PATH) {
    const major = cachedWdioVersions()[vscodeVersion]?.chromedriver
    try {
        const driver = major !== undefined ? await cachedChromedriver(String(major)) : undefined
        if (driver !== undefined) {
            process.env.CHROMEDRIVER_PATH = driver
            console.log(`[wdio] Chromedriver from the cache: ${driver}`)
        } else {
            console.log(`[wdio] no Chromedriver for VS Code ${vscodeVersion} in the cache: wdio downloads it`)
        }
    } catch (e) {
        console.warn(`[wdio] cannot read the Chromedriver cache, wdio downloads the driver: ${e}`)
    }
}

// After a stop during the setup (for example during `elan toolchain install`),
// we do not start wdio.
await runSignalHandlers()
if (stoppedBy()) {
    exitLike({ status: 1, signal: null })
} else {
    // On Windows, `wdio` is a `.cmd` file, which needs a shell.
    exitLike(
        await runChild('wdio', ['run', './wdio.conf.mjs'], {
            cwd: extensionPath,
            stdio: 'inherit',
            shell: process.platform === 'win32',
        }),
    )
}
