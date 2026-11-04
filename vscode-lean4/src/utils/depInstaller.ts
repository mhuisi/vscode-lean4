import * as os from 'os'
import path from 'path'
import { commands, Disposable, env, OutputChannel } from 'vscode'
import { SetupDiagnoser } from '../diagnostics/setupDiagnoser'
import {
    batchExecuteWithProgress,
    displayModalResultError,
    ExecutionExitCode,
    ExecutionResult,
    ProgressExecutionOptions,
} from './batch'
import { addToProcessEnvPATH } from './envPath'
import {
    displayModalNotification,
    displayNotification,
    displayNotificationWithInput,
    displayStickyNotificationWithOptionalInput,
    NotificationSeverity,
    StickyInput,
    StickyNotificationOptions,
} from './notifs'

export type LinuxPackageManager =
    | { kind: 'Apt'; isPkExecAvailable: boolean }
    | { kind: 'Dnf'; isPkExecAvailable: boolean }
    | { kind: 'Other' }

export type DependencyInstallationMethod =
    | {
          kind: 'Automatic'
          shell: 'Windows' | 'Unix'
          script: string
          manualBackupScript: string | undefined
          pathExtensions: string[]
      }
    | { kind: 'Manual'; script: string | undefined }

export type MissingDependencyInstallationProcedure =
    | { kind: 'Linux'; isGitAvailable: boolean; isCurlAvailable: boolean; packageManager: LinuxPackageManager }
    | { kind: 'MacOS'; isGitAvailable: boolean; isCurlAvailable: boolean }
    | { kind: 'Windows'; isGitAvailable: boolean; isCurlAvailable: boolean; isWinGetAvailable: boolean }
    | { kind: 'Other'; isGitAvailable: boolean; isCurlAvailable: boolean }

export type DependencyInstallationProcedure =
    | { kind: 'AllDepsInstalled' }
    | (MissingDependencyInstallationProcedure & { method: DependencyInstallationMethod })

export type DependencyInstallationResult =
    | { kind: 'Success' }
    | { kind: 'Error'; result: ExecutionResult }
    | { kind: 'Cancelled' }
    | { kind: 'PendingInstall' }

function windowsGitInstallDirs(): string[] {
    const dirs = []
    const localAppDataDir = process.env.LOCALAPPDATA
    if (localAppDataDir !== undefined) {
        dirs.push(path.join(localAppDataDir, 'Programs', 'Git', 'cmd'))
    }
    dirs.push(path.join('c:', 'Program Files', 'Git', 'cmd'))
    return dirs
}

export function depInstallationLocations(): string[] {
    switch (os.type()) {
        case 'Linux':
            // Installation locations of Git and curl should already be in PATH on most Linux systems
            return []
        case 'Darwin':
            // MacOS ships with a dummy executable for Git that is already in the PATH, which is replaced
            // with the real executable when Apple Command Line Tools is installed.
            return []
        case 'Windows_NT':
            return windowsGitInstallDirs()
    }
    return []
}

const windowsRawGitInstallScript = `$gitInstallerUrl = "https://github.com/git-for-windows/git/releases/download/v2.50.1.windows.1/Git-2.50.1-64-bit.exe"
$installDir = Join-Path $env:TEMP "lean4-vscode-extension"
$gitInstallerLoc = Join-Path $installDir "GitInstaller.exe"
try {
    New-Item -ItemType Directory -Path $installDir -Force -ErrorAction Stop | Out-Null
    Invoke-WebRequest -Uri $gitInstallerUrl -OutFile $gitInstallerLoc -ErrorAction Stop
    & $gitInstallerLoc /VERYSILENT /NORESTART /SP-
} catch {
    Write-Host "Downloading or starting the Git installer failed."
    Write-Host $_
    exit 1
}
exit $LASTEXITCODE`

const macOsInstallScript = `set -e
touch "/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress"
aclt_label="$(/usr/sbin/softwareupdate -l |
              grep -B 1 -E 'Command Line Tools' |
              awk -F'*' '/^ *\\*/ {print $2}' |
              sed -e 's/^ *Label: //' -e 's/^ *//' |
              sort -V |
              tail -n1 |
              tr -d '\n')"
/usr/sbin/softwareupdate -i "$aclt_label"`

export class DepInstaller implements Disposable {
    private pendingInstall: boolean = false
    private diagnoser: SetupDiagnoser

    private subscriptions: Disposable[] = []

    constructor(readonly outputChannel: OutputChannel) {
        this.diagnoser = new SetupDiagnoser({
            channel: outputChannel,
            cwdUri: undefined,
            context: 'Dependency Installation',
        })
        this.subscriptions.push(
            commands.registerCommand('lean4.setup.installDeps', () =>
                this.displayInstallDependenciesPrompt('Information', undefined),
            ),
        )
    }

    async displayInstallDependenciesPrompt(
        severity: NotificationSeverity,
        reason: string | undefined,
    ): Promise<'Success' | 'PendingInstall' | 'Failure'> {
        const p = await this.determineDependencyInstallationProcedure()
        if (p.kind === 'AllDepsInstalled') {
            displayNotification('Information', 'All dependencies of Lean (Git and curl) are already installed.')
            return 'Success'
        }
        if (p.method.kind === 'Manual') {
            await displayManualInstallationPrompt(severity, reason, p)
            return 'Failure'
        }
        const choice = await displayNotificationWithInput(severity, installDependenciesPrompt(reason, p), ['Proceed'])
        if (choice !== 'Proceed') {
            return 'Failure'
        }
        return await this.installMissingDepsAndDisplayNotification(p)
    }

    async displayStickyInstallDependenciesPrompt(
        severity: NotificationSeverity,
        reason: string | undefined,
        options: StickyNotificationOptions<string>,
        otherItems: StickyInput<string>[] = [],
    ): Promise<Disposable> {
        const p = await this.determineDependencyInstallationProcedure()
        if (p.kind === 'AllDepsInstalled') {
            displayNotification('Information', 'All dependencies of Lean (Git and curl) are already installed.')
            return Disposable.from()
        }
        if (p.method.kind === 'Manual') {
            return await displayStickyManualInstallationPrompt(severity, reason, p, options, otherItems)
        }
        const installDepsItem: StickyInput<'Install Dependencies'> = {
            input: 'Install Dependencies',
            continueDisplaying: false,
            action: async () => {
                await this.installMissingDepsAndDisplayNotification(p)
            },
        }
        return displayStickyNotificationWithOptionalInput(severity, installDependenciesPrompt(reason, p), options, [
            installDepsItem,
            ...otherItems,
        ])
    }

    private async installMissingDepsAndDisplayNotification(
        p: MissingDependencyInstallationProcedure & { method: DependencyInstallationMethod },
    ): Promise<'Success' | 'PendingInstall' | 'Failure'> {
        const r = await this.installMissingDeps(p)
        switch (r.kind) {
            case 'Success':
                displayNotification('Information', 'Dependency installation successful!')
                return 'Success'
            case 'Error':
                await displayModalResultError(r.result, unsuccessfulDependencyInstallationPrompt(p))
                return 'Failure'
            case 'Cancelled':
                return 'Failure'
            case 'PendingInstall':
                return 'PendingInstall'
        }
    }

    async installMissingDeps(
        p: MissingDependencyInstallationProcedure & {
            method: DependencyInstallationMethod
        },
    ): Promise<DependencyInstallationResult> {
        if (p.method.kind === 'Manual') {
            throw new Error('got manual installation method in `installMissingDeps`')
        }
        if (this.pendingInstall) {
            displayNotification('Error', 'Dependencies are already being installed.')
            return { kind: 'PendingInstall' }
        }
        this.pendingInstall = true
        try {
            const installationResult = await this.runCommand(
                p.method.script,
                [],
                'Installing missing dependencies',
                p.method.shell,
            )
            switch (installationResult.exitCode) {
                case ExecutionExitCode.Success:
                    this.addDepsToProcessEnv(p.method)
                    return { kind: 'Success' }
                case ExecutionExitCode.CannotLaunch:
                case ExecutionExitCode.ExecutionError:
                    return { kind: 'Error', result: installationResult }
                case ExecutionExitCode.Cancelled:
                    return { kind: 'Cancelled' }
            }
        } finally {
            this.pendingInstall = false
        }
    }

    private addDepsToProcessEnv(method: DependencyInstallationMethod) {
        if (method.kind !== 'Automatic') {
            return
        }
        for (const pathExt of method.pathExtensions) {
            addToProcessEnvPATH(pathExt)
        }
    }

    async determineDependencyInstallationProcedure(): Promise<DependencyInstallationProcedure> {
        const p = await this.determineMissingDependencyInstallationProcedure()
        if (p === undefined) {
            return { kind: 'AllDepsInstalled' }
        }
        return { ...p, method: dependencyInstallationMethod(p) }
    }

    private async determineMissingDependencyInstallationProcedure(): Promise<
        MissingDependencyInstallationProcedure | undefined
    > {
        const isCurlAvailable = await this.diagnoser.checkCurlAvailable()
        const isGitAvailable = await this.diagnoser.checkGitAvailable()
        if (isCurlAvailable && isGitAvailable) {
            return undefined
        }

        switch (os.type()) {
            case 'Linux':
                const isAptAvailable = await this.diagnoser.checkAptGetAvailable()
                if (isAptAvailable) {
                    const isPkExecAvailable = await this.diagnoser.checkPkExecAvailable()
                    return {
                        kind: 'Linux',
                        isCurlAvailable,
                        isGitAvailable,
                        packageManager: { kind: 'Apt', isPkExecAvailable },
                    }
                }
                const isDnfAvailable = await this.diagnoser.checkDnfAvailable()
                if (isDnfAvailable) {
                    const isPkExecAvailable = await this.diagnoser.checkPkExecAvailable()
                    return {
                        kind: 'Linux',
                        isCurlAvailable,
                        isGitAvailable,
                        packageManager: { kind: 'Dnf', isPkExecAvailable },
                    }
                }
                return {
                    kind: 'Linux',
                    isCurlAvailable,
                    isGitAvailable,
                    packageManager: { kind: 'Other' },
                }
            case 'Darwin':
                return {
                    kind: 'MacOS',
                    isCurlAvailable,
                    isGitAvailable,
                }
            case 'Windows_NT':
                const isWinGetAvailable = await this.diagnoser.checkWinGetAvailable()
                return {
                    kind: 'Windows',
                    isCurlAvailable,
                    isGitAvailable,
                    isWinGetAvailable,
                }
        }
        return {
            kind: 'Other',
            isCurlAvailable,
            isGitAvailable,
        }
    }

    private async runCommand(
        executablePath: string,
        args: string[],
        title: string,
        shell?: 'Unix' | 'Windows' | undefined,
    ): Promise<ExecutionResult> {
        const options: ProgressExecutionOptions = {
            allowCancellation: true,
            channel: this.outputChannel,
            shell,
        }
        return batchExecuteWithProgress(executablePath, args, 'Dependency Installation', title, options)
    }

    dispose() {
        for (const s of this.subscriptions) {
            s.dispose()
        }
    }
}

function dependencyInstallationMethod(p: MissingDependencyInstallationProcedure): DependencyInstallationMethod {
    switch (p.kind) {
        case 'Linux':
            switch (p.packageManager.kind) {
                case 'Apt':
                    const manualAptScript = `sudo apt update && sudo apt install ${missingDeps(p).join(' ')}`
                    if (!p.packageManager.isPkExecAvailable) {
                        return {
                            kind: 'Manual',
                            script: manualAptScript,
                        }
                    }
                    return {
                        kind: 'Automatic',
                        shell: 'Unix',
                        // `ulimit -Sn 1024`: https://github.com/microsoft/vscode/issues/237427
                        script: `ulimit -Sn 1024; pkexec bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -y && apt-get install -y ${missingDeps(p).join(' ')}'`,
                        manualBackupScript: manualAptScript,
                        pathExtensions: [],
                    }
                case 'Dnf':
                    const manualDnfScript = `sudo dnf install ${missingDeps(p).join(' ')}`
                    if (!p.packageManager.isPkExecAvailable) {
                        return {
                            kind: 'Manual',
                            script: manualDnfScript,
                        }
                    }
                    return {
                        kind: 'Automatic',
                        shell: 'Unix',
                        script: `pkexec dnf install -y ${missingDeps(p).join(' ')}`,
                        manualBackupScript: manualDnfScript,
                        pathExtensions: [],
                    }
                case 'Other':
                    return {
                        kind: 'Manual',
                        script: undefined,
                    }
            }
        case 'MacOS':
            if (!p.isCurlAvailable) {
                return {
                    kind: 'Manual',
                    script: undefined,
                }
            }
            return {
                kind: 'Automatic',
                shell: 'Unix',
                script: macOsInstallScript,
                manualBackupScript: macOsInstallScript,
                pathExtensions: [],
            }
        case 'Windows':
            if (!p.isCurlAvailable) {
                return {
                    kind: 'Manual',
                    script: undefined,
                }
            }
            if (!p.isWinGetAvailable) {
                return {
                    kind: 'Automatic',
                    shell: 'Windows',
                    script: windowsRawGitInstallScript,
                    manualBackupScript: undefined,
                    pathExtensions: windowsGitInstallDirs(),
                }
            }
            const windowsWingetGitInstallScript =
                'winget install -e --id Git.Git --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity'
            return {
                kind: 'Automatic',
                shell: 'Windows',
                script: windowsWingetGitInstallScript,
                manualBackupScript: windowsWingetGitInstallScript,
                pathExtensions: windowsGitInstallDirs(),
            }

        case 'Other':
            return {
                kind: 'Manual',
                script: undefined,
            }
    }
}

async function displayManualInstallationPrompt(
    severity: NotificationSeverity,
    reason: string | undefined,
    p: MissingDependencyInstallationProcedure & { method: DependencyInstallationMethod },
) {
    let reasonPrefix = ''
    if (reason !== undefined) {
        reasonPrefix = `${reason} `
    }
    if (p.method.script === undefined) {
        await displayModalNotification(
            severity,
            `${reasonPrefix}Please install ${missingDepsSentence(p)} and restart VS Code.`,
        )
        return
    }
    const prompt = `${reasonPrefix}Please install ${missingDepsSentence(p)} from a terminal using the script below and restart VS Code.\n\n${p.method.script}`
    const copyToClipboardInput = 'Copy Script to Clipboard'
    const choice = await displayNotificationWithInput('Information', prompt, [copyToClipboardInput], 'Close')
    if (choice === copyToClipboardInput) {
        await env.clipboard.writeText(p.method.script)
    }
}

async function displayStickyManualInstallationPrompt(
    severity: NotificationSeverity,
    reason: string | undefined,
    p: MissingDependencyInstallationProcedure & { method: DependencyInstallationMethod },
    options: StickyNotificationOptions<string>,
    otherItems: StickyInput<string>[] = [],
): Promise<Disposable> {
    let reasonPrefix = ''
    if (reason !== undefined) {
        reasonPrefix = `${reason} `
    }
    const script = p.method.script
    if (script === undefined) {
        await displayModalNotification(
            severity,
            `${reasonPrefix}Please install ${missingDepsSentence(p)} and restart VS Code.`,
        )
        return Disposable.from()
    }
    const prompt = `${reasonPrefix}Please install ${missingDepsSentence(p)} from a [terminal](command:workbench.action.terminal.new) using the script below and restart VS Code.\n\n${script}`
    const copyToClipboardItem: StickyInput<'Copy Script to Clipboard'> = {
        input: 'Copy Script to Clipboard',
        continueDisplaying: true,
        action: async () => {
            await env.clipboard.writeText(script)
        },
    }
    return displayStickyNotificationWithOptionalInput(severity, prompt, options, [copyToClipboardItem, ...otherItems])
}

export function missingDepsSentence(p: MissingDependencyInstallationProcedure): string {
    return sentenceJoin(missingDeps(p).map(d => '`' + d + '`'))
}

export function sentenceJoin(entries: string[]): string {
    if (entries.length === 0) {
        throw new Error('Cannot join empty array.')
    }
    if (entries.length === 1) {
        return entries[0]
    }
    if (entries.length === 2) {
        return `${entries[0]} and ${entries[1]}`
    }
    return `${entries.slice(0, entries.length - 1).join(', ')} and ${entries[entries.length - 1]}`
}

export function missingDeps(p: MissingDependencyInstallationProcedure): string[] {
    const missingDeps = []
    if (!p.isGitAvailable) {
        missingDeps.push('git')
    }
    if (!p.isCurlAvailable) {
        missingDeps.push('curl')
    }
    return missingDeps
}

function installDependenciesPrompt(
    reason: string | undefined,
    p: MissingDependencyInstallationProcedure & {
        method: DependencyInstallationMethod
    },
): string {
    if (p.method.kind === 'Manual') {
        throw new Error('cannot display installDependenciesPrompt for manual installation')
    }
    let reasonPrefix = ''
    if (reason !== undefined) {
        reasonPrefix = `${reason} `
    }
    return `${reasonPrefix}Do you wish to install ${missingDepsSentence(p)}?`
}

export function unsuccessfulDependencyInstallationPrompt(
    p: MissingDependencyInstallationProcedure & {
        method: DependencyInstallationMethod
    },
): string {
    if (p.method.kind === 'Manual') {
        throw new Error('cannot display unsuccessfulDependencyInstallationPrompt for manual installation')
    }
    if (p.method.manualBackupScript === undefined) {
        return `Installation of ${missingDepsSentence(p)} unsuccessful.`
    }
    return `Installation of ${missingDepsSentence(p)} unsuccessful.
If you are unable to figure out the issue from the command output below, you can also try running the following manual installation script from a terminal:

${p.method.manualBackupScript}`
}
