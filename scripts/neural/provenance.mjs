import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
export const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const normalizeSourceKey = path => path.replaceAll('\\', '/');
export function inferenceContractHash(sourceHashes) {
    const contract = Object.fromEntries(Object.entries(sourceHashes).map(([key, hash]) => [normalizeSourceKey(key), hash]).filter(([key]) => key.startsWith('src/')).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    if (!Object.keys(contract).length || Object.values(contract).some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw Error('Invalid inference source contract');
    return sha256(contract);
}
export function sourceProvenance(root) {
    function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]); }
    const selected = [...files(join(root, 'src')).filter(p => /\.(ts|json)$/.test(p) && !p.endsWith('.spec.ts')), ...files(join(root, 'scripts/neural')).filter(p => /\.(ts|mjs)$/.test(p) && !p.endsWith('.node-test.mjs') && !p.endsWith('.test.mjs'))].sort();
    const sourceHashes = Object.fromEntries(selected.map(p => [normalizeSourceKey(relative(root, p)), sha256(readFileSync(p, 'utf8'))]));
    return { sourceHashes, sourceHash: sha256(sourceHashes), inferenceContractHash: inferenceContractHash(sourceHashes) };
}
