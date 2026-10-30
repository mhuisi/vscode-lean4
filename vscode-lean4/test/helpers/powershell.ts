import { execFileSync } from 'node:child_process'
import * as path from 'node:path'

// Runs Windows PowerShell in the same state as `src/utils/batch.ts`: with its
// full path, without the profiles of the user, and without `PSModulePath`. In
// CI, the step shell `pwsh` sets `PSModulePath` to the module folders of
// PowerShell 7, and Windows PowerShell then cannot load its own modules
// (`withoutPSModulePath` in `src/utils/envPath.ts` explains this).
export function windowsPowerShell(args: string[]): void {
    const exe = path.win32.join(
        process.env.windir || process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
    )
    // The names of environment variables on Windows are case-insensitive.
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
    )
    execFileSync(exe, ['-NoProfile', '-NonInteractive', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
}
