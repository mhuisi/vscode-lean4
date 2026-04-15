import { describe, expect, it } from 'vitest'
import { groupByKey, groupByUniqueKey } from '../../src/utils/groupBy'

describe('groupByKey', () => {
    it('returns an empty map for an empty input', () => {
        expect(groupByKey([], () => 0).size).toBe(0)
    })

    it('preserves insertion order within each group', () => {
        const grouped = groupByKey(
            [
                { k: 'a', v: 1 },
                { k: 'b', v: 2 },
                { k: 'a', v: 3 },
            ],
            x => x.k,
        )
        expect(grouped.get('a')?.map(x => x.v)).toEqual([1, 3])
        expect(grouped.get('b')?.map(x => x.v)).toEqual([2])
    })
})

describe('groupByUniqueKey', () => {
    it('returns the last value for duplicate keys', () => {
        const m = groupByUniqueKey(
            [
                { k: 'a', v: 1 },
                { k: 'a', v: 2 },
            ],
            x => x.k,
        )
        expect(m.get('a')?.v).toBe(2)
        expect(m.size).toBe(1)
    })
})
