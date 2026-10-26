/** Stable family-level splitting: variants inherit this assignment, never split traces. */
export type ExperimentSplit = 'train' | 'dev' | 'test';
export function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
export function splitInventoryFamilies(ids: readonly string[], seed: number): Record<string, ExperimentSplit> {
    if (new Set(ids).size !== ids.length)
        throw new Error('Duplicate inventory family');
    if (ids.length < 3)
        throw new Error('At least three independent inventory families required');
    const sorted = [...ids].sort(), random = seededRandom(seed);
    for (let i = sorted.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
    }
    const testCount = Math.max(1, Math.floor(ids.length * 0.2)), devCount = Math.max(1, Math.floor(ids.length * 0.2));
    return Object.fromEntries(sorted.map((id, i) => [id, i < testCount ? 'test' : i < testCount + devCount ? 'dev' : 'train']).sort((a, b) => a[0]!.localeCompare(b[0]!))) as Record<string, ExperimentSplit>;
}
export function qualifiedScore(result: {
    completed: boolean;
    simScore: number;
}): number | null {
    return result.completed && Number.isFinite(result.simScore) ? result.simScore : null;
}
export function qualifiedTrainingRecords<T extends {
    split: ExperimentSplit;
    complete: boolean;
    score: number | null;
}>(records: readonly T[]): T[] {
    return records.filter(record => record.split === 'train' && record.complete && record.score !== null && Number.isFinite(record.score));
}
