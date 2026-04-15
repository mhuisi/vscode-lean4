import { defineConfig } from 'vitest/config'

// Vitest runs the pure TypeScript tests of all packages. A test that imports
// `vscode` belongs in `vscode-lean4/test/{vscode-test-cli,wdio,network}`.
// `lean4-infoview/test/breaking.ts` is not a vitest test: `npm test` of the
// infoview package type-checks it.
export default defineConfig({
    test: {
        environment: 'node',
        include: [
            'lean4-unicode-input/test/**/*.test.ts',
            'lean4-infoview-api/test/**/*.test.ts',
            'vscode-lean4/test/unit/**/*.test.ts',
        ],
        reporters: ['default'],
    },
})
