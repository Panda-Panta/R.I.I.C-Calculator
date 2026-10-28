"""Independent finite RIIC oracle. Its labels are never method inputs.

Enumerate each declared legal vector using the unchanged native simulator, for
one or more fixed seeds. The private cache may answer a method only after its
explicit, budget-counted query. Never import this file from a method module.
"""
from __future__ import annotations

import argparse
import itertools
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from common import Problem
from run_suite import NativeOracle, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--node-modules', required=True, type=Path)
    parser.add_argument('--cache', required=True, type=Path)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--seeds', nargs='+', type=int, default=[42, 20261028, 1198905590, 20260920])
    args = parser.parse_args()
    if args.out.exists():
        parser.error('Output must be new')
    args.out.mkdir(parents=True)
    started = time.perf_counter()

    def worker(seed):
        out = args.out / f'seed-{seed}'
        out.mkdir()
        oracle = NativeOracle(args.node_modules, out, args.cache)
        results = []
        try:
            for spec in oracle.scenarios:
                structural = Problem(spec)
                rows = []
                for vector in structural.vectors():
                    if not structural.schedule_feasible(vector):
                        continue
                    record = oracle.evaluate(spec['id'], vector, fidelity='full', seed=seed)
                    rows.append({'vector': list(vector), **record})
                valid = [r for r in rows if r.get('valid') and r.get('score') is not None]
                best = max((r['score'] for r in valid), default=None)
                result = {'scenario': spec['id'], 'seed': seed, 'declared_vectors': len(rows),
                          'valid_full_vectors': len(valid), 'all_full_complete': len(valid) == len(rows),
                          'best_score': best, 'best_vectors': [r['vector'] for r in valid if abs(r['score'] - best) < 1e-8],
                          'rows': rows, 'source_sha256': spec['metadata'].get('source_sha256'),
                          'scope': 'entire declared finite static domain, this full simulator window and seed only'}
                results.append(result)
                write_json(out / f'{spec["id"]}.json', result)
                print(json.dumps({k: result[k] for k in ('scenario', 'seed', 'declared_vectors', 'valid_full_vectors', 'best_score')}), flush=True)
            return results
        finally:
            oracle.close()

    results = []
    with ThreadPoolExecutor(max_workers=min(args.workers, len(args.seeds))) as executor:
        for future in as_completed([executor.submit(worker, seed) for seed in args.seeds]):
            results.extend(future.result())
    write_json(args.out / 'summary.json', {'seeds': args.seeds, 'elapsed_ms': (time.perf_counter() - started) * 1000,
                                         'all_complete': all(r['all_full_complete'] for r in results),
                                         'rows': [{k: r[k] for k in ('scenario', 'seed', 'declared_vectors', 'valid_full_vectors', 'best_score', 'best_vectors')} for r in results],
                                         'scope': 'finite benchmark oracle; no claim for unenumerated rosters, larger domains, other windows, or game/device behavior'})


if __name__ == '__main__':
    main()
