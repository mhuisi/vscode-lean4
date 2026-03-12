import {
    CancellationToken,
    DiagnosticCollection,
    Disposable,
    EventEmitter,
    FileSystemWatcher,
    OutputChannel,
    Progress,
    ProgressLocation,
    ProgressOptions,
    RelativePattern,
    window,
    workspace,
    WorkspaceFolder,
} from 'vscode'
import {
    ClientCapabilities,
    DiagnosticSeverity,
    DidChangeTextDocumentParams,
    DidCloseTextDocumentParams,
    DocumentFilter,
    Executable,
    InitializeResult,
    LanguageClient,
    LanguageClientOptions,
    LSPErrorCodes,
    ResponseError,
    RevealOutputChannelOn,
    ServerCapabilities,
    State,
    StaticFeature,
} from 'vscode-languageclient/node'

import {
    LeanDiagnostic,
    LeanFileProgressParams,
    LeanFileProgressProcessingInfo,
    LeanServerCapabilities,
    ServerStoppedReason,
} from '@leanprover/infoview-api'
import {
    allowedLoggingMethods,
    disallowedLoggingMethods,
    isLoggingEnabled,
    loggingDir,
    serverArgs,
    shouldAutofocusOutput,
} from './config'
import { logger } from './utils/logger'
// @ts-ignore
import * as fs from 'fs'
import { glob } from 'glob'
import { SemVer } from 'semver'
import { formatCommandExecutionOutput } from './utils/batch'
import {
    c2pConverter,
    LeanImport,
    LeanModule,
    LeanModuleHierarchyImportedByParams,
    LeanModuleHierarchyImportsParams,
    LeanPrepareModuleHierarchyParams,
    LeanPublishDiagnosticsParams,
    p2cConverter,
    patchConverters,
    setDependencyBuildMode,
} from './utils/converters'
import { elanInstalledToolchains } from './utils/elan'
import { ExtUri, FileUri, parseExtUri, toExtUri } from './utils/exturi'
import { fileExists } from './utils/fsHelper'
import { leanRunner } from './utils/leanCmdRunner'
import { lean, LeanDocument } from './utils/leanEditorProvider'
import {
    displayNotification,
    displayNotificationWithInput,
    displayNotificationWithOptionalInput,
    displayNotificationWithOutput,
} from './utils/notifs'
import { lakefileLeanUri, lakefileTomlUri, leanToolchainUri, willUseLakeServer } from './utils/projectInfo'

interface LogConfig {
    logDir?: string | undefined
    allowedMethods?: string[] | undefined
    disallowedMethods?: string[] | undefined
}

function logConfig(): LogConfig | undefined {
    if (!isLoggingEnabled()) {
        return undefined
    }
    const allowedMethods = allowedLoggingMethods()
    const disallowedMethods = disallowedLoggingMethods()
    return {
        logDir: loggingDir(),
        allowedMethods: allowedMethods.length > 0 ? allowedMethods : undefined,
        disallowedMethods: disallowedMethods.length > 0 ? disallowedMethods : undefined,
    }
}

interface LeanClientCapabilties {
    silentDiagnosticSupport?: boolean | undefined
}

const leanClientCapabilities: LeanClientCapabilties = {
    silentDiagnosticSupport: true,
}

export type PrepareModuleHierarchyResult =
    | { kind: 'Success'; module: LeanModule | undefined }
    | { kind: 'StoppedClient' }
    | { kind: 'Unsupported' }
export type ModuleHierarchyImportsResult =
    | { kind: 'Success'; imports: LeanImport[] }
    | { kind: 'StoppedClient' }
    | { kind: 'Unsupported' }
export type ModuleHierarchyImportedByResult =
    | { kind: 'Success'; imports: LeanImport[] }
    | { kind: 'StoppedClient' }
    | { kind: 'Unsupported' }

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type ServerProgress = Map<ExtUri, LeanFileProgressProcessingInfo[]>

export class LeanClient implements Disposable {
    running: boolean
    private client: LanguageClient | undefined
    private outputChannel: OutputChannel
    folderUri: ExtUri
    private subFolderExclusions: FileUri[] | undefined
    private subscriptions: Disposable[] = []
    private noPrompt: boolean = false
    private showingRestartMessage: boolean = false
    private isRestarting: boolean = false
    private staleDepNotifier: Disposable | undefined
    private configFileContents: Map<string, string> = new Map()

    private openServerDocuments: Set<string> = new Set<string>()

    private didChangeEmitter = new EventEmitter<DidChangeTextDocumentParams>()
    didChange = this.didChangeEmitter.event

    private diagnosticsEmitter = new EventEmitter<LeanPublishDiagnosticsParams>()
    diagnostics = this.diagnosticsEmitter.event

    private didSetLanguageEmitter = new EventEmitter<string>()
    didSetLanguage = this.didSetLanguageEmitter.event

    private didCloseEmitter = new EventEmitter<DidCloseTextDocumentParams>()
    didClose = this.didCloseEmitter.event

    private customNotificationEmitter = new EventEmitter<{ method: string; params: any }>()
    /** Fires whenever a custom notification (i.e. one not defined in LSP) is received. */
    customNotification = this.customNotificationEmitter.event

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

    private serverFailedEmitter = new EventEmitter<string>()
    serverFailed = this.serverFailedEmitter.event

    static async init(folderUri: ExtUri, outputChannel: OutputChannel): Promise<LeanClient> {
        const c = new LeanClient()
        c.outputChannel = outputChannel
        c.folderUri = folderUri
        c.subscriptions.push(new Disposable(() => c.staleDepNotifier?.dispose()))
        await c.registerRestartServerNotificationWatchers()
        if (folderUri.scheme === 'file') {
            // All nested inner projects are excluded from this project so that we do not
            // get duplicate language server output for files in a nested inner project.
            const excludedToolchainPaths = await glob('**/lean-toolchain', {
                cwd: folderUri.fsPath,
                // TODO for configurable `.lake/packages`: Run `lake update` if no manifest exists, parse the manifest, grab the packages directory from it
                ignore: ['lean-toolchain', '.lake/packages/**'],
                dot: true,
                absolute: true,
            })
            const excludedFolderUris = excludedToolchainPaths.map(t => new FileUri(t).join('..'))
            c.subFolderExclusions = excludedFolderUris
        }
        return c
    }

    private isExcluded(uri: FileUri): boolean {
        if (this.subFolderExclusions === undefined) {
            return false
        }
        return this.subFolderExclusions.some(excludedFolderUri => uri.isInFolder(excludedFolderUri))
    }

    private isParamExcluded<P>(param: P | undefined): boolean {
        if (typeof param !== 'object' || param === null) {
            return false
        }
        let docUri: ExtUri | undefined
        if ('uri' in param) {
            docUri = parseExtUri(param.uri as string)
        } else if ('textDocument' in param) {
            const doc = param.textDocument as any
            if ('uri' in doc) {
                docUri = parseExtUri(doc.uri as string)
            }
        }
        if (docUri === undefined || docUri.scheme !== 'file') {
            return false
        }
        return this.isExcluded(docUri)
    }

    private async updateConfigFileContents(uri: FileUri): Promise<boolean> {
        let contents: string
        try {
            contents = (await fs.promises.readFile(uri.fsPath, { encoding: 'utf8' })).trim()
        } catch {
            return false
        }
        const oldContents = this.configFileContents.get(uri.toString())
        const isFirstUpdate = oldContents === undefined
        if (isFirstUpdate || oldContents !== contents) {
            this.configFileContents.set(uri.toString(), contents)
            return !isFirstUpdate
        }
        return false
    }

    private async registerRestartServerNotificationWatchers() {
        const folderUri = this.folderUri
        if (folderUri.scheme === 'untitled') {
            return
        }
        const watchers: { name: string; watcher: FileSystemWatcher }[] = []
        if (await fileExists(leanToolchainUri(folderUri).fsPath)) {
            watchers.push({
                name: 'Project Lean version (`lean-toolchain`)',
                watcher: workspace.createFileSystemWatcher(
                    // Hack: We want to avoid having to escape globs and an empty glob doesn't match the file,
                    // so we instead watch for `*` relative to `leanToolchainUri(folderUri)`
                    // (accepting some unlikely false-positives).
                    new RelativePattern(leanToolchainUri(folderUri).asUri(), '*'),
                    true,
                    false,
                    true,
                ),
            })
            await this.updateConfigFileContents(leanToolchainUri(folderUri))
        }
        if (await fileExists(lakefileLeanUri(folderUri).fsPath)) {
            watchers.push({
                name: 'Project configuration (`lakefile.lean`)',
                watcher: workspace.createFileSystemWatcher(
                    new RelativePattern(lakefileLeanUri(folderUri).asUri(), '*'),
                    true,
                    false,
                    true,
                ),
            })
            await this.updateConfigFileContents(lakefileLeanUri(folderUri))
        }
        if (await fileExists(lakefileTomlUri(folderUri).fsPath)) {
            watchers.push({
                name: 'Project configuration (`lakefile.toml`)',
                watcher: workspace.createFileSystemWatcher(
                    new RelativePattern(lakefileTomlUri(folderUri).asUri(), '*'),
                    true,
                    false,
                    true,
                ),
            })
            await this.updateConfigFileContents(lakefileTomlUri(folderUri))
        }
        this.subscriptions.push(...watchers.map(w => w.watcher))
        let isWatcherNotificationDisplayed = false
        for (const w of watchers) {
            this.subscriptions.push(
                w.watcher.onDidChange(async uri => {
                    const fileUri = FileUri.fromUri(uri)
                    if (fileUri === undefined) {
                        return
                    }
                    const didReallyChange = await this.updateConfigFileContents(fileUri)
                    if (!didReallyChange) {
                        // In core on ext4, building touches the metadata of the file, which causes
                        // the change event to trigger.
                        // VS Code file watchers can't distinguish between "modify" and "change",
                        // so we use the file contents to distinguish the two post-hoc.
                        return
                    }
                    if (isWatcherNotificationDisplayed) {
                        return
                    }
                    isWatcherNotificationDisplayed = true
                    displayNotificationWithOptionalInput(
                        'Information',
                        `${w.name} of '${folderUri.baseName()}' has changed. Do you wish to restart the Lean server?`,
                        [
                            {
                                input: 'Restart Server',
                                action: async () => await this.restart(),
                            },
                        ],
                        () => {
                            isWatcherNotificationDisplayed = false
                        },
                    )
                }),
            )
        }
    }

    dispose(): void {
        this.subscriptions.forEach(s => s.dispose())
        if (this.isStarted()) void this.stop()
    }

    serverCapabilities(): ServerCapabilities<LeanServerCapabilities> | undefined {
        return this.client?.initializeResult?.capabilities
    }

    // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
    leanServerCapabilities(): LeanServerCapabilities | undefined {
        return this.serverCapabilities()?.experimental
    }

    showRestartMessage(restartFile: boolean = false, uri?: ExtUri | undefined) {
        if (this.showingRestartMessage) {
            return
        }
        this.showingRestartMessage = true
        const finalizer = () => {
            this.showingRestartMessage = false
        }
        let restartItem: string
        let messageTitle: string
        if (!restartFile) {
            restartItem = 'Restart Lean Server'
            messageTitle = 'Lean Server has stopped unexpectedly.'
        } else {
            restartItem = 'Restart Lean Server on this file'
            messageTitle = 'The Lean Server has stopped processing this file.'
        }
        displayNotificationWithOptionalInput(
            'Error',
            messageTitle,
            [
                {
                    input: restartItem,
                    action: () => {
                        if (restartFile && uri !== undefined) {
                            const document = lean.getLeanDocumentByUri(uri)
                            if (document !== undefined) {
                                void this.restartFile(document)
                            }
                        } else {
                            void this.start()
                        }
                    },
                },
            ],
            finalizer,
        )
    }

    async sendPrepareModuleHierarchy(uri: ExtUri): Promise<PrepareModuleHierarchyResult> {
        const client = this.client
        if (client === undefined || !client.isRunning) {
            return { kind: 'StoppedClient' }
        }
        if (this.leanServerCapabilities()?.moduleHierarchyProvider === undefined) {
            return { kind: 'Unsupported' }
        }
        const param: LeanPrepareModuleHierarchyParams = {
            textDocument: { uri: client.code2ProtocolConverter.asUri(uri.asUri()) },
        }
        const response: LeanModule | undefined = await client.sendRequest('$/lean/prepareModuleHierarchy', param)
        return { kind: 'Success', module: response }
    }

    async sendModuleHierarchyImports(module: LeanModule): Promise<ModuleHierarchyImportsResult> {
        const client = this.client
        if (client === undefined || !client.isRunning) {
            return { kind: 'StoppedClient' }
        }
        if (this.leanServerCapabilities()?.moduleHierarchyProvider === undefined) {
            return { kind: 'Unsupported' }
        }
        const param: LeanModuleHierarchyImportsParams = { module }
        const response: LeanImport[] = await client.sendRequest('$/lean/moduleHierarchy/imports', param)
        return { kind: 'Success', imports: response }
    }

    async sendModuleHierarchyImportedBy(module: LeanModule): Promise<ModuleHierarchyImportedByResult> {
        const client = this.client
        if (client === undefined || !client.isRunning) {
            return { kind: 'StoppedClient' }
        }
        if (this.leanServerCapabilities()?.moduleHierarchyProvider === undefined) {
            return { kind: 'Unsupported' }
        }
        const param: LeanModuleHierarchyImportedByParams = { module }
        const response: LeanImport[] = await client.sendRequest('$/lean/moduleHierarchy/importedBy', param)
        return { kind: 'Success', imports: response }
    }

    async restart(): Promise<void> {
        if (this.isRestarting) {
            displayNotification('Error', 'Client is already being started.')
            return
        }
        this.isRestarting = true
        try {
            let defaultToolchain: string | undefined
            if (this.folderUri.scheme === 'untitled') {
                const installedToolchainsResult = await elanInstalledToolchains()
                switch (installedToolchainsResult.kind) {
                    case 'Success':
                        if (installedToolchainsResult.defaultToolchain === undefined) {
                            this.serverFailedEmitter.fire(
                                'No default Lean version set - cannot launch client for untitled file.',
                            )
                            return
                        }
                        defaultToolchain = installedToolchainsResult.defaultToolchain
                        break
                    case 'ElanNotFound':
                        defaultToolchain = undefined
                        break
                    case 'ExecutionError':
                        this.serverFailedEmitter.fire(
                            `Cannot determine Lean version information for launching a client for an untitled file: ${installedToolchainsResult.message}`,
                        )
                        return
                }
            }

            logger.log('[LeanClient] Restarting Lean Server')
            if (this.isStarted()) {
                await this.stop()
            }

            this.restartingEmitter.fire(undefined)

            const progressOptions: ProgressOptions = {
                location: ProgressLocation.Notification,
                title: '[Server Startup] Starting Lean language server and cloning missing packages [(Click for details)](command:lean4.troubleshooting.showOutput)',
                cancellable: false,
            }
            await window.withProgress(
                progressOptions,
                async progress => await this.startClient(progress, defaultToolchain),
            )
        } finally {
            this.isRestarting = false
        }
    }

    private async determineToolchainOverride(
        defaultToolchain: string | undefined,
    ): Promise<{ kind: 'Override'; toolchain: string } | { kind: 'NoOverride' } | { kind: 'Error'; message: string }> {
        const cwdUri = this.folderUri.scheme === 'file' ? this.folderUri : undefined
        const toolchainDecision = await leanRunner.decideToolchain({
            channel: this.outputChannel,
            context: 'Server Startup',
            cwdUri,
            toolchainUpdateMode: 'PromptAboutUpdate',
            waitingPrompt: 'Fetching Lean version information',
        })

        if (toolchainDecision.kind === 'Error') {
            return toolchainDecision
        }

        if (toolchainDecision.kind === 'RunWithSpecificToolchain') {
            return { kind: 'Override', toolchain: toolchainDecision.toolchain }
        }

        toolchainDecision.kind satisfies 'RunWithActiveToolchain'

        if (this.folderUri.scheme === 'untitled' && defaultToolchain !== undefined) {
            // Fixes issue #227, for adhoc files it would pick up the cwd from the open folder
            // which is not what we want.  For adhoc files we want the (default) toolchain instead.
            return { kind: 'Override', toolchain: defaultToolchain }
        }
        return { kind: 'NoOverride' }
    }

    private async startClient(
        progress: Progress<{ message?: string; increment?: number }>,
        defaultToolchain: string | undefined,
    ): Promise<void> {
        // Should only be called from `restart`

        const startTime = Date.now()
        progress.report({})
        const toolchainOverrideResult = await this.determineToolchainOverride(defaultToolchain)
        if (toolchainOverrideResult.kind === 'Error') {
            this.serverFailedEmitter.fire(`Error while starting client: ${toolchainOverrideResult.message}`)
            return
        }
        const toolchainOverride: string | undefined =
            toolchainOverrideResult.kind === 'Override' ? toolchainOverrideResult.toolchain : undefined

        this.client = await this.setupClient(toolchainOverride)

        let insideRestart = true
        try {
            this.client.onDidChangeState(async s => {
                // see https://github.com/microsoft/vscode-languageserver-node/issues/825
                if (s.newState === State.Starting) {
                    logger.log('[LeanClient] starting')
                } else if (s.newState === State.Running) {
                    const end = Date.now()
                    logger.log(`[LeanClient] running, started in ${end - startTime} ms`)
                    this.running = true // may have been auto restarted after it failed.
                    if (!insideRestart) {
                        this.restartedEmitter.fire(undefined)
                    }
                } else if (s.newState === State.Stopped) {
                    this.running = false
                    logger.log('[LeanClient] has stopped or it failed to start')
                    if (!this.noPrompt) {
                        // only raise this event and show the message if we are not the ones
                        // who called the stop() method.
                        this.stoppedEmitter.fire({ message: 'Lean server has stopped.', reason: '' })
                        this.showRestartMessage()
                    }
                }
            })
            await this.client.start()
            const version = this.client.initializeResult?.serverInfo?.version
            if (version && new SemVer(version).compare('0.2.0') < 0) {
                if (this.staleDepNotifier) {
                    this.staleDepNotifier.dispose()
                }
                this.staleDepNotifier = this.diagnostics(params => this.checkForImportsOutdatedError(params))
            }

            // if we got this far then the client is happy so we are running!
            this.running = true
        } catch (error) {
            const msg = '' + error
            logger.log(`[LeanClient] restart error ${msg}`)
            this.outputChannel.appendLine(msg)
            this.serverFailedEmitter.fire(msg)
            insideRestart = false
        }

        // HACK(WN): Register a default notification handler to fire on custom notifications.
        // A mechanism to do this is provided in vscode-jsonrpc. One can register a `StarNotificationHandler`
        // here: https://github.com/microsoft/vscode-languageserver-node/blob/b2fc85d28a1a44c22896559ee5f4d3ba37a02ef5/jsonrpc/src/common/connection.ts#L497
        // which fires on any LSP notifications not in the standard, for example the `$/lean/..` ones.
        // However this mechanism is not exposed in vscode-languageclient, so we hack around its implementation.
        const starHandler = (method: string, params_: any) => {
            if (method === '$/lean/fileProgress' && this.client) {
                const params = params_ as LeanFileProgressParams
                const uri = toExtUri(p2cConverter.asUri(params.textDocument.uri))
                if (uri !== undefined) {
                    this.progressChangedEmitter.fire([uri.toString(), params.processing])
                    // save the latest progress on this Uri in case infoview needs it later.
                    this.progress.set(uri, params.processing)
                }
            }

            this.customNotificationEmitter.fire({ method, params: params_ })
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        this.client.onNotification(starHandler as any, () => {})

        // Reveal the standard error output channel when the server prints something to stderr.
        // The vscode-languageclient library already takes care of writing it to the output channel.
        let stderrMsgBoxVisible = false
        ;(this.client as any)._serverProcess.stderr.on('data', async (chunk: Buffer) => {
            if (shouldAutofocusOutput()) {
                this.client?.outputChannel.show(true)
            } else if (!stderrMsgBoxVisible) {
                stderrMsgBoxVisible = true
                const finalizer = () => {
                    stderrMsgBoxVisible = false
                }
                displayNotificationWithOutput(
                    'Error',
                    `Lean server printed an error:\n${chunk.toString()}`,
                    [],
                    finalizer,
                )
            }
        })

        this.restartedEmitter.fire(undefined)
        insideRestart = false
    }

    private checkForImportsOutdatedError(params: LeanPublishDiagnosticsParams) {
        const fileUri = parseExtUri(params.uri)
        if (fileUri === undefined) {
            return
        }

        const fileName = fileUri.scheme === 'file' ? fileUri.baseName() : 'untitled'
        const isImportsOutdatedError = params.diagnostics.some(
            d =>
                d.severity === DiagnosticSeverity.Error &&
                d.message.includes('Imports are out of date and must be rebuilt') &&
                d.range.start.line === 0 &&
                d.range.start.character === 0 &&
                d.range.end.line === 0 &&
                d.range.end.character === 0,
        )
        if (!isImportsOutdatedError) {
            return
        }

        const message = `Imports of '${fileName}' are out of date and must be rebuilt. Restarting the file will rebuild them.`
        const input = 'Restart File'
        displayNotificationWithOptionalInput('Information', message, [
            {
                input,
                action: () => {
                    const document = lean.getLeanDocumentByUri(fileUri)
                    if (document === undefined) {
                        displayNotification(
                            'Error',
                            `'${fileName}' was closed in the meantime. Imports will not be rebuilt.`,
                        )
                        return
                    }

                    void this.restartFile(document)
                },
            },
        ])
    }

    async withStoppedClient<T>(
        action: () => Promise<T>,
    ): Promise<{ kind: 'Success'; result: T } | { kind: 'IsRestarting' }> {
        if (this.isRestarting) {
            return { kind: 'IsRestarting' }
        }
        this.isRestarting = true // Ensure that client cannot be restarted in the mean-time
        let result: T
        try {
            if (this.isStarted()) {
                await this.stop()
            }
            result = await action()
        } finally {
            this.isRestarting = false
        }
        await this.restart()
        return { kind: 'Success', result }
    }

    isInFolderManagedByThisClient(uri: ExtUri): boolean {
        if (this.folderUri.scheme === 'untitled' && uri.scheme === 'untitled') {
            return true
        }
        if (this.folderUri.scheme === 'file' && uri.scheme === 'file') {
            return uri.isInFolder(this.folderUri)
        }
        return false
    }

    getClientFolder(): ExtUri {
        return this.folderUri
    }

    start(): Promise<void> {
        return this.restart()
    }

    isStarted(): boolean {
        return this.client !== undefined
    }

    isRunning(): boolean {
        if (this.client) {
            return this.running
        }
        return false
    }

    async stop(): Promise<void> {
        if (this.client && this.running) {
            this.noPrompt = true
            try {
                // some timing conditions can happen while running unit tests that cause
                // this to throw an exception which then causes those tests to fail.
                await this.client.stop()
            } catch (e) {
                logger.log(`[LeanClient] Error stopping language client: ${e}`)
            }
        }

        this.noPrompt = false
        this.progress = new Map()
        this.client = undefined
        this.openServerDocuments = new Set()
        this.running = false
    }

    async restartFile(leanDoc: LeanDocument): Promise<void> {
        const extUri = leanDoc.extUri
        const formattedFileName = extUri.scheme === 'file' ? extUri.baseName() : extUri.toString()
        const formattedProjectName =
            this.folderUri.scheme === 'file' ? this.folderUri.fsPath : this.folderUri.toString()
        if (this.client === undefined || !this.running) {
            displayNotification(
                'Error',
                `Cannot restart '${formattedFileName}': The language server for the project at '${formattedProjectName}' is stopped.`,
            )
            return
        }

        if (!this.isInFolderManagedByThisClient(extUri)) {
            displayNotification(
                'Error',
                `Cannot restart '${formattedFileName}': The project at '${formattedProjectName}' does not contain the file.`,
            )
            return
        }

        const uri = extUri.toString()
        if (!this.openServerDocuments.delete(uri)) {
            displayNotification(
                'Error',
                `Cannot restart '${formattedFileName}': The file has never been opened in the language server for the project at '${formattedProjectName}'.`,
            )
            return
        }
        logger.log(`[LeanClient] Restarting File: ${uri}`)
        await this.client.sendNotification(
            'textDocument/didClose',
            this.client.code2ProtocolConverter.asCloseTextDocumentParams(leanDoc.doc),
        )

        if (this.openServerDocuments.has(uri)) {
            displayNotification(
                'Error',
                `Cannot restart '${formattedFileName}': The file has already been opened in the language server for the project at '${formattedProjectName}' since initiating the restart.`,
            )
            return
        }
        this.openServerDocuments.add(uri)
        await this.client.sendNotification(
            'textDocument/didOpen',
            setDependencyBuildMode(this.client.code2ProtocolConverter.asOpenTextDocumentParams(leanDoc.doc), 'once'),
        )

        this.restartedWorkerEmitter.fire(uri)
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    sendRequest(method: string, params: any, token?: CancellationToken): Promise<any> {
        return this.running && this.client
            ? this.client.sendRequest(method, params, token)
            : new Promise<any>((_, reject) => {
                  reject('No connection to Lean')
              })
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    sendNotification(method: string, params: any): Promise<void> | undefined {
        return this.running && this.client ? this.client.sendNotification(method, params) : undefined
    }

    getDiagnostics(): DiagnosticCollection | undefined {
        return this.running ? this.client?.diagnostics : undefined
    }

    get initializeResult(): InitializeResult | undefined {
        return this.running ? this.client?.initializeResult : undefined
    }

    private async determineServerOptions(toolchainOverride: string | undefined): Promise<Executable> {
        const env = Object.assign({}, process.env)
        const [serverExecutable, options] = await this.determineExecutable()
        if (toolchainOverride) {
            options.unshift('+' + toolchainOverride)
        }

        const cwd = this.folderUri.scheme === 'file' ? this.folderUri.fsPath : undefined
        if (cwd) {
            // Add folder name to command-line so that it shows up in `ps aux`.
            options.push(cwd)
        } else {
            options.push('untitled')
        }

        return {
            command: serverExecutable,
            args: options.concat(serverArgs()),
            options: {
                cwd,
                env,
            },
        }
    }

    private async determineExecutable(): Promise<[string, string[]]> {
        if (await willUseLakeServer(this.folderUri)) {
            return ['lake', ['serve', '--']]
        } else {
            return ['lean', ['--server']]
        }
    }

    private obtainClientOptions(): LanguageClientOptions {
        // TODO for configurable `.lake/packages`:
        // Run `lake update` if no manifest exists, parse the manifest, grab the packages directory from it and add a selector for it
        const documentSelector: DocumentFilter = {
            language: 'lean4',
        }

        let workspaceFolder: WorkspaceFolder | undefined
        documentSelector.scheme = this.folderUri.scheme
        if (this.folderUri.scheme === 'file') {
            const escapedPath = this.folderUri.fsPath.replace(/[?*()[\]{}]/g, '[$&]')
            documentSelector.pattern = `${escapedPath}/**/*`
            workspaceFolder = {
                uri: this.folderUri.asUri(),
                name: this.folderUri.baseName(),
                index: 0, // the language client library does not actually need this index
            }
        }

        return {
            outputChannel: this.outputChannel,
            revealOutputChannelOn: RevealOutputChannelOn.Never, // contrary to the name, this disables the message boxes
            documentSelector: [documentSelector, { ...documentSelector, language: 'lean' }],
            workspaceFolder,
            initializationOptions: {
                hasWidgets: true,
                logCfg: logConfig(),
            },
            connectionOptions: {
                maxRestartCount: 0,
                cancellationStrategy: undefined as any,
            },
            middleware: {
                sendRequest: async (type, param, token, next) => {
                    if (this.isParamExcluded(param)) {
                        // Major HACK:
                        // We can't return a value here to make the language client library reject the request,
                        // but throwing a `ContentModified` exception achieves the same thing:
                        // the language client library ensures that a default value is returned when this exception occurs and for all request handlers,
                        // VS Code ignores the handler that returned the default value and tries other ones.
                        throw new ResponseError(LSPErrorCodes.ContentModified, '')
                    }
                    return next(type, param, token)
                },
                sendNotification: async (type, next, param) => {
                    // We also have to repeat this check in all other notification middlewares
                    // so that these middlewares don't produce any side-effects when this
                    // check here ends up filtering the notification
                    // (which we can't tell in the other notification middlewares above this one)
                    if (this.isParamExcluded(param)) {
                        return
                    }
                    return next(type, param)
                },
                handleDiagnostics: (uri, diagnostics, next) => {
                    const diagnosticsInVsCode = diagnostics.filter(d => !('isSilent' in d && d.isSilent))
                    next(uri, diagnosticsInVsCode)
                    const uri_ = c2pConverter.asUri(uri)
                    const diagnostics_: LeanDiagnostic[] = []
                    for (const d of diagnostics) {
                        const d_: LeanDiagnostic = {
                            ...c2pConverter.asDiagnostic(d),
                        }
                        diagnostics_.push(d_)
                    }
                    this.diagnosticsEmitter.fire({ uri: uri_, diagnostics: diagnostics_ })
                },

                didOpen: async (doc, next) => {
                    const params = c2pConverter.asOpenTextDocumentParams(doc)
                    if (this.isParamExcluded(params)) {
                        return
                    }
                    const docUri = toExtUri(doc.uri)
                    if (!docUri) {
                        return // This should never happen since the glob we launch the client for ensures that all uris are ext uris
                    }

                    // This will sometimes open invisible documents in the language server
                    // (e.g. holding `Ctrl` while hovering over an identifier will quickly emit a `didOpen` and then a `didClose` notification for the document the identifier is in).
                    // There is no good way to prevent this (c.f. https://github.com/microsoft/vscode-languageserver-node/issues/848#issuecomment-2185043021),
                    // but specifically in the case of `Ctrl`+Hover, the language server typically seems to not start expensive elaboration for the invisible document.
                    // We may however launch a new server instance if the document is in a different project (e.g. core).

                    if (this.openServerDocuments.has(docUri.toString())) {
                        return
                    }
                    this.openServerDocuments.add(docUri.toString())

                    await next(doc)

                    // Opening the document may have set the language ID.
                    this.didSetLanguageEmitter.fire(doc.languageId)
                },

                didChange: async (data, next) => {
                    const params = c2pConverter.asChangeTextDocumentParams(
                        data,
                        data.document.uri,
                        data.document.version,
                    )
                    if (this.isParamExcluded(params)) {
                        return
                    }
                    await next(data)
                    this.didChangeEmitter.fire(params)
                },

                didClose: async (doc, next) => {
                    const params = c2pConverter.asCloseTextDocumentParams(doc)
                    if (this.isParamExcluded(params)) {
                        return
                    }
                    const docUri = toExtUri(doc.uri)
                    if (!docUri) {
                        return // This should never happen since the glob we launch the client for ensures that all uris are ext uris
                    }

                    if (!this.openServerDocuments.delete(docUri.toString())) {
                        // Do not send `didClose` if we filtered the corresponding `didOpen` (see comment in the `didOpen` middleware).
                        // The language server is only resilient against requests for closed files, not the `didClose` notification itself.
                        return
                    }

                    await next(doc)

                    this.didCloseEmitter.fire(params)
                },

                provideRenameEdits: async (document, position, newName, token, next) => {
                    const edit = await next(document, position, newName, token)
                    if (!edit) {
                        return edit
                    }
                    const entries = edit.entries()
                    const amountFiles = entries.length
                    if (amountFiles <= 1) {
                        return edit
                    }
                    const amountEdits = entries.map(([_, edits]) => edits.length).reduce((acc, n) => acc + n, 0)
                    const choice = await displayNotificationWithInput(
                        'Warning',
                        `This rename operation will rename ${amountEdits} occurrences in ${amountFiles} files. Do you wish to proceed?`,
                        ['Proceed'],
                    )
                    if (choice === undefined) {
                        return undefined
                    }
                    return edit
                },
            },
        }
    }

    private async setupClient(toolchainOverride: string | undefined): Promise<LanguageClient> {
        const serverOptions: Executable = await this.determineServerOptions(toolchainOverride)
        const clientOptions: LanguageClientOptions = this.obtainClientOptions()

        this.outputChannel.appendLine(
            formatCommandExecutionOutput(serverOptions.options?.cwd, serverOptions.command, serverOptions.args ?? []),
        )
        const client = new LanguageClient('lean4', 'Lean 4', serverOptions, clientOptions)
        const leanCapabilityFeature: StaticFeature = {
            initialize(_1, _2) {},
            getState() {
                return { kind: 'static' }
            },
            fillClientCapabilities(capabilities: ClientCapabilities & { lean?: LeanClientCapabilties | undefined }) {
                capabilities.lean = leanClientCapabilities
            },
            clear() {},
        }
        client.registerFeature(leanCapabilityFeature)

        patchConverters(client.protocol2CodeConverter, client.code2ProtocolConverter)
        return client
    }
}
