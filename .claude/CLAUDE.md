# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Install dependencies (run from repo root)
npm install

# Build all packages
npm run build

# Watch mode for development (rebuilds on file changes)
npm run watch

# Lint all TypeScript/TSX files
npm run lint

# Package as .vsix for local install testing (from vscode-lean4/)
cd vscode-lean4 && npm run package
```

## Testing

`vscode-lean4/test/README.md` documents the test framework: how to run the tests, the isolated test home, the prompt stubs, and the helper map. Read it before you write or debug tests.

### Running tests locally

Use the `test:headless*` scripts. On Linux, they run the tests in `xvfb-run` (this needs `xvfb` or `xorg-x11-server-Xvfb`), so that the VS Code windows do not take the focus. `npm test` opens real windows.

```bash
# In the repository root. After `npm ci`, run `npm run build:dev` once:
# the type check of the tests and the type-aware lint need the `dist/` folders.
npm run test:headless        # vitest, tsc of the tests, grammar, vscode-test-cli, wdio
npm run test:unit            # vitest only; no VS Code, no xvfb

# In vscode-lean4/
npm run test:headless:wdio
npm run test:headless:network          # real network: elan install, Mathlib
npm run test:headless:vscode-test-cli -- cli-<name>   # one file of test/vscode-test-cli/
```

All runs use the test home `~/.cache/lean4-vscode-tests/home` (or `LEAN4_TEST_HOME_OVERRIDE`). Each run deletes everything in it except `.elan`. Do not start two runs at the same time. The npm scripts prepare the test home. If you start `vscode-test` or `wdio` directly, run `node scripts/prepareTestHome.mjs` in `vscode-lean4/` first.

The VS Code tests import only types from `src/` (`import type`). Get objects of the running extension through its exports (`test/helpers/client.ts`).

### Diagnosing test failures

- `vscode-lean4/vscode-test-cli-output/<test name>.json`: the state of the workbench when a test or hook failed (diagnostics, editors, output channels).
- The test output contains all output of the extension as `[output:<channel name>] <text>`. A failed assertion often comes after an earlier `error:` line that names the cause.
- `vscode-lean4/wdio-output/`: JUnit results, a screenshot of each failed wdio test, and the VS Code logs.
- `scripts/runAllTests.mjs` runs all suites even if one fails, and prints a summary at the end. `vscode-lean4/scripts/runCliTests.mjs` does the same for the `cli-*` labels.

### Diagnosing CI failures

`.github/workflows/test.yml` has the jobs `test`, `test-nightly` and `network`, each on Ubuntu and Windows. `.github/workflows/on-push.yml` has `lint` and `package`. When a test job fails, CI uploads `vscode-test-cli-output/` and `wdio-output/` as an artifact.

1. Read the `[output:<channel>]` lines near the failed test in the job log.
2. Download the artifact and read the JSON dump or the screenshot of the failed test.
3. If the failure does not occur locally, look for these causes: the `dist/` folders are not built, the runner image changed, or a new stable release of Lean changed the behavior (see "Lean versions" in `test/README.md`).

## Architecture

This is an **npm-workspaces monorepo** (with Nx as the task runner) containing five packages:

### Packages

| Package | Role |
|---|---|
| `vscode-lean4/` | VS Code extension entry point, LSP client, project management |
| `lean4-infoview/` | React-based infoview WebView (reusable, no VS Code dependency; rendered in the side panel) |
| `lean4-infoview-api/` | Shared TypeScript types/interfaces for editor↔infoview communication |
| `lean4-unicode-input/` | Unicode abbreviation engine (reusable, no VS Code dependency) |
| `lean4-unicode-input-component/` | React component wrapping the abbreviation engine (reusable, no VS Code dependency) |

### VS Code and LSP Information

- `vscode-lean4/package.json` is the declarative manifest configuration file of the VS Code extension
- `vscode-lean4/src/extension.ts` contains the main function of the VS Code extension (`activate()`)
- Information on the VS Code API can be found in the following places:
  - TypeScript API: `node_modules/@types/vscode/index.d.ts` or https://code.visualstudio.com/api/references/vscode-api 
  - Fields of `vscode-lean4/package.json`: https://code.visualstudio.com/api/references/extension-manifest
  - Contribution points in `vscode-lean4/package.json`: https://code.visualstudio.com/api/references/contribution-points
  - Activation events in `vscode-lean4/package.json`: https://code.visualstudio.com/api/references/activation-events
  - `when` clauses in `vscode-lean4/package.json`: https://code.visualstudio.com/api/references/when-clause-contexts
- Information on LSP (Language Server Protocol) can be found at https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
- A Lean specification of the implementation of LSP that is used by the Lean language server can be found at https://raw.githubusercontent.com/leanprover/lean4/refs/heads/master/src/Lean/Server/ProtocolOverview.lean

### Extension Activation Flow (`vscode-lean4/src/extension.ts`)

1. `activate()` registers always-on features (abbreviations, diagnostics, installer, project init, etc.)
2. It then lazily activates Lean 4 features only when a Lean document or project is detected
3. `LeanClientProvider` (`src/utils/clientProvider.ts`) maintains **one `LeanClient` per project folder**, managing the LSP lifecycle for each
4. `LeanClient` (`src/leanclient.ts`) wraps `vscode-languageclient` to communicate with the `lake serve` process

### Infoview Communication

The infoview runs in a VS Code WebView and communicates with the extension host through a custom RPC layer:
- `lean4-infoview-api` defines the `EditorApi` (editor→infoview calls) and `InfoviewApi` (infoview→editor calls) interfaces
- `vscode-lean4/src/rpc.ts` implements the bidirectional RPC mechanism over `postMessage`
- `vscode-lean4/src/infoview.ts` (`InfoProvider`) manages the WebView panel and implements `EditorApi`
- `lean4-infoview/src/infoview/editorConnection.ts` implements the infoview side

### Key Source Directories

- `vscode-lean4/src/utils/` — utilities: LSP converters, URI helpers, project detection, installer logic, elan management
- `vscode-lean4/src/diagnostics/` — setup/precondition checks shown when the extension first activates
- `vscode-lean4/src/abbreviation/` — abbreviation feature (Unicode input via `\` leader key)
- `vscode-lean4/syntaxes/` — TextMate grammars: `lean4.json` (main), `lean4-markdown.json` (~2250 lines, markdown inside Lean comments), `codeblock.json`
- `vscode-lean4/webview/` — WebView entry point bundled by webpack into `dist/`
- `lean4-infoview/src/infoview/` — React components for goals, messages, widgets, tooltips, trace explorer

### Build System

- **`vscode-lean4`**: webpack bundles the extension and the infoview WebView separately; the infoview dist is copied from `lean4-infoview/dist/` by `CopyPlugin`
- **`lean4-infoview`**: rollup bundles the React infoview
- **`lean4-unicode-input`** and **`lean4-unicode-input-component`**: TypeScript compiled directly
