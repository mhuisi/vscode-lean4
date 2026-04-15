import { describe, expect, it } from 'vitest'
import { InteractiveHypothesisBundle } from '../src/rpcApi'
import { InteractiveHypothesisBundle_nonAnonymousNames, TaggedText_stripTags } from '../src/util'

describe('TaggedText_stripTags', () => {
    it('returns the raw text for a leaf node', () => {
        expect(TaggedText_stripTags({ text: 'hello' })).toBe('hello')
    })

    it('concatenates appended segments in order', () => {
        expect(
            TaggedText_stripTags({
                append: [{ text: 'foo ' }, { text: 'bar' }],
            }),
        ).toBe('foo bar')
    })

    it('unwraps tagged wrappers and descends into their payload', () => {
        expect(
            TaggedText_stripTags<string>({
                tag: ['ignored', { append: [{ text: 'a' }, { tag: ['also', { text: 'b' }] }] }],
            }),
        ).toBe('ab')
    })
})

describe('InteractiveHypothesisBundle_nonAnonymousNames', () => {
    it('keeps concrete names and drops placeholders containing [anonymous]', () => {
        const result = InteractiveHypothesisBundle_nonAnonymousNames({
            names: ['h', '[anonymous]', 'h.[anonymous].tail', 'x'],
        } as Pick<InteractiveHypothesisBundle, 'names'> as InteractiveHypothesisBundle)
        expect(result).toEqual(['h', 'x'])
    })
})
