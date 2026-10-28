"""Independent finite references; these tests do not establish RIIC skill truth."""

from itertools import product
import json
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from methods.m06_factor_dp import solve
from common import Problem as PublicProblem, make_toy_problem


class Problem:
    """The reference deliberately does not reuse DP compilation or elimination."""

    def __init__(self, spec, budget=16, oracle=None, schedule=None):
        self.spec = spec
        self.domains = [range(size) for size in spec["domains"]]
        self.initial = tuple(spec.get("initial", [0] * len(self.domains)))
        self.remaining = budget
        self.history = []
        self.oracle = oracle or self.cheap
        self.schedule = schedule or (lambda vector: True)

    def feasible(self, vector):
        if len(vector) != len(self.domains) or any(v not in d for v, d in zip(vector, self.domains)):
            return False
        for forbidden in self.spec.get("forbidden", []):
            if [vector[i] for i in forbidden["vars"]] == forbidden["values"]:
                return False
        for resource in self.spec.get("resources", []):
            if sum(row[v] for row, v in zip(resource["usage"], vector)) > resource["capacity"]:
                return False
        return True

    def cheap(self, vector):
        total = sum(row[v] for row, v in zip(self.spec.get("unary", []), vector))
        for factor in self.spec.get("factors", []):
            key = ",".join(str(vector[i]) for i in factor["vars"])
            total += factor["table"].get(key, 0.0)
        return total

    def schedule_feasible(self, vector):
        return self.schedule(vector)

    def evaluate(self, vector, fidelity="full", seed=None):
        if self.remaining <= 0:
            raise AssertionError("oracle budget exceeded")
        self.remaining -= 1
        valid = self.feasible(vector) and self.schedule_feasible(vector)
        result = {"vector": list(vector), "valid": valid, "score": self.oracle(vector) if valid else None, "fidelity": fidelity, "seed": seed}
        self.history.append(result)
        return result

    def vectors(self, *args, **kwargs):
        raise AssertionError("DP must not enumerate the public vector space")


def exhaustive(problem):
    return sorted(
        ((problem.cheap(vector), tuple(vector)) for vector in product(*problem.domains) if problem.feasible(vector)),
        reverse=True,
    )


class FactorDPTests(unittest.TestCase):
    def test_budget_one_preserves_legal_initial_with_better_full_score(self):
        spec = {"id": "baseline-first", "domains": [2], "initial": [0], "unary": [[0, 1]]}

        def oracle(vector, **kwargs):
            return {"valid": True, "score": 100 if vector[0] == 0 else 0}

        problem = PublicProblem(spec, evaluator=oracle, budget=1)
        result = solve(problem, budget=1)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["best_score"], 100)
        self.assertEqual(result["model_best_vector"], [1])
        self.assertEqual(len(problem.history), 1)
        self.assertEqual(problem.history[0]["vector"], [0])

    def test_public_problem_smoke_budget_json_and_full_best(self):
        problem = make_toy_problem(budget=16)
        result = solve(problem, seed=42, budget=16)
        json.dumps(result, allow_nan=False)
        self.assertEqual(len(problem.history), 16)
        self.assertEqual(result["diagnostics"]["queries"], 16)
        self.assertEqual(result["best_vector"], problem.best()["vector"])
        self.assertTrue(problem.feasible(result["best_vector"]))
        self.assertTrue(problem.schedule_feasible(result["best_vector"]))
        self.assertTrue(all(record["fidelity"] == "full" for record in problem.history))
        self.assertEqual(result["model_best_score"], exhaustive(Problem(problem.spec))[0][0])

    def test_96_vector_six_way_factor_and_multi_budget_search_keep_all_interactions(self):
        sizes = [3, 2, 2, 2, 2, 2]
        target = (2, 0, 1, 0, 1, 0)
        spec = {"domains": sizes, "initial": [0] * 6,
                "unary": [[0, 1, 2], *([[0, 1]] * 5)],
                "factors": [{"vars": list(range(6)), "table": {"1,1,1,1,1,1": 9, "2,1,1,0,1,0": -7}}]}

        def oracle(vector):
            return 200 if tuple(vector) == target else -sum(vector)

        best_scores = []
        previous_queries = []
        for budget in (1, 2, 8, 16, 32, 64, 96):
            problem = Problem(spec, budget=budget, oracle=oracle)
            result = solve(problem, seed=42, budget=budget)
            with self.subTest(budget=budget):
                self.assertEqual(len(problem.history), budget)
                self.assertEqual(problem.history[0]["vector"], spec["initial"])
                self.assertEqual(result["diagnostics"]["root_dp"]["induced_width"], 5)
                self.assertEqual(result["diagnostics"]["root_dp"]["max_table_entries"], 32)
                self.assertEqual(result["diagnostics"]["factor_counts"]["reward"], 1)
                self.assertEqual(result["diagnostics"]["factors_dropped"], 0)
                self.assertEqual(result["model_best_score"], exhaustive(problem)[0][0])
                queries = [record["vector"] for record in problem.history]
                self.assertEqual(queries[:len(previous_queries)], previous_queries)
                self.assertEqual(len({tuple(vector) for vector in queries}), budget)
                previous_queries = queries
                best_scores.append(result["best_score"])
        self.assertEqual(best_scores, sorted(best_scores))
        self.assertEqual(best_scores[-1], max(oracle(vector) for vector in product(*(range(size) for size in sizes))))

    def test_seeded_mixed_small_domains_match_independent_exhaustive_top_scores(self):
        rng = random.Random(628)
        for case in range(30):
            sizes = [rng.randint(1, 3) for _ in range(5)]
            spec = {"domains": sizes, "unary": [[rng.randint(-5, 3) for _ in range(size)] for size in sizes], "factors": [], "forbidden": [], "resources": []}
            for _ in range(3):
                scope = rng.sample(range(5), rng.randint(2, 4))
                table = {",".join(map(str, values)): rng.randint(-7, 9) for values in product(*(range(sizes[i]) for i in scope)) if rng.random() < 0.4}
                spec["factors"].append({"vars": scope, "table": table})
            scope = rng.sample(range(5), 2)
            spec["forbidden"].append({"vars": scope, "values": [rng.randrange(sizes[i]) for i in scope]})
            spec["resources"].append({"name": "capacity", "capacity": rng.randint(2, 6), "usage": [[rng.randint(-1, 2) for _ in range(size)] for size in sizes]})
            problem = Problem(spec, budget=7)
            expected = exhaustive(problem)
            if expected:
                problem.initial = expected[0][1]
            with self.subTest(case=case):
                result = solve(problem, budget=7)
                if not expected:
                    self.assertIsNone(result["model_best_vector"])
                    self.assertEqual(problem.history, [])
                else:
                    self.assertEqual(result["model_best_score"], expected[0][0])
                    self.assertEqual([record["score"] for record in problem.history], [score for score, _ in expected[:7]])

    def test_nonzero_cross_factors_negative_values_resources_forbidden_and_off(self):
        spec = {
            "domains": [3, 3, 2, 2],
            "initial": [0, 0, 0, 0],
            "unary": [[-3, -2, -5], [-2, -4, -1], [-2, -1], [-1, -3]],
            "factors": [
                {"vars": [1, 0], "table": {"1,1": 9, "2,2": 7, "0,1": -5}},
                {"vars": [1, 2], "table": {"1,1": 4, "2,0": -8}},
                {"vars": [3, 2, 0], "table": {"0,1,1": 3, "1,0,2": -4}},
            ],
            "forbidden": [{"vars": [2, 0], "values": [1, 2]}, {"vars": [0, 1, 3], "values": [1, 1, 1]}],
            "resources": [{"name": "beds", "capacity": 3, "usage": [[0, 1, 2], [0, 1, 2], [0, 1], [0, 1]]}],
        }
        problem = Problem(spec, budget=1)
        expected = exhaustive(problem)
        result = solve(problem, budget=1)
        self.assertAlmostEqual(result["model_best_score"], expected[0][0])
        self.assertAlmostEqual(problem.cheap(result["model_best_vector"]), expected[0][0])
        self.assertTrue(problem.feasible(result["best_vector"]))
        self.assertIn(0, result["model_best_vector"], "off/zero remains an ordinary legal choice")
        self.assertEqual(result["diagnostics"]["factor_counts"], {"unary": 4, "reward": 3, "forbidden": 2, "resource": 1})
        self.assertEqual(result["diagnostics"]["factors_dropped"], 0)

    def test_sparse_chain_operation_count_is_not_full_assignment_enumeration(self):
        n = 40
        spec = {"domains": [2] * n, "unary": [[-2, -1] for _ in range(n)], "factors": [{"vars": [i, i + 1], "table": {"1,1": 3, "0,1": -2}} for i in range(n - 1)]}
        result = solve(Problem(spec, budget=1), budget=1)
        diag = result["diagnostics"]
        self.assertEqual(result["model_best_vector"], [1] * n)
        self.assertEqual(result["model_best_score"], -n + 3 * (n - 1))
        self.assertEqual(diag["root_dp"]["induced_width"], 1)
        self.assertEqual(diag["max_table_entries"], 2)
        self.assertEqual(diag["join_assignment_evaluations"], 4 * (n - 1) + 2)
        self.assertEqual(len(diag["root_dp"]["trace"]), n)

    def test_nonuniform_clique_eliminates_larger_domain_to_reduce_message_rows(self):
        spec = {"domains": [2, 2, 3, 2, 2, 2], "unary": [[0, 0], [0, 0], [0, 0, 0], [0, 0], [0, 0], [0, 0]],
                "factors": [{"vars": list(range(6)), "table": {"1,1,2,1,1,1": 11, "0,1,0,0,0,0": -8}}]}
        problem = Problem(spec, budget=0)
        result = solve(problem, budget=0)
        root = result["diagnostics"]["root_dp"]
        self.assertEqual(root["elimination_order"][0], 2)
        self.assertEqual(root["induced_width"], 5)
        self.assertEqual(root["max_table_entries"], 32)
        self.assertEqual(sum(step["joint_assignments"] for step in root["trace"]), 158)
        self.assertEqual(result["model_best_score"], exhaustive(problem)[0][0])
        self.assertEqual(result["diagnostics"]["factors_dropped"], 0)

    def test_lawler_top_scores_match_independent_exhaustive_reference(self):
        spec = {"domains": [2] * 4, "unary": [[0, 1], [0, 2], [0, 4], [0, 8]], "initial": [1] * 4, "factors": [{"vars": [0, 2], "table": {"1,1": 0.25, "0,0": -0.125}}]}
        problem = Problem(spec, budget=7)
        expected = exhaustive(problem)
        result = solve(problem, budget=7)
        self.assertEqual([r["score"] for r in problem.history], [score for score, _ in expected[:7]])
        self.assertEqual(len({tuple(r["vector"]) for r in problem.history}), 7)
        self.assertGreater(result["diagnostics"]["dp_solves"], 1)

    def test_negative_optimum_is_not_replaced_by_a_zero_sentinel(self):
        spec = {"domains": [2, 2], "unary": [[-5, -2], [-7, -1]], "factors": [{"vars": [0, 1], "table": {"1,1": -3, "0,1": 1}}]}
        problem = Problem(spec, budget=1)
        result = solve(problem, budget=1)
        self.assertEqual(result["model_best_score"], exhaustive(problem)[0][0])
        self.assertLess(result["best_score"], 0)

    def test_resource_constant_and_negative_usage_are_exact(self):
        spec = {"domains": [2, 2, 2], "unary": [[0, 2], [0, 4], [0, 8]], "resources": [{"name": "signed", "capacity": 1, "usage": [[1, 1], [-1, 2], [0, 3]]}]}
        problem = Problem(spec, budget=1)
        result = solve(problem, budget=1)
        self.assertEqual(result["model_best_score"], exhaustive(problem)[0][0])
        self.assertTrue(problem.feasible(result["model_best_vector"]))

    def test_constant_factor_unsorted_scope_and_fixed_domains(self):
        spec = {"domains": [1, 2, 2], "unary": [[-1], [1, 2], [-1, 0]], "factors": [{"vars": [], "table": {"": -9}}, {"vars": [2, 0, 1], "table": {"0,0,1": 8, "1,0,0": -7}}]}
        problem = Problem(spec, budget=1)
        result = solve(problem, budget=1)
        self.assertEqual(result["model_best_score"], exhaustive(problem)[0][0])
        self.assertEqual(result["diagnostics"]["root_dp"]["conditioned_variables"], [0])

    def test_infeasibility_does_not_become_zero_reward(self):
        spec = {"domains": [2], "unary": [[4, 9]], "resources": [{"name": "impossible", "capacity": -1, "usage": [[0, 0]]}]}
        problem = Problem(spec)
        result = solve(problem)
        self.assertIsNone(result["model_best_vector"])
        self.assertIsNone(result["model_best_score"])
        self.assertIsNone(result["best_vector"])
        self.assertEqual(result["diagnostics"]["status"], "model_infeasible")
        self.assertEqual(problem.history, [])

    def test_dense_global_constraint_stops_without_dropping_factor(self):
        n = 20
        spec = {"domains": [2] * n, "unary": [[0, 1]] * n, "forbidden": [{"vars": list(range(n)), "values": [1] * n}]}
        problem = Problem(spec, budget=2)
        result = solve(problem, budget=2)
        diag = result["diagnostics"]
        self.assertEqual(diag["status"], "complexity_limit")
        self.assertEqual(diag["limit_hit"]["reason"], "message_table_limit")
        self.assertFalse(diag["model_optimum_proved"])
        self.assertEqual(diag["factors_dropped"], 0)
        self.assertEqual(result["best_vector"], [0] * n)
        self.assertEqual(len(problem.history), 1)

    def test_scheduling_is_filtered_and_not_claimed_as_a_dp_factor(self):
        spec = {"domains": [2, 2], "initial": [0, 0], "unary": [[0, 10], [0, 1]]}
        problem = Problem(spec, budget=2, schedule=lambda vector: vector[0] == 0)
        result = solve(problem, budget=2)
        self.assertEqual(result["model_best_vector"], [1, 1])
        self.assertEqual(result["best_vector"], [0, 1])
        self.assertGreater(result["diagnostics"]["schedule_rejections"], 0)
        self.assertIn("Scheduling is checked on proposals", result["proof_scope"])
        self.assertTrue(all(problem.schedule_feasible(r["vector"]) for r in problem.history))

    def test_schedule_unknown_preserves_verified_result_without_infeasibility_claim(self):
        def schedule(vector):
            if vector[0] == 2:
                raise RuntimeError("finite checker exhausted; UNKNOWN")
            return True

        spec = {"domains": [3], "initial": [0], "unary": [[0, 1, 2]]}
        problem = Problem(spec, budget=3, schedule=schedule)
        result = solve(problem, budget=3)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(len(problem.history), 1)
        self.assertEqual(result["diagnostics"]["status"], "schedule_check_incomplete")
        self.assertEqual(result["diagnostics"]["schedule_rejections"], 0)
        self.assertTrue(result["diagnostics"]["model_optimum_proved"])

    def test_invalid_initial_does_not_consume_oracle_budget(self):
        spec = {"domains": [2], "initial": [-1], "unary": [[0, 1]]}
        problem = Problem(spec, budget=1)
        result = solve(problem, budget=1)
        self.assertEqual(result["best_vector"], [1])
        self.assertEqual(len(problem.history), 1)
        self.assertEqual(result["diagnostics"]["structural_rejections"], 1)

    def test_initial_matching_dp_optimum_is_queried_once(self):
        spec = {"domains": [2], "initial": [1], "unary": [[0, 1]]}
        problem = Problem(spec, budget=2)
        result = solve(problem, budget=2)
        self.assertEqual([record["vector"] for record in problem.history], [[1], [0]])
        self.assertEqual(result["diagnostics"]["queries"], 2)

    def test_full_oracle_selects_verified_candidate_when_G_ranking_reverses(self):
        spec = {"domains": [3], "initial": [2], "unary": [[1, 2, 3]]}
        problem = Problem(spec, budget=2, oracle=lambda vector: -10 * vector[0])
        result = solve(problem, budget=2)
        self.assertEqual(result["model_best_vector"], [2])
        self.assertEqual(result["best_vector"], [1])
        self.assertEqual(result["best_score"], -10)
        self.assertTrue(any(r["vector"] == result["best_vector"] and r["valid"] for r in problem.history))

    def test_zero_and_remaining_budget_bound_queries(self):
        spec = {"domains": [3, 3], "unary": [[0, 1, 2], [0, 4, 8]]}
        zero = Problem(spec)
        result = solve(zero, budget=0)
        self.assertEqual(result["model_best_vector"], [2, 2])
        self.assertIsNone(result["best_vector"])
        self.assertEqual(zero.history, [])
        limited = Problem(spec, budget=3)
        result = solve(limited, budget=16, seed=123)
        self.assertEqual(len(limited.history), 3)
        self.assertEqual(result["diagnostics"]["queries"], 3)
        self.assertTrue(all(r["seed"] == 123 for r in limited.history))


if __name__ == "__main__":
    unittest.main()
