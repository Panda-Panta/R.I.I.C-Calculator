import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from run_suite import unused_validation_seeds, algorithm_state, load_method, ALL_METHODS, HERE
from common import Problem


class RunnerEvidenceTests(unittest.TestCase):
    def test_heldout_seed_excludes_search_and_observed_seeds(self):
        history = [{'seed': 1198905590}, {'seed': 20260920}]
        seeds = unused_validation_seeds(history, 20261028)
        self.assertEqual(len(seeds), 3)
        self.assertFalse(set(seeds) & {20261028, 1198905590, 20260920})

    def test_unsupported_mechanism_is_not_hidden_by_a_valid_fallback(self):
        self.assertEqual(algorithm_state({'best_vector': [0], 'diagnostics': {'status': 'unsupported_objectives'}}),
                         'unsupported_objectives')

    def test_all_methods_preserve_a_better_initial_at_one_query_budget(self):
        # G recommends the wrong leaf. The comparison protocol charges and
        # protects the known initial before any proposed replacement.
        # Isolated branches contain one method; the integration branch contains
        # all 15 and the explicit auxiliary hybrid. Test exactly present modules.
        available = [identifier for identifier, name in ALL_METHODS.items()
                     if (HERE / 'methods' / f'{name}.py').exists()]
        for identifier in available:
            with self.subTest(method=identifier):
                problem = Problem({'id': 'shared-incumbent', 'domains': [2], 'initial': [0],
                                   'unary': [[0, 1]]},
                                  lambda vector, fidelity, seed: {
                                      'valid': True, 'score': 100 if vector[0] == 0 else 0,
                                      'metrics': {'exp': 1, 'gold': 1, 'order_lmd': 1, 'change_cost': vector[0]}},
                                  budget=1)
                result = load_method(identifier).solve(problem, seed=42, budget=1)
                self.assertEqual(result['best_vector'], [0])
                self.assertEqual(len(problem.history), 1)
                self.assertEqual(problem.history[0]['vector'], [0])


if __name__ == '__main__':
    unittest.main()
