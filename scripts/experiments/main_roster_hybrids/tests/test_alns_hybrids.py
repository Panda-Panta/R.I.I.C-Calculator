"""Independent full-oracle kernels; no native RIIC F is launched here."""
import importlib.util
import itertools
import json
import sys
import unittest
from unittest.mock import patch

from scripts.experiments.main_roster_hybrids.strategies import alns_hybrids as hybrid


def problem(spec=None, *, budget=16, unknown=False):
    common = hybrid._legacy("common")
    if spec is None:
        spec = {"id": "independent-main-rest-fiam-policy-ties", "domains": [2, 2, 2], "initial": [0, 0, 0],
                "unary": [[0, 10], [0, 0], [0, 0]],
                "factors": [{"vars": [0, 1, 2], "table": {
                    ",".join(map(str, vector)): 0 for vector in itertools.product(range(2), repeat=3)}}],
                "forbidden": [], "resources": [], "metadata": {}}
    def oracle(vector, *, fidelity, seed):
        if unknown:
            return {"valid": False, "score": None, "reason": "explicit-unknown-independent-oracle"}
        score = 1000000 if fidelity == "short" else 10 * vector[0] + 2 * sum(vector[1:]) + 8 * all(vector[1:])
        return {"valid": True, "score": float(score), "metrics": {}, "shared_cache_hit": True}
    return common.Problem(spec, oracle, budget=budget)


class LedgerTests(unittest.TestCase):
    def test_absolute_file_loading_without_package_finds_sibling_exact_repair(self):
        spec = importlib.util.spec_from_file_location("_independent_alns_absolute_load", hybrid.__file__)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        self.assertEqual(module.__package__, "")
        source = problem(budget=2)
        result = module.solve_factor_dp(source, seed=42, budget=2)
        self.assertEqual(len(source.history), 2)
        self.assertGreater(result["diagnostics"]["component_calls"]["exact_repair"], 0)
        self.assertNotIn("unsupported", result["diagnostics"]["status"])

    def test_duplicate_and_cached_initial_calls_each_consume_one_logical_query(self):
        source = problem(budget=8)
        ledger = hybrid._QueryLedger(source, budget=2, seed=42)
        ledger.evaluate(source.initial, stage="initial")
        ledger.evaluate(source.initial, stage="duplicate")
        self.assertEqual(ledger.calls, 2)
        self.assertEqual(len(source.history), 2)
        self.assertEqual(source.remaining, 6)
        self.assertTrue(all(record["shared_cache_hit"] for record in source.history))
        with self.assertRaises(RuntimeError):
            ledger.evaluate(source.initial, stage="over-budget")
        self.assertEqual(len(source.history), 2)

    def test_short_score_never_becomes_the_full_winner_and_still_costs_budget(self):
        source = problem(budget=2)
        ledger = hybrid._QueryLedger(source, budget=10, seed=42)
        ledger.evaluate((1, 1, 1), stage="short", fidelity="short")
        self.assertIsNone(ledger.best_vector)
        ledger.evaluate(source.initial, stage="full", fidelity="full")
        self.assertEqual(ledger.calls, 2)
        self.assertEqual(ledger.best_vector, source.initial)
        self.assertEqual(ledger.best_score, 0)
        self.assertEqual(source.remaining, 0)


class HybridKernelChecks:
    solver = None
    exact_name = None

    def test_budget_two_uses_actual_related_destroy_and_exact_repair_in_one_problem(self):
        source = problem(budget=16)
        from scripts.experiments.main_roster_hybrids.strategies import exact_repairs
        repair = getattr(exact_repairs, self.exact_name)
        with patch.object(exact_repairs, self.exact_name, wraps=repair) as called:
            result = self.solver(source, seed=42, budget=2)
        self.assertEqual(len(source.history), 2)
        self.assertEqual(result["diagnostics"]["queries"], 2)
        self.assertGreater(called.call_count, 0)
        self.assertTrue(all(call.args[0] is source for call in called.call_args_list))
        self.assertGreater(result["diagnostics"]["component_calls"]["related_destroy"], 0)
        self.assertGreater(result["diagnostics"]["component_calls"]["exact_repair"], 0)
        self.assertEqual(result["best_score"], max(row["score"] for row in source.history if row["valid"]))
        json.dumps(result, allow_nan=False)

    def test_full_high_order_factor_is_kept_and_queried_under_budget_two(self):
        table = {",".join(map(str, vector)): -4 for vector in itertools.product(range(2), repeat=4)}
        table["0,0,0,0"], table["1,1,1,1"] = 5, 40
        spec = {"id": "independent-four-way-factor", "domains": [2] * 4, "initial": [0] * 4,
                "unary": [[0, 0]] * 4, "factors": [{"vars": [0, 1, 2, 3], "table": table}],
                "metadata": {}}
        common = hybrid._legacy("common")
        source = common.Problem(spec, lambda vector, **kwargs: {"valid": True, "score": float(table[",".join(map(str, vector))])}, budget=2)
        result = self.solver(source, seed=42, budget=2)
        self.assertEqual(result["best_vector"], [1] * 4)
        self.assertEqual(result["best_score"], 40)
        self.assertTrue(any(operation["released"] == [0, 1, 2, 3] for operation in result["diagnostics"]["operations"]))

    def test_equal_G_policy_variants_get_real_F_queries_and_feedback_by_budget_four(self):
        source = problem(budget=4)
        result = self.solver(source, seed=42, budget=4)
        self.assertEqual(len(source.history), 4)
        policy_rows = [row for row in source.history if row["vector"][0] == 1]
        self.assertGreaterEqual(len(policy_rows), 2)
        self.assertEqual(len({source.cheap(row["vector"]) for row in policy_rows}), 1)
        self.assertGreaterEqual(len({tuple(row["vector"][1:]) for row in policy_rows}), 2)
        self.assertTrue(any(row["vector"] == [1, 1, 1] for row in policy_rows))
        self.assertGreaterEqual(len({row["score"] for row in policy_rows}), 2)
        diagnostics = result["diagnostics"]
        self.assertTrue(any(operation["reward"] > 0 for operation in diagnostics["operations"]))
        self.assertTrue(any(update["before"] != update["after"] for update in diagnostics["weight_updates"]))
        self.assertGreater(diagnostics["component_calls"]["metropolis"], 0)
        self.assertGreater(diagnostics["component_calls"]["ce_sample"], 0)
        self.assertGreater(len(diagnostics["ce_updates"]), 0)
        self.assertTrue(any(operation["tie_pool_size"] > 1 for operation in diagnostics["operations"]))

    def test_unknown_oracle_labels_stay_none_and_never_reward_a_zero(self):
        source = problem(budget=4, unknown=True)
        result = self.solver(source, seed=42, budget=4)
        self.assertEqual(len(source.history), 4)
        self.assertIsNone(result["best_vector"])
        self.assertIsNone(result["best_score"])
        self.assertTrue(all(row["full_score"] is None for row in result["diagnostics"]["query_ledger"]))
        self.assertTrue(all(operation["reward"] == 0 for operation in result["diagnostics"]["operations"]))
        self.assertEqual(result["diagnostics"]["ce_updates"], [])

    def test_unavailable_exact_component_is_explicit_and_not_a_G_sorter_fallback(self):
        source = problem(budget=4)
        from scripts.experiments.main_roster_hybrids.strategies import exact_repairs
        unavailable = {"vector": None, "status": "UNSUPPORTED", "exact": False, "diagnostics": {"reason": "independent missing-backend check"}}
        with patch.object(exact_repairs, self.exact_name, return_value=unavailable):
            result = self.solver(source, seed=42, budget=4)
        self.assertEqual(len(source.history), 1)
        self.assertIn("unsupported_exact_repair", result["diagnostics"]["status"])
        self.assertEqual(result["best_vector"], [0, 0, 0])
        self.assertEqual(result["diagnostics"]["component_calls"]["exact_repair"], 1)

    def test_public_remaining_and_zero_budget_are_global_bounds(self):
        source = problem(budget=2)
        result = self.solver(source, seed=42, budget=20)
        self.assertEqual(len(source.history), 2)
        self.assertEqual(result["diagnostics"]["queries"], 2)
        zero = problem(budget=4)
        result = self.solver(zero, seed=42, budget=0)
        self.assertEqual(zero.history, [])
        self.assertIsNone(result["best_vector"])

    def test_seed_replays_vectors_rewards_and_accepted_moves(self):
        first, second = problem(budget=4), problem(budget=4)
        left, right = self.solver(first, seed=919, budget=4), self.solver(second, seed=919, budget=4)
        self.assertEqual([row["vector"] for row in first.history], [row["vector"] for row in second.history])
        self.assertEqual(left["best_vector"], right["best_vector"])
        project = lambda result: [(row["destroy"], row["released"], row["candidate"], row["reward"], row["accepted"])
                                  for row in result["diagnostics"]["operations"]]
        self.assertEqual(project(left), project(right))


class FactorDPTests(HybridKernelChecks, unittest.TestCase):
    solver = staticmethod(hybrid.solve_factor_dp)
    exact_name = "repair_factor_dp"


@unittest.skipUnless(importlib.util.find_spec("ortools"), "Real CP-SAT requires the existing isolated OR-Tools runtime")
class CPSATTests(HybridKernelChecks, unittest.TestCase):
    solver = staticmethod(hybrid.solve_cp)
    exact_name = "repair_cp"


if __name__ == "__main__":
    unittest.main()
