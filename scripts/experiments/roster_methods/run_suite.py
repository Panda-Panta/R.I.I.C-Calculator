"""Run isolated method modules against common kernels or the frozen RIIC oracle.

Usage: python run_suite.py --out NEW_DIRECTORY --mode toy|native [--node-modules PATH]
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import math
import os
import subprocess
import sqlite3
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from common import Problem, make_toy_problem, json_evidence

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
METHODS = {
    '01': 'm01_pool', '02': 'm02_alns', '03': 'm03_cpsat', '04': 'm04_colgen',
    '05': 'm05_benders', '06': 'm06_factor_dp', '07': 'm07_bayes',
    '08': 'm08_multifidelity', '09': 'm09_ranking', '10': 'm10_renewal',
    '11': 'm11_cross_entropy', '12': 'm12_annealing', '13': 'm13_pareto',
    '14': 'm14_mcts', '15': 'm15_gnn_rl',
}
ALL_METHODS = {**METHODS, '16': 'm16_hybrid'}
MODULE_CACHE = {}
MODULE_LOCK = threading.Lock()
METHOD_LOCKS = {identifier: threading.Lock() for identifier in ALL_METHODS}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')


def load_method(identifier):
    with MODULE_LOCK:
        if identifier in MODULE_CACHE:
            return MODULE_CACHE[identifier]
        name = ALL_METHODS[identifier]
        module_spec = importlib.util.spec_from_file_location(name, HERE / 'methods' / f'{name}.py')
        module = importlib.util.module_from_spec(module_spec)
        sys.modules[name] = module
        module_spec.loader.exec_module(module)
        MODULE_CACHE[identifier] = module
        return module


def manifest(identifiers=None):
    items = []
    paths = sorted((ROOT / 'src').rglob('*')) + sorted(HERE.rglob('*'))
    for path in paths:
        if path.is_file() and path.suffix in ('.ts', '.vue', '.json', '.py', '.mjs') and '__pycache__' not in path.parts:
            if identifiers is not None and path.is_relative_to(HERE):
                name = path.stem.removeprefix('test_')
                if name.startswith('m') and name[1:3].isdigit() and name[1:3] not in identifiers:
                    continue
            items.append({'path': path.relative_to(ROOT).as_posix(), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    git_head = None
    try:
        top = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip())
        if top.resolve() == ROOT.resolve():
            git_head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    except subprocess.CalledProcessError:
        pass
    return {'git_head': git_head, 'provided_archive_commit': os.environ.get('ROSTER_ARCHIVE_COMMIT'),
            'sha256': hashlib.sha256(json.dumps(items, sort_keys=True).encode()).hexdigest(), 'inputs': items,
            'python': sys.version, 'executable': sys.executable}


class NativeOracle:
    """A serialized physical simulator, shared cache, and independent query budgets.

    Each method still pays one query for every cached/repeated evaluation. Cached
    labels are returned only after that method asks for the matching candidate.
    Wall time includes queueing; cached wall time is not an algorithm speed claim.
    """
    def __init__(self, node_modules: Path, out: Path, cache_path: Path | None = None):
        self.lock, self.cache = threading.Lock(), {}
        self.physical_calls, self.cache_hits = 0, 0
        self.log = (out / 'native-stderr.log').open('w', encoding='utf-8')
        command = ['node', str(HERE / 'native_adapter.mjs'), '--node-modules', str(node_modules),
                   '--out', str(out / 'native-engine')]
        self.process = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.log, text=True, encoding='utf-8', bufsize=1)
        self.scenarios = self.request({'op': 'scenarios'})['scenarios']
        self.adapter_sha = hashlib.sha256((HERE / 'native_adapter.mjs').read_bytes()).hexdigest()
        self.spec_hashes = {spec['id']: hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest() for spec in self.scenarios}
        self.database = None
        if cache_path:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.database = sqlite3.connect(cache_path, timeout=60, check_same_thread=False)
            self.database.execute('PRAGMA journal_mode=WAL')
            self.database.execute('CREATE TABLE IF NOT EXISTS evaluations (cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            self.database.commit()

    def request(self, value):
        self.process.stdin.write(json.dumps(value) + '\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f'Native oracle stopped with code {self.process.poll()}; see native-stderr.log')
        result = json.loads(line)
        if result.get('error'):
            raise RuntimeError(str(result['error']))
        return result

    def evaluate(self, scene_id, vector, *, fidelity, seed):
        key = (scene_id, tuple(vector), fidelity, int(seed))
        with self.lock:
            database_key = json.dumps([self.adapter_sha, self.spec_hashes[scene_id], *key], separators=(',', ':'))
            if key not in self.cache and self.database:
                stored = self.database.execute('SELECT payload FROM evaluations WHERE cache_key=?', (database_key,)).fetchone()
                if stored:
                    self.cache[key] = json.loads(stored[0])
            if key in self.cache:
                self.cache_hits += 1
                result = copy.deepcopy(self.cache[key])
                result['shared_cache_hit'] = True
                return result
            result = self.request({'op': 'evaluate', 'scene_id': scene_id, 'vector': list(vector),
                                   'fidelity': fidelity, 'seed': seed})
            self.physical_calls += 1
            result['shared_cache_hit'] = False
            self.cache[key] = copy.deepcopy(result)
            if self.database:
                self.database.execute('INSERT OR IGNORE INTO evaluations VALUES (?,?)',
                                      (database_key, json.dumps(result, ensure_ascii=False, allow_nan=False)))
                self.database.commit()
            return result

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=10)
        self.log.close()
        if self.database:
            self.database.close()


def unused_validation_seeds(history, search_seed, count=3):
    used = {row.get('seed') for row in history} | {search_seed}
    seeds = []
    candidates = iter([20261028, 1198905590, 20260920] + [((2654435761 * (i + 1)) & 0xffffffff) for i in range(count + len(used) + 5)])
    for candidate in candidates:
        if candidate not in used and candidate not in seeds:
            seeds.append(candidate)
            if len(seeds) == count:
                return seeds
    raise RuntimeError('Could not construct unused validation seeds')


def algorithm_state(result):
    if not isinstance(result, dict):
        return None
    diagnostics = result.get('diagnostics')
    if isinstance(diagnostics, dict):
        return result.get('status') or diagnostics.get('status') or diagnostics.get('comparison_status')
    return result.get('status')


def run_one(identifier, spec, factory, out, budget, seed):
    # Global RNGs inside a neural library must not race across scenes of one method.
    with METHOD_LOCKS[identifier]:
        return run_one_serial(identifier, spec, factory, out, budget, seed)


def run_one_serial(identifier, spec, factory, out, budget, seed):
    started = time.perf_counter()
    problem = factory(spec, budget, seed)
    module = load_method(identifier)
    result, error = None, None
    try:
        result = module.solve(problem, seed=seed, budget=budget)
        json.dumps(result, allow_nan=False)
    except Exception:
        error = traceback.format_exc()
        result = None
    selected = result.get('best_vector') if isinstance(result, dict) else None
    try:
        selected_valid = selected is not None and problem.feasible(selected) and problem.schedule_feasible(selected)
    except Exception:
        selected_valid = False
        error = error or traceback.format_exc()
    # Decision quality is measured separately on unused seeds, outside search budget.
    holdout = []
    if selected_valid:
        for holdout_seed in unused_validation_seeds(problem.history, seed):
            check = factory(spec, 2, holdout_seed)
            initial = check.evaluate(check.initial, seed=holdout_seed)
            chosen = check.evaluate(selected, seed=holdout_seed)
            eligible = bool(initial['valid'] and chosen['valid'])
            holdout.append({'seed': holdout_seed, 'baseline': initial, 'selected': chosen,
                            'difference': chosen['score'] - initial['score'] if eligible else None})
    valid_differences = [row['difference'] for row in holdout if row['difference'] is not None]
    full = [row for row in problem.history if row['fidelity'] == 'full']
    mechanism_state = algorithm_state(result)
    unsupported = isinstance(mechanism_state, str) and 'unsupported' in mechanism_state.lower()
    row = {'method': identifier, 'module': ALL_METHODS[identifier], 'scenario': spec['id'],
           'status': 'error' if error else 'unsupported-mechanism' if unsupported else 'evaluated' if selected_valid and valid_differences else 'no-valid-selection',
           'algorithm_status': mechanism_state,
           'budget': budget, 'search_seed': seed, 'queries': len(problem.history),
           'full_queries': len(full), 'valid_full_queries': sum(bool(r['valid']) for r in full),
           'selected_vector': selected, 'selected_structurally_valid': selected_valid,
           'holdout_mean_difference': sum(valid_differences) / len(valid_differences) if valid_differences else None,
           'holdout': holdout, 'elapsed_ms_including_queue': (time.perf_counter() - started) * 1000,
           'result': result, 'history': problem.history, 'error': error,
           'evidence_type': spec.get('metadata', {}).get('evidence_type', 'native-calculator-simulation')}
    warnings = []
    row = json_evidence(row, warnings)
    if warnings:
        row['evidence_serialization_warnings'] = warnings
        row['status'] = 'error'
    write_json(out / 'results' / f'{identifier}-{spec["id"]}.json', row)
    print(json.dumps({k: row[k] for k in ('method', 'scenario', 'status', 'queries', 'holdout_mean_difference')}, ensure_ascii=False), flush=True)
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--mode', choices=['toy', 'native'], default='toy')
    parser.add_argument('--method', default='all')
    parser.add_argument('--budget', type=int, default=16)
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--workers', type=int, default=15)
    parser.add_argument('--node-modules', type=Path)
    parser.add_argument('--cache', type=Path, help='Optional private, source-keyed native cache; every method query still counts')
    args = parser.parse_args()
    if args.out.exists():
        parser.error('Output directory must be new; refusing overwrite')
    if args.budget < 1 or not 1 <= args.workers <= 15:
        parser.error('Positive budget and workers in [1,15] required')
    identifiers = list(METHODS) if args.method == 'all' else [args.method.zfill(2)]
    if any(identifier not in ALL_METHODS for identifier in identifiers):
        parser.error('Unknown method')
    args.out.mkdir(parents=True)
    before = manifest(identifiers)
    write_json(args.out / 'source-manifest.json', before)
    native = None
    started = time.perf_counter()
    try:
        if args.mode == 'toy':
            scenarios = [make_toy_problem(scene=i).spec for i in range(3)]
            def factory(spec, budget, seed):
                return make_toy_problem(budget=budget, scene=int(spec['id'].split('-')[-1]), default_seed=seed)
        else:
            if not args.node_modules:
                parser.error('--node-modules required for native mode')
            native = NativeOracle(args.node_modules, args.out, args.cache)
            scenarios = native.scenarios
            def factory(spec, budget, seed):
                return Problem(spec, lambda vector, *, fidelity, seed:
                               native.evaluate(spec['id'], vector, fidelity=fidelity, seed=seed),
                               budget=budget, default_seed=seed)
        write_json(args.out / 'public-scenarios.json', scenarios)
        rows = []
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            jobs = [executor.submit(run_one, identifier, spec, factory, args.out, args.budget, args.seed)
                    for spec in scenarios for identifier in identifiers]
            for job in as_completed(jobs):
                rows.append(job.result())
        # An explicit frozen-policy transfer check, separate from within-scene adaptation.
        transfer = None
        if '15' in identifiers and len(scenarios) >= 2:
            module = sys.modules['m15_gnn_rl']
            training = [factory(spec, args.budget, args.seed) for spec in scenarios[:-1]]
            policy, diagnostics = module.train_policy(training, seed=args.seed, budget=args.budget)
            holdout_problem = factory(scenarios[-1], 1, 20261028)
            transfer_result = module.evaluate_frozen_policy(policy, holdout_problem, seed=20261028, budget=1)
            transfer = {'training_scene_ids': [s['id'] for s in scenarios[:-1]], 'holdout_scene_id': scenarios[-1]['id'],
                        'training_diagnostics': diagnostics, 'frozen_result': transfer_result,
                        'holdout_history': holdout_problem.history,
                        'scope': 'bounded static construction transfer; insufficient evidence for broad generalization'}
            write_json(args.out / 'gnn-frozen-transfer.json', transfer)
        after = manifest(identifiers)
        summary = {'mode': args.mode, 'methods': len(identifiers), 'scenarios': len(scenarios),
                   'budget_per_method_scene': args.budget, 'workers': args.workers,
                   'elapsed_ms': (time.perf_counter() - started) * 1000,
                   'source_unchanged': before['sha256'] == after['sha256'],
                   'physical_native_calls': native.physical_calls if native else None,
                   'shared_cache_hits': native.cache_hits if native else None,
                   'statuses': {status: sum(r['status'] == status for r in rows) for status in sorted({r['status'] for r in rows})},
                   'rows': [{k: row[k] for k in ('method', 'scenario', 'status', 'algorithm_status', 'queries', 'full_queries',
                                               'valid_full_queries', 'selected_vector', 'holdout_mean_difference',
                                               'elapsed_ms_including_queue')} for row in sorted(rows, key=lambda r: (r['scenario'], r['method']))],
                   'caveats': ['Synthetic kernels are not RIIC evidence.',
                               'Native scores establish calculator simulation only, not game/device production.',
                               'Method wall times include queueing and shared cache; do not compare as standalone speedups.',
                               'Three held-out seeds are a bounded replication check, not a confidence or global-optimality proof.']}
        write_json(args.out / 'summary.json', summary)
        if any(row['status'] == 'error' for row in rows):
            sys.exit(1)
    finally:
        if native:
            native.close()


if __name__ == '__main__':
    main()
