import { describe, expect, it } from 'vitest';
import { splitInventoryFamilies, qualifiedScore, qualifiedTrainingRecords } from './experiment';
describe('neural experiment evidence contracts', () => {
    it('splits families before variants independently of order and rejects duplicate identity', () => {
        const ids = Array.from({ length: 12 }, (_, i) => `inventory-${i}`);
        const a = splitInventoryFamilies(ids, 42);
        expect(splitInventoryFamilies([...ids].reverse(), 42)).toEqual(a);
        expect(new Set(Object.values(a))).toEqual(new Set(['train', 'dev', 'test']));
        expect(() => splitInventoryFamilies(['same', 'same'], 42)).toThrow(/duplicate/i);
    });
    it('never makes failed, incomplete or nonfinite simulator results zero labels', () => {
        expect(qualifiedScore({ completed: false, simScore: 0 })).toBeNull();
        expect(qualifiedScore({ completed: true, simScore: NaN })).toBeNull();
        expect(qualifiedScore({ completed: true, simScore: 0 })).toBe(0);
    });
    it('admits only completed training-family teacher records, not held-out labels', () => {
        const records = [{ split: 'train' as const, complete: true, score: 2 }, { split: 'test' as const, complete: true, score: 99 }, { split: 'train' as const, complete: false, score: null }];
        expect(qualifiedTrainingRecords(records)).toEqual([records[0]]);
    });
});
