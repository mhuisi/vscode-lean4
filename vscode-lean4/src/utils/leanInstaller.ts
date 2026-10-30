import { SemVer } from 'semver'
import { Disposable, OutputChannel, commands } from 'vscode'
import { setAlwaysAskBeforeInstallingLeanVersions } from '../config'
import {
    ExecutionExitCode,
    ExecutionResult,
    batchExecuteWithProgress,
    displayModalResultError,
    displayResultError,
} from './batch'
import { LeanClientProvider } from './clientProvider'
import { elanSelfUninstall, elanSelfUpdate, elanVersion, isElanEagerResolutionVersion } from './elan'
import {
    NotificationSeverity,
    StickyInput,
    StickyNotificationOptions,
    displayNotification,
    displayNotificationWithInput,
    displayStickyNotificationWithOptionalInput,
} from './notifs'
// The CI action `setup-elan` runs the same scripts.
import unixInstallationScript from '../../scripts/elan-install/install-unix.sh'
import windowsInstallationScript from '../../scripts/elan-install/install-windows.ps1'

export function elanInstallationMethod(): ElanInstallationMethod {
    if (process.platform === 'win32') {
        return {
            script: windowsInstallationScript,
            // `batchExecuteWithProc` starts PowerShell with the execution policy `Bypass`. A user who
            // runs the script in a terminal needs this policy for the session, else Windows PowerShell
            // cannot load the script module of `Expand-Archive`.
            manualScript:
                'Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force\n' + windowsInstallationScript,
            shell: 'Windows',
        }
    }
    return {
        script: unixInstallationScript,
        manualScript: unixInstallationScript,
        shell: 'Unix',
    }
}

export class LeanVersion {
    version: string
    error: string | undefined
}

export type UpdateElanMode =
    | {
          kind: 'Outdated'
          versions: { currentVersion: SemVer; recommendedVersion: SemVer }
      }
    | {
          kind: 'Manual'
          versions: { currentVersion: SemVer }
      }

export type ElanInstallationMethod = { script: string; manualScript: string; shell: 'Windows' | 'Unix' }

export type ElanInstallationResult =
    | { kind: 'Success' }
    | { kind: 'Error'; result: ExecutionResult }
    | { kind: 'Cancelled' }
    | { kind: 'PendingOperation' }

export class LeanInstaller implements Disposable {
    private outputChannel: OutputChannel
    private clientProvider: LeanClientProvider | undefined
    private pendingOperation: 'Install' | 'Update' | 'Uninstall' | undefined

    private subscriptions: Disposable[] = []

    constructor(outputChannel: OutputChannel) {
        this.outputChannel = outputChannel
        this.subscriptions.push(
            commands.registerCommand(
                'lean4.setup.installElan',
                async () => await this.displayInstallElanPrompt('Information', undefined),
            ),
            commands.registerCommand('lean4.setup.updateElan', async () => await this.displayManualUpdateElanPrompt()),
            commands.registerCommand('lean4.setup.uninstallElan', async () => await this.displayUninstallElanPrompt()),
        )
    }

    setClientProvider(clientProvider: LeanClientProvider) {
        this.clientProvider = clientProvider
    }

    // Installation

    async displayInstallElanPrompt(severity: NotificationSeverity, reason: string | undefined): Promise<boolean> {
        const r = await this.displayInstallElanPromptWithItems(severity, reason)
        if (r !== undefined && r.kind === 'InstallElan') {
            return r.success
        }
        return false
    }

    displayStickyInstallElanPrompt(
        severity: NotificationSeverity,
        reason: string | undefined,
        // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
        options: StickyNotificationOptions<'Install Elan' | string>,
        otherItems: StickyInput<string>[] = [],
    ): Disposable {
        const p = this.installElanPrompt(reason)
        const installElanItem: StickyInput<'Install Elan'> = {
            input: p.item,
            continueDisplaying: false,
            action: async () => {
                await this.installElanAndDisplaySettingPrompt()
            },
        }
        return displayStickyNotificationWithOptionalInput(severity, p.message, options, [
            installElanItem,
            ...otherItems,
        ])
    }

    async displayInstallElanPromptWithItems(
        severity: NotificationSeverity,
        reason: string | undefined,
        otherItems: string[] = [],
        defaultItem?: string | undefined,
    ): Promise<{ kind: 'InstallElan'; success: boolean } | { kind: 'OtherItem'; choice: string } | undefined> {
        const p = this.installElanPrompt(reason)
        const choice = await displayNotificationWithInput(severity, p.message, [p.item, ...otherItems], defaultItem)
        if (choice === undefined) {
            return undefined
        }
        if (choice === p.item) {
            return {
                kind: 'InstallElan',
                success: (await this.installElanAndDisplaySettingPrompt()) === 'Success',
            }
        }
        return { kind: 'OtherItem', choice }
    }

    private async installElanAndDisplaySettingPrompt(): Promise<'Success' | 'InstallationFailed' | 'PendingOperation'> {
        const r = await this.installElan()
        switch (r.kind) {
            case 'Success':
                await this.displayInstallationSuccessfulPrompt()
                return 'Success'
            case 'Error':
                await this.displayInstallationUnsuccessfulPrompt(r.result)
                return 'InstallationFailed'
            case 'Cancelled':
                return 'InstallationFailed'
            case 'PendingOperation':
                return 'InstallationFailed'
        }
    }

    async installElan(): Promise<ElanInstallationResult> {
        const r = await this.runOperation<ElanInstallationResult>('Install', async () => {
            const method = elanInstallationMethod()
            const result = await batchExecuteWithProgress(
                method.script,
                [],
                'Lean Installation',
                "Installing Lean's version manager Elan",
                {
                    channel: this.outputChannel,
                    allowCancellation: true,
                    shell: method.shell,
                },
            )
            switch (result.exitCode) {
                case ExecutionExitCode.Success:
                    return { kind: 'Success' }
                case ExecutionExitCode.CannotLaunch:
                case ExecutionExitCode.ExecutionError:
                    return { kind: 'Error', result }
                case ExecutionExitCode.Cancelled:
                    return { kind: 'Cancelled' }
            }
        })
        if (r === 'PendingOperation') {
            return { kind: 'PendingOperation' }
        }
        return r
    }

    private installElanPrompt(reason: string | undefined): { message: string; item: 'Install Elan' } {
        let message: string
        if (reason !== undefined) {
            message = `${reason} Do you wish to install Lean's version manager Elan?`
        } else {
            message = "This command will install Lean's version manager Elan.\n\n" + 'Do you wish to proceed?'
        }
        const item = 'Install Elan'
        return { message, item }
    }

    async displayInstallationSuccessfulPrompt() {
        const prompt =
            'Lean installation successful!\n\n' +
            "Do you want Lean's version manager Elan to download and install Lean versions automatically in VS Code, or would you prefer it to ask for confirmation before downloading and installing new Lean versions?\n" +
            'Asking for confirmation is especially desirable if you are ever using a limited internet data plan or your internet connection tends to be slow, whereas automatic installs are less tedious on fast and unlimited internet connections.'

        const choice = await displayNotificationWithInput(
            'Information',
            prompt,
            ['Always Ask For Confirmation'],
            'Install Lean Versions Automatically',
        )
        if (choice === 'Always Ask For Confirmation') {
            await setAlwaysAskBeforeInstallingLeanVersions(true)
        }
        if (choice === 'Install Lean Versions Automatically') {
            await setAlwaysAskBeforeInstallingLeanVersions(false)
        }
    }

    async displayInstallationUnsuccessfulPrompt(result: ExecutionResult) {
        const error =
            "Installation of Lean's version manager Elan was unsuccessful.\n" +
            'If you are unable to figure out the issue from the command output below, you can also try running the following manual installation script from a terminal:\n\n' +
            elanInstallationMethod().manualScript
        await displayModalResultError(result, error)
    }

    // Updating

    async displayManualUpdateElanPrompt() {
        const versionResult = await elanVersion()
        switch (versionResult.kind) {
            case 'Success':
                await this.displayUpdateElanPrompt('Information', {
                    kind: 'Manual',
                    versions: { currentVersion: versionResult.version },
                })
                break
            case 'ElanNotInstalled':
                displayNotification('Error', 'Elan is not installed.')
                break
            case 'ExecutionError':
                displayNotification('Error', `Error while determining current Elan version: ${versionResult.message}`)
                break
        }
    }

    async displayUpdateElanPrompt(severity: NotificationSeverity, mode: UpdateElanMode): Promise<boolean> {
        const r = await this.displayUpdateElanPromptWithItems(severity, mode)
        if (r !== undefined && r.kind === 'UpdateElan') {
            return r.success
        }
        return false
    }

    async displayUpdateElanPromptWithItems(
        severity: NotificationSeverity,
        mode: UpdateElanMode,
        otherItems: string[] = [],
        defaultItem?: string | undefined,
    ): Promise<{ kind: 'UpdateElan'; success: boolean } | { kind: 'OtherItem'; choice: string } | undefined> {
        const p = this.updateElanPrompt(mode)
        const choice = await displayNotificationWithInput(severity, p.message, [p.item, ...otherItems], defaultItem)
        if (choice === undefined) {
            return undefined
        }
        if (choice === p.item) {
            return { kind: 'UpdateElan', success: await this.updateElan(mode.versions.currentVersion) }
        }
        return { kind: 'OtherItem', choice }
    }

    displayStickyUpdateElanPrompt(
        severity: NotificationSeverity,
        mode: UpdateElanMode,
        // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
        options: StickyNotificationOptions<'Update Elan' | string>,
        otherItems: StickyInput<string>[] = [],
    ): Disposable {
        const p = this.updateElanPrompt(mode)
        const updateElanItem: StickyInput<'Update Elan'> = {
            input: p.item,
            continueDisplaying: false,
            action: async () => {
                await this.updateElan(mode.versions.currentVersion)
            },
        }
        return displayStickyNotificationWithOptionalInput(severity, p.message, options, [updateElanItem, ...otherItems])
    }

    private async updateElan(currentVersion: SemVer): Promise<boolean> {
        const r = await this.runOperation('Update', async () => {
            if (currentVersion.compare('3.1.0') === 0) {
                // `elan self update` was broken in elan 3.1.0, so we need to take a different approach to updating elan here.
                const installElanResult = await this.installElanAndDisplaySettingPrompt()
                if (installElanResult !== 'Success') {
                    return false
                }
                await this.displayElanUpdateSuccessfulPrompt(currentVersion)
                return true
            }

            const elanSelfUpdateResult = await elanSelfUpdate(this.outputChannel, 'Update Elan')
            if (elanSelfUpdateResult.exitCode !== ExecutionExitCode.Success) {
                displayResultError(
                    elanSelfUpdateResult,
                    "Cannot update Elan. If you suspect that this is due to the way that you have set up Elan (e.g. from a package repository that ships an outdated version of Elan), you can disable these warnings using the 'Lean4: Show Setup Warnings' setting under 'File' > 'Preferences' > 'Settings'.",
                )
                return false
            }

            await this.displayElanUpdateSuccessfulPrompt(currentVersion)

            return true
        })
        if (r === 'PendingOperation') {
            return false
        }
        return r
    }

    private updateElanPrompt(mode: UpdateElanMode): { message: string; item: 'Update Elan' } {
        switch (mode.kind) {
            case 'Manual':
                return {
                    message:
                        "This command will update Lean's version manager Elan to its most recent version.\n\n" +
                        'Do you wish to proceed?',
                    item: 'Update Elan',
                }
            case 'Outdated':
                return {
                    message:
                        `Lean's version manager Elan is outdated: the installed version is ${mode.versions.currentVersion.toString()}, but a version of ${mode.versions.recommendedVersion.toString()} is recommended.\n\n` +
                        'Do you wish to update Elan?',
                    item: 'Update Elan',
                }
        }
    }

    private async displayElanUpdateSuccessfulPrompt(currentVersion: SemVer) {
        if (isElanEagerResolutionVersion(currentVersion)) {
            displayNotification('Information', 'Elan update successful!')
            return
        }

        const prompt =
            'Elan update successful!\n\n' +
            'Do you want Elan in VS Code to continue downloading and installing Lean versions automatically, or would you prefer it to ask for confirmation before downloading and installing new Lean versions?\n' +
            'Asking for confirmation is especially desirable if you are ever using a limited internet data plan or your internet connection tends to be slow, whereas automatic installs are less tedious on fast and unlimited internet connections.'

        const choice = await displayNotificationWithInput(
            'Information',
            prompt,
            ['Always Ask For Confirmation'],
            'Install Lean Versions Automatically',
        )
        if (choice === 'Always Ask For Confirmation') {
            await setAlwaysAskBeforeInstallingLeanVersions(true)
        }
        if (choice === 'Install Lean Versions Automatically') {
            await setAlwaysAskBeforeInstallingLeanVersions(false)
        }
    }

    // Uninstalling

    async displayUninstallElanPrompt() {
        await this.runOperation('Uninstall', async () => {
            const prompt =
                "This command will uninstall Lean's version manager Elan and all installed Lean versions.\n\n" +
                'Do you wish to proceed?'
            const choice = await displayNotificationWithInput('Information', prompt, ['Proceed'])
            if (choice !== 'Proceed') {
                return
            }

            const r = await elanSelfUninstall(this.outputChannel, 'Uninstall Elan')
            switch (r.exitCode) {
                case ExecutionExitCode.Success:
                    displayNotification('Information', 'Elan uninstalled successfully.')
                    break
                case ExecutionExitCode.CannotLaunch:
                    displayNotification('Error', 'Elan is not installed.')
                    break
                case ExecutionExitCode.ExecutionError:
                    displayNotification('Error', `Error while installing Elan: ${r.combined}`)
                    break
                case ExecutionExitCode.Cancelled:
                    displayNotification('Information', 'Uninstalling Elan cancelled.')
            }
        })
    }

    private async runOperation<T>(
        kind: 'Install' | 'Update' | 'Uninstall',
        op: () => Promise<T>,
    ): Promise<T | 'PendingOperation'> {
        switch (this.pendingOperation) {
            case 'Install':
                displayNotification(
                    'Error',
                    'Elan is being installed. Please wait until the installation has finished.',
                )
                return 'PendingOperation'
            case 'Update':
                displayNotification('Error', 'Elan is being updated. Please wait until the update has finished.')
                return 'PendingOperation'
            case 'Uninstall':
                displayNotification(
                    'Error',
                    'Elan is being uninstalled. Please wait until the deinstallation has finished.',
                )
                return 'PendingOperation'
            case undefined:
                this.pendingOperation = kind
                try {
                    if (this.clientProvider === undefined) {
                        return await op()
                    }
                    const r = await this.clientProvider.withStoppedClients(op)
                    if (r.kind === 'IsRestarting') {
                        displayNotification('Error', 'Cannot re-install Elan while a server is being restarted.')
                        return 'PendingOperation'
                    }
                    return r.result
                } finally {
                    this.pendingOperation = undefined
                }
        }
    }

    getOutputChannel(): OutputChannel {
        return this.outputChannel
    }

    dispose() {
        for (const s of this.subscriptions) {
            s.dispose()
        }
    }
}
