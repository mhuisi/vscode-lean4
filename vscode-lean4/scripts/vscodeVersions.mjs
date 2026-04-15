import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The VS Code versions of a test run.
//
// `@vscode/test-cli` uses the newest version that the update server lists
// (`LEAN4_VSCODE_VERSION` in `.vscode-test.mjs`). wdio-vscode-service also needs
// the Chromedriver version of its VS Code: it reads `cgmanifest.json` at the
// git tag of that version on GitHub. After a release, the tag can come later
// than the entry on the update server. Until then, wdio-vscode-service fails
// with "Couldn't fetch Chromedriver version". Thus wdio uses the newest version
// whose `cgmanifest.json` exists.
//
// `scripts/runCliTests.mjs`, `scripts/runWdio.mjs` and the CI action
// `cache-vscode` use this file. In CI,
// `node scripts/vscodeVersions.mjs` writes `latest=<version>` and
// `wdio=<version>` to stdout, for `$GITHUB_OUTPUT`.

const releasesUrl = 'https://update.code.visualstudio.com/api/releases/stable'
// The same URL as `VSCODE_MANIFEST_URL` of wdio-vscode-service.
const manifestUrl = version => `https://raw.githubusercontent.com/microsoft/vscode/${version}/cgmanifest.json`
// The tag of a release usually comes within a few days, so we look only at
// the newest versions.
const maxWdioCandidates = 3
const timeoutMs = 10_000
// A request that fails with a network error, a timeout, HTTP 429 or HTTP 5xx
// gets this number of attempts. The wait before the next attempt doubles each time.
const maxAttempts = 3
const firstRetryDelayMs = 2_000

// `fetch` with retries for temporary failures. Returns the response of the last
// attempt, or throws its error.
async function fetchWithRetry(url, options = {}) {
    for (let attempt = 1; ; attempt++) {
        let failure
        try {
            const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
            const temporary = response.status === 429 || response.status >= 500
            if (!temporary || attempt === maxAttempts) return response
            await response.body?.cancel()
            failure = `HTTP ${response.status}`
        } catch (e) {
            if (attempt === maxAttempts) throw e
            failure = String(e)
        }
        const delayMs = firstRetryDelayMs * 2 ** (attempt - 1)
        // stderr: in CI, stdout goes to `$GITHUB_OUTPUT`.
        console.warn(`${url}: ${failure}. Attempt ${attempt + 1} of ${maxAttempts} in ${delayMs / 1000} s.`)
        await new Promise(resolve => setTimeout(resolve, delayMs))
    }
}

// Returns the stable versions, the newest first. Throws if it cannot get them.
export async function fetchStableVersions() {
    const response = await fetchWithRetry(releasesUrl)
    if (!response.ok) {
        throw new Error(`${releasesUrl}: HTTP ${response.status}`)
    }
    const versions = await response.json()
    if (!Array.isArray(versions) || typeof versions[0] !== 'string') {
        throw new Error(`${releasesUrl}: unexpected response: ${JSON.stringify(versions).slice(0, 200)}`)
    }
    return versions
}

// Returns `{ latest, wdio }`: the newest stable version, and the newest stable
// version that wdio-vscode-service can use. Throws if it cannot get them.
export async function resolveVSCodeVersions() {
    const versions = await fetchStableVersions()
    const candidates = versions.slice(0, maxWdioCandidates)
    for (const version of candidates) {
        const url = manifestUrl(version)
        const manifest = await fetchWithRetry(url, { method: 'HEAD' })
        if (manifest.ok) {
            return { latest: versions[0], wdio: version }
        }
        if (manifest.status !== 404) {
            throw new Error(`${url}: HTTP ${manifest.status}`)
        }
    }
    throw new Error(`GitHub has no cgmanifest.json for the VS Code versions ${candidates.join(', ')}`)
}

// True if Node runs this file as the main module. Node resolves symlinks in `import.meta.url`, but
// not in `process.argv[1]`, so we compare the real paths.
function isMainModule() {
    if (process.argv[1] === undefined) {
        return false
    }
    try {
        return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    } catch {
        return false
    }
}

if (isMainModule()) {
    const { latest, wdio } = await resolveVSCodeVersions()
    console.log(`latest=${latest}`)
    console.log(`wdio=${wdio}`)
}
