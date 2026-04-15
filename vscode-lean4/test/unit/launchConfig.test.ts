import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliTestNames } from '../../scripts/cliTestNames.mjs'

// The debug configuration "Debug vscode-test-cli (pick label)" in
// `.vscode/launch.json` lists the files of `test/vscode-test-cli/` by hand:
// `launch.json` cannot compute the list. This test finds a missing entry.
describe('.vscode/launch.json', () => {
    it('lists each file of test/vscode-test-cli/ in the input `cliLabel`', () => {
        // `launch.json` has comments, so `JSON.parse` cannot read it.
        const launchJson = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.vscode', 'launch.json'), 'utf8')
        const options = /"id":\s*"cliLabel"[\s\S]*?"options":\s*\[([\s\S]*?)\]/.exec(launchJson)?.[1]
        expect(options, 'the input `cliLabel` with its `options`').toBeDefined()
        const labels = [...(options ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1]).sort()

        expect(labels).toEqual(cliTestNames)
    })
})
