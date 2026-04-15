import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'

// Runs the `elan` CLI in the environment of the test home. The tests use these
// functions, not the elan code of the extension (`src/utils/elan.ts`): a test
// that checks the extension with the code of the extension cannot find a bug
// in that code. `execFile`, not `execFileSync`: a download takes minutes, and
// a synchronous call blocks the extension host for that time.

const execFileAsync = promisify(execFile)

// Runs `elan ...args` and returns its stdout. Fails with stdout and stderr in
// the message if elan fails.
export async function elan(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
    try {
        const { stdout } = await execFileAsync('elan', args, {
            env: { ...process.env, ...env },
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        })
        return stdout
    } catch (e) {
        const err = e as Error & { stdout?: string; stderr?: string }
        throw new Error(`\`elan ${args.join(' ')}\` failed: ${err.message}\n${err.stderr ?? ''}${err.stdout ?? ''}`)
    }
}

// Installs `toolchain`. Succeeds if it is installed already.
export async function elanInstallToolchain(toolchain: string): Promise<void> {
    try {
        await elan(['toolchain', 'install', toolchain])
    } catch (e) {
        if (!/is already installed/.test((e as Error).message)) throw e
    }
}

// The installed toolchains (`elan toolchain list`). If there are none, elan
// prints `No installed toolchains`.
export async function elanInstalledToolchains(): Promise<string[]> {
    return (await elan(['toolchain', 'list']))
        .split(/\r?\n/)
        .map(line => line.replace(/\(default\)$/, '').trim())
        .filter(line => line.length > 0 && !/^no installed toolchains/i.test(line))
}

// The default toolchain as `elan default` wrote it to `settings.toml`, for
// example `leanprover/lean4:stable`.
export function elanDefaultToolchain(): string | undefined {
    const settingsPath = path.join(process.env.ELAN_HOME ?? '', 'settings.toml')
    if (!fs.existsSync(settingsPath)) return undefined
    return /^default_toolchain\s*=\s*"([^"]*)"/m.exec(fs.readFileSync(settingsPath, 'utf8'))?.[1]
}

// The installed version that elan uses for `toolchain` without a network
// query (`resolved_active.cached` of `elan dump-state --no-net`), for example
// `leanprover/lean4:v4.20.0` for `leanprover/lean4:stable`.
export async function elanCachedResolution(toolchain: string): Promise<string | undefined> {
    const state = JSON.parse(await elan(['dump-state', '--no-net'], { ELAN_TOOLCHAIN: toolchain })) as {
        toolchains?: { resolved_active?: { cached?: string | null } | null }
    }
    return state.toolchains?.resolved_active?.cached ?? undefined
}
