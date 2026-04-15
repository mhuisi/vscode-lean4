# vscode-lean4 tests

## Layout

- `vscode-test-cli/`: integration tests that run in the VS Code extension host through `@vscode/test-cli`. Each file runs in its own VS Code instance, with the label `cli-<file name>`. Elan must be installed. VS Code opens the fixture `lean-project` as the workspace, except for `adhoc` (no folder) and `multi-root` (the multi-root workspace in `fixtures/multi-root/`). To change this, edit `workspaceOf` in `.vscode-test.mjs`.
- `wdio/`: UI tests of the InfoView through `wdio-vscode-service`. Only these tests can read the content of a webview.
- `network/`: tests that download elan, a Lean toolchain and Mathlib. CI runs them only on the nightly schedule and on manual dispatch.
- `unit/`: pure TypeScript tests for vitest. They do not use VS Code.
- `grammar/`: snapshot tests for the TextMate grammars. See `grammar/README.md`.
- `helpers/`: shared code for the tests. See the helper map at the end of this file.
- `fixtures/`: Lean projects and files that the tests open.

## Run the tests

After `npm ci`, build all packages once: `npm run test:unit` and the lint need their `dist/` folders. `npm test` builds them itself.

```bash
# In the repository root
npm run build:dev
npm run test:headless        # unit, type check of the tests, grammar, vscode-test-cli, wdio
npm run test:unit            # vitest only

# In vscode-lean4/
npm run test:headless:vscode-test-cli                     # all files of vscode-test-cli/
npm run test:headless:vscode-test-cli -- cli-abbreviation # one file
npm run test:headless:wdio
npm run test:headless:network          # downloads several GB
```

The npm scripts of `vscode-lean4/` compile the tests and build the extension first. `npm test` in the root builds only one time for all suites, before the first suite. `scripts/runCliTests.mjs` takes labels as arguments: `cli-<file name>` or `network`. Without arguments, it runs all `cli-*` labels. It runs `network` after the other labels, because the network suite deletes `.elan`. If a compiled test file is missing in `out/`, the script stops with an error. You can also start the script with `node`: like npm, it adds the `node_modules/.bin` folders to PATH.

`.vscode-test.mjs` has the label `network` only if `LEAN4_TEST_NETWORK=1`. `scripts/runCliTests.mjs` sets this variable for the label `network`. Thus `vscode-test` without `--label`, and the Extension Test Runner of VS Code, do not start the network suite.

`scripts/runCliTests.mjs` gets the newest stable version of VS Code one time, and gives it to `vscode-test` as `LEAN4_VSCODE_VERSION`. If the script cannot get the version, `vscode-test` uses `stable`. To use another version, set `LEAN4_VSCODE_VERSION`.

wdio uses the newest stable version of VS Code that has a git tag on GitHub, because wdio-vscode-service reads the Chromedriver version from that tag (`scripts/vscodeVersions.mjs`). After a VS Code release, the tag can come some time after the release. To use another version, set `LEAN4_WDIO_VSCODE_VERSION`, for example to `1.143.1`. `scripts/runWdio.mjs` downloads this version itself and gives the executable to wdio as `LEAN4_WDIO_VSCODE_BINARY`, so that wdio-vscode-service makes no network requests for an installed version (the script explains why). If the script cannot get the newest version (for example offline), it uses the newest version in `.wdio-vscode-service/versions.txt`.

wdio downloads Chromedriver into `.wdio-vscode-service/chromedriver/`. For each VS Code version, wdio-vscode-service writes the major version of its Chromedriver into `versions.txt`. `scripts/runWdio.mjs` gives the newest cached driver with this major version to wdio as `CHROMEDRIVER_PATH`. Else wdio asks the network for the newest driver at each run, also if the driver is in the cache. To use another driver, set `CHROMEDRIVER_PATH`.

On Linux, `scripts/headless.mjs` runs the command in `xvfb-run` with a 1920x1080 screen, so that the VS Code windows do not take the focus. This needs the package `xvfb` (Debian, Ubuntu) or `xorg-x11-server-Xvfb` (Fedora). On Windows and macOS, the script runs the command directly. `npm test` without `headless` opens real VS Code windows.

If you stop a run with Ctrl-C or SIGTERM, or close its terminal, the run scripts also stop VS Code and wait for it (`scripts/childProcess.mjs`).

## Debug a test

Use the debug configuration "Debug vscode-test-cli (pick label)" in `.vscode/launch.json`. Its `preLaunchTask` compiles the tests and prepares the test home. When you add a file to `vscode-test-cli/`, add its name to the input `cliLabel` in `.vscode/launch.json`. `unit/launchConfig.test.ts` fails until you do.

On Linux, `.vscode-test.mjs` and `wdio.conf.mjs` also give Electron the flag `--ozone-platform=x11`. Without it, Electron uses Wayland if `WAYLAND_DISPLAY` is set, also inside `xvfb-run`.

## Test home

The tests do not use your home folder. `scripts/testHome.mjs` sets `HOME`, `USERPROFILE`, `ELAN_HOME`, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` to folders in the test home, `~/.cache/lean4-vscode-tests/home`. We do not use `/tmp`: on some distros it is a tmpfs that is too small for a Lean toolchain.

- At the start of each run, the setup deletes everything in the test home except `.elan`. Thus the runs reuse the downloaded toolchains, but all other state is new.
- The setup also makes the toolchain `LEAN4_TEST_TOOLCHAIN` (default: `leanprover/lean4:stable`) the elan default, and installs it, so that the first test does not wait for the download. It sets the default in each run, because a stopped run can leave another default. The network suite skips this step, because it installs elan itself. If `elan` is not on PATH, the setup fails. Only a run with no label other than `network` can start without elan.
- The setup removes all toolchain links in `.elan/toolchains`. The tests link toolchains only for the time of one test, so a link is a leftover of a stopped run.
- Only the run scripts do the setup: `scripts/runAllTests.mjs` (in the root), `scripts/runCliTests.mjs`, `scripts/runWdio.mjs` and `scripts/prepareTestHome.mjs`. `.vscode-test.mjs` and `wdio.conf.mjs` change no files, because tools that only read the configuration also load them (for example `vscode-test --list-configuration`). If you start `vscode-test` or `wdio` directly, run `node scripts/prepareTestHome.mjs` first. For the label `network`, also set `LEAN4_TEST_NETWORK=1`.
- Each label gets its own VS Code user data folder in the test home. Thus a setting that the extension writes does not affect other labels or later runs.
- The network suite deletes `.elan`. After a network run, the next run downloads the toolchain again. The network files run in a fixed order in one VS Code, because some of them change the state of the next ones. When you add a file to `network/`, add its name to `networkTestNames` in `scripts/cliTestNames.mjs`.
- On Windows, the elan installer adds `<test home>\.elan\bin` to the PATH of the user in the registry. The test home cannot isolate the registry. Thus, after the test, `elan-install.test.ts` removes this entry from the PATH of the user, and keeps all other entries (`helpers/windowsUserPath.ts`).
- Do not start two test runs at the same time: they use the same test home.

To use a different folder, set `LEAN4_TEST_HOME_OVERRIDE` to an absolute path. CI does this, so that it can cache `.elan`. Do not set `LEAN4_TEST_HOME` yourself: the run scripts set it for their child processes, which then do not prepare the test home again. The setup uses the folder only if it is empty, contains only `.elan`, or contains the marker file `.lean4-test-home`. The elan installer writes `.profile` into the folder, so the CI action `setup-elan` writes the marker file before it installs elan. It refuses a folder that is your home folder or contains it. Before a test deletes elan state, `requireIsolatedTestHome` makes sure that the marker file exists.

Earlier versions of this framework made a new `lean4-test-home-*` folder in `~/.cache/lean4-vscode-tests/` for each run. You can delete these folders.

## Lean versions

All fixtures use `leanprover/lean4:stable`, so that the tests show when a new stable release of Lean breaks the extension. The CI job `test` keys its elan cache on the current stable version (from `https://release.lean-lang.org/`). Thus a new stable release gets a new cache. The fixtures `mock-lean3-project` and `mock-ancient-lean4-project` use mock toolchains that the tests link with `elan toolchain link`. The fixture `multi-root/b` uses `lean4-test-alt`, a link to an installed toolchain that `multi-root.test.ts` makes.

If a new stable release breaks a test, the cause is usually in the extension. If the cause is a bug in Lean, pin the fixture to the last good version (`leanprover/lean4:vX.Y.Z`), and remove the pin when Lean has a fix.

The CI job `test-nightly` runs the same tests with `leanprover/lean4:nightly`. It sets nightly as the elan default, sets `LEAN4_TEST_TOOLCHAIN=leanprover/lean4:nightly`, and changes the `lean-toolchain` files of the fixtures from `:stable` to `:nightly`. It runs only on the nightly schedule and on manual dispatch. A failure there is often a change in Lean (error text, LSP messages) and not a bug in the extension. To reproduce it, make the same change to the fixtures as the CI step, and run the tests with `LEAN4_TEST_TOOLCHAIN=leanprover/lean4:nightly`. The setup then installs nightly and makes it the elan default.

## Failure output

The tests write their output to two folders in `vscode-lean4/`. Git ignores both folders. Each run deletes them first. If a CI job fails, CI uploads them, and also the VS Code logs of the `cli-*` labels (`<test home>/vscode-user-data/<label>/logs/`).

### `vscode-test-cli-output/`

- When a test or a `before`/`beforeEach` hook fails, `helpers/teardown.ts` writes `<test name>.json`. It contains the diagnostics of all files, the active editor (file, cursor, text), the visible and open editors, and the last 1 MiB of text of each output channel of the extension. The test output has all text of the output channels.
- The tests also write all output of the extension to stdout, as `[output:<channel name>] <text>`.
- At the end, `scripts/runCliTests.mjs` prints a table of the labels and the failure details of each failed label.

### `wdio-output/`

- `wdio-junit-<cid>.xml`: the results in JUnit format.
- `<test name>.png`: a screenshot of the workbench when a test failed.
- `vscode-logs/`: the log files of VS Code (extension host, renderer).

## Prompts and quick picks

The extension shows most notifications without waiting for them. Thus `withPrompts` replaces `window.show{Information,Warning,Error}Message` for the time of a test step, gives scripted answers, and writes each prompt to stdout:

```ts
await withPrompts(
    [choose(/^Delete all build artifacts\?$/, 'Proceed'), dismiss(/^Project cleaned successfully\./)],
    async () => {
        await commands.executeCommand('lean4.project.clean')
    },
)
```

- `choose(message, button)` answers the prompt whose message matches with that button. `dismiss(message)` dismisses it. These rules can match prompts in any order.
- `dismiss(message, { optional: true })` is for a prompt that a background event shows. The prompt can come after the step, or more than one time.
- `withPrompts` fails if a prompt has no matching answer, if an answer names a button that the prompt does not have, or if an answer is not used.
- `{ dismissRemaining: true }` dismisses prompts that no answer matches. Use it only when the test cannot control the prompts, and say why in a comment.
- When the command returns before the prompt appears, wait for it with `waitForPrompt(log, predicate, timeoutMs, label)` in the body.

`withQuickPicks(answers, body)` does the same for `window.showQuickPick`. An answer is a label, a RegExp for labels, or a function that gets the items. `stubStatefulQuickPick(label)` replaces `window.createQuickPick`. Call the `restore` function that it returns in a `finally`.

When a test times out, mocha does not stop its body, so the stubs of the body stay active. Thus the root `afterEach` hook of `helpers/teardown.ts` restores the stubs that a test left (`helpers/stubs.ts`). A new helper that replaces a `window` function must restore its stubs with the function from `trackStubs`.

## Imports from `src/`

The tests in `vscode-test-cli/`, `network/`, `wdio/` and `helpers/` run in VS Code, next to the webpack bundle of the extension. They import only types from `src/` (`import type`). A runtime import loads a second copy of the extension code, with its own state, and ESLint rejects it.

- Get the objects of the running extension through its exports: `getExports()` and `getClientProvider()` in `helpers/client.ts`.
- Check the results with code that is independent of the extension, for example with the `elan` CLI (`helpers/elan.ts`).
- The vitest tests in `unit/` can import `src/` modules that do not import `vscode`.

## Helper map

| Helper | Use |
|---|---|
| `activation.activateExtension()` | Activates the extension and captures its output channel. `teardown.ts` calls it for each file. |
| `editors.openInEditor(uri, { preview })`, `closeAllEditors()` | Open a file (with `preview: false`, the next file does not replace its tab); reset the editors. |
| `client.openAndAwaitClient(uri, timeoutMs)` | Open a file and wait until its Lean client runs. |
| `client.getExports()`, `getClientProvider()` | Get the exports of the running extension, or its `LeanClientProvider`. |
| `client.clientForFolder(folder)` | Get the Lean client of a project folder. |
| `lsp.waitForDiagnostics(uri, predicate, timeoutMs)` | Wait until the diagnostics match. Returns at once if the current diagnostics match. After an action, the predicate must match only the new state: a change does not show its cause (see `server-launch.test.ts`). |
| `lsp.hasError`, `hasErrorIncluding(text)`, `hasInfoIncluding(text)` | Predicates for `waitForDiagnostics`. Prefer a predicate with the text of the message: then a diagnostic from another cause does not match. |
| `elan.elan(args)`, `elanDefaultToolchain()`, `elanInstalledToolchains()`, `elanInstallToolchain(toolchain)`, `elanCachedResolution(toolchain)` | Run the `elan` CLI and read the elan state without the code of the extension. |
| `prompts.withPrompts`, `choose`, `dismiss`, `waitForPrompt` | See "Prompts and quick picks". |
| `quickPicks.withQuickPicks`, `stubStatefulQuickPick` | See "Prompts and quick picks". |
| `dialogs.withSaveDialog(uri, fn)`, `withOpenDialog(uris, fn)` | Answer `window.showSaveDialog` and `showOpenDialog`. |
| `stubs.trackStubs(stubs)` | Get a restore function for the stubs of a helper. `teardown.ts` restores the stubs that a test left. |
| `fixtures.scaffoldFromFixture(name, prefix)` | Copy a fixture into the test home, for tests that change the project. |
| `fixtures.assertNotInProject(dir)` | Make sure that no folder above `dir` has a `lean-toolchain` file or a lakefile, for tests of files outside of a project. |
| `lake.lake(cwd, args, timeoutMs)` | Run `lake` without a block of the extension host. The error contains stdout and stderr. |
| `testHome.requireIsolatedTestHome({ requireElanHome })` | Make sure that the test home is isolated before a test changes elan state. |
| `testHome.makeTestWorkDir(prefix)` | Make a scratch folder in the test home. |
| `mockToolchain.withMockToolchain(name, { leanVersion }, fn)` | Link a mock toolchain whose `lean` prints the given version. |
| `mockToolchain.withLinkedToolchain(name, target, fn)` | Link an installed toolchain folder under another name. |
| `git.git(cwd, ...args)`, `gitText`, `initGitRepo(dir)` | Run git without the global and system git configuration. |
| `windowsUserPath.removeTestElanFromWindowsUserPath()` | On Windows, remove `<test home>\.elan\bin` from the PATH of the user in the registry, after a test that installs elan. |
| `timeouts.*` | Shared timeouts, `pollFor` and `withTimeout`. |
| `typing.typeChars(text)`, `backspace`, `waitForText`, `expectTextSettles` | Type into the active editor and check the text, for the abbreviation tests. |
| `wdio.*` | InfoView helpers for wdio: `openFixtureFile`, `moveCursorTo`, `replaceLine`, `insertText`, `runCommand`, `revertAllEditors`, `isInfoViewOpen`, `waitForInfoView`, `withInfoView`, `waitForBody`, `expectBodyStays`, `expandAllMessages`, `collapseAllMessages`, `pinCurrentPosition`, `waitForErrorCount`. The InfoView keeps its old text until it has the new state. Thus, after an action, wait for text that only the new state has, for example the position in the header of a goal (`Pin.lean:4:0`). |
