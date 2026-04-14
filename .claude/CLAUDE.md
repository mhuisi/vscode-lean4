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
