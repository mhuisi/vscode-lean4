import { LeanFileProgressProcessingInfo, ServerStoppedReason } from '@leanprover/infoview-api'
import { Disposable, EventEmitter, OutputChannel, commands } from 'vscode'
import { SetupDiagnostics, checkAll } from '../diagnostics/setupDiagnostics'
import { PreconditionCheckResult, SetupNotificationOptions } from '../diagnostics/setupNotifs'
import { FoldingRangesProvidedEvent, LeanClient } from '../leanclient'
import { LeanPublishDiagnosticsParams } from './converters'
import { ExtUri, FileUri } from './exturi'
import { lean } from './leanEditorProvider'
import { displayNotification } from './notifs'
import { findLeanProjectRootInfo, willUseLakeServer } from './projectInfo'

async function checkLean4ProjectPreconditions(
    channel: OutputChannel,
    context: string,
    folderUri: ExtUri,
): Promise<PreconditionCheckResult> {
    const options: SetupNotificationOptions = {
        errorMode: { mode: 'NonModal' },
        warningMode: { modal: false, proceedByDefault: true },
    }
    const d = new SetupDiagnostics(options)
    return await checkAll(
        () => d.checkIsValidProjectFolder(channel, folderUri),
        () => d.checkIsLeanVersionUpToDate(channel, context, folderUri, { toolchainUpdateMode: 'PromptAboutUpdate' }),
        async () => {
            if (!(await willUseLakeServer(folderUri))) {
                return 'Fulfilled'
            }
            return await d.checkIsLakeInstalledCorrectly(channel, context, folderUri, {
                toolchainUpdateMode: 'PromptAboutUpdate',
            })
        },
    )
}

// This class ensures we have one LeanClient per folder.
export class LeanClientProvider implements Disposable {
    private subscriptions: Disposable[] = []
    private outputChannel: OutputChannel
    private clients: Map<string, LeanClient> = new Map()
    private pending: Map<string, boolean> = new Map()
    private progressChangedEmitter = new EventEmitter<[string, LeanFileProgressProcessingInfo[]]>()
    progressChanged = this.progressChangedEmitter.event

    private diagnosticsChangedEmitter = new EventEmitter<LeanPublishDiagnosticsParams>()
    diagnosticsChanged = this.diagnosticsChangedEmitter.event

    private didProvideFoldingRangesEmitter = new EventEmitter<FoldingRangesProvidedEvent>()
    didProvideFoldingRanges = this.didProvideFoldingRangesEmitter.event

    private clientAddedEmitter = new EventEmitter<LeanClient>()
    clientAdded = this.clientAddedEmitter.event

    private clientRemovedEmitter = new EventEmitter<LeanClient>()
    clientRemoved = this.clientRemovedEmitter.event

    private clientStoppedEmitter = new EventEmitter<[LeanClient, boolean, ServerStoppedReason]>()
    clientStopped = this.clientStoppedEmitter.event

    constructor(outputChannel: OutputChannel) {
        this.outputChannel = outputChannel

        lean.visibleLeanEditors.forEach(e => this.ensureClient(e.documentExtUri))

        this.subscriptions.push(
            commands.registerCommand('lean4.restartFile', () => this.restartActiveFile()),
            commands.registerCommand('lean4.refreshFileDependencies', () => this.restartActiveFile()),
            commands.registerCommand('lean4.restartServer', () => this.restartActiveClient()),
            commands.registerCommand('lean4.stopServer', () => this.stopActiveClient()),
        )

        this.subscriptions.push(lean.onDidOpenLeanDocument(document => this.ensureClient(document.extUri)))
    }

    getActiveClient(): LeanClient | undefined {
        const activeEditor = lean.lastActiveLeanEditor
        if (activeEditor === undefined) {
            return undefined
        }
        return this.findClient(activeEditor.documentExtUri)
    }

    restartFile(uri: ExtUri) {
        const fileName = uri.scheme === 'file' ? uri.baseName() : 'untitled file'

        const client: LeanClient | undefined = this.findClient(uri)
        if (!client || !client.isRunning()) {
            displayNotification('Error', `No active client for '${fileName}'.`)
            return
        }

        const doc = lean.getLeanDocumentByUri(uri)
        if (doc === undefined) {
            displayNotification('Error', `'${fileName}' was closed in the meantime.`)
            return
        }

        void client.restartFile(doc)
    }

    restartActiveFile() {
        const doc = lean.lastActiveLeanDocument
        if (doc === undefined) {
            displayNotification(
                'Error',
                'No active Lean editor tab. Make sure to focus the Lean editor tab for which you wish to issue a restart.',
            )
            return
        }
        this.restartFile(doc.extUri)
    }

    private async stopActiveClient() {
        const client = this.getActiveClient()
        if (client === undefined) {
            displayNotification('Error', 'Cannot stop language server: No active client.')
            return
        }
        if (client.isStarted()) {
            await client.stop()
        }
    }

    private async restartActiveClient() {
        const client = this.getActiveClient()
        if (client === undefined) {
            displayNotification(
                'Error',
                'Cannot restart server: No focused Lean tab. Please focus the Lean tab for which you wish to restart the server.',
            )
            return
        }
        await client.restart()
    }

    // Find the client for a given document.
    findClient(path: ExtUri): LeanClient | undefined {
        const candidates = this.getClients().filter(client => client.isInFolderManagedByThisClient(path))
        // All candidate folders are a prefix of `path`, so they must necessarily be prefixes of one another
        // => the best candidate (the innermost client folder) is just the one with the longest path
        let bestCandidate: LeanClient | undefined
        for (const candidate of candidates) {
            if (!bestCandidate) {
                bestCandidate = candidate
                continue
            }
            const folder = candidate.getClientFolder()
            const bestFolder = bestCandidate.getClientFolder()
            if (
                folder.scheme === 'file' &&
                bestFolder.scheme === 'file' &&
                folder.fsPath.length > bestFolder.fsPath.length
            ) {
                bestCandidate = candidate
            }
        }
        return bestCandidate
    }

    getClients(): LeanClient[] {
        return Array.from(this.clients.values())
    }

    withStoppedClients<T>(
        action: () => Promise<T>,
    ): Promise<{ kind: 'Success'; result: T } | { kind: 'IsRestarting' }> {
        let combinedAction: () => Promise<{ kind: 'Success'; result: T } | { kind: 'IsRestarting' }> = async () => ({
            kind: 'Success',
            result: await action(),
        })
        for (const c of this.clients.values()) {
            const previousCombinedAction = combinedAction
            combinedAction = async () => {
                const r = await c.withStoppedClient(previousCombinedAction)
                if (r.kind === 'IsRestarting' || r.result.kind === 'IsRestarting') {
                    return { kind: 'IsRestarting' }
                }
                return { kind: 'Success', result: r.result.result }
            }
        }
        return combinedAction()
    }

    getClientForFolder(folder: ExtUri): LeanClient | undefined {
        return this.clients.get(folder.toString())
    }

    async ensureClient(uri: ExtUri): Promise<[boolean, LeanClient | undefined]> {
        const projectInfo = await findLeanProjectRootInfo(uri)
        if (projectInfo.kind === 'FileNotFound') {
            return [false, undefined]
        }
        if (projectInfo.kind === 'LakefileWithoutToolchain') {
            displayNotification(
                'Error',
                `Project at ${projectInfo.projectRootUri} has a Lakefile, but lacks a 'lean-toolchain' file. Please create one with the Lean version that you would like the project to use.`,
            )
            return [false, undefined]
        }
        const folderUri = projectInfo.projectRootUri
        let client = this.getClientForFolder(folderUri)
        if (client) {
            return [true, client]
        }

        const key = folderUri.toString()
        if (this.pending.has(key)) {
            return [false, undefined]
        }
        this.pending.set(key, true)

        const preconditionCheckResult = await checkLean4ProjectPreconditions(
            this.outputChannel,
            'Client Startup',
            folderUri,
        )
        if (preconditionCheckResult === 'Fatal') {
            this.pending.delete(key)
            return [false, undefined]
        }

        client = await LeanClient.init(folderUri, this.outputChannel)
        this.subscriptions.push(client)
        this.clients.set(key, client)

        client.serverFailed(err => {
            this.clients.delete(key)
            client.dispose()
            displayNotification('Error', err)
        })

        client.stopped(reason => {
            this.clientStoppedEmitter.fire([client, client === this.getActiveClient(), reason])
        })

        // aggregate progress changed events.
        client.progressChanged(arg => {
            this.progressChangedEmitter.fire(arg)
        })

        client.diagnostics(p => {
            this.diagnosticsChangedEmitter.fire(p)
        })

        client.didProvideFoldingRanges(e => {
            this.didProvideFoldingRangesEmitter.fire(e)
        })

        // Fired before starting the client because the InfoView uses this to register
        // events on `client` that fire during `start`.
        this.clientAddedEmitter.fire(client)

        await client.start()

        this.pending.delete(key)

        return [false, client]
    }

    dispose(): void {
        for (const s of this.subscriptions) {
            s.dispose()
        }
    }
}
