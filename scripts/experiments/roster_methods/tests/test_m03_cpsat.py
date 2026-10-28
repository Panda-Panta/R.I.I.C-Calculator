"""Independent finite-domain checks; these tests are not native RIIC evidence."""

import copy
import importlib.util
import itertools
import math
import pathlib
import unittest
from fractions import Fraction


MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "methods" / "m03_cpsat.py"
MODULE_SPEC = importlib.util.spec_from_file_location("m03_cpsat", MODULE_PATH)
m03 = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(m03)
HAS_ORTOOLS = importlib.util.find_spec("ortools") is not None


def feasible(spec, vector):
    if len(vector) != len(spec["domains"]) or any(not 0 <= v < spec["domains"][i] for i, v in enumerate(vector)):
        return False
    for row in spec.get("forbidden", []):
        if all(vector[i] == v for i, v in zip(row["vars"], row["values"])):
            return False
    for row in spec.get("resources", []):
        if sum(Fraction(str(row["usage"][i][v])) for i, v in enumerate(vector)) > Fraction(str(row["capacity"])):
            return False
    return True


def proxy(spec, vector):
    value = sum(spec["unary"][i][v] for i, v in enumerate(vector))
    for row in spec.get("factors", []):
        value += row["table"].get(",".join(str(vector[i]) for i in row["vars"]), 0)
    return value


def oracle(spec):
    return [(vector, proxy(spec, vector)) for vector in itertools.product(*(range(d) for d in spec["domains"])) if feasible(spec, vector)]


class FakeProblem:
    def __init__(self, spec, budget=16, score=None):
        self.spec = copy.deepcopy(spec)
        self.initial = tuple(spec["initial"])
        self.domains = [range(d) for d in spec["domains"]]
        self.scene_id = spec.get("id", "m03-independent-finite-oracle")
        self.history = []
        self.limit = budget
        self.score = score or (lambda vector: proxy(self.spec, vector))

    @property
    def remaining(self):
        return self.limit - len(self.history)

    def vectors(self, **_):
        raise AssertionError("CP-SAT must not call the exhaustive model oracle")

    def feasible(self, vector):
        return feasible(self.spec, vector)

    def cheap(self, vector):
        return proxy(self.spec, vector)

    def evaluate(self, vector, fidelity="full", seed=None):
        assert self.remaining > 0
        valid = feasible(self.spec, vector)
        item = {"vector": list(vector), "valid": valid, "score": self.score(vector) if valid else None, "fidelity": fidelity, "seed": seed}
        self.history.append(item)
        return item

    def best(self):
        rows = [row for row in self.history if row["valid"] and row["fidelity"] == "full"]
        return max(rows, key=lambda row: row["score"]) if rows else None


@unittest.skipUnless(HAS_ORTOOLS, "real OR-Tools CP-SAT is required")
class CpSatTests(unittest.TestCase):
    def test_real_solver_matches_independent_oracle_for_tables_bans_resources(self):
        spec = {
            "domains": [3, 2, 2], "initial": [0, 0, 0],
            "unary": [[-3, 4, 4.5], [-2, 3], [0, 1]],
            "factors": [{"vars": [0, 1], "table": {"1,1": -10, "2,0": 2.5}}, {"vars": [1, 2], "table": {"0,1": 4}}],
            "forbidden": [{"vars": [0, 2], "values": [2, 1]}],
            "resources": [{"name": "beds", "capacity": 3, "usage": [[0, 1, 2], [0, 1], [1, 0]]}],
        }
        rows = oracle(spec)
        result = m03.solve(FakeProblem(spec), budget=16)
        self.assertEqual(result["algorithm"], "OR-Tools CP-SAT")
        self.assertTrue(result["solver_version"])
        self.assertEqual(result["model_status"], "OPTIMAL")
        self.assertTrue(result["model_optimality_proven"])
        self.assertEqual(result["model_proxy_objective"], max(value for _, value in rows))
        self.assertTrue(all(feasible(spec, row["vector"]) for row in result["model_solutions"]))
        self.assertGreater(len(result["model_solutions"]), 1)
        self.assertEqual(result["resource_scaling"][0]["scale"], 1)
        self.assertGreaterEqual(result["model_proxy_upper_bound"], max(value for _, value in rows))

    def test_negative_values_do_not_create_a_zero_score_solution(self):
        spec = {"domains": [2, 2], "initial": [0, 0], "unary": [[-9, -2], [-8, -3]], "factors": [{"vars": [0, 1], "table": {"1,1": -20}}], "forbidden": [], "resources": []}
        result = m03.solve(FakeProblem(spec), budget=4)
        self.assertEqual(result["model_proxy_objective"], -10)
        self.assertLess(result["model_scaled_objective"], 0)
        self.assertEqual(result["model_scaled_objective"], result["model_scaled_best_bound"])

    def test_near_ties_have_an_explicit_original_proxy_error_bound(self):
        spec = {"domains": [2, 2], "initial": [0, 0], "unary": [[1.0000001, 1.0000004], [-0.0000004, -0.0000001]], "factors": [{"vars": [0, 1], "table": {"0,0": 0.0000004, "1,1": 0.00000049}}], "forbidden": [], "resources": []}
        optimum = max(value for _, value in oracle(spec))
        result = m03.solve(FakeProblem(spec), budget=4)
        self.assertGreater(result["objective_abs_error_bound"], 0)
        self.assertLessEqual(optimum - result["model_proxy_objective"], result["optimal_scaled_solution_proxy_regret_bound"] + 1e-15)
        self.assertGreaterEqual(result["model_proxy_upper_bound"] + 1e-15, optimum)

    def test_proven_infeasibility_has_no_evaluation_or_invented_zero(self):
        spec = {"domains": [2], "initial": [0], "unary": [[10, 20]], "factors": [], "forbidden": [{"vars": [0], "values": [0]}, {"vars": [0], "values": [1]}], "resources": []}
        problem = FakeProblem(spec)
        result = m03.solve(problem, budget=4)
        self.assertEqual(result["model_status"], "INFEASIBLE")
        self.assertIsNone(result["best_vector"])
        self.assertIsNone(result["model_best_vector"])
        self.assertEqual(problem.history, [])
        self.assertNotIn("best_score", result)

    def test_decimal_resources_are_exact_without_weakening_capacity(self):
        spec = {"domains": [2, 2], "initial": [0, 0], "unary": [[0, 5], [0, 4]], "factors": [], "forbidden": [], "resources": [{"name": "fractional", "capacity": .3, "usage": [[0, .1], [0, .2]]}]}
        result = m03.solve(FakeProblem(spec), budget=4)
        self.assertEqual(result["model_best_vector"], [1, 1])
        self.assertEqual(result["resource_scaling"][0]["scale"], 10)

    def test_returned_best_is_queried_f_not_the_model_champion(self):
        spec = {"domains": [3], "initial": [0], "unary": [[1, 20, 10]], "factors": [], "forbidden": [], "resources": []}
        problem = FakeProblem(spec, budget=3, score=lambda vector: [100, 1, 50][vector[0]])
        result = m03.solve(problem, budget=3)
        self.assertEqual(result["model_best_vector"], [1])
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["best_score"], 100)
        self.assertEqual(result["evaluations"], 3)
        self.assertEqual(len(problem.history), 3)
        self.assertEqual(len({tuple(row["vector"]) for row in problem.history}), 3)
        self.assertIn("never native F", result["proof_scope"])

    def test_zero_query_budget_does_not_call_f_or_exhaustive_oracle(self):
        spec = {"domains": [2], "initial": [0], "unary": [[1, 2]], "factors": [], "forbidden": [], "resources": []}
        problem = FakeProblem(spec, budget=0)
        result = m03.solve(problem, budget=0)
        self.assertEqual(problem.history, [])
        self.assertIsNone(result["best_vector"])
        self.assertFalse(result["model_optimality_proven"])

    def test_invalid_coefficients_are_explicit_and_not_zero_filled(self):
        spec = {"domains": [2], "initial": [0], "unary": [[0, math.inf]], "factors": [], "forbidden": [], "resources": []}
        result = m03.solve(FakeProblem(spec), budget=2)
        self.assertTrue(any("invalid_model_input" in message for message in result["diagnostics"]))
        self.assertIsNone(result["best_vector"])

    def test_tied_tiers_use_real_satisfaction_pool_and_cover_the_domain(self):
        spec = {"domains": [2] * 4, "initial": [0] * 4,
                "unary": [[0, 1], [0, 1], [0, 0], [0, 0]],
                "factors": [], "forbidden": [], "resources": []}
        problem = FakeProblem(spec, budget=32)
        result = m03.solve(problem, budget=32)
        expected = oracle(spec)
        self.assertGreater(result["tie_enumeration_solves"], 0)
        self.assertLess(result["total_solver_calls"], len(expected) + 1)
        self.assertEqual(len(result["model_solutions"]), len(expected))
        self.assertEqual({tuple(row["vector"]) for row in problem.history}, {v for v, _ in expected})
        self.assertEqual(len(problem.history), len(expected))
        self.assertEqual(result["query_curve"][0]["vector"], spec["initial"])
        self.assertEqual(result["terminal_model_status"], "INFEASIBLE")
        self.assertTrue(result["finite_F_certificate"]["best_fixed_seed_F_over_declared_domain_proven"])
        self.assertEqual(result["finite_F_certificate"]["structural_model_size"], 16)

    def test_unique_G_tiers_do_not_add_unnecessary_tie_solver_calls(self):
        spec = {"domains": [2, 2], "initial": [0, 0], "unary": [[0, 1], [0, 4]],
                "factors": [], "forbidden": [], "resources": []}
        result = m03.solve(FakeProblem(spec, budget=8), budget=8)
        self.assertEqual(result["tie_enumeration_solves"], 0)
        self.assertEqual(result["optimization_solves"], 5)
        self.assertTrue(result["finite_F_certificate"]["best_fixed_seed_F_over_declared_domain_proven"])

    def test_partial_query_budget_never_proves_F_optimality(self):
        spec = {"domains": [2, 2], "initial": [0, 0], "unary": [[0, 1], [0, 4]],
                "factors": [], "forbidden": [], "resources": []}
        result = m03.solve(FakeProblem(spec, budget=2), budget=2)
        self.assertTrue(result["model_optimality_proven"])
        self.assertFalse(result["finite_F_certificate"]["model_enumeration_complete"])
        self.assertFalse(result["finite_F_certificate"]["best_fixed_seed_F_over_declared_domain_proven"])
        self.assertEqual(result["evaluations"], 2)

    def test_complete_model_enumeration_with_invalid_F_is_not_an_F_certificate(self):
        class IncompleteProblem(FakeProblem):
            def evaluate(self, vector, fidelity="full", seed=None):
                row = super().evaluate(vector, fidelity=fidelity, seed=seed)
                if tuple(vector) == (1, 1):
                    row.update(valid=False, score=None)
                return row

        spec = {"domains": [2, 2], "initial": [0, 0], "unary": [[0, 1], [0, 4]],
                "factors": [], "forbidden": [], "resources": []}
        result = m03.solve(IncompleteProblem(spec, budget=8), budget=8)
        self.assertTrue(result["finite_F_certificate"]["model_enumeration_complete"])
        self.assertTrue(result["finite_F_certificate"]["all_model_vectors_full_evaluated"])
        self.assertFalse(result["finite_F_certificate"]["best_fixed_seed_F_over_declared_domain_proven"])
        self.assertIsNone(next(row for row in result["query_curve"] if row["vector"] == [1, 1])["F"])


if __name__ == "__main__":
    unittest.main()
