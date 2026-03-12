import { AbbreviationConfig, SymbolsByAbbreviation } from '@leanprover/unicode-input'
import { Disposable, workspace } from 'vscode'

export class VSCodeAbbreviationConfig implements AbbreviationConfig, Disposable {
    abbreviationCharacter: string
    customTranslations: SymbolsByAbbreviation
    eagerReplacementEnabled: boolean
    inputModeEnabled: boolean
    languages: string[]

    private subscriptions: Disposable[] = []

    constructor() {
        this.reloadConfig()
        this.subscriptions.push(
            workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('lean4.input')) {
                    this.reloadConfig()
                }
            }),
        )
    }

    private reloadConfig() {
        this.inputModeEnabled = workspace.getConfiguration('lean4.input').get('enabled', true)
        this.abbreviationCharacter = workspace.getConfiguration('lean4.input').get('leader', '\\')
        this.languages = workspace.getConfiguration('lean4.input').get('languages', ['lean4', 'lean'])
        this.customTranslations = workspace.getConfiguration('lean4.input').get('customTranslations', {})
        this.eagerReplacementEnabled = workspace.getConfiguration('lean4.input').get('eagerReplacementEnabled', true)
    }

    dispose() {
        for (const s of this.subscriptions) {
            s.dispose()
        }
    }
}
