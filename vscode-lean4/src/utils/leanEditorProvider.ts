import {
    commands,
    Disposable,
    EventEmitter,
    ExtensionContext,
    TextDocument,
    TextDocumentChangeEvent,
    TextEditor,
    TextEditorEdit,
    TextEditorSelectionChangeEvent,
    window,
    workspace,
} from 'vscode'
import { ExtUri, isExtUri, toExtUriOrError } from './exturi'
import { groupByKey, groupByUniqueKey } from './groupBy'

export function isLeanDocument(doc: TextDocument): boolean {
    return isExtUri(doc.uri) && (doc.languageId === 'lean4' || doc.languageId === 'lean')
}

export class LeanDocument {
    constructor(
        readonly doc: TextDocument,
        readonly extUri: ExtUri,
    ) {}

    equals(other: LeanDocument): boolean {
        return this.doc === other.doc
    }

    equalsTextDocument(other: TextDocument): boolean {
        return this.doc === other
    }

    static equalsWithUndefined(a: LeanDocument | undefined, b: LeanDocument | undefined): boolean {
        if (a === undefined) {
            return b === undefined
        }
        if (b === undefined) {
            return a === undefined
        }
        return a.equals(b)
    }
}

export class LeanEditor {
    constructor(
        readonly editor: TextEditor,
        readonly documentExtUri: ExtUri,
    ) {}

    equals(other: LeanEditor): boolean {
        return this.editor === other.editor
    }

    equalsTextEditor(other: TextEditor): boolean {
        return this.editor === other
    }

    static equalsWithUndefined(a: LeanEditor | undefined, b: LeanEditor | undefined): boolean {
        if (a === undefined) {
            return b === undefined
        }
        if (b === undefined) {
            return a === undefined
        }
        return a.equals(b)
    }
}

class LeanDocumentIndex {
    private docsByUri: Map<string, LeanDocument>

    /**
     * Assumes that `docs` only contains at most one `LeanDocument` per URI.
     * This is given for `TextDocument`s from VS Code.
     * */
    constructor(docs: LeanDocument[]) {
        this.docsByUri = groupByUniqueKey(docs, doc => doc.extUri.toString())
    }

    get(uri: ExtUri): LeanDocument | undefined {
        return this.docsByUri.get(uri.toString())
    }
}

class LeanEditorIndex {
    private editorsByUri: Map<string, LeanEditor[]>

    constructor(editors: LeanEditor[]) {
        this.editorsByUri = groupByKey(editors, editor => editor.documentExtUri.toString())
    }

    get(uri: ExtUri): LeanEditor[] | undefined {
        return this.editorsByUri.get(uri.toString())
    }
}

export class LeanEditorProvider implements Disposable {
    private subscriptions: Disposable[] = []

    // In mode 'Lean', the `LeanEditorProvider` will provide API for editors and documents with a language ID of `lean4` and `ExtUri` URIs, i.e. proper Lean documents.
    // In mode 'Text', the `LeanEditorProvider` will provide API for editors and documents with `ExtUri` uris, i.e. any file that might be considered in some context of the extension.
    // Both of these are useful occasionally, especially since VS Code lacks API to e.g. determine which visible text editors were revealed just now.
    private mode: 'Lean' | 'Text'

    private _visibleLeanEditors: LeanEditor[]
    private visibleLeanEditorsByUri: LeanEditorIndex
    private readonly onDidChangeVisibleLeanEditorsEmitter = new EventEmitter<readonly LeanEditor[]>()
    readonly onDidChangeVisibleLeanEditors = this.onDidChangeVisibleLeanEditorsEmitter.event

    private _activeLeanEditor: LeanEditor | undefined
    private readonly onDidChangeActiveLeanEditorEmitter = new EventEmitter<LeanEditor | undefined>()
    readonly onDidChangeActiveLeanEditor = this.onDidChangeActiveLeanEditorEmitter.event

    private _lastActiveLeanEditor: LeanEditor | undefined
    private readonly onDidChangeLastActiveLeanEditorEmitter = new EventEmitter<LeanEditor | undefined>()
    readonly onDidChangeLastActiveLeanEditor = this.onDidChangeLastActiveLeanEditorEmitter.event

    private _leanDocuments: LeanDocument[]
    private leanDocumentsByUri: LeanDocumentIndex
    private readonly onDidChangeLeanDocumentsEmitter = new EventEmitter<readonly LeanDocument[]>()
    readonly onDidChangeLeanDocuments = this.onDidChangeLeanDocumentsEmitter.event
    private readonly onDidOpenLeanDocumentEmitter = new EventEmitter<LeanDocument>()
    readonly onDidOpenLeanDocument = this.onDidOpenLeanDocumentEmitter.event
    private readonly onDidCloseLeanDocumentEmitter = new EventEmitter<LeanDocument>()
    readonly onDidCloseLeanDocument = this.onDidCloseLeanDocumentEmitter.event

    private _lastActiveLeanDocument: LeanDocument | undefined
    private readonly onDidChangeLastActiveLeanDocumentEmitter = new EventEmitter<LeanDocument | undefined>()
    readonly onDidChangeLastActiveLeanDocument = this.onDidChangeLastActiveLeanDocumentEmitter.event

    private readonly onDidRevealLeanEditorEmitter = new EventEmitter<LeanEditor>()
    readonly onDidRevealLeanEditor = this.onDidRevealLeanEditorEmitter.event
    private readonly onDidConcealLeanEditorEmitter = new EventEmitter<LeanEditor>()
    readonly onDidConcealLeanEditor = this.onDidConcealLeanEditorEmitter.event

    private readonly onDidChangeLeanDocumentEmitter = new EventEmitter<TextDocumentChangeEvent>()
    readonly onDidChangeLeanDocument = this.onDidChangeLeanDocumentsEmitter.event

    private readonly onDidChangeLeanEditorSelectionEmitter = new EventEmitter<TextEditorSelectionChangeEvent>()
    readonly onDidChangeLeanEditorSelection = this.onDidChangeLeanEditorSelectionEmitter.event

    constructor(mode: 'Lean' | 'Text') {
        this.mode = mode

        this._visibleLeanEditors = this.filterLeanEditors(window.visibleTextEditors)
        this.visibleLeanEditorsByUri = new LeanEditorIndex(this._visibleLeanEditors)
        this.subscriptions.push(window.onDidChangeVisibleTextEditors(editors => this.updateVisibleTextEditors(editors)))

        this._activeLeanEditor = this.filterLeanEditor(window.activeTextEditor)
        this._lastActiveLeanEditor = this.filterLeanEditor(window.activeTextEditor)
        this._lastActiveLeanDocument = this.filterLeanDocument(window.activeTextEditor?.document)
        this.subscriptions.push(window.onDidChangeActiveTextEditor(editor => this.updateActiveTextEditor(editor)))

        this._leanDocuments = this.filterLeanDocuments(workspace.textDocuments)
        this.leanDocumentsByUri = new LeanDocumentIndex(this._leanDocuments)
        this.subscriptions.push(
            workspace.onDidOpenTextDocument(doc => {
                this.updateLeanDocuments(workspace.textDocuments)
                this.openLeanDocument(doc)
                // Update visible and active editors in case this `onDidOpenTextDocument` call was
                // triggered by a changed language ID.
                this.updateVisibleTextEditors(window.visibleTextEditors)
                this.updateActiveTextEditor(window.activeTextEditor)
            }),
        )
        this.subscriptions.push(
            workspace.onDidCloseTextDocument(doc => {
                // Update visible and active editors in case this `onDidCloseTextDocument` call was
                // triggered by a changed language ID.
                this.updateVisibleTextEditors(window.visibleTextEditors)
                this.updateActiveTextEditor(window.activeTextEditor)
                this.updateLeanDocuments(workspace.textDocuments)
                this.closeLeanDocument(doc)
                this.invalidateClosedLastActiveLeanDocument(doc)
            }),
        )
        this.subscriptions.push(workspace.onDidChangeTextDocument(event => this.updateDocument(event)))
        this.subscriptions.push(window.onDidChangeTextEditorSelection(event => this.updateTextEditorSelection(event)))
    }

    private updateVisibleTextEditors(visibleTextEditors: readonly TextEditor[]) {
        const oldVisibleLeanEditors = [...this._visibleLeanEditors]
        this.updateVisibleLeanEditors(visibleTextEditors)
        this.invalidateInvisibleLastActiveLeanEditor(visibleTextEditors)
        this.revealLeanEditors(oldVisibleLeanEditors, visibleTextEditors)
        this.concealLeanEditors(oldVisibleLeanEditors, visibleTextEditors)
    }

    private updateActiveTextEditor(activeTextEditor: TextEditor | undefined) {
        this.updateActiveLeanEditor(activeTextEditor)
        this.updateLastActiveLeanEditor(activeTextEditor)
        this.updateLastActiveLeanDocument(activeTextEditor)
    }

    private updateVisibleLeanEditors(visibleTextEditors: readonly TextEditor[]) {
        const newVisibleLeanEditors = this.filterLeanEditors(visibleTextEditors)
        if (
            newVisibleLeanEditors.length === this._visibleLeanEditors.length &&
            newVisibleLeanEditors.every((newVisibleLeanEditor, i) =>
                newVisibleLeanEditor.equals(this._visibleLeanEditors[i]),
            )
        ) {
            return
        }
        this._visibleLeanEditors = newVisibleLeanEditors
        this.visibleLeanEditorsByUri = new LeanEditorIndex(newVisibleLeanEditors)
        this.onDidChangeVisibleLeanEditorsEmitter.fire(newVisibleLeanEditors)
    }

    private revealLeanEditors(
        oldVisibleLeanEditors: readonly LeanEditor[],
        newVisibleTextEditors: readonly TextEditor[],
    ) {
        const oldVisibleLeanEditorsIndex = new Set(oldVisibleLeanEditors.map(leanEditor => leanEditor.editor))
        const newVisibleLeanEditors = this.filterLeanEditors(newVisibleTextEditors)
        const revealedLeanEditors = newVisibleLeanEditors.filter(
            newVisibleLeanEditor => !oldVisibleLeanEditorsIndex.has(newVisibleLeanEditor.editor),
        )
        for (const revealedLeanEditor of revealedLeanEditors) {
            this.onDidRevealLeanEditorEmitter.fire(revealedLeanEditor)
        }
    }

    private concealLeanEditors(
        oldVisibleLeanEditors: readonly LeanEditor[],
        newVisibleTextEditors: readonly TextEditor[],
    ) {
        const newVisibleLeanEditors = this.filterLeanEditors(newVisibleTextEditors)
        const newVisibleLeanEditorsIndex = new Set(newVisibleLeanEditors.map(leanEditor => leanEditor.editor))
        const concealedLeanEditors = oldVisibleLeanEditors.filter(
            newVisibleLeanEditor => !newVisibleLeanEditorsIndex.has(newVisibleLeanEditor.editor),
        )
        for (const concealedLeanEditor of concealedLeanEditors) {
            this.onDidConcealLeanEditorEmitter.fire(concealedLeanEditor)
        }
    }

    private updateActiveLeanEditor(activeTextEditor: TextEditor | undefined) {
        const newActiveLeanEditor = this.filterLeanEditor(activeTextEditor)
        if (LeanEditor.equalsWithUndefined(newActiveLeanEditor, this._activeLeanEditor)) {
            return
        }
        this._activeLeanEditor = newActiveLeanEditor
        this.onDidChangeActiveLeanEditorEmitter.fire(newActiveLeanEditor)
    }

    private invalidateInvisibleLastActiveLeanEditor(visibleTextEditors: readonly TextEditor[]) {
        if (
            this._lastActiveLeanEditor !== undefined &&
            !visibleTextEditors.includes(this._lastActiveLeanEditor.editor)
        ) {
            this._lastActiveLeanEditor = undefined
            this.onDidChangeLastActiveLeanEditorEmitter.fire(undefined)
        }
    }

    private updateLastActiveLeanEditor(activeTextEditor: TextEditor | undefined) {
        const newLastActiveLeanEditor = this.filterLeanEditor(activeTextEditor)
        if (newLastActiveLeanEditor === undefined) {
            return
        }
        if (LeanEditor.equalsWithUndefined(newLastActiveLeanEditor, this._lastActiveLeanEditor)) {
            return
        }
        this._lastActiveLeanEditor = newLastActiveLeanEditor
        this.onDidChangeLastActiveLeanEditorEmitter.fire(newLastActiveLeanEditor)
    }

    private updateLeanDocuments(textDocuments: readonly TextDocument[]) {
        const newLeanDocuments = this.filterLeanDocuments(textDocuments)
        if (
            newLeanDocuments.length === this._leanDocuments.length &&
            newLeanDocuments.every((newLeanDocument, i) => newLeanDocument.equals(this._leanDocuments[i]))
        ) {
            return
        }
        this._leanDocuments = newLeanDocuments
        this.leanDocumentsByUri = new LeanDocumentIndex(newLeanDocuments)
        this.onDidChangeLeanDocumentsEmitter.fire(newLeanDocuments)
    }

    private openLeanDocument(textDocument: TextDocument) {
        const leanTextDocument = this.filterLeanDocument(textDocument)
        if (leanTextDocument === undefined) {
            return
        }
        this.onDidOpenLeanDocumentEmitter.fire(leanTextDocument)
    }

    private closeLeanDocument(textDocument: TextDocument) {
        const leanTextDocument = this.filterLeanDocument(textDocument)
        if (leanTextDocument === undefined) {
            return
        }
        this.onDidCloseLeanDocumentEmitter.fire(leanTextDocument)
    }

    private invalidateClosedLastActiveLeanDocument(closedTextDocument: TextDocument) {
        if (this._lastActiveLeanDocument?.doc === closedTextDocument) {
            this._lastActiveLeanDocument = undefined
            this.onDidChangeLastActiveLeanDocumentEmitter.fire(undefined)
        }
    }

    private updateLastActiveLeanDocument(activeTextEditor: TextEditor | undefined) {
        const newLastActiveLeanDocument = this.filterLeanDocument(activeTextEditor?.document)
        if (newLastActiveLeanDocument === undefined) {
            return
        }
        if (LeanDocument.equalsWithUndefined(newLastActiveLeanDocument, this._lastActiveLeanDocument)) {
            return
        }
        this._lastActiveLeanDocument = newLastActiveLeanDocument
        this.onDidChangeLastActiveLeanDocumentEmitter.fire(newLastActiveLeanDocument)
    }

    private updateDocument(event: TextDocumentChangeEvent) {
        if (!this.isLeanDocument(event.document)) {
            return
        }
        this.onDidChangeLeanDocumentEmitter.fire(event)
    }

    private updateTextEditorSelection(event: TextEditorSelectionChangeEvent) {
        if (!this.isLeanEditor(event.textEditor)) {
            return
        }
        this.onDidChangeLeanEditorSelectionEmitter.fire(event)
    }

    private isLeanDocument(doc: TextDocument): boolean {
        switch (this.mode) {
            case 'Lean':
                return isLeanDocument(doc)
            case 'Text':
                return isExtUri(doc.uri)
        }
    }

    private asLeanDocument(doc: TextDocument): LeanDocument | undefined {
        if (this.isLeanDocument(doc)) {
            return new LeanDocument(doc, toExtUriOrError(doc.uri))
        }
        return undefined
    }

    private filterLeanDocuments(docs: readonly TextDocument[]): LeanDocument[] {
        return docs.map(doc => this.asLeanDocument(doc)).filter(doc => doc !== undefined)
    }

    private filterLeanDocument(doc: TextDocument | undefined): LeanDocument | undefined {
        if (doc === undefined) {
            return undefined
        }
        return this.asLeanDocument(doc)
    }

    private isLeanEditor(editor: TextEditor): boolean {
        return this.isLeanDocument(editor.document)
    }

    private asLeanEditor(editor: TextEditor): LeanEditor | undefined {
        if (this.isLeanEditor(editor)) {
            return new LeanEditor(editor, toExtUriOrError(editor.document.uri))
        }
        return undefined
    }

    private filterLeanEditors(editors: readonly TextEditor[]): LeanEditor[] {
        return editors.map(editor => this.asLeanEditor(editor)).filter(editor => editor !== undefined)
    }

    private filterLeanEditor(editor: TextEditor | undefined): LeanEditor | undefined {
        if (editor === undefined) {
            return undefined
        }
        return this.asLeanEditor(editor)
    }

    get visibleLeanEditors(): readonly LeanEditor[] {
        return this._visibleLeanEditors
    }

    get activeLeanEditor(): LeanEditor | undefined {
        return this._activeLeanEditor
    }

    get lastActiveLeanEditor(): LeanEditor | undefined {
        return this._lastActiveLeanEditor
    }

    get leanDocuments(): readonly LeanDocument[] {
        return this._leanDocuments
    }

    get lastActiveLeanDocument(): LeanDocument | undefined {
        return this._lastActiveLeanDocument
    }

    getVisibleLeanEditorsByUri(uri: ExtUri): readonly LeanEditor[] {
        return this.visibleLeanEditorsByUri.get(uri) ?? []
    }

    getLeanDocumentByUri(uri: ExtUri): LeanDocument | undefined {
        return this.leanDocumentsByUri.get(uri)
    }

    registerLeanEditorCommand(
        command: string,
        callback: (leanEditor: LeanEditor, edit: TextEditorEdit, ...args: any[]) => void,
        thisArg?: any,
    ): Disposable {
        return commands.registerTextEditorCommand(
            command,
            (editor, edit, ...args) => {
                const leanEditor = this.filterLeanEditor(editor)
                if (leanEditor === undefined) {
                    return
                }
                callback(leanEditor, edit, ...args)
            },
            thisArg,
        )
    }

    dispose() {
        for (const s of this.subscriptions) {
            s.dispose()
        }
    }
}

export let lean: LeanEditorProvider
export let text: LeanEditorProvider

/** Must be called at the very start when the extension is activated so that `lean` is defined. */
export function registerLeanEditorProviders(context: ExtensionContext) {
    lean = new LeanEditorProvider('Lean')
    text = new LeanEditorProvider('Text')
    context.subscriptions.push(lean)
    context.subscriptions.push(text)
    context.subscriptions.push({
        dispose: () => {
            const u: any = undefined
            // Implicit invariant: When the extension deactivates, `lean` and `text` are not called after these assignments.
            lean = u
            text = u
        },
    })
}
