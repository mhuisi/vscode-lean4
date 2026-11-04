import { commands, Disposable, OutputChannel, QuickPickItem, SaveDialogOptions, Uri, window, workspace } from 'vscode'
import { checkAll, SetupDiagnostics } from './diagnostics/setupDiagnostics'
import { PreconditionCheckResult, SetupNotificationOptions } from './diagnostics/setupNotifs'
import {
    batchExecute,
    batchExecuteWithProgress,
    displayResultError,
    ExecutionExitCode,
    ExecutionResult,
} from './utils/batch'
import { DepInstaller } from './utils/depInstaller'
import { elanStableChannel } from './utils/elan'
import { ExtUri, extUriToCwdUri, FileUri } from './utils/exturi'
import { displayLakeRunnerError, FetchMathlibCacheResult, lake, LakeRunnerResult } from './utils/lake'
import { LeanInstaller } from './utils/leanInstaller'
import { displayNotification, displayNotificationWithInput } from './utils/notifs'
import { checkParentFoldersForLeanProject, isValidLeanProject } from './utils/projectInfo'

const projectInitNotificationOptions: SetupNotificationOptions = {
    errorMode: { mode: 'NonModal' },
    warningMode: { modal: true, proceedByDefault: false },
}

async function checkCreateLean4ProjectPreconditions(
    leanInstaller: LeanInstaller,
    depInstaller: DepInstaller,
    context: string,
    folderUri: ExtUri,
    projectToolchain: string,
): Promise<PreconditionCheckResult> {
    const channel = leanInstaller.getOutputChannel()
    const cwdUri = extUriToCwdUri(folderUri)
    const d = new SetupDiagnostics(projectInitNotificationOptions)
    return await checkAll(
        () => d.checkAreDependenciesInstalled(depInstaller, channel, cwdUri),
        () => d.checkIsElanUpToDate(leanInstaller, cwdUri, { elanMustBeInstalled: true }),
        () =>
            d.checkIsLeanVersionUpToDate(channel, context, folderUri, {
                toolchainUpdateMode: 'UpdateAutomatically',
                toolchainOverride: projectToolchain,
            }),
        () =>
            d.checkIsLakeInstalledCorrectly(channel, context, folderUri, {
                toolchainOverride: projectToolchain,
                toolchainUpdateMode: 'UpdateAutomatically',
            }),
    )
}

async function checkPreCloneLean4ProjectPreconditions(
    depInstaller: DepInstaller,
    channel: OutputChannel,
    cwdUri: FileUri | undefined,
) {
    const d = new SetupDiagnostics(projectInitNotificationOptions)
    return await checkAll(() => d.checkAreDependenciesInstalled(depInstaller, channel, cwdUri))
}

async function checkPostCloneLean4ProjectPreconditions(installer: LeanInstaller, context: string, folderUri: ExtUri) {
    const channel = installer.getOutputChannel()
    const cwdUri = extUriToCwdUri(folderUri)
    const d = new SetupDiagnostics(projectInitNotificationOptions)
    return await checkAll(
        () => d.checkIsElanUpToDate(installer, cwdUri, { elanMustBeInstalled: false }),
        () => d.checkIsLeanVersionUpToDate(channel, context, folderUri, { toolchainUpdateMode: 'UpdateAutomatically' }),
        () =>
            d.checkIsLakeInstalledCorrectly(channel, context, folderUri, {
                toolchainUpdateMode: 'UpdateAutomatically',
            }),
    )
}

export class ProjectInitializationProvider implements Disposable {
    private subscriptions: Disposable[] = []

    constructor(
        private channel: OutputChannel,
        private leanInstaller: LeanInstaller,
        private depInstaller: DepInstaller,
    ) {
        this.subscriptions.push(
            commands.registerCommand('lean4.project.createStandaloneProject', () => this.createStandaloneProject()),
            commands.registerCommand('lean4.project.createMathlibProject', () => this.createMathlibProject()),
            commands.registerCommand('lean4.project.open', () => this.openProject()),
            commands.registerCommand('lean4.project.clone', () => this.cloneProject()),
        )
    }

    private async createStandaloneProject() {
        const createStandaloneProjectContext = 'Create Standalone Project'
        const toolchain = elanStableChannel
        const projectFolder: FileUri | 'DidNotComplete' = await this.createProject(
            createStandaloneProjectContext,
            undefined,
            toolchain,
        )
        if (projectFolder === 'DidNotComplete') {
            return
        }

        const buildResult: LakeRunnerResult = await lake({
            channel: this.channel,
            cwdUri: projectFolder,
            context: createStandaloneProjectContext,
            toolchain,
            toolchainUpdateMode: 'UpdateAutomatically',
        }).build()
        if (buildResult.kind === 'Cancelled') {
            return
        }
        if (buildResult.kind !== 'Success') {
            displayLakeRunnerError(buildResult, 'Cannot build Lean project.')
            return
        }

        const initialCommitResult: 'Success' | 'GitAddFailed' | 'GitCommitFailed' =
            await this.createInitialCommit(projectFolder)
        if (initialCommitResult !== 'Success') {
            return
        }

        await ProjectInitializationProvider.openNewFolder(projectFolder)
    }

    private async createMathlibProject() {
        const createMathlibProjectContext = 'Create Project Using Mathlib'
        const mathlibToolchain = 'leanprover-community/mathlib4:lean-toolchain'
        const projectFolder: FileUri | 'DidNotComplete' = await this.createProject(
            createMathlibProjectContext,
            'math',
            mathlibToolchain,
        )
        if (projectFolder === 'DidNotComplete') {
            return
        }

        const cacheGetResult: FetchMathlibCacheResult = await lake({
            channel: this.channel,
            cwdUri: projectFolder,
            context: createMathlibProjectContext,
            toolchain: mathlibToolchain,
            toolchainUpdateMode: 'UpdateAutomatically',
        }).fetchMathlibCache()
        if (cacheGetResult.kind === 'Cancelled') {
            return
        }
        if (cacheGetResult.kind === 'CacheUnavailable') {
            displayNotification(
                'Error',
                'Cannot fetch Mathlib build artifact cache: `lake exe cache` is not available.',
            )
            return
        }
        if (cacheGetResult.kind !== 'Success') {
            displayLakeRunnerError(cacheGetResult, 'Cannot fetch Mathlib build artifact cache.')
            return
        }

        const buildResult: LakeRunnerResult = await lake({
            channel: this.channel,
            cwdUri: projectFolder,
            context: createMathlibProjectContext,
            toolchain: mathlibToolchain,
            toolchainUpdateMode: 'UpdateAutomatically',
        }).build()
        if (buildResult.kind === 'Cancelled') {
            return
        }
        if (buildResult.kind !== 'Success') {
            displayLakeRunnerError(buildResult, 'Cannot build Lean project.')
            return
        }

        const initialCommitResult: 'Success' | 'GitAddFailed' | 'GitCommitFailed' =
            await this.createInitialCommit(projectFolder)
        if (initialCommitResult !== 'Success') {
            return
        }

        await ProjectInitializationProvider.openNewFolder(projectFolder)
    }

    private async createProject(
        context: string,
        kind?: string | undefined,
        toolchain: string = elanStableChannel,
    ): Promise<FileUri | 'DidNotComplete'> {
        const projectFolder: FileUri | undefined = await ProjectInitializationProvider.askForNewProjectFolderLocation({
            saveLabel: 'Create project folder',
            title: 'Create a new project folder',
        })
        if (projectFolder === undefined) {
            return 'DidNotComplete'
        }

        await workspace.fs.createDirectory(projectFolder.asUri())

        const preconditionCheckResult = await checkCreateLean4ProjectPreconditions(
            this.leanInstaller,
            this.depInstaller,
            context,
            projectFolder,
            toolchain,
        )
        if (preconditionCheckResult === 'Fatal') {
            return 'DidNotComplete'
        }

        const projectName: string = projectFolder.baseName()
        const result: LakeRunnerResult = await lake({
            channel: this.channel,
            cwdUri: projectFolder,
            context,
            toolchain,
            toolchainUpdateMode: 'UpdateAutomatically',
        }).initProject(projectName, kind)
        if (result.kind === 'Cancelled') {
            return 'DidNotComplete'
        }
        if (result.kind !== 'Success') {
            displayLakeRunnerError(result, 'Cannot initialize project.')
            return 'DidNotComplete'
        }

        const updateResult: LakeRunnerResult = await lake({
            channel: this.channel,
            cwdUri: projectFolder,
            context,
            toolchain,
            toolchainUpdateMode: 'UpdateAutomatically',
        }).updateDependencies()
        if (updateResult.kind === 'Cancelled') {
            return 'DidNotComplete'
        }
        if (updateResult.kind !== 'Success') {
            displayLakeRunnerError(updateResult, 'Cannot update dependencies.')
            return 'DidNotComplete'
        }

        return projectFolder
    }

    private async createInitialCommit(projectFolder: FileUri): Promise<'Success' | 'GitAddFailed' | 'GitCommitFailed'> {
        const gitAddResult = await batchExecute('git', ['add', '--all'], projectFolder.fsPath, {
            combined: this.channel,
        })
        if (gitAddResult.exitCode !== ExecutionExitCode.Success) {
            displayResultError(gitAddResult, 'Cannot add files to staging area of Git repository for project.')
            return 'GitAddFailed'
        }

        const author = 'Lean 4 VS Code Extension'
        const email = '<>'

        const gitCommitResult = await batchExecute(
            'git',
            ['-c', `user.name='${author}'`, '-c', `user.email='${email}'`, 'commit', '-m', 'Initial commit'],
            projectFolder.fsPath,
            { combined: this.channel },
        )
        if (gitCommitResult.exitCode !== ExecutionExitCode.Success) {
            displayResultError(gitCommitResult, 'Cannot commit files to Git repository for project.')
            return 'GitCommitFailed'
        }

        return 'Success'
    }

    private async openProject() {
        const projectFolders: Uri[] | undefined = await window.showOpenDialog({
            title: "Open Lean 4 project folder containing a 'lean-toolchain' file",
            openLabel: 'Open project folder',
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
        })
        if (projectFolders === undefined || projectFolders.length !== 1) {
            return
        }

        const projectFolderUri = projectFolders[0]
        if (!(await ProjectInitializationProvider.checkIsFileUriOrShowError(projectFolderUri))) {
            return
        }
        let projectFolder = new FileUri(projectFolderUri.fsPath)

        if (!(await isValidLeanProject(projectFolder))) {
            const parentProjectFolder: FileUri | undefined =
                await ProjectInitializationProvider.attemptFindingLeanProjectInParentFolder(projectFolder)
            if (parentProjectFolder === undefined) {
                return
            }
            projectFolder = parentProjectFolder
        }

        // This kills the extension host, so it has to be the last command
        await commands.executeCommand('vscode.openFolder', projectFolder.asUri())
    }

    private static async attemptFindingLeanProjectInParentFolder(projectFolder: FileUri): Promise<FileUri | undefined> {
        const parentProjectFolder: FileUri | undefined = await checkParentFoldersForLeanProject(projectFolder)
        if (parentProjectFolder === undefined) {
            const message = `The selected folder is not a valid Lean 4 project folder.
Please make sure to select a folder containing a \'lean-toolchain\' file.
Click the following link to learn how to set up Lean projects: [(Show Setup Guide)](command:lean4.docs.showSetupGuide)`
            displayNotification('Error', message)
            return undefined
        }

        const message = `The selected folder is not a valid Lean 4 project folder because it does not contain a 'lean-toolchain' file.
However, a valid Lean 4 project folder was found in one of the parent directories at '${parentProjectFolder.fsPath}'.
Open this project instead?`
        const input = 'Open parent directory project'
        const choice: string | undefined = await displayNotificationWithInput('Information', message, [input])
        if (choice !== input) {
            return undefined
        }

        return parentProjectFolder
    }

    private async cloneProject() {
        const downloadProjectContext = 'Download Project'

        const quickPick = window.createQuickPick<QuickPickItem & { isPreset: boolean }>()
        quickPick.title = "Enter a Git repository URL or choose a preset project to download (Press 'Escape' to cancel)"
        quickPick.placeholder = 'URL of Git repository for existing Lean 4 project'
        quickPick.ignoreFocusOut = true
        quickPick.matchOnDescription = true
        quickPick.matchOnDetail = true
        const presets: (QuickPickItem & { isPreset: boolean })[] = [
            {
                label: 'Mathlib',
                description: "Lean's math library",
                detail: 'https://github.com/leanprover-community/mathlib4',
                isPreset: true,
            },
            {
                label: 'Mathematics in Lean',
                description: 'Introduction to Lean for users with a mathematics background',
                detail: 'https://github.com/leanprover-community/mathematics_in_lean',
                isPreset: true,
            },
        ]
        quickPick.items = presets
        quickPick.onDidChangeValue(_ => {
            if (
                quickPick.activeItems.length === 0 ||
                (quickPick.activeItems.length === 1 && !quickPick.activeItems[0].isPreset)
            ) {
                quickPick.items = presets.concat({
                    label: 'Git repository URL',
                    detail: quickPick.value,
                    isPreset: false,
                })
            } else {
                quickPick.items = presets
            }
        })
        quickPick.onDidAccept(async () => {
            const cloneChoices = quickPick.selectedItems
            quickPick.dispose()

            if (cloneChoices.length === 0) {
                return
            }
            const cloneChoice = cloneChoices[0]
            if (cloneChoice.detail === undefined) {
                return
            }
            const projectUri: string = cloneChoice.detail

            const projectFolder: FileUri | undefined =
                await ProjectInitializationProvider.askForNewProjectFolderLocation({
                    saveLabel: 'Create project folder',
                    title: 'Create a new project folder to clone existing Lean 4 project into',
                })
            if (projectFolder === undefined) {
                return
            }

            await workspace.fs.createDirectory(projectFolder.asUri())

            const preCloneCheckResult = await checkPreCloneLean4ProjectPreconditions(
                this.depInstaller,
                this.leanInstaller.getOutputChannel(),
                projectFolder,
            )
            if (preCloneCheckResult === 'Fatal') {
                return
            }

            const result: ExecutionResult = await batchExecuteWithProgress(
                'git',
                ['clone', projectUri, projectFolder.fsPath],
                downloadProjectContext,
                'Cloning project',
                { channel: this.channel, allowCancellation: true },
            )
            if (result.exitCode === ExecutionExitCode.Cancelled) {
                return
            }
            if (result.exitCode !== ExecutionExitCode.Success) {
                displayResultError(result, 'Cannot download project.')
                return
            }

            const postCloneCheckResult = await checkPostCloneLean4ProjectPreconditions(
                this.leanInstaller,
                downloadProjectContext,
                projectFolder,
            )
            if (postCloneCheckResult === 'Fatal') {
                return
            }

            const lakeRunner = lake({
                channel: this.channel,
                cwdUri: projectFolder,
                context: downloadProjectContext,
                toolchainUpdateMode: 'UpdateAutomatically',
            })

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

            const buildResult = await lakeRunner.build()
            if (buildResult.kind === 'Cancelled') {
                return
            }
            if (buildResult.kind === 'Error') {
                displayLakeRunnerError(buildResult, 'Cannot build downloaded project.')
                return
            }

            await ProjectInitializationProvider.openNewFolder(projectFolder)
        })

        quickPick.show()
    }

    private static async askForNewProjectFolderLocation(options: SaveDialogOptions): Promise<FileUri | undefined> {
        const projectFolder: Uri | undefined = await window.showSaveDialog(options)
        if (projectFolder === undefined || !(await this.checkIsFileUriOrShowError(projectFolder))) {
            return undefined
        }
        return new FileUri(projectFolder.fsPath)
    }

    private static async checkIsFileUriOrShowError(projectFolder: Uri): Promise<boolean> {
        if (projectFolder.scheme === 'file') {
            return true
        } else {
            displayNotification('Error', 'Project folder must be created in a file system.')
            return false
        }
    }

    private static async openNewFolder(projectFolder: FileUri) {
        const message = `Project initialized. Open new project folder '${projectFolder.baseName()}'?`
        const input = 'Open project folder'
        const choice: string | undefined = await displayNotificationWithInput('Information', message, [input])
        if (choice === input) {
            // This kills the extension host, so it has to be the last command
            await commands.executeCommand('vscode.openFolder', projectFolder.asUri())
        }
    }

    dispose() {
        for (const s of this.subscriptions) {
            s.dispose()
        }
    }
}
