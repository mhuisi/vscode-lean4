import * as fs from 'fs'
import { join } from 'path'
import { commands, Disposable, OutputChannel, QuickPickItem, QuickPickItemKind, window } from 'vscode'
import { LeanClient } from './leanclient'
import { LeanClientProvider } from './utils/clientProvider'
import {
    displayLakeRunnerError,
    FetchMathlibCacheResult,
    lake,
    LakeRunner,
    LakeRunnerResult,
} from './utils/lake'
import { FileUri } from './utils/exturi'
import { lean } from './utils/leanEditorProvider'
import { DirectGitDependency, Manifest, ManifestReadError, parseManifestInFolder } from './utils/manifest'
import { displayNotification, displayNotificationWithInput, displayNotificationWithOptionalInput } from './utils/notifs'

type DependencyToolchainResult =
    | { kind: 'Success'; dependencyToolchain: string }
    | { kind: 'DoNotUpdate' }
    | { kind: 'Cancelled' }

export class ProjectOperationProvider implements Disposable {
    private subscriptions: Disposable[] = []
    private isRunningOperation: boolean = false // Used to synchronize project operations

    constructor(
        private channel: OutputChannel,
        private clientProvider: LeanClientProvider,
    ) {
        this.subscriptions.push(
            commands.registerCommand('lean4.project.build', () => this.buildProject()),
            commands.registerCommand('lean4.project.clean', () => this.cleanProject()),
            commands.registerCommand('lean4.project.updateDependency', () => this.updateDependency()),
            commands.registerCommand('lean4.project.fetchCache', () => this.fetchMathlibCache()),
            commands.registerCommand('lean4.project.fetchOpenFileCaches', () => this.fetchMathlibCacheForOpenFiles(undefined)),
            commands.registerCommand('lean4.project.fetchAllOpenFileCaches', () => this.fetchMathlibCacheForOpenFiles('all')),
            commands.registerCommand('lean4.project.fetchFileCache', () => this.fetchMathlibCacheForOpenFiles('current')),
        )
    }

    private async buildProject() {
        await this.runOperation('Build Project', async lakeRunner => {
            const resolveResult: LakeRunnerResult = await lakeRunner.resolveDeps()
            if (resolveResult.kind === 'Cancelled') {
                return
            }
            if (resolveResult.kind !== 'Success') {
                displayLakeRunnerError(resolveResult, 'Cannot clone missing project dependencies.')
                return
            }

            const fetchResult: 'Success' | 'Failure' = await lakeRunner.tryFetchMathlibCacheWithError()
            if (fetchResult !== 'Success') {
                return
            }

            const result: LakeRunnerResult = await lakeRunner.build()
            if (result.kind === 'Cancelled') {
                return
            }
            if (result.kind !== 'Success') {
                displayLakeRunnerError(result, 'Cannot build project.')
                return
            }

            displayNotification('Information', 'Project built successfully.')
            return
        })
    }

    private async cleanProject() {
        const deleteInput = 'Proceed'
        const deleteChoice: string | undefined = await displayNotificationWithInput(
            'Information',
            'Delete all build artifacts?',
            [deleteInput],
        )
        if (deleteChoice !== deleteInput) {
            return
        }

        await this.runOperation('Clean Project', async lakeRunner => {
            const cleanResult: LakeRunnerResult = await lakeRunner.clean()
            if (cleanResult.kind === 'Cancelled') {
                return
            }
            if (cleanResult.kind !== 'Success') {
                displayLakeRunnerError(cleanResult, 'Cannot delete build artifacts.')
                return
            }

            const rebuildMessage = 'Project cleaned successfully. Do you wish to rebuild the project?'
            const rebuildInput = 'Rebuild Project'
            const rebuildChoice: string | undefined = await displayNotificationWithInput(
                'Information',
                rebuildMessage,
                [rebuildInput],
                'Do Not Rebuild',
            )
            if (rebuildChoice !== rebuildInput) {
                return
            }

            const fetchResult: 'Success' | 'Failure' = await lakeRunner.tryFetchMathlibCacheWithError()
            if (fetchResult !== 'Success') {
                return
            }

            const buildResult: LakeRunnerResult = await lakeRunner.build()
            if (buildResult.kind === 'Cancelled') {
                return
            }
            if (buildResult.kind !== 'Success') {
                displayLakeRunnerError(buildResult, 'Cannot build project.')
                return
            }

            displayNotification('Information', 'Project rebuilt successfully.')
        })
    }

    private async fetchMathlibCache() {
        await this.runOperation('Fetch Mathlib Build Cache', async lakeRunner => {
            const fetchResult: FetchMathlibCacheResult = await lakeRunner.fetchMathlibCache()
            if (fetchResult.kind === 'Cancelled') {
                return
            }
            if (fetchResult.kind === 'CacheUnavailable') {
                displayNotification('Error', 'This command cannot be used in non-Mathlib projects.')
                return
            }
            if (fetchResult.kind !== 'Success') {
                displayLakeRunnerError(fetchResult, 'Cannot fetch Mathlib build artifact cache.')
                return
            }

            displayNotification('Information', 'Mathlib build artifact cache fetched successfully.')
        })
    }

    private static readonly fileCacheOperationNames = {
        all: 'Fetch Mathlib Build Cache For All Open Files',
        current: 'Fetch Mathlib Build Cache For Current File',
        undefined: 'Fetch Mathlib Build Cache For Open Files',
    } as const

    private async fetchMathlibCacheForOpenFiles(kind: 'all' | 'current' | undefined) {
        await this.runOperation(ProjectOperationProvider.fileCacheOperationNames[`${kind}`], async lakeRunner => {
            const projectUri = lakeRunner.options.cwdUri!
            const fileUris = await this.determineFiles(kind, projectUri)
            if (fileUris === undefined) {
                displayNotification(
                    'Error',
                    'No open Lean files in the current project. Make sure to open a Lean file for which you wish to fetch the cache.',
                )
                return
            }
            if (fileUris.length === 0) {
                return
            }

            const fetchResult: FetchMathlibCacheResult = await lakeRunner.fetchMathlibCacheForFiles(fileUris)
            if (fetchResult.kind === 'Cancelled') {
                return
            }
            if (fetchResult.kind === 'CacheUnavailable') {
                displayNotification('Error', 'This command cannot be used in non-Mathlib projects.')
                return
            }
            if (fetchResult.kind !== 'Success') {
                displayLakeRunnerError(fetchResult, 'Cannot fetch Mathlib build artifact cache.')
                return
            }

            displayNotification(
                'Information',
                'Mathlib build artifact cache for open file(s) fetched successfully.'
            )
        })
    }

    private async determineFiles(kind: 'all' | 'current' | undefined, projectUri: FileUri): Promise<FileUri[] | undefined> {
        if (kind === 'current') {
            const doc = lean.lastActiveLeanDocument
            if (doc === undefined) {
                return undefined
            }
            const uri = doc.extUri
            if (uri.scheme !== 'file') {
                return undefined
            }
            const relativeUri = uri.relativeTo(projectUri)
            if (relativeUri === undefined) {
                return undefined
            }
            return [relativeUri]
        }
        if (kind === 'all') {
            return lean.collectOpenLeanFileUris().map(uri => uri.relativeTo(projectUri)).filter(uri => uri !== undefined)
        }
        const visibleDocUris: FileUri[] = []
        const openDocUris: FileUri[] = []
        for (const docUri of lean.collectOpenLeanFileUris()) {
            const relativeUri = docUri.relativeTo(projectUri)
            if (relativeUri === undefined) {
                continue
            }
            if (lean.getVisibleLeanEditorsByUri(docUri).length > 0) {
                visibleDocUris.push(relativeUri)
            } else {
                openDocUris.push(relativeUri)
            }
        }

        if (visibleDocUris.length === 0 && openDocUris.length === 0) {
            return undefined
        }

        visibleDocUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath))
        openDocUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath))

        const items: FileQuickPickItem[] = []
        for (const relativeUri of visibleDocUris) {
            items.push({ label: relativeUri.fsPath, picked: true, relativeUri })
        }
        if (visibleDocUris.length > 0 && openDocUris.length > 0) {
            items.push({ label: '', kind: QuickPickItemKind.Separator })
        }
        for (const relativeUri of openDocUris) {
            items.push({ label: relativeUri.fsPath, picked: true, relativeUri })
        }

        const selected = await window.showQuickPick(items, {
            title: 'Select files to fetch the Mathlib build cache for',
            canPickMany: true,
        })
        if (selected === undefined || selected.length === 0) {
            return []
        }

        return selected
            .filter(item => item.kind !== QuickPickItemKind.Separator)
            .map(item => item.relativeUri)
    }

    private async updateDependency() {
        const activeClient: LeanClient | undefined = this.clientProvider.getActiveClient()
        if (!activeClient) {
            displayNotification('Error', 'No active client.')
            return
        }

        const activeFolderUri = activeClient.folderUri

        if (activeFolderUri.scheme === 'untitled') {
            displayNotification('Error', 'Cannot update dependency of untitled file.')
            return
        }

        const manifestResult: Manifest | ManifestReadError = await parseManifestInFolder(activeFolderUri)
        if (typeof manifestResult === 'string') {
            displayNotification('Error', manifestResult)
            return
        }

        const items: GitDependencyQuickPickItem[] = manifestResult.directGitDependencies.map(gitDep => ({
            label: gitDep.name,
            description: gitDep.uri.toString(),
            ...gitDep,
        }))

        const dependencyChoice: GitDependencyQuickPickItem | undefined = await window.showQuickPick(items, {
            title: 'Choose a dependency to update',
            canPickMany: false,
        })
        if (!dependencyChoice) {
            return
        }

        const warningMessage = `This command will update ${dependencyChoice.name} to its most recent version. It is only intended to be used by maintainers of this project. If the updated version of ${dependencyChoice.name} is incompatible with any other dependency or the code in this project, this project may not successfully build anymore. Are you sure you want to proceed?`
        const warningInput = 'Proceed'
        const warningChoice = await displayNotificationWithInput('Warning', warningMessage, [warningInput])
        if (warningChoice !== warningInput) {
            return
        }

        await this.runOperation('Update Dependency', async lakeRunner => {
            const result: LakeRunnerResult = await lakeRunner.updateDependency(dependencyChoice.name)
            if (result.kind === 'Cancelled') {
                return
            }
            if (result.kind !== 'Success') {
                displayLakeRunnerError(result, 'Cannot update dependency.')
                return
            }

            const fetchResult: 'Success' | 'Failure' = await lakeRunner.tryFetchMathlibCacheWithError()
            if (fetchResult !== 'Success') {
                return
            }

            const localToolchainPath: string = join(activeFolderUri.fsPath, 'lean-toolchain')
            const dependencyToolchainPath: string = join(
                activeFolderUri.fsPath,
                manifestResult.packagesDir,
                dependencyChoice.name,
                'lean-toolchain',
            )
            const dependencyToolchainResult = await this.determineDependencyToolchain(
                localToolchainPath,
                dependencyToolchainPath,
                dependencyChoice.name,
            )
            if (dependencyToolchainResult.kind === 'Cancelled') {
                return
            }

            if (dependencyToolchainResult.kind !== 'DoNotUpdate') {
                try {
                    fs.writeFileSync(localToolchainPath, dependencyToolchainResult.dependencyToolchain)
                } catch {
                    displayNotification('Error', 'Cannot update Lean version.')
                    return
                }
            }
        })
    }

    private async determineDependencyToolchain(
        localToolchainPath: string,
        dependencyToolchainPath: string,
        dependencyName: string,
    ): Promise<DependencyToolchainResult> {
        const toolchainResult = await this.readToolchains(localToolchainPath, dependencyToolchainPath)
        if (!(toolchainResult instanceof Array)) {
            const errorFlavor =
                toolchainResult === 'CannotReadLocalToolchain'
                    ? `Could not read Lean version of open project at '${localToolchainPath}'`
                    : `Could not read Lean version of ${dependencyName} at ${dependencyToolchainPath}`
            const message = `${errorFlavor}. Do you wish to update ${dependencyName} without updating the Lean version of the open project to that of ${dependencyName} regardless?`
            const input = 'Proceed'
            const choice: string | undefined = await displayNotificationWithInput('Information', message, [input])
            return choice === input ? { kind: 'DoNotUpdate' } : { kind: 'Cancelled' }
        }
        const [localToolchain, dependencyToolchain]: [string, string] = toolchainResult

        if (localToolchain === dependencyToolchain) {
            return { kind: 'DoNotUpdate' }
        }

        const message = `The Lean version '${localToolchain}' of the open project differs from the Lean version '${dependencyToolchain}' of ${dependencyName}. Do you wish to update the Lean version of the open project to the Lean version of ${dependencyName}?`
        const updateInput = 'Update Lean Version'
        const keepInput = 'Keep Lean Version'
        const choice = await displayNotificationWithInput('Information', message, [keepInput, updateInput])
        if (choice === undefined) {
            return { kind: 'Cancelled' }
        }
        if (choice !== updateInput) {
            return { kind: 'DoNotUpdate' }
        }

        return { kind: 'Success', dependencyToolchain }
    }

    private async readToolchains(
        localToolchainPath: string,
        dependencyToolchainPath: string,
    ): Promise<[string, string] | 'CannotReadLocalToolchain' | 'CannotReadDependencyToolchain'> {
        let localToolchain: string
        try {
            localToolchain = fs.readFileSync(localToolchainPath, 'utf8').trim()
        } catch (e) {
            return 'CannotReadLocalToolchain'
        }

        let dependencyToolchain: string
        try {
            dependencyToolchain = fs.readFileSync(dependencyToolchainPath, 'utf8').trim()
        } catch (e) {
            return 'CannotReadDependencyToolchain'
        }

        return [localToolchain, dependencyToolchain]
    }

    private async runOperation(context: string, command: (lakeRunner: LakeRunner) => Promise<void>) {
        if (this.isRunningOperation) {
            displayNotification(
                'Error',
                'Another project action is already being executed. Please wait for its completion.',
            )
            return
        }
        this.isRunningOperation = true
        try {
            if (!this.clientProvider) {
                displayNotification('Error', 'Lean client has not loaded yet.')
                return
            }

            const activeClient: LeanClient | undefined = this.clientProvider.getActiveClient()
            if (!activeClient) {
                displayNotification('Error', 'No active client.')
                return
            }

            if (activeClient.folderUri.scheme === 'untitled') {
                displayNotification('Error', 'Cannot run project action for untitled files.')
                return
            }

            const lakeRunner: LakeRunner = lake({
                channel: this.channel,
                cwdUri: activeClient.folderUri,
                context,
                toolchainUpdateMode: 'DoNotUpdate',
            })

            const result = await activeClient.withStoppedClient(() => command(lakeRunner))
            if (result.kind === 'IsRestarting') {
                displayNotification('Error', 'Cannot run project action while restarting the server.')
            }
        } finally {
            this.isRunningOperation = false
        }
    }

    dispose() {
        for (const s of this.subscriptions) {
            s.dispose()
        }
    }
}

interface GitDependencyQuickPickItem extends QuickPickItem, DirectGitDependency {}

type FileQuickPickItem =
    | (QuickPickItem & { kind: QuickPickItemKind.Separator; relativeUri?: undefined })
    | (QuickPickItem & { kind?: QuickPickItemKind.Default; relativeUri: FileUri })
