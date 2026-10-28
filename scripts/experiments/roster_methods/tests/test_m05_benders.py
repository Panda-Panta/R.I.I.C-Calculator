"""Independent finite-model checks for method 05; no game-runtime claim."""

from __future__ import annotations

import itertools
import json
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from methods import m05_benders
from common import Problem, make_toy_problem


class TinyProblem:
    """A visible G and an F callable, kept independent of the shared runner."""

    def __init__(self, spec, *, budget=16, oracle=None):
        self.spec = spec
        self.domains = [range(size) for size in spec["domains"]]
        self.initial = tuple(spec.get("initial", [0] * len(self.domains)))
        self.metadata = spec.get("metadata", {})
        self.scene_id = "m05-independent-tiny"
        self.remaining = budget
        self.history = []
        self.oracle = oracle or (lambda vector: sum(vector))

    def feasible(self, vector):
        if len(vector) != len(self.domains):
            return False
        if any(value not in domain for value, domain in zip(vector, self.domains)):
            return False
        for item in self.spec.get("forbidden", []):
            if all(vector[i] == value for i, value in zip(item["vars"], item["values"])):
                return False
        for resource in self.spec.get("resources", []):
            if sum(resource["usage"][i][value] for i, value in enumerate(vector)) > resource["capacity"]:
                return False
        return True

    def cheap(self, vector):
        score = sum(self.spec["unary"][i][value] for i, value in enumerate(vector))
        for factor in self.spec.get("factors", []):
            key = ",".join(str(vector[i]) for i in factor["vars"])
            score += factor["table"].get(key, 0)
        return score

    def evaluate(self, vector, fidelity="full", seed=None):
        if self.remaining <= 0:
            raise AssertionError("F budget exceeded")
        self.remaining -= 1
        value = self.oracle(tuple(vector))
        result = {
            "vector": list(vector), "valid": value is not None, "score": value,
            "fidelity": fidelity, "seed": seed, "metrics": {}, "elapsed_ms": 0,
        }
        self.history.append(result)
        return result


def independent_schedule(spec, vector):
    """Flat Cartesian reference, without DFS, pruning, or method helpers."""
    scheduling = spec.get("scheduling")
    if scheduling is None:
        return True
    active = [
        job for job in scheduling["jobs"]
        if job.get("var") is None or "values" not in job or vector[job["var"]] in job["values"]
    ]
    horizon = scheduling["horizon"]
    domains = [
        range(job.get("release", 0), job.get("deadline", horizon) - job["duration"] + 1)
        for job in active
    ]
    for starts in itertools.product(*domains):
        loads = [
            sum(job.get("demand", 1) for job, start in zip(active, starts)
                if start <= time < start + job["duration"])
            for time in range(horizon)
        ]
        if all(load <= scheduling["beds"] for load in loads):
            return True
    return False


def recovery_spec():
    jobs = []
    for var in range(2):
        jobs += [
            {"id": f"long-{var}", "var": var, "values": [2], "duration": 3, "deadline": 3},
            {"id": f"short-{var}", "var": var, "values": [1], "duration": 2},
        ]
    return {
        "domains": [3, 3], "initial": [0, 0],
        "unary": [[0, 5, 9], [0, 6, 10]],
        "scheduling": {"horizon": 4, "beds": 1, "jobs": jobs},
    }


class BendersTests(unittest.TestCase):
    def test_repeated_master_subproblem_and_every_cut_preserves_feasible_vectors(self):
        spec = recovery_spec()
        scores = {(0, 0): 0, (1, 1): 7, (0, 2): 11, (2, 0): 5}
        problem = TinyProblem(spec, budget=4, oracle=lambda vector: scores.get(vector, -3))
        result = m05_benders.solve(problem, seed=17, budget=4)
        diagnostics = result["diagnostics"]
        self.assertEqual(result["best_vector"], [0, 2])
        self.assertEqual(diagnostics["queries"], 4)
        self.assertEqual(len(problem.history), 4)
        self.assertEqual(problem.history[0]["vector"], [0, 0])
        self.assertEqual([row["G"] for row in diagnostics["iterations"]], [19, 15, 15, 11, 10, 9])
        self.assertEqual(len(diagnostics["cuts"]), 3)
        vectors = list(itertools.product(*problem.domains))
        for cut in diagnostics["cuts"]:
            self.assertEqual(cut["certificate"]["status"], "INFEASIBLE")
            self.assertTrue(cut["certificate"]["search_exhausted"])
            rejected = [vector for vector in vectors
                        if all(vector[item["var"]] == item["value"] for item in cut["literals"])]
            self.assertEqual(len(rejected), 1)
            self.assertTrue(all(not independent_schedule(spec, vector) for vector in rejected))
            for vector in vectors:
                if independent_schedule(spec, vector):
                    self.assertTrue(any(vector[item["var"]] != item["value"] for item in cut["literals"]))
        feasible_scores = [problem.cheap(vector) for vector in vectors if independent_schedule(spec, vector)]
        self.assertEqual(result["model_objective"]["best_feasible_value"], max(feasible_scores))
        self.assertTrue(result["proof_scope"]["finite_G_optimality"])
        self.assertFalse(result["proof_scope"]["F_global_optimality"])

    def test_subproblem_matches_independent_cartesian_reference(self):
        rng = random.Random(82)
        for case in range(24):
            horizon = rng.randint(2, 4)
            jobs = [
                {"id": f"job-{i}", "var": i, "values": [1],
                 "duration": rng.randint(1, 3), "release": rng.randrange(horizon),
                 "deadline": horizon, "demand": rng.randint(1, 2)}
                for i in range(3)
            ]
            spec = {"domains": [2, 2, 2], "unary": [[0, 1]] * 3,
                    "scheduling": {"horizon": horizon, "beds": rng.randint(0, 2), "jobs": jobs}}
            problem = TinyProblem(spec)
            for vector in itertools.product(*problem.domains):
                answer = m05_benders.schedule_subproblem(problem, vector)
                self.assertEqual(answer["status"] == "FEASIBLE", independent_schedule(spec, vector), (case, vector))
                self.assertNotEqual(answer["status"], "UNKNOWN")
                if answer["status"] == "INFEASIBLE":
                    self.assertTrue(answer["search_exhausted"])
                else:
                    self.check_witness(spec, vector, answer["witness"])

    def check_witness(self, spec, vector, witness):
        scheduling = spec["scheduling"]
        active = {job["id"]: job for job in scheduling["jobs"] if vector[job["var"]] in job.get("values", [0, 1])}
        self.assertEqual(set(active), {row["job"] for row in witness})
        self.assertEqual(len(active), len(witness))
        for row in witness:
            job = active[row["job"]]
            self.assertGreaterEqual(row["start"], job.get("release", 0))
            self.assertEqual(row["end"], row["start"] + job["duration"])
            self.assertLessEqual(row["end"], job.get("deadline", scheduling["horizon"]))
            self.assertEqual(row["demand"], job.get("demand", 1))
        for time in range(scheduling["horizon"]):
            self.assertLessEqual(sum(row["demand"] for row in witness if row["start"] <= time < row["end"]), scheduling["beds"])

    def test_zero_durations_and_multiple_beds_have_valid_witnesses(self):
        spec = {"domains": [1], "unary": [[0]], "scheduling": {
            "horizon": 2, "beds": 2,
            "jobs": [{"id": "a", "var": 0, "duration": 2},
                     {"id": "b", "var": 0, "duration": 2},
                     {"id": "empty", "var": 0, "duration": 0, "demand": 10}],
        }}
        answer = m05_benders.schedule_subproblem(TinyProblem(spec), (0,))
        self.assertEqual(answer["status"], "FEASIBLE")
        self.check_witness(spec, (0,), answer["witness"])

    def test_low_F_and_failed_oracle_are_never_cuts(self):
        spec = {"domains": [3], "initial": [0], "unary": [[0, 3, 5]]}
        problem = TinyProblem(spec, oracle=lambda vector: None if vector == (2,) else -100)
        result = m05_benders.solve(problem, budget=3)
        self.assertEqual(result["diagnostics"]["cuts"], [])
        self.assertEqual(result["diagnostics"]["queries"], 3)
        self.assertEqual(len(result["diagnostics"]["enumeration_exclusions"]), 3)
        self.assertEqual(result["best_vector"], [0])

    def test_evaluation_exception_is_counted_without_a_cut(self):
        spec = {"domains": [2], "initial": [0], "unary": [[0, 1]]}
        problem = TinyProblem(spec)
        calls = []

        def failing(vector, fidelity="full", seed=None):
            calls.append(tuple(vector))
            raise RuntimeError("unfinished simulation")

        problem.evaluate = failing
        result = m05_benders.solve(problem, budget=2)
        self.assertEqual(result["diagnostics"]["queries"], 2)
        self.assertEqual(len(calls), 2)
        self.assertEqual(result["diagnostics"]["cuts"], [])
        self.assertIsNone(result["best_vector"])

    def test_node_limit_is_unknown_not_infeasible(self):
        spec = recovery_spec()
        spec["initial"] = [2, 2]
        spec["metadata"] = {"m05": {"subproblem_node_limit": 0}}
        answer = m05_benders.schedule_subproblem(TinyProblem(spec), (2, 2), node_limit=0)
        self.assertEqual(answer["status"], "UNKNOWN")
        self.assertFalse(answer["search_exhausted"])
        result = m05_benders.solve(TinyProblem(spec), budget=3)
        self.assertEqual(result["diagnostics"]["cuts"], [])
        self.assertFalse(result["proof_scope"]["finite_G_optimality"])
        self.assertFalse(result["proof_scope"]["finite_model_infeasible"])

    def test_unsupported_constraint_is_unknown_and_never_ignored(self):
        spec = recovery_spec()
        spec["scheduling"]["precedence"] = [["long-0", "long-1"]]
        result = m05_benders.solve(TinyProblem(spec), budget=2)
        self.assertEqual(result["diagnostics"]["queries"], 0)
        self.assertEqual(result["diagnostics"]["cuts"], [])
        self.assertTrue(result["diagnostics"]["deferred"])
        self.assertFalse(result["proof_scope"]["finite_model_infeasible"])

    def test_master_uses_factors_and_structural_constraints(self):
        spec = {"domains": [2, 2], "initial": [0, 0], "unary": [[0, 1], [0, 1]],
                "factors": [{"vars": [0, 1], "table": {"1,1": 50}}],
                "forbidden": [{"vars": [0, 1], "values": [1, 0]}]}
        result = m05_benders.solve(TinyProblem(spec), budget=2)
        self.assertEqual(result["diagnostics"]["iterations"][0]["vector"], [1, 1])
        self.assertEqual(result["model_objective"]["best_feasible_value"], 52)
        self.assertTrue(result["proof_scope"]["finite_G_optimality"])

    def test_master_limit_has_no_false_G_optimality(self):
        spec = {"domains": [3], "initial": [0], "unary": [[0, 1, 99]],
                "metadata": {"m05": {"master_vector_limit": 2}}}
        result = m05_benders.solve(TinyProblem(spec), budget=3)
        self.assertFalse(result["diagnostics"]["master"]["complete"])
        self.assertFalse(result["proof_scope"]["finite_G_optimality"])

    def test_zero_budget_and_external_remaining_are_respected(self):
        spec = {"domains": [2], "initial": [0], "unary": [[0, 1]]}
        no_budget = TinyProblem(spec)
        result = m05_benders.solve(no_budget, budget=0)
        self.assertEqual(no_budget.history, [])
        self.assertEqual(result["diagnostics"]["queries"], 0)
        one_query = TinyProblem(spec, budget=1)
        result = m05_benders.solve(one_query, budget=16)
        self.assertEqual(result["diagnostics"]["queries"], 1)
        self.assertEqual(one_query.remaining, 0)

    def test_complete_cut_exhaustion_proves_only_the_finite_model_infeasible(self):
        spec = {"domains": [2], "initial": [0], "unary": [[0, 1]], "scheduling": {
            "horizon": 1, "beds": 0, "jobs": [{"id": "rest", "var": 0, "duration": 1}],
        }}
        result = m05_benders.solve(TinyProblem(spec), budget=4)
        self.assertEqual(len(result["diagnostics"]["cuts"]), 1)
        self.assertEqual(result["diagnostics"]["queries"], 0)
        self.assertTrue(result["proof_scope"]["finite_model_infeasible"])
        self.assertFalse(result["proof_scope"]["F_global_optimality"])

    def test_public_toy_smoke_has_counted_full_queries_and_json_output(self):
        problem = make_toy_problem(budget=16)
        result = m05_benders.solve(problem, seed=42, budget=16)
        self.assertEqual(result["diagnostics"]["queries"], len(problem.history))
        self.assertLessEqual(len(problem.history), 16)
        self.assertEqual(problem.history[0]["vector"], list(problem.initial))
        self.assertEqual(result["best_vector"], problem.best()["vector"])
        self.assertTrue(all(row["fidelity"] == "full" for row in problem.history))
        self.assertEqual(json.loads(json.dumps(result, allow_nan=False))["best_vector"], result["best_vector"])

    def test_cut_example_also_uses_public_evaluate(self):
        spec = {"id": "public-benders-cuts", **recovery_spec()}

        def evaluator(vector, *, fidelity, seed):
            return {"valid": True, "score": sum(vector), "metrics": {}}

        problem = Problem(spec, evaluator, budget=4)
        result = m05_benders.solve(problem, budget=4)
        self.assertEqual(len(problem.history), 4)
        self.assertEqual(len(result["diagnostics"]["cuts"]), 3)
        for cut in result["diagnostics"]["cuts"]:
            self.assertFalse(problem.schedule_feasible(cut["rejected_vector"]))
        self.assertEqual(json.loads(json.dumps(result, allow_nan=False))["diagnostics"]["queries"], 4)

    def test_unconditional_job_uses_public_activation_semantics(self):
        spec = {"domains": [2], "initial": [0], "unary": [[0, 1]], "scheduling": {
            "horizon": 1, "beds": 0, "jobs": [{"id": "always-rest", "duration": 1}],
        }}
        problem = TinyProblem(spec)
        for vector in [(0,), (1,)]:
            answer = m05_benders.schedule_subproblem(problem, vector)
            self.assertEqual(answer["status"], "INFEASIBLE")
            self.assertFalse(independent_schedule(spec, vector))

    def test_core_cut_generalizes_activation_values_and_ignores_irrelevant_variables(self):
        spec = {"domains": [3, 2, 3], "initial": [0, 0, 0],
                "unary": [[0, 10, 11], [0, 10], [0, 0, 0]], "scheduling": {
                    "horizon": 2, "beds": 1, "jobs": [
                        {"id": "a", "var": 0, "values": [1, 2], "duration": 2},
                        {"id": "b", "var": 1, "values": [1], "duration": 2},
                        {"id": "irrelevant", "var": 2, "duration": 0},
                    ],
                }}
        problem = TinyProblem(spec, budget=32)
        result = m05_benders.solve(problem, budget=32)
        cuts = result["diagnostics"]["cuts"]
        self.assertEqual(len(cuts), 1)
        self.assertEqual(cuts[0]["literals"], [
            {"var": 0, "value": 2, "values": [1, 2]},
            {"var": 1, "value": 1, "values": [1]},
        ])
        self.assertEqual(cuts[0]["covered_master_vectors"], 6)
        self.assertEqual({j["id"] for j in cuts[0]["certificate"]["model"]["jobs"]}, {"a", "b"})
        self.assertEqual(cuts[0]["core_reduction"]["removed_jobs"], ["irrelevant"])
        for vector in itertools.product(*problem.domains):
            rejected = all(vector[item["var"]] in item["values"] for item in cuts[0]["literals"])
            if rejected:
                self.assertFalse(independent_schedule(spec, vector))
        self.assertEqual(len(problem.history), 12)
        self.assertTrue(result["proof_scope"]["finite_model_covered_by_proofs_or_full_queries"])
        self.assertFalse(result["proof_scope"]["all_finite_candidates_valid_full_queried"])

    def test_unconditional_infeasible_core_cuts_every_assignment_once(self):
        spec = {"domains": [2, 3], "initial": [0, 0], "unary": [[0, 1], [0, 1, 2]],
                "scheduling": {"horizon": 1, "beds": 0,
                               "jobs": [{"id": "constant-conflict", "duration": 1}]}}
        result = m05_benders.solve(TinyProblem(spec), budget=16)
        cuts = result["diagnostics"]["cuts"]
        self.assertEqual(len(cuts), 1)
        self.assertEqual(cuts[0]["literals"], [])
        self.assertEqual(cuts[0]["covered_master_vectors"], 6)
        self.assertTrue(result["proof_scope"]["finite_model_infeasible"])

    def test_G_ties_use_diversity_after_first_exact_G_candidate(self):
        spec = {"domains": [2, 2, 2], "initial": [0, 0, 0], "unary": [[0, 0]] * 3}
        result = m05_benders.solve(TinyProblem(spec), budget=4)
        iterations = result["diagnostics"]["iterations"]
        self.assertEqual(iterations[0]["vector"], [0, 0, 1])
        self.assertEqual(iterations[1]["tie_break"], "maximin_hamming_within_equal_G")
        first_seen = [(0, 0, 0), (0, 0, 1)]
        expected = max(min(sum(a != b for a, b in zip(v, other)) for other in first_seen)
                       for v in itertools.product(range(2), repeat=3) if v not in first_seen)
        chosen = iterations[1]["vector"]
        self.assertEqual(min(sum(a != b for a, b in zip(chosen, other)) for other in first_seen), expected)
        self.assertTrue(all(row["G"] == 0 for row in iterations))
        self.assertEqual(result["diagnostics"]["queries"], 4)

    def test_random_generalized_cuts_preserve_every_independently_feasible_assignment(self):
        rng = random.Random(105)
        for case in range(16):
            horizon = rng.randint(2, 4)
            spec = {"domains": [3, 2, 2], "initial": [0, 0, 0],
                    "unary": [[rng.randrange(8) for _ in range(size)] for size in [3, 2, 2]],
                    "scheduling": {"horizon": horizon, "beds": rng.randint(0, 2), "jobs": []}}
            for var, size in enumerate(spec["domains"]):
                values = [value for value in range(size) if rng.randrange(2)]
                spec["scheduling"]["jobs"].append({
                    "id": f"job-{var}", "var": var, "values": values,
                    "duration": rng.randint(1, 3), "demand": rng.randint(1, 2),
                    "release": rng.randrange(horizon), "deadline": horizon,
                })
            problem = TinyProblem(spec, budget=12)
            result = m05_benders.solve(problem, budget=12)
            feasible = [vector for vector in itertools.product(*problem.domains) if independent_schedule(spec, vector)]
            for cut in result["diagnostics"]["cuts"]:
                self.assertEqual(cut["certificate"]["status"], "INFEASIBLE")
                self.assertTrue(cut["certificate"]["search_exhausted"])
                for vector in feasible:
                    self.assertFalse(all(vector[item["var"]] in item["values"] for item in cut["literals"]), (case, vector, cut))
            self.assertTrue(result["proof_scope"]["finite_model_covered_by_proofs_or_full_queries"])
            self.assertEqual(result["proof_scope"]["finite_model_infeasible"], not feasible)

    def test_core_reduction_unknown_never_removes_an_unproved_job(self):
        spec = {"domains": [2, 2], "initial": [1, 1], "unary": [[0, 1], [0, 1]],
                "metadata": {"m05": {"subproblem_node_limit": 0}}, "scheduling": {
                    "horizon": 1, "beds": 1, "jobs": [
                        {"id": "impossible-window", "var": 0, "values": [1], "duration": 2},
                        {"id": "ordinary", "var": 1, "values": [1], "duration": 1},
                    ]}}
        result = m05_benders.solve(TinyProblem(spec), budget=8)
        cut = result["diagnostics"]["cuts"][0]
        self.assertEqual(cut["core_reduction"]["attempts"][0]["status"], "UNKNOWN")
        self.assertNotIn("impossible-window", cut["core_reduction"]["removed_jobs"])
        self.assertFalse(cut["core_reduction"]["subset_minimal_proved"])
        self.assertEqual(cut["certificate"]["status"], "INFEASIBLE")
        self.assertEqual(cut["literals"], [{"var": 0, "value": 1, "values": [1]}])


if __name__ == "__main__":
    unittest.main()
