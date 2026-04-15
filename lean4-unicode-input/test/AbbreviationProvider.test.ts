import { describe, expect, it } from 'vitest'
import { AbbreviationConfig, AbbreviationProvider } from '../src'

const baseConfig: AbbreviationConfig = {
    abbreviationCharacter: '\\',
    customTranslations: {},
    eagerReplacementEnabled: false,
}

describe('AbbreviationProvider.getReplacementText', () => {
    const provider = new AbbreviationProvider(baseConfig)

    it('returns undefined for the empty abbreviation', () => {
        expect(provider.getReplacementText('')).toBeUndefined()
    })

    it('resolves a fully matching abbreviation', () => {
        expect(provider.getReplacementText('alpha')).toBe('α')
        expect(provider.getReplacementText('to')).toBe('→')
        expect(provider.getReplacementText('lam')).toBe('λ')
    })

    it('falls back to the longest prefix plus the untyped remainder', () => {
        // `alp` already replaces to α, so `alp7` becomes α7.
        expect(provider.getReplacementText('alp')).toBe('α')
        expect(provider.getReplacementText('alp7')).toBe('α7')
    })

    it('honours custom translations supplied via config', () => {
        const withCustom = new AbbreviationProvider({
            ...baseConfig,
            customTranslations: { myabbr: '∞' },
        })
        expect(withCustom.getReplacementText('myabbr')).toBe('∞')
    })
})

describe('AbbreviationProvider queries', () => {
    const provider = new AbbreviationProvider(baseConfig)

    it('collectAllAbbreviations returns every abbreviation mapping to a symbol', () => {
        const abbrs = provider.collectAllAbbreviations('→')
        // Both `to` and `r` map to → in the bundled table.
        expect(abbrs).toEqual(expect.arrayContaining(['to', 'r']))
    })

    it('findAutoClosingAbbreviations returns matching pairs for an opening symbol', () => {
        // `<>` maps to ⟨$CURSOR⟩, so the query is by the opening symbol ⟨
        // (not by the abbreviation `<`). The closing half is ⟩.
        const pairs = provider.findAutoClosingAbbreviations('⟨')
        expect(pairs).toEqual(expect.arrayContaining([['<>', '⟩']]))
    })
})
