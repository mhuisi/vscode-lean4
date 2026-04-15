import { execFileSync } from 'node:child_process'

// The git calls of the tests ignore the global and system configuration (for
// example `commit.gpgsign` or `core.hooksPath`). Requires git 2.32 or later.
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'
const ISOLATED_GIT_ENV: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
}

// Runs `git` in `cwd` with the given args. stdio piped so stderr is captured
// in the thrown error rather than flooding test output on failure.
export function git(cwd: string, ...args: string[]): Buffer {
    return execFileSync('git', args, { cwd, env: ISOLATED_GIT_ENV, stdio: 'pipe' })
}

// Same as `git` but returns stdout decoded as UTF-8. Convenient for reading
// `git log` / `git config --get` output.
export function gitText(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, env: ISOLATED_GIT_ENV, encoding: 'utf8' })
}

// Initializes a fresh repo in `dir` on the `main` branch, records an author,
// stages everything, and makes an initial commit. The identity is in one
// place, so that the tests do not set it again, and so that `user.email` and
// `user.name` are clearly different from the real configuration of the developer.
export function initGitRepo(dir: string): void {
    git(dir, 'init', '-b', 'main')
    git(dir, 'config', 'user.email', 'test@example.invalid')
    git(dir, 'config', 'user.name', 'Test')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'Initial commit')
}
