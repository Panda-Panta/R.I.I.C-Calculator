"""Independent finite references; no native F or product simulator is called."""
from copy import deepcopy
from fractions import Fraction
from itertools import product
import importlib.util
import json
import os
from pathlib import Path
import random
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from strategies.exact_repairs import repair_cp, repair_factor_dp

BACKENDS = (repair_cp, repair_factor_dp)


def score(spec, vector):
    value = sum(Fraction(str(spec['unary'][i][choice])) for i, choice in enumerate(vector))
    for factor in spec.get('factors', []):
        key = ','.join(str(vector[i]) for i in factor['vars'])
        value += Fraction(str(factor['table'].get(key, 0)))
    return value


def feasible(spec, vector):
    if len(vector) != len(spec['domains']) or any(type(v) is not int or not 0 <= v < spec['domains'][i] for i, v in enumerate(vector)):
        return False
    if any(all(vector[i] == v for i, v in zip(item['vars'], item['values'])) for item in spec.get('forbidden', [])):
        return False
    return all(sum(Fraction(str(row[v])) for row, v in zip(item['usage'], vector)) <= Fraction(str(item['capacity'])) for item in spec.get('resources', []))


def oracle(spec, incumbent, released, excluded=(), schedule=lambda vector: True):
    blocked = {tuple(vector) for vector in excluded}
    legal = [vector for vector in product(*(range(n) for n in spec['domains'])) if tuple(vector) not in blocked and
             all(i in released or value == incumbent[i] for i, value in enumerate(vector)) and feasible(spec, vector) and schedule(vector)]
    return max((score(spec, vector) for vector in legal), default=None), legal


class Model:
    def __init__(self, spec, schedule=lambda vector: True):
        self.spec = deepcopy(spec)
        self.domains = [range(n) for n in spec['domains']]
        self.initial = tuple(spec['initial'])
        self.schedule = schedule
        self.checks = []

    @property
    def history(self):
        raise AssertionError('repair must not read F history')

    def feasible(self, vector):
        return feasible(self.spec, vector)

    def schedule_feasible(self, vector):
        self.checks.append(tuple(vector))
        return self.schedule(tuple(vector))

    def evaluate(self, *args, **kwargs):
        raise AssertionError('zero-F repair called evaluate')

    def vectors(self, *args, **kwargs):
        raise AssertionError('repair enumerated complete vectors')

    def cheap(self, *args, **kwargs):
        raise AssertionError('repair must use the declared factor model')


def fixture():
    return {'id': 'independent-high-order', 'domains': [2, 3, 2, 2], 'initial': [0, 1, 0, 0],
            'unary': [[-2, -1], [0, -3, 2], [-1, 1], [0, -2]],
            'factors': [{'vars': [3, 0, 2], 'table': {'1,1,1': 9.25, '0,0,1': 3, '0,1,0': -8}},
                        {'vars': [], 'table': {'': -4}}],
            'forbidden': [{'vars': [0, 1], 'values': [1, 2]}],
            'resources': [{'name': 'people', 'capacity': 4, 'usage': [[0, 2], [0, 1, 1], [0, 1], [0, 1]]}]}


def real_problem(spec):
    old = next(parent / 'scripts/experiments/roster_methods/common.py' for parent in Path(__file__).resolve().parents
               if (parent / 'scripts/experiments/roster_methods/common.py').is_file())
    loader = importlib.util.spec_from_file_location('_test_original_common_boundary', old)
    module = importlib.util.module_from_spec(loader); loader.loader.exec_module(module)
    return module.Problem(spec, budget=0)


class ExactRepairTests(unittest.TestCase):
    def assert_oracle(self, backend, spec, incumbent, released, excluded=(), schedule=lambda vector: True):
        expected, legal = oracle(spec, incumbent, set(released), excluded, schedule)
        model = Model(spec, schedule)
        before = deepcopy((model.spec, incumbent, released, excluded))
        result = backend(model, incumbent, released, excluded=excluded, seed=17)
        self.assertEqual(result['status'], 'INFEASIBLE' if expected is None else 'OPTIMAL', result)
        self.assertTrue(result['exact'], result)
        if expected is None:
            self.assertIsNone(result['vector'])
        else:
            self.assertIn(tuple(result['vector']), legal)
            error = result['diagnostics'].get('optimal_scaled_solution_proxy_regret_bound', 0)
            self.assertLessEqual(float(expected - score(spec, result['vector'])), error + 1e-9)
        self.assertEqual((model.spec, incumbent, released, excluded), before)
        self.assertEqual(result['diagnostics']['f_calls'], 0)
        json.dumps(result, allow_nan=False)
        return result

    def test_fixed_neighborhood_higher_order_negative_and_constant_oracle(self):
        for backend in BACKENDS:
            with self.subTest(backend=backend.__name__):
                self.assert_oracle(backend, fixture(), [0, 1, 0, 0], [0, 2, 3])

    def test_visited_complete_vectors_are_excluded_without_changing_inputs(self):
        spec = fixture()
        for backend in BACKENDS:
            with self.subTest(backend=backend.__name__):
                _, legal = oracle(spec, spec['initial'], {0, 1, 2, 3})
                best = max(legal, key=lambda vector: score(spec, vector))
                self.assert_oracle(backend, spec, spec['initial'][:], [0, 1, 2, 3], [list(best)])

    def test_excluded_fixed_incumbent_proves_only_this_neighborhood_empty(self):
        for backend in BACKENDS:
            with self.subTest(backend=backend.__name__):
                spec = fixture()
                self.assert_oracle(backend, spec, spec['initial'][:], [], [spec['initial'][:]])

    def test_conflicting_fixed_resource_and_forbidden_constraints(self):
        spec = {'id': 'infeasible', 'domains': [2, 2], 'initial': [1, 0], 'unary': [[1, 2], [1, 2]],
                'resources': [{'capacity': 0, 'usage': [[0, 1], [0, 1]]}]}
        for backend in BACKENDS:
            self.assert_oracle(backend, spec, [1, 0], [1])
        spec['resources'] = []
        spec['forbidden'] = [{'vars': [], 'values': []}]
        for backend in BACKENDS:
            self.assert_oracle(backend, spec, [1, 0], [0, 1])

    def test_exact_decimal_resource_scaling_including_negative_usage(self):
        spec = {'id': 'decimal', 'domains': [2, 2, 2], 'initial': [0, 0, 0], 'unary': [[0, 1], [0, 2], [0, -1]],
                'resources': [{'capacity': .375, 'usage': [[0, .125], [0, .25], [0, -.125]]}]}
        for backend in BACKENDS:
            self.assert_oracle(backend, spec, spec['initial'][:], [0, 1, 2])

    def test_sparse_missing_factor_is_zero_and_permuted_scope_is_retained(self):
        spec = {'id': 'sparse', 'domains': [2, 2, 2], 'initial': [0, 0, 0], 'unary': [[-1, 0], [0, -1], [0, -1]],
                'factors': [{'vars': [2, 0, 1], 'table': {'1,1,1': 8, '0,0,0': -10}}]}
        for backend in BACKENDS:
            self.assert_oracle(backend, spec, spec['initial'][:], [0, 1, 2])

    def test_schedule_false_only_excludes_that_complete_assignment(self):
        spec = {'id': 'schedule', 'domains': [2, 2], 'initial': [0, 0], 'unary': [[0, 2], [0, 1]]}
        for backend in BACKENDS:
            result = self.assert_oracle(backend, spec, [0, 0], [0, 1], schedule=lambda vector: vector != (1, 1))
            self.assertEqual(result['diagnostics']['schedule_exclusions'], [[1, 1]])
            self.assertIn(result['vector'], [[1, 0], [0, 1]])

    def test_unknown_schedule_is_not_a_conflict_cut_or_zero_value(self):
        def unknown(vector):
            raise RuntimeError('finite scheduler exhausted')
        for backend in BACKENDS:
            result = backend(Model(fixture(), unknown), [0, 1, 0, 0], [0, 1, 2, 3])
            self.assertEqual(result['status'], 'UNKNOWN', result)
            self.assertFalse(result['exact'])
            self.assertIsNone(result['vector'])
            self.assertEqual(result['diagnostics']['schedule_exclusions'], [])
            json.dumps(result, allow_nan=False)

    def test_actual_cp_sat_evidence_and_integer_rounding_bound(self):
        spec = {'id': 'close', 'domains': [2], 'initial': [0], 'unary': [[-1.00000049, -1.00000040]]}
        result = self.assert_oracle(repair_cp, spec, [0], [0])
        data = result['diagnostics']
        self.assertEqual(data['backend'], 'OR-Tools CP-SAT')
        self.assertTrue(data['solver_version'])
        self.assertGreater(len(data['solves']), 0)
        self.assertEqual(data['objective_scale'], 1_000_000)
        self.assertGreater(data['objective_abs_error_bound'], 0)
        self.assertGreaterEqual(data['proxy_upper_bound'], max(float(score(spec, (i,))) for i in range(2)))
        self.assertIn('conflicts', data['solves'][0])

    def test_actual_factor_elimination_on_a_chain_without_complete_enumeration(self):
        n = 32
        spec = {'id': 'chain', 'domains': [2] * n, 'initial': [0] * n, 'unary': [[0, 0] for _ in range(n)],
                'factors': [{'vars': [i, i + 1], 'table': {'1,1': 1}} for i in range(n - 1)]}
        result = repair_factor_dp(Model(spec), [0] * n, list(range(n)))
        self.assertEqual(result['vector'], [1] * n)
        self.assertEqual(result['status'], 'OPTIMAL')
        self.assertEqual(result['diagnostics']['backend'], 'max-sum factor elimination')
        self.assertEqual(result['diagnostics']['model_solves'][0]['induced_width'], 1)
        self.assertLessEqual(result['diagnostics']['work']['assignments'], 4 * n)
        self.assertEqual(result['diagnostics']['factors_dropped'], 0)

    def test_real_common_cancellation_does_not_receive_a_dp_optimality_certificate(self):
        spec = {'id': 'real-common-G-addition-order', 'domains': [2, 1], 'initial': [0, 0],
                'unary': [[0, 0], [1e16]],
                'factors': [{'vars': [0], 'table': {'0': -1e16, '1': -1e16}},
                            {'vars': [0], 'table': {'1': 1}}]}
        problem = real_problem(spec)
        self.assertEqual(problem.cheap((0, 0)), 0)
        self.assertEqual(problem.cheap((1, 0)), 1)
        result = repair_factor_dp(problem, [0, 0], [0, 1])
        self.assertEqual(result['status'], 'FEASIBLE', result)
        self.assertFalse(result['exact'])
        self.assertFalse(result['diagnostics']['certificate_valid'])
        self.assertFalse(result['diagnostics']['numeric_certificate']['supported'])
        self.assertIsNone(result['diagnostics']['proxy_upper_bound'])
        self.assertTrue(problem.feasible(result['vector']))
        self.assertEqual(result['diagnostics']['proxy_objective'], problem.cheap(result['vector']))
        self.assertEqual(problem.history, [])

    def test_real_common_single_whole_factor_and_safe_integer_chain_remain_certified(self):
        table = {','.join(map(str, vector)): (index - 2) / 10
                 for index, vector in enumerate(product(range(2), repeat=3))}
        spec = {'id': 'v1-whole-G', 'domains': [2, 2, 2], 'initial': [0, 0, 0],
                'unary': [[0, 0]] * 3, 'factors': [{'vars': [0, 1, 2], 'table': table}], 'resources': []}
        problem = real_problem(spec)
        result = repair_factor_dp(problem, spec['initial'], [0, 1, 2])
        self.assertEqual(result['status'], 'OPTIMAL', result)
        self.assertTrue(result['exact'])
        self.assertTrue(result['diagnostics']['numeric_certificate']['supported'])
        self.assertEqual(result['diagnostics']['numeric_certificate']['criterion'], 'at_most_one_nonzero_reward_term')
        self.assertEqual(problem.cheap(result['vector']), max(problem.cheap(v) for v in product(range(2), repeat=3)))
        self.assertEqual(problem.history, [])
        chain = {'id': 'safe-integer-chain', 'domains': [2] * 8, 'initial': [0] * 8,
                 'unary': [[0, 0]] * 8,
                 'factors': [{'vars': [i, i + 1], 'table': {'1,1': 1}} for i in range(7)]}
        result = repair_factor_dp(real_problem(chain), chain['initial'], list(range(8)))
        self.assertEqual(result['status'], 'OPTIMAL', result)
        self.assertTrue(result['exact'])
        self.assertEqual(result['diagnostics']['numeric_certificate']['criterion'], 'safe_exact_dyadic_sum')

    def test_nonfinite_bucket_accumulation_is_unknown_and_strict_json_safe(self):
        spec = {'id': 'finite-input-overflowing-bucket', 'domains': [2, 1], 'initial': [0, 0],
                'unary': [[0, 0], [-1e308]],
                'factors': [{'vars': [0], 'table': {'0': 1e308, '1': 1e308}},
                            {'vars': [0], 'table': {'0': 1e308, '1': 1e308}}]}
        problem = real_problem(spec)
        self.assertEqual(problem.cheap((0, 0)), 1e308)
        result = repair_factor_dp(problem, spec['initial'], [0, 1])
        self.assertEqual(result['status'], 'UNKNOWN', result)
        self.assertFalse(result['exact'])
        self.assertIsNone(result['vector'])
        self.assertIsNone(result['diagnostics']['proxy_upper_bound'])
        self.assertEqual(result['diagnostics']['numeric_failure'], 'nonfinite_bucket_sum')
        json.dumps(result, allow_nan=False)
        self.assertEqual(problem.history, [])

    def test_real_common_decimal_resource_is_unsupported_before_any_certificate(self):
        spec = {'id': 'real-common-decimal-resource', 'domains': [2, 2], 'initial': [0, 0],
                'unary': [[0, 1], [0, 2]],
                'resources': [{'capacity': .3, 'usage': [[0, .1], [0, .2]]}]}
        for backend in BACKENDS:
            problem = real_problem(spec)
            self.assertFalse(problem.feasible((1, 1)))
            self.assertEqual(max(problem.cheap(v) for v in product(range(2), repeat=2) if problem.feasible(v)), 2)
            result = backend(problem, spec['initial'], [0, 1])
            self.assertEqual(result['status'], 'UNSUPPORTED', result)
            self.assertFalse(result['exact'])
            self.assertIsNone(result['vector'])
            self.assertFalse(result['diagnostics']['certificate_valid'])
            self.assertIsNone(result['diagnostics']['proxy_upper_bound'])
            self.assertFalse(result['diagnostics']['resource_compatibility']['supported'])
            self.assertEqual(result['diagnostics']['resource_compatibility']['resources'][0]['criterion'],
                             'decimal_binary_coefficient_mismatch')
            self.assertEqual(problem.history, [])

    def test_real_common_opposite_resource_mismatch_is_never_false_infeasible(self):
        spec = {'id': 'common-resource-rounds-down', 'domains': [1] * 100, 'initial': [0] * 100,
                'unary': [[0]] * 100,
                'resources': [{'capacity': 9.99999999999999, 'usage': [[.1]] * 100}]}
        for backend in BACKENDS:
            problem = real_problem(spec)
            self.assertTrue(problem.feasible(spec['initial']))
            result = backend(problem, spec['initial'], list(range(100)))
            self.assertEqual(result['status'], 'UNSUPPORTED', result)
            self.assertFalse(result['exact'])
            self.assertIsNone(result['vector'])
            self.assertFalse(result['diagnostics']['certificate_valid'])
            self.assertIsNone(result['diagnostics']['proxy_upper_bound'])
            self.assertFalse(result['diagnostics']['resource_compatibility']['supported'])
            self.assertEqual(problem.history, [])

    def test_real_common_exact_dyadic_resource_is_certified(self):
        spec = {'id': 'common-safe-dyadic-resource', 'domains': [2, 2, 2], 'initial': [0, 0, 0],
                'unary': [[0, 1], [0, 2], [0, -1]],
                'resources': [{'capacity': .375, 'usage': [[0, .125], [0, .25], [0, -.125]]}]}
        for backend in BACKENDS:
            problem = real_problem(spec)
            best = max(problem.cheap(v) for v in product(range(2), repeat=3) if problem.feasible(v))
            result = backend(problem, spec['initial'], [0, 1, 2])
            self.assertEqual(result['status'], 'OPTIMAL', result)
            self.assertTrue(result['exact'])
            self.assertTrue(result['diagnostics']['resource_compatibility']['supported'])
            self.assertEqual(problem.cheap(result['vector']), best)
            self.assertEqual(problem.history, [])

    def test_dp_complexity_limit_is_unknown_and_keeps_the_high_order_factor(self):
        n = 24
        spec = {'id': 'wide', 'domains': [2] * n, 'initial': [0] * n, 'unary': [[0, 0] for _ in range(n)],
                'factors': [{'vars': list(range(n)), 'table': {','.join(['1'] * n): 10}}]}
        result = repair_factor_dp(Model(spec), [0] * n, list(range(n)))
        self.assertEqual(result['status'], 'UNKNOWN')
        self.assertFalse(result['exact'])
        self.assertIsNone(result['vector'])
        self.assertEqual(result['diagnostics']['factors_dropped'], 0)

    def test_cp_zero_time_budget_is_unknown_not_infeasible(self):
        result = repair_cp(Model(fixture()), [0, 1, 0, 0], [0, 1, 2, 3], time_limit_s=0)
        self.assertEqual(result['status'], 'UNKNOWN')
        self.assertFalse(result['exact'])

    def test_invalid_neighborhood_and_nonfinite_model_are_explicit(self):
        for backend in BACKENDS:
            for released, excluded in [([4], []), ([True], []), ([], [[0]])]:
                with self.subTest(backend=backend.__name__, released=released, excluded=excluded):
                    result = backend(Model(fixture()), [0, 1, 0, 0], released, excluded=excluded)
                    self.assertEqual(result['status'], 'MODEL_INVALID')
            spec = fixture(); spec['factors'][0]['table']['1,1,1'] = float('nan')
            self.assertEqual(backend(Model(spec), [0, 1, 0, 0], [0, 2])['status'], 'MODEL_INVALID')

    def test_noncanonical_keys_cannot_change_common_lookup_semantics(self):
        spec = {'id': 'key-mismatch', 'domains': [2], 'initial': [0], 'unary': [[0, 0]],
                'factors': [{'vars': [0], 'table': {'01': 10}}]}
        for backend in BACKENDS:
            result = backend(Model(spec), [0], [0])
            self.assertEqual(result['status'], 'MODEL_INVALID', result)
            self.assertIsNone(result['vector'])

    def test_configured_legacy_root_is_authoritative_not_a_silent_fallback(self):
        missing = str(Path(__file__).resolve().parent / 'does-not-exist-original-methods')
        with patch.dict(os.environ, {'RIIC_ROSTER_METHODS_ROOT': missing}):
            for backend in BACKENDS:
                result = backend(Model(fixture()), [0, 1, 0, 0], [0, 2])
                self.assertEqual(result['status'], 'UNSUPPORTED', result)
                self.assertIsNone(result['vector'])

    def test_random_small_domains_against_independent_exhaustive_oracle(self):
        rng = random.Random(193)
        for case in range(18):
            spec = {'id': f'oracle-{case}', 'domains': [2, 2, 2], 'initial': [0, 0, 0],
                    'unary': [[rng.randrange(-5, 5), rng.randrange(-5, 5)] for _ in range(3)],
                    'factors': [{'vars': [0, 1, 2], 'table': {','.join(map(str, v)): rng.randrange(-4, 8) for v in product(range(2), repeat=3)}}],
                    'resources': [{'capacity': 2, 'usage': [[0, 1], [0, 1], [0, 1]]}]}
            excluded = [[1, 0, 1]] if case % 2 else []
            for backend in BACKENDS:
                with self.subTest(case=case, backend=backend.__name__):
                    self.assert_oracle(backend, spec, [0, 0, 0], [0, 1, 2], excluded)

    def test_old_common_problem_zero_query_contract(self):
        old = next(parent / 'scripts/experiments/roster_methods/common.py' for parent in Path(__file__).resolve().parents
                   if (parent / 'scripts/experiments/roster_methods/common.py').is_file())
        loader = importlib.util.spec_from_file_location('_test_original_common', old)
        module = importlib.util.module_from_spec(loader); loader.loader.exec_module(module)
        for backend in BACKENDS:
            problem = module.Problem(fixture(), budget=0)
            result = backend(problem, problem.initial, [0, 2, 3])
            self.assertEqual(result['status'], 'OPTIMAL', result)
            self.assertEqual(problem.history, [])
            self.assertEqual(problem.remaining, 0)


if __name__ == '__main__':
    unittest.main()
