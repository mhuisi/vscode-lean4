import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `vscode-tmgrammar-snap` writes a missing snapshot and passes. Thus a fixture
// without a committed snapshot would never be checked. Fail in that case.
// `recursive`: the test reads `test/grammar/**/*.lean`.
const grammarDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'grammar')
const missing = readdirSync(grammarDir, { recursive: true }).filter(
    f => f.endsWith('.lean') && !existsSync(join(grammarDir, `${f}.snap`)),
)
if (missing.length > 0) {
    console.error(`missing grammar snapshots for: ${missing.join(', ')}`)
    console.error('Run `npm run test:grammar:update`, read the new .snap files, and commit them.')
    process.exit(1)
}
