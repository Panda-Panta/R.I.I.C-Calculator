"""Finite independent references for the LP/pricing and evaluation boundary."""

import copy
from itertools import product
import json
from pathlib import Path
import sys
import unittest

import numpy as np
from scipy.optimize import linprog


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from methods.m04_colgen import _build_model, _column_generation, _integer_candidates, _integer_enrichment, solve
from common import Problem, make_toy_problem


class FiniteProblem:
    def __init__(self, spec, budget=16, scores=None, schedule=None):
        self.spec = copy.deepcopy(spec)
        self.domains = [range(size) for size in spec["domains"]]
        self.initial = tuple(spec["initial"])
        self.remaining = budget
        self.history = []
        self._scores = scores
        self._schedule = schedule

    def cheap(self, vector):
        score = sum(self.spec["unary"][i][v] for i, v in enumerate(vector))
        return score + sum(f["table"].get(",".join(str(vector[i]) for i in f["vars"]), 0)
                           for f in self.spec.get("factors", []))

    def feasible(self, vector):
        if len(vector) != len(self.domains) or any(v not in d for v, d in zip(vector, self.domains)):
            return False
        if any(all(vector[i] == v for i, v in zip(f["vars"], f["values"]))
               for f in self.spec.get("forbidden", [])):
            return False
        return all(sum(r["usage"][i][v] for i, v in enumerate(vector)) <= r["capacity"]
                   for r in self.spec.get("resources", []))

    def schedule_feasible(self, vector):
        return self._schedule(vector) if self._schedule is not None else True

    def evaluate(self, vector, fidelity="full", seed=None):
        if self.remaining <= 0:
            raise AssertionError("evaluation budget exceeded")
        self.remaining -= 1
        valid = self.feasible(vector) and self.schedule_feasible(vector)
        score = self._scores[tuple(vector)] if self._scores is not None else self.cheap(vector)
        record = {"vector": list(vector), "valid": valid, "score": score if valid else None,
                  "fidelity": fidelity, "seed": seed, "metrics": {}, "elapsed_ms": 0.0}
        self.history.append(record)
        return record


def independent_all_option_lp(spec):
    """All variable choices are explicit, independent of m04's pattern builder."""
    assert not spec.get("factors") and not spec.get("forbidden")
    choices = [(i, v) for i, size in enumerate(spec["domains"]) for v in range(size)]
    equality = [[float(i == j) for j, _ in choices] for i in range(len(spec["domains"]))]
    usage = [[r["usage"][i][v] for i, v in choices] for r in spec.get("resources", [])]
    result = linprog([-spec["unary"][i][v] for i, v in choices], A_eq=equality,
                     b_eq=np.ones(len(equality)), A_ub=usage if usage else None,
                     b_ub=[r["capacity"] for r in spec["resources"]] if usage else None,
                     bounds=(0, None), method="highs")
    return result


def integer_oracle(problem):
    legal = [v for v in product(*problem.domains) if problem.feasible(v) and problem.schedule_feasible(v)]
    return max((problem.cheap(v), v) for v in legal) if legal else None


def triangle_spec():
    return {"id": "fractional-triangle", "domains": [2, 2, 2], "initial": [0, 0, 0],
            "unary": [[0, 1], [0, 1], [0, 1]], "factors": [], "forbidden": [],
            "resources": [
                {"name": "staff-ab", "capacity": 1, "usage": [[0, 1], [0, 1], [0, 0]]},
                {"name": "staff-bc", "capacity": 1, "usage": [[0, 0], [0, 1], [0, 1]]},
                {"name": "staff-ac", "capacity": 1, "usage": [[0, 1], [0, 0], [0, 1]]}]}


class ColumnGenerationTests(unittest.TestCase):
    def test_fractional_lp_matches_full_column_lp_and_integer_enumeration(self):
        problem = FiniteProblem(triangle_spec())
        result = solve(problem, budget=8)
        d = result["diagnostics"]
        full_lp = independent_all_option_lp(problem.spec)
        self.assertTrue(full_lp.success)
        self.assertAlmostEqual(d["lp_objective"], -full_lp.fun)
        self.assertAlmostEqual(d["lp_objective"], 1.5)
        self.assertEqual(d["fractional_columns"], 6)
        self.assertAlmostEqual(d["best_observed_score"], integer_oracle(problem)[0])
        self.assertEqual(d["best_observed_score"], 1)
        self.assertGreater(sum(len(i["added_columns"]) for i in d["iterations"]), 0)
        terminal = [i for i in d["iterations"] if i["phase"] == "phase_ii"][-1]
        self.assertTrue(terminal["pricing_complete"])
        self.assertEqual(terminal["patterns_scanned"], 6)
        self.assertGreaterEqual(min(terminal["minimum_reduced_cost_by_block"]), -1e-8)
        np.testing.assert_allclose(terminal["resource_scarcity_prices"], [0.5, 0.5, 0.5])
        self.assertFalse(d["branch_and_price"])

    def test_phase_i_repairs_missing_column_false_infeasibility(self):
        spec = {"domains": [2, 2], "initial": [1, 1], "unary": [[0, 4], [0, 3]],
                "resources": [{"name": "one-person", "capacity": 1, "usage": [[0, 1], [0, 1]]}]}
        # The initial restricted master really is infeasible without Phase I.
        restricted = linprog([-4, -3], A_eq=np.eye(2), b_eq=[1, 1],
                             A_ub=[[1, 1]], b_ub=[1], bounds=(0, None), method="highs")
        self.assertEqual(restricted.status, 2)
        result = solve(FiniteProblem(spec), budget=4)
        d = result["diagnostics"]
        phase_i = [i for i in d["iterations"] if i["phase"] == "phase_i"]
        self.assertEqual(phase_i[0]["lp_min_objective"], 1)
        self.assertGreater(len(phase_i[0]["added_columns"]), 0)
        self.assertEqual(phase_i[-1]["lp_min_objective"], 0)
        self.assertEqual(d["status"], "full_model_lp_optimal")
        self.assertAlmostEqual(d["lp_objective"], -independent_all_option_lp(spec).fun)
        self.assertEqual(result["best_vector"], [1, 0])

    def test_positive_phase_i_with_complete_pricing_proves_model_infeasible(self):
        spec = {"domains": [2], "initial": [0], "unary": [[0, 1]],
                "resources": [{"name": "missing-person", "capacity": 0, "usage": [[1, 1]]}]}
        problem = FiniteProblem(spec)
        result = solve(problem)
        self.assertEqual(result["diagnostics"]["status"], "full_model_infeasible")
        self.assertEqual(result["diagnostics"]["phase_i_objective"], 1)
        self.assertTrue(result["diagnostics"]["full_pricing_complete"])
        self.assertIsNone(result["best_vector"])
        self.assertEqual(problem.history, [])
        self.assertEqual(independent_all_option_lp(spec).status, 2)

    def test_factor_and_forbidden_hyperedges_are_absorbed_in_exact_patterns(self):
        spec = {"domains": [2, 2, 2], "initial": [0, 0, 0], "unary": [[0, 1], [0, 1], [0, 1]],
                "factors": [{"vars": [0, 1], "table": {"1,0": 6}}],
                "forbidden": [{"vars": [1, 2], "values": [1, 1]}], "resources": []}
        problem = FiniteProblem(spec)
        result = solve(problem, budget=16)
        self.assertEqual(result["diagnostics"]["blocks"], [[0, 1, 2]])
        self.assertEqual(result["diagnostics"]["total_local_patterns"], 6)
        oracle_reward, oracle_vector = integer_oracle(problem)
        # A single block has an integral complete-column LP.
        self.assertEqual(result["diagnostics"]["lp_objective"], oracle_reward)
        self.assertEqual(tuple(result["best_vector"]), oracle_vector)

    def test_only_queried_true_scores_count_and_budget_is_honored(self):
        spec = {"domains": [3], "initial": [0], "unary": [[0, 10, 9]], "resources": []}
        scores = {(0,): 5, (1,): 1, (2,): 100}
        problem = FiniteProblem(spec, scores=scores)
        result = solve(problem, seed=7, budget=2)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["diagnostics"]["evaluations_used"], 2)
        self.assertEqual({tuple(r["vector"]) for r in problem.history}, {(0,), (1,)})
        self.assertTrue(all(r["seed"] == 7 and r["fidelity"] == "full" for r in problem.history))
        self.assertIn("no global optimum", result["proof_scope"]["expensive_objective"])
        one = FiniteProblem(spec, budget=1, scores=scores)
        one_result = solve(one, budget=16)
        self.assertEqual(one_result["best_vector"], [0])
        self.assertEqual(len(one.history), 1)

    def test_budget_one_evaluates_legal_initial_before_proxy_champion(self):
        spec = {"id": "incumbent-first", "domains": [2], "initial": [0],
                "unary": [[0, 1]], "resources": []}
        problem = Problem(spec, lambda vector, **_: {"valid": True, "score": 100 if vector == (0,) else 0}, budget=1)
        result = solve(problem, budget=1)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(problem.history[0]["vector"], [0])
        self.assertEqual(problem.history[0]["score"], 100)
        self.assertEqual(result["diagnostics"]["evaluations_used"], 1)

    def test_diversity_columns_allow_a_lower_proxy_better_f_candidate(self):
        spec = {"domains": [3], "initial": [0], "unary": [[0, 10, 9]], "resources": []}
        problem = FiniteProblem(spec, scores={(0,): 5, (1,): 1, (2,): 100})
        result = solve(problem, budget=3)
        self.assertEqual(result["best_vector"], [2])
        self.assertEqual(len(problem.history), 3)
        self.assertEqual(problem.history[0]["vector"], [0])
        additions = result["diagnostics"]["diversity_enrichment"]["added_columns"]
        self.assertTrue(any(c["values"] == [2] and c["lp_reduced_cost"] > 0 for c in additions))

    def test_single_block_integer_enrichment_does_not_claim_joint_exchange_optimality(self):
        spec = {"domains": [3] * 4, "initial": [0] * 4,
                "unary": [[0, 14, 8], [0, 12, 7], [0, 12, 6], [0, 7, 14]],
                "resources": [
                    {"name": "a", "capacity": 7,
                     "usage": [[0, 4, 3], [0, 4, 1], [0, 4, 5], [0, 3, 3]]},
                    {"name": "b", "capacity": 8,
                     "usage": [[0, 3, 2], [0, 2, 3], [0, 5, 3], [0, 6, 1]]}]}
        problem = FiniteProblem(spec)
        model = _build_model(problem)
        generated = _column_generation(model)
        columns, rounds = _integer_enrichment(model, generated["columns"], generated["iterations"][-1])
        _, runs = _integer_candidates(model, columns, 1)
        self.assertEqual(runs[0]["objective"], 28)
        self.assertEqual(integer_oracle(problem), (29, (2, 2, 0, 2)))
        self.assertEqual(rounds[-1]["status"], "single_block_neighborhood_exhausted")
        self.assertIn("neighborhood", rounds[-1]["scope"])

    def test_integer_neighborhood_enrichment_closes_known_restricted_master_gap(self):
        spec = {"domains": [3] * 4, "initial": [0] * 4,
                "unary": [[0, 12, 2], [0, 11, 13], [0, 10, 1], [0, 2, 9]],
                "resources": [
                    {"name": "staff-a", "capacity": 6,
                     "usage": [[0, 2, 2], [0, 6, 4], [0, 4, 6], [0, 3, 4]]},
                    {"name": "staff-b", "capacity": 6,
                     "usage": [[0, 6, 3], [0, 1, 1], [0, 5, 3], [0, 1, 4]]}]}
        problem = FiniteProblem(spec)
        result = solve(problem)
        d = result["diagnostics"]
        self.assertAlmostEqual(d["lp_objective"], 23.125)
        self.assertAlmostEqual(d["lp_objective"], -independent_all_option_lp(spec).fun)
        self.assertEqual(d["integer_enrichment"][0]["restricted_objective"], 13)
        self.assertEqual(d["best_observed_score"], 15)
        additions = [c for round_ in d["integer_enrichment"] for c in round_["added_columns"]]
        self.assertTrue(any(c["block"] == 0 and c["values"] == [2] for c in additions))
        self.assertTrue(any(c["lp_reduced_cost"] > 0 for c in additions))
        self.assertEqual(integer_oracle(problem), (15, (2, 2, 0, 0)))
        self.assertIn("no full integer optimality", result["proof_scope"]["integer"])
        self.assertTrue(d["full_pricing_complete"])

    def test_schedule_is_a_candidate_guard_and_never_a_false_lp_claim(self):
        spec = {"domains": [2], "initial": [0], "unary": [[0, 2]], "resources": []}
        problem = FiniteProblem(spec, schedule=lambda v: v[0] == 0)
        result = solve(problem, budget=4)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["diagnostics"]["rejected_before_evaluation"], [[1]])
        self.assertEqual(len(problem.history), 1)
        self.assertIn("not encoded", result["proof_scope"]["schedule"])

    def test_zero_budget_still_prices_lp_but_never_queries(self):
        problem = FiniteProblem(triangle_spec())
        result = solve(problem, budget=0)
        self.assertIsNone(result["best_vector"])
        self.assertEqual(result["diagnostics"]["status"], "full_model_lp_optimal")
        self.assertEqual(problem.history, [])

    def test_common_contract_smoke_json_and_actual_query_budget(self):
        problem = make_toy_problem(budget=16)
        result = solve(problem, seed=42, budget=16)
        json.dumps(result, allow_nan=False)
        self.assertLessEqual(len(problem.history), 16)
        self.assertEqual(result["diagnostics"]["evaluations_used"], len(problem.history))
        self.assertEqual(result["best_vector"], problem.best()["vector"])
        self.assertTrue(problem.feasible(result["best_vector"]))
        self.assertTrue(problem.schedule_feasible(result["best_vector"]))
        self.assertTrue(all(r["valid"] and r["fidelity"] == "full" for r in problem.history))

    def test_unknown_schedule_does_not_become_infeasibility_or_a_query(self):
        def unknown(_):
            raise RuntimeError("finite scheduler budget exhausted")
        problem = FiniteProblem({"domains": [2], "initial": [0], "unary": [[0, 1]], "resources": []},
                                schedule=unknown)
        result = solve(problem)
        self.assertIsNone(result["best_vector"])
        self.assertEqual(result["diagnostics"]["status"], "full_model_lp_optimal")
        self.assertEqual(len(result["diagnostics"]["schedule_guard_unknown"]), 2)
        self.assertEqual(result["diagnostics"]["rejected_before_evaluation"], [])
        self.assertEqual(problem.history, [])

    def test_pattern_cap_is_explicit_unsupported_not_a_zero_score(self):
        spec = {"domains": [256, 256], "initial": [0, 0], "unary": [[0] * 256] * 2,
                "factors": [{"vars": [0, 1], "table": {}}], "resources": []}
        problem = FiniteProblem(spec)
        result = solve(problem)
        self.assertEqual(result["diagnostics"]["status"], "unsupported_model")
        self.assertIn("65536", result["diagnostics"]["reason"])
        self.assertEqual(result["best_vector"], [0, 0])
        self.assertEqual(len(problem.history), 1)
        self.assertEqual(result["diagnostics"]["evaluation_stages"], ["initial"])


if __name__ == "__main__":
    unittest.main()
