import { describe, expect, it } from 'vitest'
import { Range } from '../src/Range'

describe('Range', () => {
    it('rejects a negative length at construction', () => {
        expect(() => new Range(0, -1)).toThrow()
    })

    it('reports inclusive end via offsetEnd', () => {
        expect(new Range(3, 2).offsetEnd).toBe(4)
    })

    it('is empty iff length is zero', () => {
        expect(new Range(5, 0).isEmpty).toBe(true)
        expect(new Range(5, 1).isEmpty).toBe(false)
    })

    it('contains and containsRange respect the inclusive end', () => {
        const r = new Range(2, 3) // covers offsets 2..4
        expect(r.contains(2)).toBe(true)
        expect(r.contains(4)).toBe(true)
        expect(r.contains(5)).toBe(false)
        expect(r.containsRange(new Range(3, 1))).toBe(true)
        expect(r.containsRange(new Range(4, 1))).toBe(true)
        expect(r.containsRange(new Range(5, 1))).toBe(false)
    })

    it('orders ranges with isBefore/isAfter', () => {
        const left = new Range(0, 2) // 0..1
        const right = new Range(3, 1) // 3..3
        expect(right.isAfter(left)).toBe(true)
        expect(left.isBefore(right)).toBe(true)
        expect(left.isAfter(right)).toBe(false)
    })

    it('moveKeepEnd rejects deltas that overflow the range', () => {
        const r = new Range(0, 2)
        expect(() => r.moveKeepEnd(3)).toThrow()
        expect(r.moveKeepEnd(1).equals(new Range(1, 1))).toBe(true)
    })
})
