"""Zero-F neighborhood repairs using the actual frozen m03/m06 algorithm cores.

These functions do not call a legacy solve(), evaluate(), vectors(), or F history.
``exact`` refers to the remaining declared model, never native F. CP uses a
scaled integer objective with its existing 2E proxy-regret bound; DP retains all
factors and certifies only order-independent numeric ranges. Scheduling is an
extra check; complexity and unsupported numerical proofs remain explicit.
"""
from copy import deepcopy
from fractions import Fraction
from functools import lru_cache
import hashlib
import importlib.util
import math
import os
from pathlib import Path
import sys
from time import perf_counter
from types import SimpleNamespace

MAX_REPAIR_ATTEMPTS = 256
PROOF_SCOPE = (
    'Remaining finite public unary+factor G model, fixed unreleased coordinates, '
    'visited exclusions and individually checked schedule exclusions only. '
    'No native F, expectation, game or unrestricted-roster optimality proof.'
)


def _legacy(name):
    configured = os.environ.get('RIIC_ROSTER_METHODS_ROOT')
    if configured:
        path = Path(configured).resolve() / 'methods' / f'{name}.py'
    else:
        relative = Path('scripts/experiments/roster_methods/methods') / f'{name}.py'
        path = next((parent / relative for parent in Path(__file__).resolve().parents if (parent / relative).is_file()), None)
    if path is None or not path.is_file():
        raise ImportError('read-only original method unavailable; set RIIC_ROSTER_METHODS_ROOT to its roster_methods directory')
    return _load_legacy(name, str(path))


@lru_cache(maxsize=4)
def _load_legacy(name, path):
    path = Path(path)
    raw = path.read_bytes()
    key = f'_main_roster_hybrid_legacy_{name}_{hashlib.sha256(str(path).encode()).hexdigest()[:12]}'
    module = importlib.util.module_from_spec(importlib.util.spec_from_file_location(key, path))
    sys.modules[key] = module  # dataclasses resolves its defining module here.
    exec(compile(raw, str(path), 'exec'), module.__dict__)
    module._repair_source = {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest()}
    return module


def _number(value):
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError('public coefficients must be finite numeric values, not booleans')
    return value


def _prepare(problem, incumbent, released, excluded):
    spec = deepcopy(problem.spec)
    sizes = spec['domains']
    if not isinstance(sizes, (list, tuple)) or any(type(size) is not int or size < 1 for size in sizes):
        raise ValueError('domains must be positive integer cardinalities')
    domains = tuple(tuple(range(size)) for size in sizes)
    if tuple(tuple(domain) for domain in problem.domains) != domains:
        raise ValueError('public domains disagree with spec cardinalities')

    def vector(raw):
        value = tuple(raw)
        if len(value) != len(sizes) or any(type(v) is not int or v not in domains[i] for i, v in enumerate(value)):
            raise ValueError('incumbent/exclusion has wrong arity or out-of-domain values')
        return value

    current, freed = vector(incumbent), set(released)
    if any(type(i) is not int or not 0 <= i < len(sizes) for i in freed):
        raise ValueError('released contains an undeclared coordinate')
    blocked = {vector(item) for item in excluded}
    fixed = {i: value for i, value in enumerate(current) if i not in freed}
    unary = spec.get('unary')
    if not isinstance(unary, (list, tuple)) or len(unary) != len(sizes):
        raise ValueError('unary must have one row per variable')
    for size, row in zip(sizes, unary):
        if not isinstance(row, (list, tuple)) or len(row) != size:
            raise ValueError('unary row has wrong size')
        for value in row:
            _number(value)

    def scope(raw):
        if not isinstance(raw, (list, tuple)) or any(type(i) is not int or not 0 <= i < len(sizes) for i in raw):
            raise ValueError('factor/forbidden scope contains an undeclared coordinate')
        return tuple(raw)

    def assignment(raw, indices):
        values = tuple(raw)
        if len(values) != len(indices) or any(type(v) is not int or v not in domains[i] for i, v in zip(indices, values)):
            raise ValueError('factor/forbidden assignment is malformed')
        return values

    for factor in spec.get('factors', []):
        indices, seen = scope(factor['vars']), set()
        if not isinstance(factor['table'], dict):
            raise ValueError('factor table must be a mapping')
        for key, value in factor['table'].items():
            if not isinstance(key, str):
                raise ValueError('factor table keys must be comma-joined strings')
            values = assignment([int(part) for part in key.split(',')] if key else [], indices)
            if key != ','.join(map(str, values)):
                raise ValueError('factor key must match canonical common.cheap lookup semantics')
            if values in seen:
                raise ValueError('duplicate canonical factor assignment')
            seen.add(values); _number(value)
    for item in spec.get('forbidden', []):
        assignment(item['values'], scope(item['vars']))
    resource_scales = []
    integer_spec = deepcopy(spec)
    for index, item in enumerate(integer_spec.get('resources', [])):
        rows = item['usage']
        if len(rows) != len(sizes) or any(len(row) != size for row, size in zip(rows, sizes)):
            raise ValueError('resource dimensions disagree with domains')
        capacity = Fraction(str(_number(item['capacity'])))
        fractions = [[Fraction(str(_number(value))) for value in row] for row in rows]
        scale = math.lcm(capacity.denominator, *(value.denominator for row in fractions for value in row))
        item['capacity'] = int(capacity * scale)
        item['usage'] = [[int(value * scale) for value in row] for row in fractions]
        if abs(item['capacity']) + sum(abs(v) for row in item['usage'] for v in row) > (1 << 53) - 1:
            raise ValueError('exact resource scaling exceeds supported safe range')
        resource_scales.append({'name': item.get('name', str(index)), 'scale': scale, 'rounding': 'none; exact decimals'})
    return spec, integer_spec, domains, current, fixed, blocked, resource_scales


def _proxy(spec, vector):
    value = sum(spec['unary'][i][v] for i, v in enumerate(vector))
    for factor in spec.get('factors', []):
        value += factor['table'].get(','.join(str(vector[i]) for i in factor['vars']), 0)
    if not math.isfinite(value):
        raise ValueError('proxy accumulation is not finite')
    return float(value)


def _dp_numeric_certificate(spec):
    """Sufficient conditions for bucket sums to agree with common.cheap.

    No complete vectors are enumerated. A selected reward term is one unary row
    or one sparse factor entry. Bucket messages combine disjoint original terms.
    If their global absolute sum in one binary unit fits 53 bits, every partial
    sum is exactly representable and regrouping cannot change the objective.
    A single nonzero term also cannot suffer cancellation or regrouping loss.
    """
    terms = [*spec['unary'], *(factor['table'].values() for factor in spec.get('factors', []))]
    nonzero = sum(any(value != 0 for value in term) for term in terms)
    if nonzero <= 1:
        return {'supported': True, 'criterion': 'at_most_one_nonzero_reward_term', 'nonzero_terms': nonzero}
    rational_terms = [[Fraction(value) for value in term] for term in terms]
    # Finite int/float inputs have power-of-two denominators; the largest is LCM.
    denominator = max((value.denominator for term in rational_terms for value in term), default=1)
    absolute_units = sum(max((abs(value) * denominator for value in term), default=0) for term in rational_terms)
    supported = absolute_units <= (1 << 53) - 1
    return {'supported': supported, 'criterion': 'safe_exact_dyadic_sum' if supported else 'uncertified_float_regrouping',
            'nonzero_terms': nonzero, 'binary_unit_denominator': denominator,
            'absolute_unit_sum_bound': int(absolute_units), 'exact_unit_limit': (1 << 53) - 1}


def _resource_compatibility(spec):
    """Prove decimal model inequalities equal common's native numeric sums."""
    checks = []
    for index, resource in enumerate(spec.get('resources', [])):
        entries = [('capacity', resource['capacity'])]
        entries += [(f'usage[{i}][{v}]', value) for i, row in enumerate(resource['usage']) for v, value in enumerate(row)]
        mismatch = next((label for label, value in entries if Fraction(str(value)) != Fraction(value)), None)
        if mismatch is not None:
            checks.append({'name': resource.get('name', str(index)), 'supported': False,
                           'criterion': 'decimal_binary_coefficient_mismatch', 'coefficient': mismatch})
            continue
        denominator = max((Fraction(value).denominator for _, value in entries), default=1)
        absolute_units = sum(max((abs(Fraction(value)) * denominator for value in row), default=0)
                             for row in resource['usage'])
        checks.append({'name': resource.get('name', str(index)), 'supported': absolute_units <= (1 << 53) - 1,
                       'criterion': 'exact_dyadic_resource_sum', 'binary_unit_denominator': denominator,
                       'absolute_unit_sum_bound': int(absolute_units), 'exact_unit_limit': (1 << 53) - 1})
    supported = all(check['supported'] for check in checks)
    return {'supported': supported, 'criterion': 'no_resources' if not checks else
            'all_resource_sums_proven_equivalent' if supported else 'resource_equivalence_unproven', 'resources': checks}


def _gate(problem, vector, diagnostics):
    try:
        if not problem.feasible(vector):
            diagnostics['validation_mismatch'] = {
                'kind': 'public_structural_constraints_disagree',
                'resource_model_semantics': 'exact decimal integerization; public checker may sum floats',
                'certificate': 'none; model/public feasibility equivalence not established',
            }
            return 'MODEL_INVALID', 'public structural validation mismatch; no common-model certificate or candidate'
        checked = problem.schedule_feasible(vector)
        if type(checked) is not bool:
            return 'UNKNOWN', 'schedule checker did not return an explicit boolean'
        if not checked:
            diagnostics['schedule_exclusions'].append(list(vector))
            return 'REJECTED', None
        return 'ACCEPTED', None
    except Exception as error:
        return 'UNKNOWN', f'{type(error).__name__}: {error}'


def _result(diagnostics, start, status, vector=None, exact=False, reason=None):
    diagnostics['total_wall_seconds'] = perf_counter() - start
    diagnostics['certificate_valid'] = bool(exact)
    if status in ('MODEL_INVALID', 'UNKNOWN', 'UNSUPPORTED'):
        diagnostics['proxy_upper_bound'] = None
    if reason:
        diagnostics['reason'] = reason
    return {'vector': list(vector) if vector is not None else None, 'status': status, 'exact': exact, 'diagnostics': diagnostics}


def _diagnostics(backend, seed):
    return {'backend': backend, 'seed': seed, 'f_calls': 0, 'proof_scope': PROOF_SCOPE,
            'proxy_objective': None, 'proxy_upper_bound': None, 'schedule_exclusions': [], 'attempt_limit': MAX_REPAIR_ATTEMPTS}


def repair_cp(problem, incumbent, released, *, excluded=(), seed=42, time_limit_s=1.0):
    """Real CP-SAT repair; time_limit_s bounds search after backend/model setup.

    Cold imports and model preparation remain charged in total_wall_seconds;
    exact=True certifies only the scaled remaining G, never native F.
    """
    start = perf_counter(); data = _diagnostics('OR-Tools CP-SAT', seed); data['solves'] = []
    try:
        limit = _number(time_limit_s)
        if limit < 0:
            raise ValueError('time_limit_s must be nonnegative')
        spec, _, _, current, fixed, blocked, _ = _prepare(problem, incumbent, released, excluded)
        data.update(fixed={str(i): v for i, v in fixed.items()}, excluded_count=len(blocked))
        data['resource_compatibility'] = _resource_compatibility(spec)
        if not data['resource_compatibility']['supported']:
            return _result(data, start, 'UNSUPPORTED', reason='resource decimal/native-float equivalence unproved; no solve or certificate')
        import ortools
        from ortools.sat.python import cp_model
        legacy = _legacy('m03_cpsat')
        data.update(legacy_source=legacy._repair_source, solver_version=ortools.__version__)
        model, variables, _, metadata, _ = legacy._build_model(spec, cp_model)
        data.update(metadata)
        for i, value in fixed.items():
            model.add(variables[i] == value)
        for vector in sorted(blocked):
            model.add_forbidden_assignments(variables, [vector])
        data['setup_wall_seconds'] = perf_counter() - start
        deadline = perf_counter() + limit
        for _ in range(MAX_REPAIR_ATTEMPTS):
            if perf_counter() >= deadline:
                return _result(data, start, 'UNKNOWN', reason='CP cumulative search time limit; no infeasibility inferred')
            solver = cp_model.CpSolver()
            solver.parameters.num_search_workers = 1
            solver.parameters.random_seed = int(seed) & 0x7fffffff
            solver.parameters.max_time_in_seconds = max(0.0, deadline - perf_counter())
            status = solver.solve(model)
            name = solver.status_name(status)
            item = {'status': name, 'wall_time_seconds': solver.wall_time, 'branches': solver.num_branches, 'conflicts': solver.num_conflicts}
            data['solves'].append(item)
            if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
                return _result(data, start, name, exact=status == cp_model.INFEASIBLE)
            vector = tuple(solver.value(variable) for variable in variables)
            value = _proxy(spec, vector)
            bound = solver.best_objective_bound
            upper = legacy._upper_float(Fraction(str(bound)) / legacy.OBJECTIVE_SCALE + Fraction.from_float(metadata['objective_abs_error_bound']))
            data.update(proxy_objective=value, scaled_objective=int(round(solver.objective_value)), scaled_best_bound=bound, proxy_upper_bound=upper)
            item.update(vector=list(vector), proxy_objective=value)
            accepted, reason = _gate(problem, vector, data)
            if accepted == 'ACCEPTED':
                return _result(data, start, name, vector, exact=status == cp_model.OPTIMAL)
            if accepted != 'REJECTED':
                return _result(data, start, accepted, reason=reason)
            # A checker rejection excludes exactly this vector, never a core cut.
            model.add_forbidden_assignments(variables, [vector])
        return _result(data, start, 'UNKNOWN', reason='CP repair candidate-check limit')
    except ImportError as error:
        return _result(data, start, 'UNSUPPORTED', reason=str(error))
    except (ValueError, TypeError, KeyError, IndexError, OverflowError) as error:
        return _result(data, start, 'MODEL_INVALID', reason=f'{type(error).__name__}: {error}')


def repair_factor_dp(problem, incumbent, released, *, excluded=(), seed=42):
    """Real bucket elimination, retaining complete high-order exclusion factors."""
    start = perf_counter(); data = _diagnostics('max-sum factor elimination', seed)
    data.update(model_solves=[], factors_dropped=0,
                numeric_semantics='legacy max-sum G; numeric certificate required for OPTIMAL; exact integer resources')
    try:
        spec, integer_spec, domains, current, fixed, blocked, scales = _prepare(problem, incumbent, released, excluded)
        data.update(fixed={str(i): v for i, v in fixed.items()}, excluded_count=len(blocked), resource_scaling=scales)
        data['resource_compatibility'] = _resource_compatibility(spec)
        if not data['resource_compatibility']['supported']:
            return _result(data, start, 'UNSUPPORTED', reason='resource decimal/native-float equivalence unproved; no solve or certificate')
        numeric = _dp_numeric_certificate(spec)
        data['numeric_certificate'] = numeric
        # The reused DP supports distinct factor scopes. Do not silently weaken a
        # valid but repeated-variable legacy factor to make it fit this backend.
        if any(len(set(item['vars'])) != len(item['vars']) for item in [*spec.get('factors', []), *spec.get('forbidden', [])]):
            return _result(data, start, 'UNSUPPORTED', reason='DP requires distinct variables in each scope')
        legacy = _legacy('m06_factor_dp')
        data['legacy_source'] = legacy._repair_source
        factors, counts = legacy._compile(SimpleNamespace(spec=integer_spec), domains)
        data.update(factor_counts=counts, limits={'message_rows': legacy._MAX_MESSAGE_ROWS, 'join_assignments': legacy._MAX_JOIN_ASSIGNMENTS, 'dp_solves': legacy._MAX_DP_SOLVES})
        reduced = tuple((current[i],) if i in fixed else domain for i, domain in enumerate(domains))
        scope = tuple(range(len(domains)))
        for vector in sorted(blocked):
            factors.append(legacy._Factor(scope, {vector: -math.inf}, kind='visited-exclusion'))
        work = legacy._Work()
        try:
            for _ in range(MAX_REPAIR_ATTEMPTS):
                solved = legacy._eliminate(factors, reduced, work)
                record = {**solved, 'vector': list(solved['vector']) if solved['vector'] is not None else None}
                nonfinite = solved.get('score') is not None and not math.isfinite(solved['score'])
                if nonfinite:
                    record.update(score=None, nonfinite_score=str(solved['score']))
                data['model_solves'].append(record)
                data['work'] = vars(work).copy()
                if nonfinite:
                    data['numeric_failure'] = 'nonfinite_bucket_sum'
                    return _result(data, start, 'UNKNOWN', reason='nonfinite bucket accumulation; no candidate or certificate')
                vector = solved['vector']
                if vector is None:
                    if numeric['supported']:
                        return _result(data, start, 'INFEASIBLE', exact=True)
                    return _result(data, start, 'UNKNOWN', reason='uncertified float regrouping; no infeasibility certificate')
                data['proxy_objective'] = _proxy(spec, vector)
                accepted, reason = _gate(problem, vector, data)
                if accepted == 'ACCEPTED':
                    if numeric['supported']:
                        data['proxy_upper_bound'] = data['proxy_objective']
                        return _result(data, start, 'OPTIMAL', vector, exact=True)
                    return _result(data, start, 'FEASIBLE', vector, reason='uncertified float regrouping; candidate only, no G optimality proof')
                if accepted != 'REJECTED':
                    return _result(data, start, accepted, reason=reason)
                factors.append(legacy._Factor(scope, {tuple(vector): -math.inf}, kind='schedule-exclusion'))
            return _result(data, start, 'UNKNOWN', reason='DP repair candidate-check limit')
        except legacy._ComplexityLimit as error:
            data.update(work=vars(work).copy(), complexity_limit=error.detail)
            return _result(data, start, 'UNKNOWN', reason='DP complexity limit; all declared factors retained')
    except ImportError as error:
        return _result(data, start, 'UNSUPPORTED', reason=str(error))
    except (ValueError, TypeError, KeyError, IndexError, OverflowError) as error:
        return _result(data, start, 'MODEL_INVALID', reason=f'{type(error).__name__}: {error}')
