"""Bounded experiment contract. Public G never contains unqueried F labels."""
from __future__ import annotations

import copy
import itertools
import math
import random
import time
import numbers
from collections.abc import Callable, Iterator, Sequence
from typing import Any


def json_evidence(value, warnings: list[str] | None = None, path: str = '$'):
    """Keep missing/nonfinite evidence missing; never manufacture zero labels."""
    warnings = warnings if warnings is not None else []
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, numbers.Integral):
        return int(value)
    if isinstance(value, numbers.Real):
        if math.isfinite(float(value)):
            return float(value)
        warnings.append(f'nonfinite:{path}')
        return None
    if isinstance(value, dict):
        return {str(key): json_evidence(item, warnings, f'{path}.{key}') for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_evidence(item, warnings, f'{path}[{i}]') for i, item in enumerate(value)]
    warnings.append(f'non-json:{path}:{type(value).__name__}')
    return None


def finite_schedule(spec: dict, vector: Sequence[int], max_nodes: int = 1_000_000) -> dict:
    """Exact, finite, nonpreemptive integer-slot capacity checker, independent of F."""
    scheduling = spec.get('scheduling')
    if not scheduling:
        return {'status': 'FEASIBLE', 'witness': [], 'nodes': 0}
    horizon, beds = scheduling['horizon'], scheduling['beds']
    if not isinstance(horizon, int) or horizon < 0 or not isinstance(beds, int) or beds < 0:
        raise ValueError('Finite scheduling requires nonnegative integer horizon/beds')
    jobs = []
    for j, job in enumerate(scheduling.get('jobs', [])):
        variable = job.get('var')
        if variable is not None and vector[variable] not in job.get('values', range(spec['domains'][variable])):
            continue
        duration, demand = job['duration'], job.get('demand', 1)
        release, deadline = job.get('release', 0), job.get('deadline', horizon)
        if not all(isinstance(n, int) for n in (duration, demand, release, deadline)) or duration < 0 or demand < 0:
            raise ValueError('Finite scheduling requires integer slots/demands')
        starts = range(max(0, release), min(horizon, deadline) - duration + 1)
        if not starts or (duration > 0 and demand > beds):
            return {'status': 'INFEASIBLE', 'witness': [], 'nodes': 0}
        jobs.append((job.get('id', str(j)), duration, demand, starts))
    jobs.sort(key=lambda job: (len(job[3]), -job[1] * job[2], job[0]))
    load, chosen, nodes = [0] * horizon, [], 0

    def dfs(index: int) -> bool | None:
        nonlocal nodes
        nodes += 1
        if nodes > max_nodes:
            return None
        if index == len(jobs):
            return True
        name, duration, demand, starts = jobs[index]
        unknown = False
        for start in starts:
            if any(load[t] + demand > beds for t in range(start, start + duration)):
                continue
            for t in range(start, start + duration):
                load[t] += demand
            chosen.append({'id': name, 'start': start, 'end': start + duration, 'demand': demand})
            answer = dfs(index + 1)
            if answer is True:
                return True
            chosen.pop()
            for t in range(start, start + duration):
                load[t] -= demand
            unknown |= answer is None
        return None if unknown else False

    answer = dfs(0)
    return {'status': 'FEASIBLE' if answer is True else 'UNKNOWN' if answer is None else 'INFEASIBLE',
            'witness': copy.deepcopy(chosen) if answer is True else [], 'nodes': nodes}


class Problem:
    def __init__(self, spec: dict, evaluator: Callable | None = None, *, budget: int = 16,
                 default_seed: int = 42):
        self.spec = copy.deepcopy(spec)
        self.scene_id = str(spec['id'])
        sizes = spec['domains']
        if not sizes or any(type(n) is not int or n <= 0 for n in sizes):
            raise ValueError('domains must contain positive integer cardinalities')
        if type(budget) is not int or budget < 0:
            raise ValueError('budget must be a nonnegative integer')
        self.domains = [range(n) for n in sizes]
        self.initial = tuple(spec['initial'])
        self.metadata = self.spec.setdefault('metadata', {})
        self.history: list[dict] = []
        self.budget = budget
        self.default_seed = default_seed
        self._evaluator = evaluator

    @property
    def remaining(self) -> int:
        return max(0, self.budget - len(self.history))

    def feasible(self, vector: Sequence[int]) -> bool:
        try:
            if len(vector) != len(self.domains) or any(type(v) is not int or v not in self.domains[i] for i, v in enumerate(vector)):
                return False
            for restriction in self.spec.get('forbidden', []):
                if all(vector[i] == v for i, v in zip(restriction['vars'], restriction['values'], strict=True)):
                    return False
            for resource in self.spec.get('resources', []):
                if sum(resource['usage'][i][value] for i, value in enumerate(vector)) > resource['capacity']:
                    return False
            return True
        except (TypeError, IndexError, ValueError):
            return False

    is_feasible = feasible

    def schedule_feasible(self, vector: Sequence[int]) -> bool:
        if not self.feasible(vector):
            return False
        result = finite_schedule(self.spec, vector)
        if result['status'] == 'UNKNOWN':
            raise RuntimeError('Finite scheduler budget exhausted; this is not an infeasibility proof')
        return result['status'] == 'FEASIBLE'

    def vectors(self, feasible_only: bool = True) -> Iterator[tuple[int, ...]]:
        for vector in itertools.product(*self.domains):
            if not feasible_only or self.feasible(vector):
                yield vector

    def cheap(self, vector: Sequence[int]) -> float:
        if not self.feasible(vector):
            return -math.inf
        unary = self.spec.get('unary', [[0] * len(d) for d in self.domains])
        result = sum(unary[i][value] for i, value in enumerate(vector))
        for factor in self.spec.get('factors', []):
            key = ','.join(str(vector[i]) for i in factor['vars'])
            result += factor['table'].get(key, 0)
        return float(result)

    def vector_features(self, vector: Sequence[int]) -> list[float]:
        one_hot = [float(vector[i] == value) for i, domain in enumerate(self.domains) for value in domain]
        scale = max(1.0, abs(self.cheap(self.initial)))
        return one_hot + [self.cheap(vector) / scale]

    def evaluate(self, vector: Sequence[int], fidelity: str = 'full', seed: int | None = None) -> dict:
        if self.remaining <= 0:
            return {'vector': list(vector), 'valid': False, 'score': None, 'metrics': {},
                    'fidelity': fidelity, 'seed': seed, 'elapsed_ms': 0, 'reason': 'budget-exhausted', 'counted': False}
        started = time.perf_counter()
        actual_seed = self.default_seed if seed is None else int(seed)
        record: dict[str, Any] = {'vector': list(vector), 'valid': False, 'score': None, 'metrics': {},
                                  'fidelity': fidelity, 'seed': actual_seed, 'counted': True}
        try:
            if fidelity not in ('cheap', 'short', 'full'):
                raise ValueError('Unknown fidelity')
            if not self.feasible(vector):
                record['reason'] = 'structurally-infeasible'
            elif not self.schedule_feasible(vector):
                record['reason'] = 'finite-schedule-infeasible'
            elif fidelity == 'cheap':
                record.update(valid=True, score=self.cheap(vector), evidence_type='declared-proxy-only')
            elif self._evaluator is None:
                record['reason'] = 'missing-evaluator'
            else:
                raw = self._evaluator(tuple(vector), fidelity=fidelity, seed=actual_seed)
                record.update(copy.deepcopy(raw))
                # Oracle cannot rewrite method query provenance or supply NaN as a label.
                record.update(vector=list(vector), fidelity=fidelity, seed=actual_seed, counted=True)
                score = record.get('score')
                record['valid'] = bool(record.get('valid')) and isinstance(score, (int, float)) and math.isfinite(score)
                if not record['valid']:
                    record['score'] = None
                    record.setdefault('reason', 'incomplete-or-invalid-oracle-result')
        except Exception as error:
            record.update(valid=False, score=None, reason=f'{type(error).__name__}: {error}')
        record['elapsed_ms'] = (time.perf_counter() - started) * 1000
        record['query_index'] = len(self.history)
        warnings = []
        record = json_evidence(record, warnings)
        if warnings:
            record['evidence_warnings'] = warnings
        self.history.append(record)
        return copy.deepcopy(record)

    def best(self) -> dict | None:
        valid = [row for row in self.history if row['valid'] and row['fidelity'] == 'full']
        return copy.deepcopy(max(valid, key=lambda row: row['score'])) if valid else None


def make_toy_problem(budget: int = 16, *, scene: int = 0, default_seed: int = 42) -> Problem:
    """Synthetic hand-auditable kernels, explicitly never labelled RIIC evidence."""
    spec = {'id': f'toy-{scene}', 'domains': [3, 3, 2, 2], 'initial': [0, 0, 0, 0],
            'unary': [[3, 5, 4], [2, 4, 6], [0, 2], [0, 1]],
            'factors': [{'vars': [0, 1], 'table': {'1,1': 3, '2,2': -2}},
                        {'vars': [1, 2], 'table': {'2,1': 2}}],
            'forbidden': [{'vars': [0, 1], 'values': [2, 2]}],
            'resources': [{'name': 'shared-support', 'capacity': 3,
                           'usage': [[0, 1, 2], [0, 1, 2], [0, 1], [0, 0]]}],
            'scheduling': {'horizon': 6, 'beds': 1, 'jobs': [
                {'id': 'rest-a', 'var': 0, 'values': [2], 'duration': 4, 'release': 0, 'deadline': 4},
                {'id': 'rest-b', 'var': 1, 'values': [1, 2], 'duration': 3, 'release': 1, 'deadline': 5}]},
            'metadata': {'evidence_type': 'synthetic-kernel-only',
                         'pareto_objectives': [{'name': 'exp', 'direction': 'max'},
                                              {'name': 'order_lmd', 'direction': 'max'},
                                              {'name': 'change_cost', 'direction': 'min'}],
                         'renewal': {'beds': 1, 'shared_state_regenerates': False,
                                     'options': [[{'work_hours': 12 + i, 'rest_hours': 4 + v,
                                                  'reward': 100 + 25 * v, 'bed_units': 1}
                                                 for v in range(size)] for i, size in enumerate([3, 3, 2, 2])]}}}
    # Unknown to solvers; scene changes the held-out nonlinear response.
    def evaluator(vector, *, fidelity, seed):
        a, b, c, d = vector
        base = 100 + 5 * a + 4 * b + 2 * c + d
        nonlocal_effect = (18 if a == (scene + 1) % 3 and d == 1 else 0) - (6 if b == 2 and c == 0 else 0)
        noise = random.Random(int(seed)).uniform(-0.7, 0.7)
        full = base + nonlocal_effect + noise
        score = full if fidelity == 'full' else base + 0.2 * nonlocal_effect + noise
        return {'valid': True, 'score': score,
                'metrics': {'exp': 50 + 3 * a + 9 * c, 'order_lmd': 80 + 7 * b + 3 * d,
                            'gold': 10 + 2 * a + 2 * b, 'change_cost': sum(v != 0 for v in vector)},
                'evidence_type': 'synthetic-kernel-only'}
    return Problem(spec, evaluator, budget=budget, default_seed=default_seed)
