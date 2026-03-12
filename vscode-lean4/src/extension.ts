import * as os from 'os'
import * as path from 'path'
import { commands, env, ExtensionContext, extensions, TextDocument, TextEditor, Uri, window, workspace } from 'vscode'
import { AbbreviationFeature } from './abbreviation/AbbreviationFeature'
import { AbbreviationView } from './abbreviationview'
import { FullDiagnosticsProvider } from './diagnostics/fullDiagnostics'
import { checkAll, SetupDiagnostics } from './diagnostics/setupDiagnostics'
import { PreconditionCheckResult, SetupNotificationOptions } from './diagnostics/setupNotifs'
import { AlwaysEnabledFeatures, Exports, Lean4EnabledFeatures } from './exports'
import { InfoProvider } from './infoview'
import { LoogleView } from './loogleview'
import { ManualView } from './manualview'
import { ProjectInitializationProvider } from './projectinit'
import { ProjectOperationProvider } from './projectoperations'
import { LeanTaskGutter } from './taskgutter'
import { LeanClientProvider } from './utils/clientProvider'
import { depInstallationLocations, DepInstaller } from './utils/depInstaller'
import { ElanCommandProvider } from './utils/elanCommands'
import { addToProcessEnvPATH } from './utils/envPath'
import { combine, onEventWhile, withoutReentrancy } from './utils/events'
import { ExtUri, extUriToCwdUri, FileUri, toExtUri } from './utils/exturi'
import { FullInstaller } from './utils/fullInstaller'
import { displayInternalErrorsIn } from './utils/internalErrors'
import { registerLeanCommandRunner } from './utils/leanCmdRunner'
import { isLeanDocument, lean, registerLeanEditorProviders, text } from './utils/leanEditorProvider'
import { LeanInstaller } from './utils/leanInstaller'
import { ModuleTreeViewProvider } from './utils/moduleTreeViewProvider'
import {
    displayActiveStickyNotification,
    displayModalNotification,
    displayNotification,
    setStickyNotificationActiveButHidden,
} from './utils/notifs'
import { PathExtensionProvider } from './utils/pathExtensionProvider'
import { findLeanProjectRootInfo } from './utils/projectInfo'
import { UriHandlerService } from './utils/uriHandlerService'
import { batchExecute } from './utils/batch'

async function setLeanFeatureSetActive(isActive: boolean) {
    await commands.executeCommand('setContext', 'lean4.isLeanFeatureSetActive', isActive)
}

async function findInitialLeanProjectUri(editor: TextEditor): Promise<ExtUri | undefined> {
    const uri = toExtUri(editor.document.uri)
    if (uri === undefined) {
        return undefined
    }
    const info = await findLeanProjectRootInfo(uri)
    if (info.kind === 'FileNotFound') {
        return undefined
    }
    if (!isLeanDocument(editor.document) && info.kind === 'Success' && info.toolchainUri === undefined) {
        return undefined
    }
    return info.projectRootUri
}

async function findActiveLeanProjectUri(): Promise<ExtUri | undefined> {
    const activeEditor = window.activeTextEditor
    if (activeEditor === undefined) {
        return undefined
    }
    return await findInitialLeanProjectUri(activeEditor)
}

async function findVisibleLeanProjectUri(): Promise<ExtUri | undefined> {
    // This happens if vscode starts with a lean file open
    // but the "Getting Started" page is active.
    for (const editor of window.visibleTextEditors) {
        const projectUri = await findInitialLeanProjectUri(editor)
        if (projectUri === undefined) {
            continue
        }
        return projectUri
    }
    return undefined
}

async function findOpenLeanProjectUri(): Promise<ExtUri | 'NoValidDocument'> {
    const activeProjectUri = await findActiveLeanProjectUri()
    if (activeProjectUri !== undefined) {
        return activeProjectUri
    }
    const visibleProjectUri = await findVisibleLeanProjectUri()
    if (visibleProjectUri !== undefined) {
        return visibleProjectUri
    }
    return 'NoValidDocument'
}

async function copyModuleName(uri: Uri | undefined) {
    const targetUri = uri !== undefined ? toExtUri(uri) : lean.lastActiveLeanDocument?.extUri
    if (targetUri === undefined) {
        return
    }
    if (targetUri.scheme !== 'file') {
        return
    }
    const info = await findLeanProjectRootInfo(targetUri)
    if (info.kind !== 'Success') {
        return
    }
    const projectRootUri = info.projectRootUri
    if (projectRootUri.scheme !== 'file') {
        return
    }
    const relativePath = targetUri.relativeTo(projectRootUri)
    if (relativePath === undefined) {
        return
    }
    const parts = relativePath.fsPath.split(path.sep)
    const lastPart = parts[parts.length - 1]
    if (lastPart.endsWith('.lean')) {
        parts[parts.length - 1] = lastPart.slice(0, -'.lean'.length)
    }
    const moduleName = parts.join('.')
    await env.clipboard.writeText(moduleName)
}

function addElanPathToPATH() {
    addToProcessEnvPATH(path.join(os.homedir(), '.elan', 'bin'))
}

/**
 * Activates all extension features that are *always* enabled, even when no Lean 4 document is currently open.
 */
function activateAlwaysEnabledFeatures(context: ExtensionContext): AlwaysEnabledFeatures {
    addElanPathToPATH()
    // Add all dependency installation locations to the PATH.
    // This is especially useful on Windows, where apparently (?) users sometimes need to
    // restart their system for changes in the PATH to be reflected in newly launched applications.
    for (const loc of depInstallationLocations()) {
        addToProcessEnvPATH(loc)
    }
    context.subscriptions.push(PathExtensionProvider.withAddedEnvPathExtensions())

    context.subscriptions.push(
        commands.registerCommand('lean4.copyModuleName', async (uri?: Uri | undefined) => await copyModuleName(uri)),
    )

    context.subscriptions.push(
        commands.registerCommand('lean4.docs.showSetupGuide', () =>
            commands.executeCommand('workbench.action.openWalkthrough', 'leanprover.lean4#lean4.welcome', false),
        ),
        commands.registerCommand('lean4.troubleshooting.showTroubleshootingGuide', () =>
            commands.executeCommand(
                'workbench.action.openWalkthrough',
                { category: 'leanprover.lean4#lean4.welcome', step: 'lean4.welcome.help' },
                false,
            ),
        ),
        commands.registerCommand('lean4.docs.showDocResources', () =>
            commands.executeCommand('simpleBrowser.show', 'https://lean-lang.org/learn/'),
        ),
    )

    const extensionPath = new FileUri(context.extensionPath)
    const manualView = new ManualView(extensionPath, extensionPath.join('manual', 'manual.md'))
    context.subscriptions.push(manualView)

    const loogleView = new LoogleView(extensionPath, context.extension.packageJSON.version)
    context.subscriptions.push(loogleView)

    const outputChannel = window.createOutputChannel('Lean: Editor')
    context.subscriptions.push(
        commands.registerCommand('lean4.troubleshooting.showOutput', async () => {
            await batchExecute('helloworld', [], undefined, { combined: outputChannel })
            outputChannel.show(true)
        }),
    )

    const depInstaller = new DepInstaller(outputChannel)
    context.subscriptions.push(depInstaller)

    const leanInstaller = new LeanInstaller(outputChannel)
    context.subscriptions.push(leanInstaller)

    const fullInstaller = new FullInstaller(outputChannel, depInstaller, leanInstaller)
    context.subscriptions.push(fullInstaller)

    const projectInitializationProvider = new ProjectInitializationProvider(outputChannel, leanInstaller, depInstaller)
    context.subscriptions.push(projectInitializationProvider)

    const checkForExtensionConflict = (doc: TextDocument) => {
        const isLean3ExtensionInstalled = extensions.getExtension('jroesch.lean') !== undefined
        if (isLean3ExtensionInstalled && isLeanDocument(doc)) {
            displayNotification(
                'Error',
                "The Lean 3 and the Lean 4 VS Code extension are enabled at the same time. Since both extensions act on .lean files, this can lead to issues with either extension. Please disable the extension for the Lean major version that you do not wish to use ('Extensions' in the left sidebar > Cog icon > 'Disable').",
            )
        }
    }
    for (const doc of workspace.textDocuments) {
        checkForExtensionConflict(doc)
    }
    context.subscriptions.push(workspace.onDidOpenTextDocument(checkForExtensionConflict))

    const fullDiagnosticsProvider = new FullDiagnosticsProvider(outputChannel)
    context.subscriptions.push(fullDiagnosticsProvider)

    const abbreviationFeature = new AbbreviationFeature(outputChannel)
    context.subscriptions.push(abbreviationFeature)

    const abbreviationView = new AbbreviationView(extensionPath, abbreviationFeature.abbreviations)
    context.subscriptions.push(abbreviationView)

    const elanCommandProvider = new ElanCommandProvider(outputChannel)
    context.subscriptions.push(elanCommandProvider)

    const uriHandlerService = new UriHandlerService()
    context.subscriptions.push(uriHandlerService)

    return {
        projectInitializationProvider,
        outputChannel,
        leanInstaller,
        depInstaller,
        fullDiagnosticsProvider,
        elanCommandProvider,
    }
}

async function checkLean4FeaturePreconditions(
    leanInstaller: LeanInstaller,
    depInstaller: DepInstaller,
    context: string,
    cwdUri: FileUri | undefined,
    d: SetupDiagnostics,
): Promise<PreconditionCheckResult> {
    return await checkAll(
        () => d.checkIsOperatingSystemSupported(),
        () => d.checkAreDependenciesInstalled(depInstaller, leanInstaller.getOutputChannel(), cwdUri),
        () => d.checkIsLean4Installed(leanInstaller, context, cwdUri, 'PromptAboutUpdate'),
        () =>
            d.checkIsElanUpToDate(leanInstaller, cwdUri, {
                elanMustBeInstalled: false,
            }),
        () => d.checkIsVSCodeUpToDate(),
    )
}

async function activateLean4Features(
    context: ExtensionContext,
    installer: LeanInstaller,
    elanCommandProvider: ElanCommandProvider,
): Promise<Lean4EnabledFeatures> {
    const clientProvider = new LeanClientProvider(installer.getOutputChannel())
    elanCommandProvider.setClientProvider(clientProvider)
    installer.setClientProvider(clientProvider)
    context.subscriptions.push(clientProvider)

    const infoProvider = new InfoProvider(clientProvider, context)
    context.subscriptions.push(infoProvider)

    context.subscriptions.push(new LeanTaskGutter(clientProvider, context))

    const projectOperationProvider: ProjectOperationProvider = new ProjectOperationProvider(
        installer.getOutputChannel(),
        clientProvider,
    )

    context.subscriptions.push(await ModuleTreeViewProvider.init(clientProvider))

    await setLeanFeatureSetActive(true)

    return { clientProvider, infoProvider, projectOperationProvider }
}

async function tryActivatingLean4FeaturesInProject(
    context: ExtensionContext,
    leanInstaller: LeanInstaller,
    depInstaller: DepInstaller,
    elanCommandProvider: ElanCommandProvider,
    resolve: (value: Lean4EnabledFeatures) => void,
    d: SetupDiagnostics,
    projectUri: ExtUri,
) {
    const preconditionCheckResult = await checkLean4FeaturePreconditions(
        leanInstaller,
        depInstaller,
        'Lean 4 Extension Startup',
        extUriToCwdUri(projectUri),
        d,
    )
    if (preconditionCheckResult === 'Fatal') {
        return
    }
    const lean4EnabledFeatures: Lean4EnabledFeatures = await displayInternalErrorsIn('activating Lean 4 features', () =>
        activateLean4Features(context, leanInstaller, elanCommandProvider),
    )
    resolve(lean4EnabledFeatures)
}

async function tryActivatingLean4Features(
    context: ExtensionContext,
    leanInstaller: LeanInstaller,
    depInstaller: DepInstaller,
    elanCommandProvider: ElanCommandProvider,
    resolve: (value: Lean4EnabledFeatures) => void,
    d: SetupDiagnostics,
    warnAboutNoValidDocument: boolean,
) {
    const projectUri = await findOpenLeanProjectUri()
    if (projectUri !== 'NoValidDocument') {
        await tryActivatingLean4FeaturesInProject(
            context,
            leanInstaller,
            depInstaller,
            elanCommandProvider,
            resolve,
            d,
            projectUri,
        )
        return
    }
    if (warnAboutNoValidDocument) {
        await displayModalNotification(
            'Error',
            'No visible Lean document - cannot retry activating the extension. Please select a Lean document.',
        )
    }
    // We try activating the Lean features in two cases:
    // 1. When revealing a new editor with the `lean` or `lean4` language ID (e.g.: switching tabs, opening a new Lean document, changing the language ID to `lean` or `lean4`)
    // 2. When revealing a new editor in a Lean project that doesn't have the `lean` or `lean4` language ID (e.g.: switching tabs, opening a new document)
    // These two events are disjoint, so combining them won't cause duplicate triggers.
    const combinedEvent = combine(
        lean.onDidRevealLeanEditor,
        _ => true,
        text.onDidRevealLeanEditor,
        editor => !isLeanDocument(editor.editor.document),
    )
    context.subscriptions.push(combinedEvent.disposable)
    context.subscriptions.push(
        onEventWhile(
            combinedEvent.event,
            withoutReentrancy('Continue', async leanEditor => {
                const projectUri = await findInitialLeanProjectUri(leanEditor.editor)
                if (projectUri === undefined) {
                    return 'Continue'
                }
                await tryActivatingLean4FeaturesInProject(
                    context,
                    leanInstaller,
                    depInstaller,
                    elanCommandProvider,
                    resolve,
                    d,
                    projectUri,
                )
                return 'Stop'
            }),
        ),
    )
}

export async function activate(context: ExtensionContext): Promise<Exports> {
    await setLeanFeatureSetActive(false)
    registerLeanEditorProviders(context)
    await setStickyNotificationActiveButHidden(false)
    context.subscriptions.push(
        commands.registerCommand('lean4.redisplaySetupError', async () => displayActiveStickyNotification()),
    )
    registerLeanCommandRunner(context)

    const alwaysEnabledFeatures: AlwaysEnabledFeatures = await displayInternalErrorsIn(
        'activating Lean 4 extension',
        async () => activateAlwaysEnabledFeatures(context),
    )

    const lean4EnabledFeatures: Promise<Lean4EnabledFeatures> = new Promise(async (resolve, _) => {
        // eslint-disable-next-line prefer-const
        let d: SetupDiagnostics
        const options: SetupNotificationOptions = {
            errorMode: {
                mode: 'Sticky',
                retry: async () =>
                    tryActivatingLean4Features(
                        context,
                        alwaysEnabledFeatures.leanInstaller,
                        alwaysEnabledFeatures.depInstaller,
                        alwaysEnabledFeatures.elanCommandProvider,
                        resolve,
                        d,
                        true,
                    ),
            },
            warningMode: { modal: true, proceedByDefault: true },
        }
        d = new SetupDiagnostics(options)
        await tryActivatingLean4Features(
            context,
            alwaysEnabledFeatures.leanInstaller,
            alwaysEnabledFeatures.depInstaller,
            alwaysEnabledFeatures.elanCommandProvider,
            resolve,
            d,
            false,
        )
    })

    return new Exports(alwaysEnabledFeatures, lean4EnabledFeatures)
}
