"""Hybrid component, finite-domain counterexample and shared-budget evidence."""
import importlib.util
import json
import unittest

from scripts.experiments.roster_methods.common import Problem
from scripts.experiments.roster_methods.methods.m16_hybrid import _cp_repair, solve


HAS_ORTOOLS = importlib.util.find_spec("ortools") is not None


def reversal_problem(budget=16, unsupported=False):
    scores = {(0, 0): 0, (1, 0): 5, (0, 1): 9, (1, 1): 2}
    spec = {"id": "m16-independent-G-F-reversal", "domains": [2, 2], "initial": [0, 0],
            "unary": [[0, 1], [0, 1]], "factors": [], "forbidden": [], "resources": []}
    def evaluate(vector, *, fidelity, seed):
        return {"valid": not unsupported, "score": None if unsupported else scores[vector],
                "metrics": {}, "shared_cache_hit": True}
    return Problem(spec, evaluate, budget=budget)


@unittest.skipUnless(HAS_ORTOOLS, "Genuine hybrid checks require the isolated OR-Tools runtime")
class HybridTests(unittest.TestCase):
    def test_real_components_share_four_queries_instead_of_three_full_budgets(self):
        problem = reversal_problem(budget=20)
        result = solve(problem, seed=42, budget=4)
        diag = result["diagnostics"]
        self.assertEqual(diag["queries"], 4)
        self.assertEqual(len(problem.history), 4)
        self.assertEqual(sum(diag["stage_queries"].values()), 4)
        self.assertEqual(len(diag["query_ledger"]), 4)
        self.assertEqual(len({tuple(record["vector"]) for record in problem.history}), 4)
        self.assertTrue(diag["actual_composition_verified"])
        self.assertGreater(diag["component_calls"]["ortools.CpSolver.solve"], 0)
        self.assertGreater(diag["component_calls"]["m02.repair"], 0)
        self.assertTrue(all(record["seed"] == 42 and record["fidelity"] == "full" for record in problem.history))
        self.assertTrue(all(record["shared_cache_hit"] for record in problem.history))
        self.assertEqual(problem.remaining, 16)
        json.dumps(result, allow_nan=False)

    def test_G_champion_can_be_exceeded_in_an_explicit_hand_auditable_counterexample(self):
        problem = reversal_problem()
        result = solve(problem, budget=4)
        self.assertEqual(result["G_champion"]["vector"], [1, 1])
        self.assertEqual(result["G_champion"]["G"], 2)
        self.assertEqual(result["G_champion"]["observed_full_F"], 2)
        self.assertEqual(result["best_vector"], [0, 1])
        self.assertEqual(result["best_score"], 9)
        self.assertGreater(result["best_score"], result["G_champion"]["observed_full_F"])
        self.assertTrue(result["diagnostics"]["coverage"]["finite_observation_maximum_proven"])

    def test_local_cp_freezes_other_decisions_and_repairs_schedule_without_F_queries(self):
        class ScheduleProblem(Problem):
            def schedule_feasible(self, vector):
                return self.feasible(vector) and tuple(vector) != (1, 1, 0)
        spec = {"id": "m16-local", "domains": [2, 2, 2], "initial": [1, 0, 0],
                "unary": [[0, 1], [0, 5], [0, 1]],
                "resources": [{"name": "capacity", "capacity": 2, "usage": [[0, 1]] * 3}]}
        problem = ScheduleProblem(spec, budget=4)
        candidate, log = _cp_repair(problem, problem.initial, [1, 2], set(), seed=42)
        self.assertEqual(candidate, (1, 0, 1))
        self.assertEqual(log["fixed"], [0])
        self.assertGreaterEqual(log["solver_calls"], 2)
        self.assertGreaterEqual(log["schedule_rejections"], 1)
        self.assertTrue(all(status in {"OPTIMAL", "FEASIBLE"} for status in log["statuses"]))
        self.assertEqual(problem.history, [])

    def test_public_remaining_bounds_all_hybrid_stages(self):
        problem = reversal_problem(budget=2)
        result = solve(problem, budget=48)
        self.assertEqual(len(problem.history), 2)
        self.assertEqual(result["diagnostics"]["queries"], 2)
        self.assertFalse(result["diagnostics"]["actual_composition_verified"])
        self.assertEqual(result["best_vector"], [1, 1])

    def test_sixteen_is_the_whole_hybrid_budget_in_a_larger_domain(self):
        spec = {"id": "m16-64-vectors", "domains": [2] * 6, "initial": [0] * 6,
                "unary": [[0, 1]] * 6}
        problem = Problem(spec, lambda vector, *, fidelity, seed:
                          {"valid": True, "score": sum((i + 1) * value for i, value in enumerate(vector)),
                           "metrics": {}, "shared_cache_hit": True}, budget=48)
        result = solve(problem, seed=42, budget=16)
        self.assertEqual(len(problem.history), 16)
        self.assertEqual(result["diagnostics"]["queries"], 16)
        self.assertEqual(sum(result["diagnostics"]["stage_queries"].values()), 16)
        self.assertEqual(problem.remaining, 32)
        self.assertTrue(result["diagnostics"]["actual_composition_verified"])
        self.assertFalse(result["diagnostics"]["coverage"]["finite_observation_maximum_proven"])

    def test_seed_replays_charged_candidates_and_decisions(self):
        left_problem, right_problem = reversal_problem(), reversal_problem()
        left, right = solve(left_problem, seed=919, budget=4), solve(right_problem, seed=919, budget=4)
        self.assertEqual(left["best_vector"], right["best_vector"])
        self.assertEqual(left["diagnostics"]["query_ledger"], right["diagnostics"]["query_ledger"])
        for a, b in zip(left["diagnostics"]["operations"], right["diagnostics"]["operations"]):
            self.assertEqual((a["destroy"], a["removed"], a["candidate"], a["accepted"]),
                             (b["destroy"], b["removed"], b["candidate"], b["accepted"]))

    def test_unsupported_full_observations_stay_none(self):
        problem = reversal_problem(unsupported=True)
        result = solve(problem, budget=16)
        self.assertEqual(len(problem.history), 4)
        self.assertIsNone(result["best_vector"])
        self.assertIsNone(result["best_score"])
        self.assertIsNone(result["G_champion"]["observed_full_F"])
        self.assertFalse(result["diagnostics"]["coverage"]["finite_observation_maximum_proven"])
        self.assertTrue(all(row["score"] is None for row in result["diagnostics"]["query_ledger"]))

    def test_zero_budget_has_no_oracle_or_component_calls(self):
        problem = reversal_problem()
        result = solve(problem, budget=0)
        self.assertEqual(problem.history, [])
        self.assertTrue(all(value == 0 for value in result["diagnostics"]["component_calls"].values()))
        self.assertIsNone(result["best_vector"])


if __name__ == "__main__":
    unittest.main()
