import { defaultInfoviewConfig, InfoviewConfig } from '@leanprover/infoview-api'
import { ConfigurationTarget, ThemeColor, workspace } from 'vscode'
import { PATH } from './utils/envPath'

function processConfigColor(c: string): ThemeColor | string {
    if (c.match(/^(#|rgb\(|rgba\(|hsl\(|hsla\()/)) {
        return c
    }
    return new ThemeColor(c)
}

export function getPowerShellPath(): string {
    // The environment of VS Code does not always contain `windir`. `test/helpers/powershell.ts`
    // uses the same fallbacks.
    const windir = process.env.windir || process.env.SystemRoot || 'C:\\Windows'
    return `${windir}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
}

export function automaticallyBuildDependencies(): boolean {
    return workspace.getConfiguration('lean4').get('automaticallyBuildDependencies', false)
}

export function envPathExtensions(): PATH {
    return new PATH(workspace.getConfiguration('lean4').get('envPathExtensions', []))
}

export function alwaysAskBeforeInstallingLeanVersions(): boolean {
    return workspace.getConfiguration('lean4').get('alwaysAskBeforeInstallingLeanVersions', false)
}

export async function setAlwaysAskBeforeInstallingLeanVersions(alwaysAskBeforeInstallingLeanVersions: boolean) {
    await workspace
        .getConfiguration('lean4')
        .update(
            'alwaysAskBeforeInstallingLeanVersions',
            alwaysAskBeforeInstallingLeanVersions,
            ConfigurationTarget.Global,
        )
}

export function serverArgs(): string[] {
    return workspace.getConfiguration('lean4').get('serverArgs', [])
}

export function isLoggingEnabled(): boolean {
    return workspace.getConfiguration('lean4.logging').get('enabled', false)
}

export function loggingDir(): string {
    return workspace.getConfiguration('lean4.logging').get('dir', '.')
}

export function allowedLoggingMethods(): string[] {
    return workspace
        .getConfiguration('lean4.logging')
        .get('allowedMethods', [
            'textDocument/didOpen',
            'textDocument/didChange',
            'textDocument/didClose',
            'textDocument/didSave',
            'textDocument/hover',
            'textDocument/documentHighlight',
            'completionItem/resolve',
            'codeAction/resolve',
            'textDocument/definition',
            'textDocument/declaration',
            'textDocument/typeDefinition',
            'textDocument/references',
            'textDocument/prepareCallHierarchy',
            'callHierarchy/incomingCalls',
            'callHierarchy/outgoingCalls',
            '$/lean/prepareModuleHierarchy',
            '$/lean/moduleHierarchy/imports',
            '$/lean/moduleHierarchy/importedBy',
            'textDocument/prepareRename',
            'textDocument/rename',
            'workspace/symbol',
            '$/lean/rpc/call',
            'Lean.Widget.getInteractiveDiagnostics',
            'Lean.Widget.getInteractiveGoals',
            'Lean.Widget.getInteractiveTermGoal',
            'Lean.Widget.InteractiveDiagnostics.infoToInteractive',
            'Lean.Widget.getGoToLocation',
            'Lean.Widget.lazyTraceChildrenToInteractive',
            'Lean.Widget.highlightMatches',
        ])
}

export function disallowedLoggingMethods(): string[] {
    return workspace.getConfiguration('lean4.logging').get('disallowedMethods', [])
}

export function shouldAutofocusOutput(): boolean {
    return workspace.getConfiguration('lean4').get('autofocusOutput', false)
}

export function getInfoViewStyle(): string {
    const val = workspace.getConfiguration('lean4.infoview').get<string>('style')
    if (val !== undefined) return val
    // Try deprecated name of the same setting if not found
    return workspace.getConfiguration('lean4').get('infoViewStyle', '')
}

export function getInfoViewAutoOpen(): boolean {
    const val = workspace.getConfiguration('lean4.infoview').get<boolean>('autoOpen')
    if (val !== undefined) return val
    return workspace.getConfiguration('lean4').get('infoViewAutoOpen', true)
}

function getInfoViewAutoOpenShowsGoal(): boolean {
    const val = workspace.getConfiguration('lean4.infoview').get<boolean>('autoOpenShowsGoal')
    if (val !== undefined) return val
    return workspace.getConfiguration('lean4').get('infoViewAutoOpenShowGoal', true)
}

function getInfoViewAllErrorsOnLine(): boolean {
    const val = workspace.getConfiguration('lean4.infoview').get<boolean>('allErrorsOnLine')
    if (val !== undefined) return val
    return workspace.getConfiguration('lean4').get('infoViewAllErrorsOnLine', true)
}

function getInfoViewDebounceTime(): number {
    return workspace.getConfiguration('lean4.infoview').get('debounceTime', 50)
}

function getInfoViewShowExpectedType(): boolean {
    return workspace.getConfiguration('lean4.infoview').get('showExpectedType', true)
}

function getInfoViewExpectedTypeVisibility(): 'Expanded by default' | 'Collapsed by default' | 'Hidden' {
    const show = getInfoViewShowExpectedType()
    const visibility = workspace.getConfiguration('lean4.infoview').get('expectedTypeVisibility', 'Expanded by default')
    if (!show && visibility === 'Expanded by default') {
        return 'Collapsed by default'
    }
    return visibility
}

function getInfoViewShowGoalNames(): boolean {
    return workspace.getConfiguration('lean4.infoview').get('showGoalNames', true)
}

function getInfoViewEmphasizeFirstGoal(): boolean {
    return workspace.getConfiguration('lean4.infoview').get('emphasizeFirstGoal', false)
}

function getInfoViewReverseTacticState(): boolean {
    return workspace.getConfiguration('lean4.infoview').get('reverseTacticState', false)
}

function getInfoViewHideTypeAssumptions(): boolean {
    return workspace.getConfiguration('lean4.infoview').get('hideTypeAssumptions', false)
}

function getInfoViewHideInstanceAssumptions(): boolean {
    return workspace.getConfiguration('lean4.infoview').get('hideInstanceAssumptions', false)
}

function getInfoViewHideInaccessibleAssumptions(): boolean {
    return workspace.getConfiguration('lean4.infoview').get('hideInaccessibleAssumptions', false)
}

function getInfoViewHideLetValues(): boolean {
    return workspace.getConfiguration('lean4.infoview').get('hideLetValues', false)
}

function getInfoViewShowTooltipOnHover(): boolean {
    return workspace.getConfiguration('lean4.infoview').get('showTooltipOnHover', true)
}

function getInfoViewMessageOrder(): 'Sort by proximity to text cursor' | 'Sort by message location' {
    return workspace.getConfiguration('lean4.infoview').get('messageOrder', 'Sort by proximity to text cursor')
}

/** The settings that the InfoView reads, and that its context menu can save. */
export function getInfoViewConfig(): InfoviewConfig {
    return {
        allErrorsOnLine: getInfoViewAllErrorsOnLine(),
        autoOpenShowsGoal: getInfoViewAutoOpenShowsGoal(),
        debounceTime: getInfoViewDebounceTime(),
        expectedTypeVisibility: getInfoViewExpectedTypeVisibility(),
        showGoalNames: getInfoViewShowGoalNames(),
        emphasizeFirstGoal: getInfoViewEmphasizeFirstGoal(),
        reverseTacticState: getInfoViewReverseTacticState(),
        hideTypeAssumptions: getInfoViewHideTypeAssumptions(),
        hideInstanceAssumptions: getInfoViewHideInstanceAssumptions(),
        hideInaccessibleAssumptions: getInfoViewHideInaccessibleAssumptions(),
        hideLetValues: getInfoViewHideLetValues(),
        showTooltipOnHover: getInfoViewShowTooltipOnHover(),
        messageOrder: getInfoViewMessageOrder(),
    }
}

/** Saves the settings of `getInfoViewConfig` in the user settings, with the names of the `lean4.infoview` section. */
export async function saveInfoViewConfig(config: InfoviewConfig): Promise<void> {
    // `defaultInfoviewConfig` has all keys of `InfoviewConfig`.
    for (const key of Object.keys(defaultInfoviewConfig) as (keyof InfoviewConfig)[]) {
        await workspace.getConfiguration('lean4.infoview').update(key, config[key], ConfigurationTarget.Global)
    }
}

export function shouldShowSetupWarnings(): boolean {
    return workspace.getConfiguration('lean4').get('showSetupWarnings', true)
}

export function showDiagnosticGutterDecorations(): boolean {
    return workspace.getConfiguration('lean4').get('showDiagnosticGutterDecorations', true)
}

export function showUnsolvedGoalsDecoration(): boolean {
    return workspace.getConfiguration('lean4').get('showUnsolvedGoalsDecoration', true)
}

export function unsolvedGoalsDecorationLightThemeColor(): ThemeColor | string {
    return processConfigColor(
        workspace.getConfiguration('lean4').get('unsolvedGoalsDecorationLightThemeColor', 'editorInfo.foreground'),
    )
}

export function unsolvedGoalsDecorationDarkThemeColor(): ThemeColor | string {
    return processConfigColor(
        workspace.getConfiguration('lean4').get('unsolvedGoalsDecorationDarkThemeColor', 'editorInfo.foreground'),
    )
}

export function goalsAccomplishedDecorationKind(): string {
    return workspace.getConfiguration('lean4').get('goalsAccomplishedDecorationKind', 'Double Checkmark')
}

export function decorationEditDelay(): number {
    return workspace.getConfiguration('lean4').get('decorationEditDelay', 750)
}

export function foldProofsByDefault(): boolean {
    return workspace.getConfiguration('lean4').get('foldProofsByDefault', false)
}

export function isRunningTest(): boolean {
    return typeof process.env.LEAN4_TEST_FOLDER === 'string'
}

export function getTestFolder(): string {
    return typeof process.env.LEAN4_TEST_FOLDER === 'string' ? process.env.LEAN4_TEST_FOLDER : ''
}

/** The editor line height, in pixels. */
export function getEditorLineHeight(): number {
    // The implementation
    // (recommended by Microsoft: https://github.com/microsoft/vscode/issues/125341#issuecomment-854812591)
    // is absolutely cursed. It's just to copy whatever VSCode does internally.
    const fontSize = workspace.getConfiguration('editor').get<number>('fontSize') ?? 0
    let lineHeight = workspace.getConfiguration('editor').get<number>('lineHeight') ?? 0

    const GOLDEN_LINE_HEIGHT_RATIO = process.platform === 'darwin' ? 1.5 : 1.35
    const MINIMUM_LINE_HEIGHT = 8

    if (lineHeight === 0) {
        lineHeight = GOLDEN_LINE_HEIGHT_RATIO * fontSize
    } else if (lineHeight < MINIMUM_LINE_HEIGHT) {
        // Values too small to be line heights in pixels are in ems.
        lineHeight = lineHeight * fontSize
    }

    // Enforce integer, minimum constraints
    lineHeight = Math.round(lineHeight)
    if (lineHeight < MINIMUM_LINE_HEIGHT) {
        lineHeight = MINIMUM_LINE_HEIGHT
    }

    return lineHeight
}

/**
 * The literal 'production' or 'development', depending on the build.
 * Should be turned into a string literal by build tools.
 */
export const prodOrDev: string =
    process.env.NODE_ENV && process.env.NODE_ENV === 'production' ? 'production' : 'development'

/** The literal '.min' or empty, depending on the build. See {@link prodOrDev}. */
export const minIfProd: string = process.env.NODE_ENV && process.env.NODE_ENV === 'production' ? '.min' : ''
