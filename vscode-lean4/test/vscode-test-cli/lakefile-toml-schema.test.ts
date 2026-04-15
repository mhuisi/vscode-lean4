import * as assert from 'node:assert'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Diagnostic, DiagnosticSeverity, Hover, Uri, commands, extensions, languages, workspace } from 'vscode'
import { closeAllEditors, openInEditor } from '../helpers/editors'
import { FIXTURES as FIXTURES_ROOT } from '../helpers/fixtures'
import { afterEachReset } from '../helpers/teardown'
import { makeTestWorkDir } from '../helpers/testHome'
import { pollFor } from '../helpers/timeouts'

// The extension makes Tombi (from its `extensionPack`) validate `lakefile.toml`
// files with the Lake schema. Tombi downloads the schema, so these tests need the network.

// The Tombi configuration of the test folder. Without it, the tests can pass
// without the `tomlValidation` contribution of the extension:
// - The SchemaStore catalog of Tombi also gives a schema for `lakefile.toml`.
//   Our schema URL redirects to the same file, so the errors are the same.
// - The default TOML version of Tombi is v1.0.0, so the `toml_1_1_*` fixtures
//   fail also without a schema. With v1.1.0 as the default, only the
//   `x-tombi-toml-version` of the Lake schema gives these errors.
const TOMBI_CONFIG = `toml-version = "v1.1.0"

[schema]
catalog = { paths = [] }
`

const TOMBI_EXTENSION_ID = 'tombi-toml.tombi'

// The schema URL of `contributes.tomlValidation` in `package.json`, as the
// hover of Tombi shows it (a link to the file in its cache).
const LAKE_SCHEMA_URL = 'schemas.lean-lang.org/lakefile-toml-schema.json'

const FIXTURES = path.join(FIXTURES_ROOT, 'lakefile-toml-schema')

// Less than the mocha timeout, so that `pollFor` fails with its own message.
const TOMBI_TIMEOUT_MS = 45_000

// Tombi gives no signal when it finds no problems, so we wait this long. We
// wait one time for all valid fixtures (see `describe('valid fixtures')`).
const VALID_SETTLE_MS = 3000

async function openLakefile(dir: string, src: string): Promise<Uri> {
    fs.mkdirSync(dir, { recursive: true })
    const dst = path.join(dir, 'lakefile.toml')
    fs.copyFileSync(src, dst)
    const uri = Uri.file(dst)
    await openInEditor(uri)
    return uri
}

function tombiDiagnostics(uri: Uri, severity: DiagnosticSeverity): Diagnostic[] {
    return languages.getDiagnostics(uri).filter(d => d.severity === severity && d.source === 'Tombi')
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
    if (diagnostics.length === 0) {
        return '<none>'
    }
    return diagnostics
        .map(d => `${d.range.start.line + 1}:${d.range.start.character + 1}: [${d.source}] ${d.message}`)
        .join('\n')
}

// Waits until Tombi publishes an error for `uri` whose message contains `expected`.
async function waitForTombiError(
    uri: Uri,
    expected: string,
    { label, timeout }: { label: string; timeout: number },
): Promise<Diagnostic[]> {
    return pollFor(
        () => {
            const errors = tombiDiagnostics(uri, DiagnosticSeverity.Error)
            return errors.some(d => d.message.includes(expected)) ? errors : undefined
        },
        timeout,
        () => `${label} (diagnostics of all sources:\n${formatDiagnostics(languages.getDiagnostics(uri))})`,
    )
}

// Waits until the hover of the `name` key refers to the Lake schema of the
// extension. A valid file has no diagnostics, so only the hover shows that
// Tombi uses the schema.
async function waitForLakefileSchema(uri: Uri, { label, timeout }: { label: string; timeout: number }): Promise<void> {
    const doc = await workspace.openTextDocument(uri)
    const nameKey = /^name\s*=/m.exec(doc.getText())
    assert.ok(nameKey, `expected a top-level \`name\` key in ${uri.fsPath}`)
    const position = doc.positionAt(nameKey.index)
    let hoverText = ''
    await pollFor(
        async () => {
            const hovers = (await commands.executeCommand<Hover[]>('vscode.executeHoverProvider', uri, position)) ?? []
            hoverText = hovers
                .flatMap(hover => hover.contents)
                .map(content => (typeof content === 'string' ? content : content.value))
                .join('\n')
            return hoverText.includes(LAKE_SCHEMA_URL) ? true : undefined
        },
        timeout,
        () => `${label} (last hover text: ${JSON.stringify(hoverText)})`,
    )
}

// Each invalid fixture names the error that the Lake schema gives for it, in a
// line `# Expected error: <part of the message>`. Thus a fixture that fails for
// another reason, for example a syntax error, does not pass.
function expectedError(fixturePath: string): string {
    const expected = /^# Expected error: (.+)$/m.exec(fs.readFileSync(fixturePath, 'utf8'))?.[1].trim()
    assert.ok(expected, `${fixturePath} has no line \`# Expected error: <part of the message>\``)
    return expected
}

const validDir = path.join(FIXTURES, 'valid')
const invalidDir = path.join(FIXTURES, 'invalid')

// Without fixtures, the loops make no tests, and the suite would pass.
const tomlFixtures = (dir: string) => fs.readdirSync(dir).filter(f => f.endsWith('.toml'))
const validFixtures = tomlFixtures(validDir)
const invalidFixtures = tomlFixtures(invalidDir)
assert.ok(validFixtures.length > 0, `expected at least one fixture under ${validDir}; got an empty directory`)
assert.ok(invalidFixtures.length > 0, `expected at least one fixture under ${invalidDir}; got an empty directory`)

describe('lakefile.toml schema validation', function () {
    this.timeout(60_000)

    let workRoot: string

    before(async function () {
        workRoot = makeTestWorkDir('lean4-lakefile-schema-')
        // Tombi looks for its configuration in the folders above the file.
        fs.writeFileSync(path.join(workRoot, 'tombi.toml'), TOMBI_CONFIG)

        // `.vscode-test.mjs` installs Tombi (`installExtensions`).
        const ext = extensions.getExtension(TOMBI_EXTENSION_ID)
        assert.ok(
            ext,
            `${TOMBI_EXTENSION_ID} is not installed in the test extension host — ` +
                'check `installExtensions` in `.vscode-test.mjs`.',
        )
        if (!ext.isActive) {
            await ext.activate()
        }
        assert.ok(ext.isActive, `${TOMBI_EXTENSION_ID} is installed but failed to activate`)

        // Fail early if Tombi cannot get the schema (for example offline).
        this.timeout(2 * 60_000)
        const probeFixture = validFixtures[0]
        const probeUri = await openLakefile(path.join(workRoot, 'schema-probe'), path.join(validDir, probeFixture))
        try {
            await waitForLakefileSchema(probeUri, {
                label:
                    `schema probe: the hover of valid/${probeFixture} did not refer to the Lake schema ` +
                    'within the budget — the Lake schema likely failed to load (offline runner? schema URL moved?)',
                timeout: 90_000,
            })
        } finally {
            await closeAllEditors()
        }
    })

    afterEach(afterEachReset)

    // A wait of `VALID_SETTLE_MS` for each fixture makes the suite slow. Thus the
    // hook opens all valid fixtures, waits one time, and saves the problems of
    // each file. The files must be open while the hook reads the diagnostics:
    // `afterEachReset` closes all editors after each test.
    describe('valid fixtures', function () {
        const problemsOf = new Map<string, Diagnostic[]>()

        before(async function () {
            this.timeout(validFixtures.length * TOMBI_TIMEOUT_MS + VALID_SETTLE_MS + 10_000)
            try {
                const opened: { fixtureName: string; uri: Uri }[] = []
                for (const fixtureName of validFixtures) {
                    const dir = path.join(workRoot, `valid-${fixtureName}`)
                    const uri = await openLakefile(dir, path.join(validDir, fixtureName))
                    await waitForLakefileSchema(uri, {
                        label: `the hover of valid/${fixtureName} to refer to the Lake schema`,
                        timeout: TOMBI_TIMEOUT_MS,
                    })
                    opened.push({ fixtureName, uri })
                }
                await new Promise(resolve => setTimeout(resolve, VALID_SETTLE_MS))
                for (const { fixtureName, uri } of opened) {
                    const isOpen = workspace.textDocuments.some(doc => doc.uri.toString() === uri.toString())
                    assert.ok(isOpen, `valid/${fixtureName} is not open, so its diagnostics can be missing`)
                    problemsOf.set(fixtureName, [
                        ...tombiDiagnostics(uri, DiagnosticSeverity.Error),
                        ...tombiDiagnostics(uri, DiagnosticSeverity.Warning),
                    ])
                }
            } finally {
                await closeAllEditors()
            }
        })

        for (const fixtureName of validFixtures) {
            it(`accepts valid/${fixtureName}`, () => {
                const problems = problemsOf.get(fixtureName)
                assert.ok(problems, `the hook did not read the diagnostics of valid/${fixtureName}`)
                assert.strictEqual(
                    problems.length,
                    0,
                    `expected no Tombi errors or warnings for valid/${fixtureName}, got:\n${formatDiagnostics(problems)}`,
                )
            })
        }
    })

    for (const fixtureName of invalidFixtures) {
        it(`rejects invalid/${fixtureName}`, async () => {
            const dir = path.join(workRoot, `invalid-${fixtureName}`)
            const expected = expectedError(path.join(invalidDir, fixtureName))
            const uri = await openLakefile(dir, path.join(invalidDir, fixtureName))
            await waitForTombiError(uri, expected, {
                label: `a Tombi error that contains ${JSON.stringify(expected)} for invalid/${fixtureName}`,
                timeout: TOMBI_TIMEOUT_MS,
            })
            // If the schema does not allow additional properties, Tombi reports valid
            // keys of a document with an error as unknown.
            const warnings = tombiDiagnostics(uri, DiagnosticSeverity.Warning)
            assert.strictEqual(
                warnings.length,
                0,
                `expected no Tombi warnings for invalid/${fixtureName}, got:\n${formatDiagnostics(warnings)}`,
            )
        })
    }
})
