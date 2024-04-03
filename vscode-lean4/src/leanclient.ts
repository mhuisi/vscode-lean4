import { TextDocument, EventEmitter, Diagnostic,
    DocumentHighlight, Range, DocumentHighlightKind, workspace,
    Disposable, Uri, ConfigurationChangeEvent, OutputChannel, DiagnosticCollection,
    WorkspaceFolder, window, ProgressLocation, ProgressOptions, Progress } from 'vscode'
import {
    DiagnosticSeverity,
    DidChangeTextDocumentParams,
    DidCloseTextDocumentParams,
    DocumentFilter,
    InitializeResult,
    LanguageClient,
    LanguageClientOptions,
    PublishDiagnosticsParams,
    RevealOutputChannelOn,
    ServerOptions,
    State
} from 'vscode-languageclient/node'
import * as ls from 'vscode-languageserver-protocol'

import { toolchainPath, lakePath, addServerEnvPaths, serverArgs, serverLoggingEnabled, serverLoggingPath, shouldAutofocusOutput, getElaborationDelay, lakeEnabled, automaticallyBuildDependencies, getFallBackToStringOccurrenceHighlighting } from './config'
import { assert } from './utils/assert'
import { LeanFileProgressParams, LeanFileProgressProcessingInfo, ServerStoppedReason } from '@leanprover/infoview-api';
import { ExecutionExitCode, ExecutionResult, batchExecute } from './utils/batch'
import { readLeanVersion } from './utils/projectInfo';
import * as fs from 'fs';
import { URL } from 'url';
import { join } from 'path';
import { logger } from './utils/logger'
 // @ts-ignore
import { SemVer } from 'semver';
import { fileExists, isFileInFolder } from './utils/fsHelper';
import { c2pConverter, p2cConverter, patchConverters } from './utils/converters'
import { displayErrorWithOutput } from './utils/errors'
import path = require('path')

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type ServerProgress = Map<Uri, LeanFileProgressProcessingInfo[]>;

export function getFullRange(diag: Diagnostic): Range {
    return (diag as any)?.fullRange || diag.range;
}

export class LeanClient implements Disposable {
    running: boolean
	private client: LanguageClient | undefined
    private toolchainPath: string
    private outputChannel: OutputChannel;
    folderUri: Uri;
    private subscriptions: Disposable[] = []
    private noPrompt : boolean = false;
    private showingRestartMessage : boolean = false;
    private elanDefaultToolchain: string;
    private isRestarting: boolean = false
    private staleDepNotifier: Disposable | undefined

    private didChangeEmitter = new EventEmitter<DidChangeTextDocumentParams>()
    didChange = this.didChangeEmitter.event

    private diagnosticsEmitter = new EventEmitter<PublishDiagnosticsParams>()
    diagnostics = this.diagnosticsEmitter.event

    private didSetLanguageEmitter = new EventEmitter<string>();
    didSetLanguage = this.didSetLanguageEmitter.event

    private didCloseEmitter = new EventEmitter<DidCloseTextDocumentParams>();
    didClose = this.didCloseEmitter.event

    private customNotificationEmitter = new EventEmitter<{method: string, params: any}>();
    /** Fires whenever a custom notification (i.e. one not defined in LSP) is received. */
    customNotification = this.customNotificationEmitter.event;

    /** saved progress info in case infoview is opened, it needs to get all of it. */
    progress: ServerProgress = new Map()

    private progressChangedEmitter = new EventEmitter<[string, LeanFileProgressProcessingInfo[]]>()
    progressChanged = this.progressChangedEmitter.event

    private stoppedEmitter = new EventEmitter<ServerStoppedReason>()
    stopped = this.stoppedEmitter.event

    private restartedEmitter = new EventEmitter()
    restarted = this.restartedEmitter.event

    private restartingEmitter = new EventEmitter()
    restarting = this.restartingEmitter.event

    private restartedWorkerEmitter = new EventEmitter<string>()
    restartedWorker = this.restartedWorkerEmitter.event

    private serverFailedEmitter = new EventEmitter<string>();
    serverFailed = this.serverFailedEmitter.event

    /** Files which are open. */
    private isOpen: Map<string, TextDocument> = new Map()

    constructor(folderUri: Uri, outputChannel : OutputChannel, elanDefaultToolchain: string) {
        this.outputChannel = outputChannel; // can be null when opening adhoc files.
        this.folderUri = folderUri;
        this.elanDefaultToolchain = elanDefaultToolchain;
        if (!this.toolchainPath) this.toolchainPath = toolchainPath();
        this.subscriptions.push(workspace.onDidChangeConfiguration((e) => this.configChanged(e)));
        this.subscriptions.push(new Disposable(() => {
            if (this.staleDepNotifier) {
                this.staleDepNotifier.dispose()
            }
        }))
    }

    dispose(): void {
        this.subscriptions.forEach((s) => s.dispose())
        if (this.isStarted()) void this.stop()
    }

    async showRestartMessage(restartFile: boolean = false, uri?: Uri | undefined): Promise<void> {
        if (this.showingRestartMessage) {
            return
        }
        this.showingRestartMessage = true;
        let restartItem: string;
        let messageTitle: string;
        if (!restartFile) {
            restartItem = 'Restart Lean Server';
            messageTitle = 'Lean Server has stopped unexpectedly.'
        } else {
            restartItem = 'Restart Lean Server on this file';
            messageTitle = 'The Lean Server has stopped processing this file.'
        }
        const item = await window.showErrorMessage(messageTitle, restartItem)
        this.showingRestartMessage = false;
        if (item === restartItem) {
            if (restartFile && uri) {
                const document = workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString())
                if (document) {
                    await this.restartFile(document);
                }
            } else {
                void this.start();
            }
        }
    }

    async restart(): Promise<void> {
        if (this.isRestarting) {
            await window.showErrorMessage('Client is already being started.')
            return
        }
        this.isRestarting = true
        try {
            logger.log('[LeanClient] Restarting Lean Server')
            if (this.isStarted()) {
                await this.stop()
            }

            this.restartingEmitter.fire(undefined)
            this.toolchainPath = toolchainPath();

            const progressOptions: ProgressOptions = {
                location: ProgressLocation.Notification,
                title: 'Starting Lean language client',
                cancellable: false
            }
            await window.withProgress(progressOptions, async progress =>
                await this.startClient(progress))
        } finally {
            this.isRestarting = false
        }
    }

    private async startClient(progress: Progress<{ message?: string; increment?: number }>) {
        // Should only be called from `restart`

        const startTime = Date.now()
        progress.report({ increment: 0 })
        this.client = await this.setupClient()

        let insideRestart = true;
        try {
            this.client.onDidChangeState(async s => {
                // see https://github.com/microsoft/vscode-languageserver-node/issues/825
                if (s.newState === State.Starting) {
                    logger.log('[LeanClient] starting');
                } else if (s.newState === State.Running) {
                    const end = Date.now()
                    logger.log(`[LeanClient] running, started in ${end - startTime} ms`);
                    this.running = true; // may have been auto restarted after it failed.
                    if (!insideRestart) {
                        this.restartedEmitter.fire(undefined)
                    }
                } else if (s.newState === State.Stopped) {
                    this.running = false;
                    logger.log('[LeanClient] has stopped or it failed to start');
                    if (!this.noPrompt) {
                        // only raise this event and show the message if we are not the ones
                        // who called the stop() method.
                        this.stoppedEmitter.fire({message:'Lean server has stopped.', reason:''});
                        await this.showRestartMessage();
                    }
                }
            })
            progress.report({ increment: 80 })
            await this.client.start()
            const version = this.client.initializeResult?.serverInfo?.version
            if (version && new SemVer(version).compare('0.2.0') < 0) {
                if (this.staleDepNotifier) {
                    this.staleDepNotifier.dispose()
                }
                this.staleDepNotifier = this.diagnostics(params => this.checkForImportsOutdatedError(params))
            }

            // tell the new client about the documents that are already open!
            for (const key of this.isOpen.keys()) {
                const doc = this.isOpen.get(key);
                if (doc) this.notifyDidOpen(doc);
            }
            // if we got this far then the client is happy so we are running!
            this.running = true;
        } catch (error) {
            const msg = '' + error;
            logger.log(`[LeanClient] restart error ${msg}`);
            this.outputChannel.appendLine(msg);
            this.serverFailedEmitter.fire(msg);
            insideRestart = false;
            return;
        }

        // HACK(WN): Register a default notification handler to fire on custom notifications.
        // A mechanism to do this is provided in vscode-jsonrpc. One can register a `StarNotificationHandler`
        // here: https://github.com/microsoft/vscode-languageserver-node/blob/b2fc85d28a1a44c22896559ee5f4d3ba37a02ef5/jsonrpc/src/common/connection.ts#L497
        // which fires on any LSP notifications not in the standard, for example the `$/lean/..` ones.
        // However this mechanism is not exposed in vscode-languageclient, so we hack around its implementation.
        const starHandler = (method: string, params_: any) => {
            if (method === '$/lean/fileProgress' && this.client) {
                const params = params_ as LeanFileProgressParams;
                const uri = p2cConverter.asUri(params.textDocument.uri)
                this.progressChangedEmitter.fire([uri.toString(), params.processing]);
                // save the latest progress on this Uri in case infoview needs it later.
                this.progress.set(uri, params.processing);
            }

            this.customNotificationEmitter.fire({method, params: params_});
        };
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        this.client.onNotification(starHandler as any, () => {});

        // Reveal the standard error output channel when the server prints something to stderr.
        // The vscode-languageclient library already takes care of writing it to the output channel.
        let stderrMsgBoxVisible = false;
        (this.client as any)._serverProcess.stderr.on('data', async (chunk: Buffer) => {
            if (shouldAutofocusOutput()) {
                this.client?.outputChannel.show(true);
            } else if (!stderrMsgBoxVisible) {
                stderrMsgBoxVisible = true;
                await displayErrorWithOutput(`Lean server printed an error:\n${chunk.toString()}`)
                stderrMsgBoxVisible = false;
            }
        });

        this.restartedEmitter.fire(undefined)
        insideRestart = false;
    }

    private async checkForImportsOutdatedError(params: PublishDiagnosticsParams) {
        const fileUri = Uri.parse(params.uri)
        const fileName = path.basename(fileUri.fsPath)
        const isImportsOutdatedError = params.diagnostics.some(d =>
            d.severity === DiagnosticSeverity.Error
                && d.message.includes('Imports are out of date and must be rebuilt')
                && d.range.start.line === 0
                && d.range.start.character === 0
                && d.range.end.line === 0
                && d.range.end.character === 0)
        if (!isImportsOutdatedError) {
            return
        }

        const message = `Imports of '${fileName}' are out of date and must be rebuilt. Restarting the file will rebuild them.`
        const input = 'Restart File'
        const choice = await window.showInformationMessage(message, input)
        if (choice !== input) {
            return
        }

        const fileUriString = fileUri.toString()
        const document = workspace.textDocuments.find(doc => doc.uri.toString() === fileUriString)
        if (!document || document.isClosed) {
            void window.showErrorMessage(`'${fileName}' was closed in the meantime. Imports will not be rebuilt.`)
            return
        }

        await this.restartFile(document)
    }

    async withStoppedClient(action: () => Promise<void>): Promise<'Success' | 'IsRestarting'> {
        if (this.isRestarting) {
            return 'IsRestarting'
        }
        this.isRestarting = true // Ensure that client cannot be restarted in the mean-time

        if (this.isStarted()) {
            await this.stop()
        }

        await action()

        this.isRestarting = false
        await this.restart()

        return 'Success'
    }

    async openLean4Document(doc: TextDocument) {
        if (this.isOpen.has(doc.uri.toString())) return;

        this.isOpen.set(doc.uri.toString(), doc)

        if (!this.running) return; // there was a problem starting lean server.

        // didOpenEditor may have also changed the language, so we fire the
        // event here because the InfoView should be wired up to receive it now.
        this.didSetLanguageEmitter.fire(doc.languageId);

        this.notifyDidOpen(doc);
    }

    notifyDidOpen(doc: TextDocument) {
        void this.client?.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: doc.uri.toString(),
                languageId: doc.languageId,
                version: 1,
                text: doc.getText(),
            },
            dependencyBuildMode: automaticallyBuildDependencies() ? 'always' : 'never'
        });
    }

    async isInFolderManagedByThisClient(uri: Uri) : Promise<boolean> {
        if (this.folderUri) {
            if (this.folderUri.scheme !== uri.scheme) return false;
            if (this.folderUri.scheme === 'file') {
                const realPath1 = await fs.promises.realpath(this.folderUri.fsPath);
                const realPath2 = await fs.promises.realpath(uri.fsPath);
                return isFileInFolder(realPath2, realPath1);
            } else {
                return uri.toString().startsWith(this.folderUri.toString());
            }
        } else {
            return uri.scheme === 'untitled'
        }
    }

    getClientFolder() : string {
        return this.folderUri.toString();
    }

    start(): Promise<void> {
        return this.restart()
    }

    isStarted(): boolean {
        return this.client !== undefined
    }

    isRunning(): boolean {
        if (this.client) {
            return this.running;
        }
        return false;
    }

    async stop(): Promise<void> {
        assert(() => this.isStarted())
        if (this.client && this.running) {
            this.noPrompt = true;
            try {
                // some timing conditions can happen while running unit tests that cause
                // this to throw an exception which then causes those tests to fail.
                await this.client.stop();
            } catch (e) {
                logger.log(`[LeanClient] Error stopping language client: ${e}`)
            }
        }

        this.noPrompt = false;
        this.progress = new Map()
        this.client = undefined
        this.running = false
    }

    configChanged(e : ConfigurationChangeEvent): void {
        const newToolchainPath = toolchainPath();
        if (this.toolchainPath !== newToolchainPath){
            void this.restart();
        }
    }

    async restartFile(doc: TextDocument): Promise<void> {
        if (!this.running) return; // there was a problem starting lean server.

        assert(() => this.isStarted())

        if (!await this.isInFolderManagedByThisClient(doc.uri)){
            // skip it, this file belongs to a different workspace...
            return;
        }
        const uri = doc.uri.toString()
        logger.log(`[LeanClient] Restarting File: ${uri}`)
        // This causes a text document version number discontinuity. In
        // (didChange (oldVersion) => restartFile => didChange (newVersion))
        // the client emits newVersion = oldVersion + 1, despite the fact that the
        // didOpen packet emitted below initializes the version number to be 1.
        // This is not a problem though, since both client and server are fine
        // as long as the version numbers are monotonous.
        void this.client?.sendNotification('textDocument/didClose', {
            'textDocument': {
                uri
            }
        })
        void this.client?.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri,
                languageId: 'lean4',
                version: 1,
                text: doc.getText()
            },
            dependencyBuildMode: automaticallyBuildDependencies() ? 'always' : 'once'
        })
        this.restartedWorkerEmitter.fire(uri)
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    sendRequest(method: string, params: any) : Promise<any> {
        return this.running && this.client ? this.client.sendRequest(method, params) :
            new Promise<any>((_, reject)=>{ reject('Client is not running');});
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    sendNotification(method: string, params: any): Promise<void> | undefined{
        return this.running  && this.client ? this.client.sendNotification(method, params) : undefined;
    }

    async getDiagnosticParams(uri: Uri, diagnostics: readonly Diagnostic[]) : Promise<PublishDiagnosticsParams> {
        const params: PublishDiagnosticsParams = {
            uri: c2pConverter.asUri(uri),
            diagnostics: await c2pConverter.asDiagnostics(diagnostics as Diagnostic[])
        };
        return params;
    }

    getDiagnostics() : DiagnosticCollection | undefined {
        return this.running ? this.client?.diagnostics : undefined;
    }

    get initializeResult() : InitializeResult | undefined {
        return this.running ? this.client?.initializeResult : undefined
    }

    private async checkToolchainVersion(folderUri: Uri) : Promise<Date | undefined> {
        // see if we have a well known toolchain label that corresponds
        // to a known date like 'leanprover/lean4:nightly-2022-02-01'
        const toolchainVersion = await readLeanVersion(folderUri);
        if (toolchainVersion) {
            const nightly_match = /^leanprover\/lean4:nightly-(\d+)-(\d+)-(\d+)$/.exec(toolchainVersion);
            if (nightly_match) {
                return new Date(parseInt(nightly_match[1]), parseInt(nightly_match[2]) - 1, parseInt(nightly_match[3]));
            }
            const release_match = /^leanprover\/lean4:(\d+)-(\d+)-(\d+)$/.exec(toolchainVersion);
            if (release_match) {
                return new Date(2023, 9, 8);
            }
            if (toolchainVersion === 'leanprover/lean4:stable') {
                return new Date(2022, 2, 1);
            }
        }
        return undefined;
    }

    async checkLakeVersion(executable: string, version: string | null) : Promise<boolean> {
        // Check that the Lake version is high enough to support "lake serve" option.
        const versionOptions = version ? ['+' + version, '--version'] : ['--version']
        const start = Date.now()
        const result: ExecutionResult = await batchExecute(executable, versionOptions, this.folderUri?.fsPath);
        if (result.exitCode !== ExecutionExitCode.Success) {
            return false
        }
        logger.log(`[LeanClient] Ran '${executable} ${versionOptions.join(' ')}' in ${Date.now() - start} ms`);
        const lakeVersion = result.stdout
        const actual = this.extractVersion(lakeVersion)
        if (actual.compare('3.0.0') > 0) {
            return true;
        }
        return false;
    }

    private extractVersion(v: string | undefined) : SemVer {
        if (!v) return new SemVer('0.0.0');
        const prefix = 'Lake version'
        if (v.startsWith(prefix)) v = v.slice(prefix.length).trim()
        const pos = v.indexOf('(')
        if (pos > 0) v = v.slice(0, pos).trim()
        try {
            return new SemVer(v)
        } catch {
            return new SemVer('0.0.0');
        }
    }

    private async determineServerOptions(): Promise<ServerOptions> {
        const env = addServerEnvPaths(process.env)
        if (serverLoggingEnabled()) {
            env.LEAN_SERVER_LOG_DIR = serverLoggingPath()
        }

        const [serverExecutable, options] = await this.determineExecutable()

        const cwd = this.folderUri?.fsPath
        if (cwd) {
            // Add folder name to command-line so that it shows up in `ps aux`.
            options.push(cwd)
        } else {
            // Fixes issue #227, for adhoc files it would pick up the cwd from the open folder
            // which is not what we want.  For adhoc files we want the (default) toolchain instead.
            options.unshift('+' + this.elanDefaultToolchain)
            options.push('untitled')
        }

        return {
            command: serverExecutable,
            args: options.concat(serverArgs()),
            options: {
                cwd,
                env
            }
        }
    }

    private async determineExecutable(): Promise<[string, string[]]> {
        const lakeExecutable = lakePath() ||
            (this.toolchainPath ? join(this.toolchainPath, 'bin', 'lake') : 'lake')
        const leanExecutable =
            (this.toolchainPath) ? join(this.toolchainPath, 'bin', 'lean') : 'lean'

        if (await this.shouldUseLake(lakeExecutable)) {
            return [lakeExecutable, ['serve', '--']]
        } else{
            return [leanExecutable, ['--server']]
        }
    }

    private async shouldUseLake(lakeExecutable: string): Promise<boolean> {
        // check if the lake process will start (skip it on scheme: 'untitled' files)
        if (!lakeEnabled() || !this.folderUri || this.folderUri.scheme !== 'file') {
            return false
        }

        const lakefileLean = Uri.joinPath(this.folderUri, 'lakefile.lean')
        const lakefileToml = Uri.joinPath(this.folderUri, 'lakefile.toml')
        if (!await fileExists(new URL(lakefileLean.toString())) && !await fileExists(new URL(lakefileToml.toString()))) {
            return false
        }

        // see if we can avoid the more expensive checkLakeVersion call.
        const date = await this.checkToolchainVersion(this.folderUri);
        if (date) {
            // Feb 16 2022 is when the 3.1.0.pre was released.
            return date >= new Date(2022, 1, 16);
        }

        return await this.checkLakeVersion(lakeExecutable, null);
    }

    private obtainClientOptions(): LanguageClientOptions {
        const documentSelector: DocumentFilter = {
            language: 'lean4'
        }

        let workspaceFolder: WorkspaceFolder | undefined
        if (this.folderUri) {
            documentSelector.scheme = this.folderUri.scheme
            if (this.folderUri.scheme !== 'untitled') {
                documentSelector.pattern = `${this.folderUri.fsPath}/**/*`
                workspaceFolder = {
                    uri: this.folderUri,
                    name: path.basename(this.folderUri.fsPath),
                    index: 0 // the language client library does not actually need this index
                }
            }
        }

        return {
            outputChannel: this.outputChannel,
            revealOutputChannelOn: RevealOutputChannelOn.Never, // contrary to the name, this disables the message boxes
            documentSelector: [documentSelector],
            workspaceFolder,
            initializationOptions: {
                editDelay: getElaborationDelay(), hasWidgets: true,
            },
            connectionOptions: {
                maxRestartCount: 0,
                cancellationStrategy: undefined as any,
            },
            middleware: {
                handleDiagnostics: (uri, diagnostics, next) => {
                    next(uri, diagnostics);
                    if (!this.client) return;
                    const uri_ = c2pConverter.asUri(uri);
                    const diagnostics_ = [];
                    for (const d of diagnostics) {
                        const d_: ls.Diagnostic = {
                            ...c2pConverter.asDiagnostic(d),
                        };
                        diagnostics_.push(d_);
                    }
                    this.diagnosticsEmitter.fire({uri: uri_, diagnostics: diagnostics_});
                },

                didOpen: async () => {
                    // Note: as per the LSP spec: An open notification must not be sent more than once
                    // without a corresponding close notification send before. This means open and close
                    // notification must be balanced and the max open count for a particular textDocument
                    // is one.  So this even does nothing the notification is handled by the
                    // openLean4Document method below after the 'lean4' languageId is established and
                    // it has weeded out documents opened to invisible editors (like 'git:' schemes and
                    // invisible editors created for Ctrl+Hover events.  A side effect of unbalanced
                    // open/close notification is leaking 'lean --worker' processes.
                    // See https://github.com/microsoft/vscode/issues/78453).
                    return;
                },

                didChange: async (data, next) => {
                    await next(data);
                    if (!this.running || !this.client) return; // there was a problem starting lean server.
                    const params = c2pConverter.asChangeTextDocumentParams(data, data.document.uri, data.document.version);
                    this.didChangeEmitter.fire(params);
                },

                didClose: async (doc, next) => {
                    if (!this.isOpen.delete(doc.uri.toString())) {
                        return;
                    }
                    await next(doc);
                    if (!this.running || !this.client) return; // there was a problem starting lean server.
                    const params = c2pConverter.asCloseTextDocumentParams(doc);
                    this.didCloseEmitter.fire(params);
                },

                provideDocumentHighlights: async (doc, pos, ctok, next) => {
                    const leanHighlights = await next(doc, pos, ctok);
                    if (leanHighlights?.length) return leanHighlights;

                    // vscode doesn't fall back to textual highlights, so we
                    // need to do that manually if the user asked for it
                    if (!getFallBackToStringOccurrenceHighlighting()) {
                        return [];
                    }

                    await new Promise((res) => setTimeout(res, 250));
                    if (ctok.isCancellationRequested) return;

                    const wordRange = doc.getWordRangeAtPosition(pos);
                    if (!wordRange) return;
                    const word = doc.getText(wordRange);

                    const highlights: DocumentHighlight[] = [];
                    const text = doc.getText();
                    const nonWordPattern = '[`~@$%^&*()-=+\\[{\\]}⟨⟩⦃⦄⟦⟧⟮⟯‹›\\\\|;:\",./\\s]|^|$'
                    const regexp = new RegExp(`(?<=${nonWordPattern})${escapeRegExp(word)}(?=${nonWordPattern})`, 'g')
                    for (const match of text.matchAll(regexp)) {
                        const start = doc.positionAt(match.index ?? 0)
                        highlights.push({
                            range: new Range(start, start.translate(0, match[0].length)),
                            kind: DocumentHighlightKind.Text,
                        })
                    }

                    return highlights;
                }
            },
        }
    }

    private async setupClient(): Promise<LanguageClient> {
        const serverOptions: ServerOptions = await this.determineServerOptions()
        const clientOptions: LanguageClientOptions = this.obtainClientOptions()

        const client = new LanguageClient(
            'lean4',
            'Lean 4',
            serverOptions,
            clientOptions
        )

        patchConverters(client.protocol2CodeConverter, client.code2ProtocolConverter)
        return client
    }
}
