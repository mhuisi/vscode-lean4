import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Must match `testHomeMarker` in `scripts/testHome.mjs`.
const TEST_HOME_MARKER = '.lean4-test-home'

// Returns the isolated `LEAN4_TEST_HOME` and asserts that `scripts/testHome.mjs`
// prepared it. Pass `{ requireElanHome: true }` in suites that change elan
// state: then `ELAN_HOME` must be `<test home>/.elan`. These checks prevent
// a test from deleting the real `~/.elan`.
export function requireIsolatedTestHome({ requireElanHome = false }: { requireElanHome?: boolean } = {}): {
    testHome: string
    elanHome: string
} {
    const testHome = process.env.LEAN4_TEST_HOME ?? ''
    const elanHome = process.env.ELAN_HOME ?? ''

    assert.ok(testHome, 'refusing to run: LEAN4_TEST_HOME is unset')
    assert.ok(
        fs.existsSync(path.join(testHome, TEST_HOME_MARKER)),
        `refusing to run: LEAN4_TEST_HOME (${testHome}) has no ${TEST_HOME_MARKER} file. ` +
            'Start the tests with the npm scripts, or run `node scripts/prepareTestHome.mjs` first.',
    )
    const realTestHome = fs.realpathSync(testHome)
    // Not `os.homedir()`: the harness sets `HOME` to the test home.
    const realHome = fs.realpathSync(os.userInfo().homedir)
    const rel = path.relative(realTestHome, realHome)
    assert.ok(
        rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel)),
        `refusing to run: LEAN4_TEST_HOME (${realTestHome}) is the real home folder or contains it`,
    )

    if (requireElanHome) {
        assert.ok(elanHome, 'refusing to run: ELAN_HOME is unset')
        assert.ok(fs.existsSync(elanHome), `refusing to run: ELAN_HOME (${elanHome}) does not exist`)
        const realElanHome = fs.realpathSync(elanHome)
        assert.strictEqual(
            path.dirname(realElanHome),
            realTestHome,
            `refusing to run: ELAN_HOME (${realElanHome}) is not directly under LEAN4_TEST_HOME (${realTestHome})`,
        )
        assert.strictEqual(
            path.basename(realElanHome),
            '.elan',
            `refusing to run: ELAN_HOME basename (${path.basename(realElanHome)}) is not '.elan'`,
        )
    }
    return { testHome, elanHome }
}

// Creates a scratch folder in the test home. The next test run deletes it.
export function makeTestWorkDir(prefix: string): string {
    const { testHome } = requireIsolatedTestHome()
    return fs.mkdtempSync(path.join(testHome, prefix))
}
