import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { rmAsync, rmSync } from './fs'
import { requireIsolatedTestHome } from './testHome'
import { withTimeout } from './timeouts'

// Compiles a small .NET program that prints `output`. On Windows, elan runs
// `bin\<tool>.exe`, so a script is not sufficient. PowerShell's `Add-Type`
// uses the C# compiler of .NET, which GitHub's Windows runners have.
// `-EncodedCommand` prevents quoting problems. `JSON.stringify` gives a valid
// C# string literal.
function compileWindowsStub(exePath: string, output: string): void {
    const psSingleQuote = (s: string) => `'${s.replace(/'/g, "''")}'`
    const csSource = `using System;
class Program {
    static void Main() { Console.WriteLine(${JSON.stringify(output)}); }
}`
    const psScript = `$ErrorActionPreference = 'Stop'
Add-Type -OutputType ConsoleApplication -OutputAssembly ${psSingleQuote(exePath)} -TypeDefinition @'
${csSource}
'@`
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        stdio: ['ignore', 'pipe', 'pipe'],
    })
}

// Links a mock toolchain `name` whose `lean` and `lake` print the given
// versions. A fixture uses it with `name` in its `lean-toolchain` file. Use
// `withMockToolchain`, which removes the link again.
function createMockToolchain(
    name: string,
    { leanVersion, lakeVersion = 'Lake version 5.0.0' }: { leanVersion: string; lakeVersion?: string },
): string {
    const { testHome, elanHome } = requireIsolatedTestHome({ requireElanHome: true })
    const toolchainDir = path.join(testHome, 'mock-toolchains', name)
    const binDir = path.join(toolchainDir, 'bin')
    fs.mkdirSync(binDir, { recursive: true })

    const writeScript = (scriptName: string, output: string) => {
        if (process.platform === 'win32') {
            compileWindowsStub(path.join(binDir, `${scriptName}.exe`), output)
        } else {
            // Single-quote the output and escape any embedded `'` for `sh`.
            const escaped = output.replace(/'/g, "'\\''")
            const file = path.join(binDir, scriptName)
            fs.writeFileSync(file, `#!/bin/sh\necho '${escaped}'\n`)
            fs.chmodSync(file, 0o755)
        }
    }
    writeScript('lean', leanVersion)
    writeScript('lake', lakeVersion)

    // `elan toolchain link` fails if the toolchain exists, for example after
    // a test that was stopped.
    removeToolchainFolder(elanHome, name)
    execFileSync('elan', ['toolchain', 'link', name, toolchainDir], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    return toolchainDir
}

// Removes the toolchain `name` from `<elanHome>/toolchains`. We do not use
// `elan toolchain uninstall`: on Windows, the CI cache restores a link as a
// normal folder, and elan does not remove it. For a link, we remove only the
// link: `withLinkedToolchain` links a real toolchain, which must stay.
// `fs.unlinkSync` also removes a directory symlink or junction on Windows.
function removeToolchainFolder(elanHome: string, name: string): void {
    const folder = path.join(elanHome, 'toolchains', name)
    let stats: fs.Stats
    try {
        stats = fs.lstatSync(folder)
    } catch {
        return // The toolchain does not exist.
    }
    if (stats.isSymbolicLink()) {
        fs.unlinkSync(folder)
    } else {
        rmSync(folder)
    }
}

// `rmAsync` waits up to about 30 s. If the removal takes longer, the error names
// this step, and not only the timeout of the test.
export const MOCK_TOOLCHAIN_REMOVAL_TIMEOUT_MS = 60_000

// Removes the link and the mock toolchain. When a test ends, the extension can
// still run a program of the mock toolchain (for example `lean --server` after
// a warning), and on Windows, a running program cannot be deleted. Thus the
// removal of the folder waits asynchronously.
async function removeMockToolchain(name: string): Promise<void> {
    const { testHome, elanHome } = requireIsolatedTestHome({ requireElanHome: true })
    removeToolchainFolder(elanHome, name)
    const folder = path.join(testHome, 'mock-toolchains', name)
    await withTimeout(rmAsync(folder), MOCK_TOOLCHAIN_REMOVAL_TIMEOUT_MS, `the removal of ${folder}`)
}

// Links a mock toolchain, runs `body`, and removes the toolchain again.
export async function withMockToolchain<T>(
    name: string,
    opts: { leanVersion: string; lakeVersion?: string },
    body: () => Promise<T>,
): Promise<T> {
    createMockToolchain(name, opts)
    let result: T
    try {
        result = await body()
    } catch (e) {
        // An error of the removal must not hide the error of `body`. The error of
        // `body` is often its cause, for example when the extension still runs
        // the toolchain.
        await removeMockToolchain(name).catch(removalError => {
            console.error(`[mock-toolchain] ${(removalError as Error).message}`)
        })
        throw e
    }
    await removeMockToolchain(name)
    return result
}

// Links the installed toolchain folder `target` as the toolchain `name`, runs
// `body`, and removes the link again.
export async function withLinkedToolchain<T>(name: string, target: string, body: () => Promise<T>): Promise<T> {
    const { elanHome } = requireIsolatedTestHome({ requireElanHome: true })
    removeToolchainFolder(elanHome, name)
    execFileSync('elan', ['toolchain', 'link', name, target], { env: process.env, stdio: 'pipe' })
    try {
        return await body()
    } finally {
        removeToolchainFolder(elanHome, name)
    }
}
