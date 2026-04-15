import { TextDocument, TextEditor, Uri, ViewColumn, commands, window, workspace } from 'vscode'

// Closes all editors. `afterEachReset` calls it after each test.
export async function closeAllEditors(): Promise<void> {
    await commands.executeCommand('workbench.action.closeAllEditors')
}

// The options of `openInEditor` and `showInEditor`. By default, VS Code opens a
// file in a preview tab, and the next file replaces that tab. With
// `preview: false`, the tab stays open.
export interface EditorOptions {
    preview?: boolean
}

// Opens `uri` in the first editor group. Without `ViewColumn.One`, the file
// opens in the column of the InfoView when the InfoView has the focus.
export async function openInEditor(uri: Uri, options: EditorOptions = {}): Promise<TextEditor> {
    return showInEditor(await workspace.openTextDocument(uri), options)
}

// Shows `doc` in the first editor group, for example an untitled document.
export async function showInEditor(doc: TextDocument, { preview }: EditorOptions = {}): Promise<TextEditor> {
    return window.showTextDocument(doc, { viewColumn: ViewColumn.One, preview })
}
