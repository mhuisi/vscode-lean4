import {
    ContextMenuEntry,
    InfoviewConfig,
    LeanFileProgressParams,
    ServerStoppedReason,
    TextInsertKind,
} from '@leanprover/infoview-api'
import { join } from 'path'
import {
    commands,
    Diagnostic,
    Disposable,
    env,
    ExtensionContext,
    Position,
    Range,
    Selection,
    TextEditor,
    TextEditorRevealType,
    Uri,
    Webview,
    window,
    workspace,
} from 'vscode'
import * as ls from 'vscode-languageserver-protocol'
import {
    getEditorLineHeight,
    getInfoViewAutoOpen,
    getInfoViewConfig,
    getInfoViewStyle,
    minIfProd,
    prodOrDev,
    saveInfoViewConfig,
} from './config'
import { EditorActions, InfoviewPanel } from './infoviewPanel'
import { LeanClient } from './leanclient'
import { LeanClientProvider } from './utils/clientProvider'
import { c2pConverter, LeanPublishDiagnosticsParams, p2cConverter } from './utils/converters'
import { ExtUri, parseExtUri, toExtUri } from './utils/exturi'
import { lean, LeanEditor } from './utils/leanEditorProvider'
import { displayNotification } from './utils/notifs'
import { viewColumnOfActiveTextEditor } from './utils/viewColumn'

/**
 * For each context menu entry of the InfoView, the argument of its command `lean4.infoview.<entry>`
 * that contains the ID of the element that the user clicked.
 */
const contextMenuIdArgs: Record<ContextMenuEntry, string> = {
    goToDefinition: 'interactiveCodeTagId',
    select: 'selectableLocationId',
    unselect: 'unselectableLocationId',
    unselectAll: 'selectedLocationsId',
    pause: 'pauseId',
    unpause: 'unpauseId',
    pin: 'pinId',
    unpin: 'unpinId',
    refresh: 'refreshId',
    pauseAllMessages: 'pauseAllMessagesId',
    unpauseAllMessages: 'unpauseAllMessagesId',
    copyState: 'copyStateId',
    copyMessage: 'copyMessageId',
    goToPinnedLocation: 'goToPinnedLocationId',
    goToMessageLocation: 'goToMessageLocationId',
    hideTraceSearch: 'hideTraceSearchId',
    showTraceSearch: 'showTraceSearchId',
    displayTargetBeforeAssumptions: 'displayTargetBeforeAssumptionsId',
    displayAssumptionsBeforeTarget: 'displayAssumptionsBeforeTargetId',
    hideTypeAssumptions: 'hideTypeAssumptionsId',
    showTypeAssumptions: 'showTypeAssumptionsId',
    hideInstanceAssumptions: 'hideInstanceAssumptionsId',
    showInstanceAssumptions: 'showInstanceAssumptionsId',
    hideInaccessibleAssumptions: 'hideInaccessibleAssumptionsId',
    showInaccessibleAssumptions: 'showInaccessibleAssumptionsId',
    hideLetValues: 'hideLetValuesId',
    showLetValues: 'showLetValuesId',
    hideGoalNames: 'hideGoalNamesId',
    showGoalNames: 'showGoalNamesId',
    emphasizeFirstGoal: 'emphasizeFirstGoalId',
    deemphasizeFirstGoal: 'deemphasizeFirstGoalId',
    saveSettings: 'saveSettingsId',
}

export class InfoProvider implements Disposable {
    /** The panel of the InfoView, if it is open. Otherwise `undefined`. */
    private panel?: InfoviewPanel
    /** The InfoProvider's subscriptions, to be cleaned up when it is disposed. */
    private subscriptions: Disposable[] = []

    private stylesheet: string = ''
    private autoOpened: boolean = false

    // the key is the LeanClient.getClientFolder()
    private clientsFailed: Map<string, ServerStoppedReason> = new Map()

    private editorActions: EditorActions = {
        saveConfig: async (config: InfoviewConfig) => saveInfoViewConfig(config),
        copyToClipboard: async text => {
            await env.clipboard.writeText(text)
            displayNotification('Information', `Copied to clipboard: ${text}`)
        },
        insertText: async (text, kind, tdpp) => {
            let uri: ExtUri | undefined
            let pos: Position | undefined
            if (tdpp) {
                uri = toExtUri(p2cConverter.asUri(tdpp.textDocument.uri))
                if (uri === undefined) {
                    return
                }
                pos = p2cConverter.asPosition(tdpp.position)
            }
            await this.handleInsertText(text, kind, uri, pos)
        },
        applyEdit: async (e: ls.WorkspaceEdit) => {
            const we = await p2cConverter.asWorkspaceEdit(e)

            const edits = we.entries()
            if (edits.length !== 1) {
                return
            }
            const [uri, _] = edits[0]
            const extUri = toExtUri(uri)
            if (extUri === undefined) {
                return
            }
            const leanEditor = lean.getVisibleLeanEditorsByUri(extUri).at(0)
            if (leanEditor === undefined) {
                return
            }
            await window.showTextDocument(leanEditor.editor.document, leanEditor.editor.viewColumn, false)

            await workspace.applyEdit(we)
        },
        showDocument: async show => {
            const uri = parseExtUri(show.uri)
            if (uri === undefined) {
                return
            }
            void this.revealEditorSelection(uri, p2cConverter.asRange(show.selection))
        },
        restartFile: async uri => {
            const extUri = parseExtUri(uri)
            if (extUri === undefined) {
                return
            }
            this.clientProvider.restartFile(extUri)
        },
    }

    constructor(
        private clientProvider: LeanClientProvider,
        private context: ExtensionContext,
    ) {
        this.updateStylesheet()

        this.subscriptions.push(
            clientProvider.clientAdded(client => {
                void this.onClientAdded(client)
            }),
            clientProvider.clientRemoved(client => {
                void this.onClientRemoved(client)
            }),
            clientProvider.clientStopped(([client, activeClient, reason]) => {
                void this.onActiveClientStopped(client, activeClient, reason)
            }),
            lean.onDidChangeActiveLeanEditor(() => this.sendPosition()),
            lean.onDidChangeLeanEditorSelection(() => this.sendPosition()),
            workspace.onDidChangeConfiguration(async _e => {
                // regression; changing the style needs a reload. :/
                this.updateStylesheet()
                await this.sendConfig()
            }),
            lean.onDidChangeLeanDocument(() => this.sendPosition()),
            lean.registerLeanEditorCommand('lean4.displayGoal', leanEditor => this.openPreview(leanEditor)),
            commands.registerCommand('lean4.toggleInfoview', () => this.toggleInfoview()),
            lean.registerLeanEditorCommand('lean4.displayList', async leanEditor => {
                await this.openPreview(leanEditor)
                await this.panel?.api.requestedAction({ kind: 'toggleAllMessages' })
            }),
            lean.registerLeanEditorCommand('lean4.infoView.copyToComment', () =>
                this.panel?.api.requestedAction({ kind: 'copyToComment' }),
            ),
            commands.registerCommand('lean4.infoView.toggleUpdating', () =>
                this.panel?.api.requestedAction({ kind: 'togglePaused' }),
            ),
            commands.registerCommand('lean4.infoView.toggleExpectedType', () =>
                this.panel?.api.requestedAction({ kind: 'toggleExpectedType' }),
            ),
            lean.registerLeanEditorCommand('lean4.infoView.toggleStickyPosition', () =>
                this.panel?.api.requestedAction({ kind: 'togglePin' }),
            ),
        )

        for (const [entry, idArg] of Object.entries(contextMenuIdArgs) as [ContextMenuEntry, string][]) {
            this.subscriptions.push(
                commands.registerCommand(`lean4.infoview.${entry}`, args =>
                    this.panel?.api.clickedContextMenu({ entry, id: args[idArg] }),
                ),
            )
        }
    }

    private async onClientRestarted(client: LeanClient) {
        await this.panel?.api.serverStopped(undefined) // clear any server stopped state
        const folderUri = client.getClientFolder()
        if (this.clientsFailed.has(folderUri.toString())) {
            this.clientsFailed.delete(folderUri.toString())
        }
        await this.initInfoView(lean.activeLeanEditor, client)
    }

    private async onClientAdded(client: LeanClient) {
        this.subscriptions.push(
            client.restarted(async () => {
                // This event is triggered both the first time the server starts
                // as well as when the server restarts.

                this.panel?.closeRpcSessions(client)

                // Need to fully re-initialize this newly restarted client with all the
                // existing subscriptions and resend position info and so on so the
                // infoview updates properly.
                await this.onClientRestarted(client)
            }),
            client.didSetLanguage(() => this.onLanguageChanged()),
        )

        // Note that when new client is first created it still fires client.restarted
        // event, so all onClientRestarted can happen there so we don't do it twice.
    }

    onClientRemoved(client: LeanClient) {
        // NOTE: we could index subscriptions made in `onClientAdded` by the client, and remove here
    }

    async onActiveClientStopped(client: LeanClient, activeClient: boolean, reason: ServerStoppedReason) {
        // Will show a message in case the active client stops
        // add failed client into a list (will be removed in case the client is restarted)
        if (activeClient) {
            // means that client and active client are the same and just show the error message
            await this.panel?.api.serverStopped(reason)
        }

        // remember this client is in a stopped state
        const key = client.getClientFolder()
        await this.sendPosition()
        if (!this.clientsFailed.has(key.toString())) {
            this.clientsFailed.set(key.toString(), reason)
        }
    }

    // Called when the extension is deactivated.
    dispose(): void {
        // Closes the panel, which also cleans up its subscriptions.
        this.panel?.dispose()
        for (const s of this.subscriptions) s.dispose()
    }

    private updateStylesheet() {
        // Here we add extra CSS variables which depend on the editor configuration,
        // but are not exposed by default.
        // Ref: https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content

        const extraCSS = `
            html {
                --vscode-editor-line-height: ${getEditorLineHeight()}px;
            }
        `
        const configCSS = getInfoViewStyle()
        this.stylesheet = extraCSS + configCSS
    }

    private async autoOpen(): Promise<boolean> {
        if (!this.panel && !this.autoOpened && getInfoViewAutoOpen() && lean.activeLeanEditor !== undefined) {
            // remember we've auto opened during this session so if user closes it it remains closed.
            this.autoOpened = true
            return await this.openPreview(lean.activeLeanEditor)
        }
        return false
    }

    private async toggleInfoview() {
        if (this.panel) {
            this.panel.dispose()
            // the onDispose handler sets this.panel = undefined
        } else if (lean.activeLeanEditor !== undefined) {
            await this.openPreview(lean.activeLeanEditor)
        } else {
            displayNotification(
                'Error',
                'No active Lean editor tab. Make sure to focus the Lean editor tab for which you wish to open the infoview.',
            )
        }
    }

    private async openPreview(leanEditor: LeanEditor): Promise<boolean> {
        if (this.panel) {
            this.panel.reveal()
        } else {
            this.panel = new InfoviewPanel(
                this.clientProvider,
                this.editorActions,
                webview => this.initialHtml(webview),
                panel => {
                    if (this.panel === panel) this.panel = undefined
                },
            )
            const client = this.clientProvider.findClient(leanEditor.documentExtUri)
            await this.initInfoView(leanEditor, client)
        }
        return true
    }

    private async initInfoView(leanEditor: LeanEditor | undefined, client: LeanClient | undefined) {
        if (leanEditor !== undefined) {
            const loc = this.getLocation(leanEditor)
            if (loc) {
                await this.panel?.api.initialize(loc)
            }
        }
        // The infoview gets information about file progress, diagnostics, etc.
        // by listening to notifications.  Send these notifications when the infoview starts
        // so that it has up-to-date information.
        if (client?.initializeResult) {
            await this.sendConfig()
            await this.panel?.api.serverStopped(undefined) // clear any server stopped state
            await this.panel?.api.serverRestarted(client.initializeResult)
            await this.sendDiagnostics(client)
            await this.sendProgress(client)
            await this.sendPosition()
        }
    }

    private async sendConfig() {
        await this.panel?.api.changedInfoviewConfig(getInfoViewConfig())
    }

    private static async getDiagnosticParams(
        uri: Uri,
        diagnostics: readonly Diagnostic[],
    ): Promise<LeanPublishDiagnosticsParams> {
        const params: LeanPublishDiagnosticsParams = {
            uri: c2pConverter.asUri(uri),
            diagnostics: await c2pConverter.asDiagnostics(diagnostics as Diagnostic[]),
        }
        return params
    }

    private async sendDiagnostics(client: LeanClient) {
        const panel = this.panel
        if (panel) {
            client.getDiagnostics()?.forEach(async (uri, diags) => {
                const params = await InfoProvider.getDiagnosticParams(uri, diags)
                await panel.api.gotServerNotification('textDocument/publishDiagnostics', params)
            })
        }
    }

    private async sendProgress(client: LeanClient) {
        if (!this.panel) return
        for (const [uri, processing] of client.progress) {
            const params: LeanFileProgressParams = {
                textDocument: {
                    uri: c2pConverter.asUri(uri.asUri()),
                    version: 0, // HACK: The infoview ignores this
                },
                processing,
            }
            await this.panel?.api.gotServerNotification('$/lean/fileProgress', params)
        }
    }

    private onLanguageChanged() {
        this.autoOpen()
            .then(async () => {
                await this.sendConfig()
                await this.sendPosition()
            })
            .catch(() => {})
    }

    private getLocation(leanEditor: LeanEditor): ls.Location | undefined {
        const selection = leanEditor.editor.selection
        return {
            uri: leanEditor.documentExtUri.toString(),
            range: {
                start: selection.start,
                end: selection.end,
            },
        }
    }

    private async sendPosition() {
        const editor = lean.activeLeanEditor
        if (editor === undefined) {
            return
        }
        const loc = this.getLocation(editor)
        const uri = editor.documentExtUri
        if (this.clientsFailed.size > 0) {
            const client = this.clientProvider.findClient(uri)
            if (client) {
                const reason = this.clientsFailed.get(client.getClientFolder().toString())
                if (reason) {
                    // send stopped event
                    await this.panel?.api.serverStopped(reason)
                } else {
                    await this.updateStatus(loc)
                }
            }
        } else {
            await this.updateStatus(loc)
        }
    }

    private async updateStatus(loc: ls.Location | undefined): Promise<void> {
        await this.panel?.api.serverStopped(undefined) // clear any server stopped state
        await this.autoOpen()
        await this.panel?.api.changedCursorLocation(loc)
    }

    private async revealEditorSelection(uri: ExtUri, selection?: Range) {
        let editor: TextEditor | undefined = lean.getVisibleLeanEditorsByUri(uri).at(0)?.editor
        if (editor === undefined) {
            editor = await window.showTextDocument(uri.asUri(), {
                viewColumn: viewColumnOfActiveTextEditor(),
                preserveFocus: false,
            })
        }
        if (selection !== undefined) {
            editor.revealRange(selection, TextEditorRevealType.InCenterIfOutsideViewport)
            editor.selection = new Selection(selection.start, selection.end)
            // ensure the text document has the keyboard focus.
            await window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false })
        }
    }

    private async handleInsertText(
        text: string,
        kind: TextInsertKind,
        uri?: ExtUri | undefined,
        pos?: Position | undefined,
    ) {
        let leanEditor: LeanEditor | undefined
        if (uri) {
            leanEditor = lean.getVisibleLeanEditorsByUri(uri).at(0)
        } else {
            leanEditor = lean.activeLeanEditor
        }
        if (leanEditor === undefined) {
            return
        }
        const editor = leanEditor.editor
        pos = pos ? pos : editor.selection.active
        if (kind === 'above') {
            // in this case, assume that we actually want to insert at the same
            // indentation level as the neighboring text
            const current_line = editor.document.lineAt(pos.line)
            const spaces = current_line.firstNonWhitespaceCharacterIndex
            const margin_str = [...Array(spaces).keys()].map(x => ' ').join('')
            let new_command = text.replace(/\n/g, '\n' + margin_str)
            new_command = `${margin_str}${new_command}\n`
            const insertPosition = current_line.range.start

            await editor.edit(builder => {
                builder.insert(insertPosition, new_command)
            })
        } else {
            await editor.edit(builder => {
                if (pos) builder.insert(pos, text)
            })
            editor.selection = new Selection(pos, pos)
        }
        // ensure the text document has the keyboard focus.
        await window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false })
    }

    private getLocalPath(webview: Webview, path: string): string {
        return webview.asWebviewUri(Uri.file(join(this.context.extensionPath, path))).toString()
    }

    private initialHtml(webview: Webview) {
        const libPostfix = `.${prodOrDev}${minIfProd}.js`
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8" />
                <meta http-equiv="Content-type" content="text/html;charset=utf-8">
                <title>InfoView</title>
                <style>${this.stylesheet}</style>
                <link rel="stylesheet" href="${this.getLocalPath(webview, 'dist/lean4-infoview/index.css')}">
            </head>
            <body>
                <div id="react_root"></div>
                <script
                    data-importmap-leanprover-infoview="${this.getLocalPath(webview, `dist/lean4-infoview/index${libPostfix}`)}"
                    data-importmap-react="${this.getLocalPath(webview, `dist/lean4-infoview/react${libPostfix}`)}"
                    data-importmap-react-jsx-runtime="${this.getLocalPath(webview, `dist/lean4-infoview/react-jsx-runtime${libPostfix}`)}"
                    data-importmap-react-dom="${this.getLocalPath(webview, `dist/lean4-infoview/react-dom${libPostfix}`)}"
                    src="${this.getLocalPath(webview, 'dist/webview.js')}"></script>
            </body>
            </html>`
    }
}
