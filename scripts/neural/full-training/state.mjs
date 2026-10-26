import { inspectReferenceEnvelope } from '../full-baseline/reference-protocol.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
export const digest = value => createHash('sha256').update(value instanceof Uint8Array ? value : typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function atomic(path, value) { writeFileSync(path + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(path + '.tmp', path); }
/** Completed zero is legitimate. Unknown/invalid/raw records are retained by the caller. */
export function qualifyEnvelope(input, outcome, purpose) {
    const reasons = [], envelope = outcome?.result, teacher = envelope?.result;
    if (envelope?.degradedBaseline === true)
        reasons.push('DEGRADED_NOT_FULL_MATHEMATICAL_REFERENCE');
    if (outcome?.admittedTarget === false || envelope?.admittedTarget === false || envelope?.comparisonComplete === false)
        reasons.push('PARTIAL_FAMILY_NOT_ADMITTED');
    if ((input?.sourceKind && input.sourceKind !== 'full-optimizer') || (envelope?.sourceKind && envelope.sourceKind !== 'full-optimizer'))
        reasons.push('SOURCE_KIND_NOT_FULL_OPTIMIZER');
    if (!['train', 'dev-overfit'].includes(purpose))
        reasons.push('UNKNOWN_PURPOSE');
    if (input?.split !== 'train' && !(purpose === 'dev-overfit' && input?.split === 'dev'))
        reasons.push('SPLIT_NOT_AUTHORIZED');
    if (outcome?.status !== 'completed' || outcome?.completed !== true || envelope?.completed !== true)
        reasons.push('TEACHER_NOT_COMPLETED');
    if (!Number.isFinite(outcome?.score) || !Number.isFinite(envelope?.score) || !Number.isFinite(teacher?.score))
        reasons.push('UNKNOWN_SCORE');
    if (teacher?.status !== 'draft' || !teacher?.workspace || !teacher?.calculationReport)
        reasons.push('MISSING_EXACT_FINAL_TEACHER');
    if (!Array.isArray(envelope?.validation?.physical) || envelope.validation.physical.length)
        reasons.push('PHYSICAL_VALIDATION_UNKNOWN_OR_FAILED');
    if (outcome?.score !== envelope?.score || envelope?.score !== teacher?.score)
        reasons.push('SCORE_CONFLICT');
    const reference = inspectReferenceEnvelope(input, envelope);
    reasons.push(...reference.reasons);
    return { referenceProtocol: reference.referenceProtocol, qualified: reasons.length === 0, reasons, score: reasons.length ? null : outcome.score, degradedBaseline: envelope?.degradedBaseline ?? null };
}
export function verifyBinding(actual, expected) {
    if (digest(actual) !== digest(expected))
        throw Error('Resume dataset/source/feature/settings mismatch');
}
export function advanceCursor(cursor, count, lengths) {
    const c = { ...cursor };
    if (!Number.isSafeInteger(count) || count < 0)
        throw Error('Invalid update count');
    while (count) {
        const remaining = lengths[c.family] - c.action;
        if (remaining <= 0)
            throw Error('Invalid cursor');
        const n = Math.min(count, remaining);
        c.action += n;
        c.updates += n;
        count -= n;
        if (c.action === lengths[c.family]) {
            c.action = 0;
            c.family++;
            if (c.family === lengths.length) {
                c.family = 0;
                c.epoch++;
            }
        }
    }
    return c;
}
/** Immutable generation + one atomic pointer: model and cursor cannot tear on interruption. */
export function saveCheckpoint(directory, bytes, state) {
    const name = `checkpoint-${state.cursor.updates}-${Date.now()}-${process.pid}`, temporary = join(directory, name + '.tmp'), final = join(directory, name);
    mkdirSync(temporary);
    writeFileSync(join(temporary, 'model.bin'), bytes, { mode: 0o600 });
    const record = { ...state, modelHash: digest(bytes) };
    atomic(join(temporary, 'state.json'), record);
    renameSync(temporary, final);
    atomic(join(directory, 'checkpoint.json'), { generation: name, stateHash: digest(record) });
    // Only our immutable checkpoint generations, keep the new generation plus one rollback.
    const generations = readdirSync(directory).filter(n => /^checkpoint-[\d-]+$/.test(n)).sort((a, b) => Number(b.split('-')[2]) - Number(a.split('-')[2]));
    for (const old of generations.filter(n => n !== name).slice(1))
        rmSync(join(directory, old), { recursive: true, force: true });
    return record;
}
export function inspectCheckpoint(directory) {
    if (!existsSync(join(directory, 'checkpoint.json')))
        return null;
    const pointer = JSON.parse(readFileSync(join(directory, 'checkpoint.json'), 'utf8'));
    if (!/^checkpoint-[\d-]+$/.test(pointer.generation))
        throw Error('Invalid checkpoint pointer');
    const state = JSON.parse(readFileSync(join(directory, pointer.generation, 'state.json'), 'utf8')), bytes = readFileSync(join(directory, pointer.generation, 'model.bin'));
    if (digest(state) !== pointer.stateHash || digest(bytes) !== state.modelHash)
        throw Error('Checkpoint integrity mismatch');
    return { state, bytes, generation: pointer.generation };
}
export function loadCheckpoint(directory, binding) {
    const result = inspectCheckpoint(directory);
    if (result)
        verifyBinding(result.state.binding, binding);
    return result;
}
