"""CLI research runner. Default is a 0F plan; --execute/--allow-native are distinct."""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
from pathlib import Path
import shutil
import sys
import time

sys.dont_write_bytecode = True
if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
    from scripts.experiments.main_roster_hybrids.method_registry import METHOD_REGISTRY, canonical_method_id, load_legacy_common, run_method
    from scripts.experiments.main_roster_hybrids.native_cache import NativeResultCache, NodeNativeClient, file_sha256
else:
    from .method_registry import METHOD_REGISTRY, canonical_method_id, load_legacy_common, run_method
    from .native_cache import NativeResultCache, NodeNativeClient, file_sha256


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def select_recorded_winners(history: list[dict]) -> dict:
    """Full actual observed F and quality choice are distinct; short is never final."""
    observed = [row for row in history if row.get('fidelity') == 'full' and row.get('native_complete') is True and _finite(row.get('observed_score'))]
    accepted = [row for row in observed if row.get('valid') is True
                and _finite(row.get('metrics', {}).get('ordinaryFatiguedHours'))
                and abs(row['metrics']['ordinaryFatiguedHours']) <= 1e-7]
    return {'bestObservedF': copy.deepcopy(max(observed, key=lambda row: row['observed_score'], default=None)),
            'qualityAcceptedWinner': copy.deepcopy(max(accepted, key=lambda row: row['observed_score'], default=None)),
            'qualitySelectionScope': 'Bound ready-domain admission plus native complete/finite and zero sampled ordinary fatigue. Strict eligibility and pending episodes remain separate. No game or global-optimality proof.'}


def make_problem(common, domain: dict, evaluator, budget: int):
    spec = copy.deepcopy(domain['publicSpec'])
    # Only capabilities are public; never publish workspaces, private cache, or F labels.
    spec.setdefault('metadata', {})['evaluation_protocol'] = {'kind': 'native', 'fixed_seed': 42, 'short_supported': True,
        'metrics': ['exp', 'order_lmd', 'gold', 'change_cost', 'ordinaryFatiguedHours', 'strictEligibility', 'unresolvedEpisodes'],
        'domain_schema_version': domain['schemaVersion'], 'full_window_hours': [24, 72], 'short_window_hours': [6, 18]}
    if 'materializations' in spec or 'workspace' in spec:
        raise ValueError('Private materialization leaked into public Problem')
    problem = common.Problem(spec, evaluator, budget=budget, default_seed=42)
    if tuple(problem.initial) != tuple(domain['initial']):
        raise ValueError('Problem.initial must be the declared incumbent')
    return problem


def _read(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def _write(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--case', action='append', required=True, help='Repeat with matching --domain paths')
    result.add_argument('--domain', action='append', required=True)
    result.add_argument('--engine-binding', required=True)
    result.add_argument('--legacy-root', default=os.environ.get('RIIC_ROSTER_METHODS_ROOT'))
    result.add_argument('--out', required=True)
    result.add_argument('--cache-dir')
    result.add_argument('--methods', default=','.join(METHOD_REGISTRY))
    result.add_argument('--budgets', default='2')
    result.add_argument('--seed', type=int, choices=[42], default=42)
    result.add_argument('--node', default=shutil.which('node') or 'node')
    result.add_argument('--execute', action='store_true', help='Run real methods, possibly cache-only; otherwise emit a plan')
    result.add_argument('--allow-native', action='store_true', help='Explicit physical F authorization, still bounded by --max-physical-f')
    result.add_argument('--max-physical-f', '--max-physical-calls', dest='max_physical_f', type=int, default=0)
    result.add_argument('--reuse-incumbent', action=argparse.BooleanOptionalAction, default=True)
    result.add_argument('--method-options', help='JSON mapping canonical method ids to options; no F labels')
    return result


def main(argv=None):
    options = parser().parse_args(argv)
    if len(options.case) != len(options.domain):
        raise SystemExit('Each --case needs one matching --domain')
    if options.allow_native and (not options.execute or options.max_physical_f <= 0):
        raise SystemExit('--allow-native requires --execute and positive --max-physical-f; root authorization is separate')
    if options.max_physical_f < 0:
        raise SystemExit('Physical budget cannot be negative')
    if not options.legacy_root:
        raise SystemExit('Use --legacy-root or RIIC_ROSTER_METHODS_ROOT')
    methods = [canonical_method_id(name.strip()) for name in options.methods.split(',') if name.strip()]
    budgets = [int(value) for value in options.budgets.split(',')]
    if not methods or len(set(methods)) != len(methods) or not budgets or any(value < 0 for value in budgets):
        raise SystemExit('Methods must be unique and budgets nonnegative')
    out = Path(options.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    common = load_legacy_common(options.legacy_root)
    method_options = _read(options.method_options) if options.method_options else {}
    scenes = []
    for case_path, domain_path in zip(options.case, options.domain, strict=True):
        case_path, domain_path = Path(case_path).resolve(), Path(domain_path).resolve()
        case, domain = _read(case_path), _read(domain_path)
        if case['sceneId'] != domain['sceneId']:
            raise ValueError('Case/domain scene mismatch')
        scenes.append({'sceneId': case['sceneId'], 'casePath': str(case_path), 'caseSha256': file_sha256(case_path),
                       'domainPath': str(domain_path), 'domainSha256': file_sha256(domain_path),
                       'publicSpec': domain['publicSpec'], 'domainEvidence': domain['evidence']})
    plan = {'schemaVersion': 1, 'scenes': scenes, 'methods': methods, 'budgets': budgets, 'fixedSeed': 42,
            'execute': options.execute, 'allowNative': options.allow_native, 'maxPhysicalF': options.max_physical_f,
            'engineBindingPath': str(Path(options.engine_binding).resolve()), 'engineBindingSha256': file_sha256(options.engine_binding),
            'legacyRoot': str(Path(options.legacy_root).resolve()), 'python': sys.executable, 'pythonVersion': sys.version,
            'dontWriteBytecode': sys.dont_write_bytecode, 'nativeParallelism': 1,
            'queryUnit': 'Every Problem.evaluate, including initial/cached/duplicate/cheap/short; no wrapper initial prequery',
            'timingScope': 'Persistent Node. Cache reuse is not a cold wall-time speed proof; Python CPU, native CPU, logical and physical costs are separate.'}
    _write(out / 'suite-plan.json', plan)
    if not options.execute:
        print(json.dumps({'out': str(out), 'status': 'prepared-only', 'physicalFCalls': 0, 'scenes': len(scenes), 'methods': len(methods)}), flush=True)
        return 0
    cache = NativeResultCache(options.cache_dir or out / 'private-cache')
    evaluator_path = Path(__file__).with_name('native_evaluator.mjs')
    physical_used = 0
    scene_results = []
    suite_wall, suite_cpu = time.perf_counter(), time.process_time()
    for scene in scenes:
        domain = _read(scene['domainPath'])
        scene_out = out / scene['sceneId']
        scene_out.mkdir()
        remaining_physical = max(0, options.max_physical_f - physical_used)
        with NodeNativeClient(node=options.node, evaluator=evaluator_path, case=scene['casePath'], domain=scene['domainPath'],
                              engine_binding=options.engine_binding, out=scene_out / 'evaluator', cache=cache,
                              allow_native=options.allow_native, max_physical_f=remaining_physical) as client:
            imported = client.import_incumbent(domain['initial']) if options.reuse_incumbent else {'status': 'disabled'}
            arms, all_history = [], []
            for budget in budgets:
                for method in methods:
                    problem = make_problem(common, domain, client.evaluate, budget)
                    assert not problem.history
                    before = client.stats()
                    print(json.dumps({'kind': 'arm-start', 'sceneId': scene['sceneId'], 'method': method, 'logicalBudget': budget,
                                      'physicalRemaining': max(0, remaining_physical - before['physical_f_calls'])}), flush=True)
                    wall, cpu = time.perf_counter(), time.process_time()
                    returned = run_method(method, problem, seed=42, budget=budget, legacy_root=options.legacy_root,
                                          options=method_options.get(method))
                    elapsed, used_cpu = (time.perf_counter() - wall) * 1000, (time.process_time() - cpu) * 1000
                    after = client.stats()
                    history = copy.deepcopy(problem.history)
                    all_history.extend(history)
                    delta = {key: after[key] - before[key] for key in after if isinstance(after[key], (int, float)) and key in before and isinstance(before[key], (int, float))}
                    record = {'sceneId': scene['sceneId'], 'method': method, 'logicalBudget': budget, 'returned': returned, 'history': history,
                              **select_recorded_winners(history), 'cost': {'logicalQueries': len(history), 'methodWallMs': elapsed,
                              'methodPythonCpuMs': used_cpu, 'nativeAndCacheDelta': delta}, 'publicSpecSha256': returned.get('registry', {}).get('public_spec_sha256')}
                    warnings = []
                    record = common.json_evidence(record, warnings)
                    record['serializationWarnings'] = warnings
                    _write(scene_out / f'{method}-budget-{budget}.json', record)
                    arms.append(record)
                    print(json.dumps({'kind': 'arm-done', 'sceneId': scene['sceneId'], 'method': method, 'status': returned.get('status'),
                                      'logicalQueries': len(history), 'physicalFCalls': delta.get('physical_f_calls', 0)}), flush=True)
            stats = client.stats()
            physical_used += stats['physical_f_calls']
            scene_result = {'sceneId': scene['sceneId'], 'incumbentImport': {'status': imported.get('status'), 'reason': imported.get('reason')},
                            'arms': arms, 'stats': stats, **select_recorded_winners(all_history)}
            _write(scene_out / 'summary.json', scene_result)
            scene_results.append(scene_result)
    summary = {'schemaVersion': 1, 'sourcePlanPath': str(out / 'suite-plan.json'), 'scenes': scene_results,
               'physicalFCalls': physical_used, 'logicalQueries': sum(arm['cost']['logicalQueries'] for scene in scene_results for arm in scene['arms']),
               'suiteWallMs': (time.perf_counter() - suite_wall) * 1000, 'suitePythonCpuMs': (time.process_time() - suite_cpu) * 1000,
               'allowNative': options.allow_native, 'noNativeParallelism': True,
               'verificationBoundary': 'Only queried real F labels. No short final winner, no game execution or global optimum proof. Strict eligibility/ordinary fatigue/pending episodes retained separately.'}
    _write(out / 'summary.json', common.json_evidence(summary))
    print(json.dumps({'out': str(out), 'physicalFCalls': physical_used, 'logicalQueries': summary['logicalQueries']}), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
