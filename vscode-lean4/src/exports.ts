import { OutputChannel } from 'vscode'
import { FullDiagnosticsProvider } from './diagnostics/fullDiagnostics'
import { InfoProvider } from './infoview'
import { ProjectInitializationProvider } from './projectinit'
import { ProjectOperationProvider } from './projectoperations'
import { LeanClientProvider } from './utils/clientProvider'
import { DepInstaller } from './utils/depInstaller'
import { ElanCommandProvider } from './utils/elanCommands'
import { LeanCommandRunner } from './utils/leanCmdRunner'
import { LeanInstaller } from './utils/leanInstaller'

export interface AlwaysEnabledFeatures {
    projectInitializationProvider: ProjectInitializationProvider
    outputChannel: OutputChannel
    leanInstaller: LeanInstaller
    depInstaller: DepInstaller
    fullDiagnosticsProvider: FullDiagnosticsProvider
    elanCommandProvider: ElanCommandProvider
    leanCommandRunner: LeanCommandRunner
}

export interface Lean4EnabledFeatures {
    clientProvider: LeanClientProvider
    infoProvider: InfoProvider
    projectOperationProvider: ProjectOperationProvider
}

export interface EnabledFeatures extends AlwaysEnabledFeatures, Lean4EnabledFeatures {}

export class Exports {
    alwaysEnabledFeatures: AlwaysEnabledFeatures
    lean4EnabledFeatures: Promise<Lean4EnabledFeatures>

    constructor(alwaysEnabledFeatures: AlwaysEnabledFeatures, lean4EnabledFeatures: Promise<Lean4EnabledFeatures>) {
        this.alwaysEnabledFeatures = alwaysEnabledFeatures
        this.lean4EnabledFeatures = lean4EnabledFeatures
    }

    async allFeatures(): Promise<EnabledFeatures> {
        const lean4EnabledFeatures = await this.lean4EnabledFeatures
        return { ...this.alwaysEnabledFeatures, ...lean4EnabledFeatures }
    }
}
