import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { rmAsync, rmSync } from './fs'
import { psSingleQuote, windowsPowerShellScript } from './powershell'
import { requireIsolatedTestHome } from './testHome'

// Compiles a small .NET program that prints `output`. On Windows, elan runs
// `bin\<tool>.exe`, so a script is not sufficient. PowerShell's `Add-Type`
// uses the C# compiler of .NET, which GitHub's Windows runners have.
// `JSON.stringify` gives a valid C# string literal.
function compileWindowsStub(exePath: string, output: string): void {
    const csSource = `using System;
class Program {
    static void Main() { Console.WriteLine(${JSON.stringify(output)}); }
}`
    const psScript = `$ErrorActionPreference = 'Stop'
Add-Type -OutputType ConsoleApplication -OutputAssembly ${psSingleQuote(exePath)} -TypeDefinition @'
${csSource}
'@`
    windowsPowerShellScript(psScript)
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

// The time that the removal of the folder of a mock toolchain can take.
export const MOCK_TOOLCHAIN_REMOVAL_TIMEOUT_MS = 60_000

// On Windows, stops the processes whose program is in one of `folders`, and
// logs them. Windows can show the path of a program through the link of the
// toolchain or in its folder, so `folders` contains both. If a process was
// stopped, the log also shows the processes of Windows Error Reporting
// (`WerFault.exe`): they can keep a crashed process alive.
// An error of the script is only logged. Then the removal reports the lock.
function stopProcessesInFolders(folders: string[]): void {
    const prefixes = folders.map(folder => psSingleQuote(folder + path.win32.sep)).join(', ')
    const psScript = `$ErrorActionPreference = 'Stop'
$prefixes = @(${prefixes})
$all = @(Get-CimInstance Win32_Process)
$mock = @($all | Where-Object {
    $exe = $_.ExecutablePath
    $exe -and @($prefixes | Where-Object { $exe.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
})
foreach ($p in $mock) {
    "stopped $($p.Name) (PID $($p.ProcessId), parent $($p.ParentProcessId)): $($p.CommandLine)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($mock.Count -gt 0) {
    foreach ($p in @($all | Where-Object { $_.Name -eq 'WerFault.exe' })) {
        "found $($p.Name) (PID $($p.ProcessId), parent $($p.ParentProcessId)): $($p.CommandLine)"
    }
}`
    try {
        for (const line of windowsPowerShellScript(psScript).split(/\r?\n/)) {
            if (line.trim() !== '') console.log(`[mock-toolchain] ${line.trim()}`)
        }
    } catch (e) {
        console.error(`[mock-toolchain] could not stop the processes of the mock toolchain: ${(e as Error).message}`)
    }
}

// Removes the link and the mock toolchain. When a test ends, the extension can
// still run a program of the mock toolchain (for example `lean --server` after
// a warning), and on Windows, a running program cannot be deleted. Thus on
// Windows, we stop these programs first. The removal of the folder waits
// asynchronously, so that the extension can process the end of the programs.
async function removeMockToolchain(name: string): Promise<void> {
    const { testHome, elanHome } = requireIsolatedTestHome({ requireElanHome: true })
    removeToolchainFolder(elanHome, name)
    const folder = path.join(testHome, 'mock-toolchains', name)
    if (process.platform === 'win32') {
        stopProcessesInFolders([folder, path.join(elanHome, 'toolchains', name)])
    }
    try {
        await rmAsync(folder, MOCK_TOOLCHAIN_REMOVAL_TIMEOUT_MS)
    } catch (e) {
        throw new Error(
            `could not remove ${folder} in ${MOCK_TOOLCHAIN_REMOVAL_TIMEOUT_MS} ms: ${(e as Error).message}`,
        )
    }
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
