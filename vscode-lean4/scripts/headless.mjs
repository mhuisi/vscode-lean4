#!/usr/bin/env node
// Cross-platform `test:headless*` wrapper.
//
// On Linux, VS Code test instances opened by `vscode-test` and wdio
// rendered through the developer's real X / Wayland session steal focus
// for the duration of the suite. We solve this with `xvfb-run -a`, which
// allocates a virtual X display and routes the test instances through it.
//
// On Windows and macOS there is no equivalent focus-stealing problem on
// CI runners (no display server) and no equivalent of xvfb in the
// upstream toolchain. Running the inner command directly gives the same
// observable behavior. So `npm run test:headless*` becomes:
//   - Linux:        xvfb-run -a <command…>
//   - Windows/mac:  <command…>
//
// Thus the npm scripts are the same on all operating systems, and the CI
// workflows and the docs do not need a separate command for each platform.
import { exitLike, runChild } from './childProcess.mjs'

const args = process.argv.slice(2)
if (args.length === 0) {
    console.error('usage: headless.mjs <command> [args...]')
    process.exit(2)
}

const useXvfb = process.platform === 'linux'
// Set the screen size: the default of some `xvfb-run` builds is 640x480, and
// at that size wdio clicks land on the wrong elements.
const cmd = useXvfb ? 'xvfb-run' : args[0]
const cmdArgs = useXvfb ? ['-a', '-s', '-screen 0 1920x1080x24', ...args] : args.slice(1)

// `shell` only on Windows, where npm is a `.cmd` shim. Elsewhere we pass the
// arguments as they are, so that the `-s` value above stays one argument.
exitLike(await runChild(cmd, cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32' }))
