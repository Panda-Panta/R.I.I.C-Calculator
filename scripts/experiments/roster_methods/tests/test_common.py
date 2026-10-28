import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import Problem, make_toy_problem


class CommonContractTests(unittest.TestCase):
    def test_budget_counts_invalid_and_repeated_queries(self):
        p = Problem({'id': 'budget', 'domains': [2], 'initial': [0],
                     'unary': [[1, 2]], 'forbidden': [{'vars': [0], 'values': [1]}]},
                    lambda x, fidelity, seed: {'valid': True, 'score': 7}, budget=3)
        self.assertFalse(p.evaluate([1])['valid'])
        p.evaluate([0])
        p.evaluate([0])
        self.assertEqual(p.remaining, 0)
        self.assertEqual(len(p.history), 3)
        self.assertEqual(p.best()['score'], 7)

    def test_sparse_factor_default_zero_and_resource_capacity(self):
        p = Problem({'id': 'f', 'domains': [2, 2], 'initial': [0, 0],
                     'unary': [[1, 2], [3, 4]],
                     'factors': [{'vars': [0, 1], 'table': {'1,0': 5}}],
                     'resources': [{'name': 'bed', 'capacity': 1, 'usage': [[0, 1], [0, 1]]}]},
                    lambda x, fidelity, seed: {'valid': True, 'score': 0})
        self.assertEqual(p.cheap([1, 0]), 10)
        self.assertEqual(p.cheap([0, 1]), 5)
        self.assertFalse(p.feasible([1, 1]))
        self.assertEqual(len(list(p.vectors())), 3)

    def test_finite_scheduler_checks_peak_not_just_total_load(self):
        spec = {'id': 'schedule', 'domains': [2], 'initial': [0], 'unary': [[0, 0]],
                'scheduling': {'horizon': 4, 'beds': 1, 'jobs': [
                    {'id': 'a', 'var': 0, 'values': [0], 'duration': 2, 'release': 0, 'deadline': 2},
                    {'id': 'b', 'var': 0, 'values': [0], 'duration': 2, 'release': 0, 'deadline': 2}]}}
        p = Problem(spec, lambda x, fidelity, seed: {'valid': True, 'score': 0})
        self.assertFalse(p.schedule_feasible([0]))
        self.assertTrue(p.schedule_feasible([1]))

    def test_short_and_invalid_oracle_values_never_win(self):
        p = Problem({'id': 'best', 'domains': [2], 'initial': [0], 'unary': [[1, 2]]},
                    lambda x, fidelity, seed: {'valid': True, 'score': 100 if fidelity == 'short' else float('nan')}, budget=3)
        p.evaluate([0], 'short')
        self.assertFalse(p.evaluate([0])['valid'])
        self.assertIsNone(p.best())

    def test_zero_duration_job_does_not_consume_a_bed(self):
        spec = {'id': 'zero', 'domains': [1], 'initial': [0], 'unary': [[0]],
                'scheduling': {'horizon': 1, 'beds': 0, 'jobs': [
                    {'id': 'empty', 'duration': 0, 'demand': 3}]}}
        p = Problem(spec, lambda x, fidelity, seed: {'valid': True, 'score': 1})
        self.assertTrue(p.schedule_feasible([0]))

    def test_toy_is_reproducible_and_declares_its_evidence_type(self):
        a, b = make_toy_problem(), make_toy_problem()
        self.assertEqual(a.evaluate(a.initial)['score'], b.evaluate(b.initial)['score'])
        self.assertEqual(a.metadata['evidence_type'], 'synthetic-kernel-only')

    def test_nonfinite_metric_remains_missing_with_a_reason(self):
        p = Problem({'id': 'metric', 'domains': [1], 'initial': [0], 'unary': [[0]]},
                    lambda x, fidelity, seed: {'valid': True, 'score': 1, 'metrics': {'exp': float('nan')}})
        record = p.evaluate([0])
        self.assertTrue(record['valid'])
        self.assertIsNone(record['metrics']['exp'])
        self.assertIn('nonfinite:$.metrics.exp', record['evidence_warnings'])


if __name__ == '__main__':
    unittest.main()
