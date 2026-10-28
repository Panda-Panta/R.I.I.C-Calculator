"""Independent ALNS kernel checks; these are not RIIC runtime evidence."""

import copy
import itertools
import json
import random
import unittest

from scripts.experiments.roster_methods.methods.m02_alns import (
    _acceptance,
    _destroy_random,
    _destroy_related,
    _repair,
    solve,
)


class KernelProblem:
    """Tiny public-contract oracle with separately supplied full scores."""

    def __init__(self, spec, budget=16, full_scores=None, unsupported=False):
        self.spec = copy.deepcopy(spec)
        self.domains = [range(size) for size in spec["domains"]]
        self.initial = tuple(spec["initial"])
        self.scene_id = "m02-independent-kernel"
        self.metadata = {"proof_scope": "synthetic kernel only"}
        self.remaining = budget
        self.history = []
        self._scores = full_scores
        self._unsupported = unsupported

    def feasible(self, vector):
        if len(vector) != len(self.domains) or any(value not in domain for value, domain in zip(vector, self.domains)):
            return False
        for entry in self.spec.get("forbidden", []):
            if all(vector[index] == value for index, value in zip(entry["vars"], entry["values"])):
                return False
        return all(
            sum(usage[value] for usage, value in zip(resource["usage"], vector)) <= resource["capacity"]
            for resource in self.spec.get("resources", [])
        )

    def schedule_feasible(self, vector):
        return tuple(vector) not in [tuple(values) for values in self.spec.get("schedule_forbidden", [])]

    def cheap(self, vector):
        result = sum(values[value] for values, value in zip(self.spec.get("unary", [[0] * len(domain) for domain in self.domains]), vector))
        for entry in self.spec.get("factors", []):
            result += entry["table"].get(",".join(str(vector[index]) for index in entry["vars"]), 0)
        return float(result)

    def evaluate(self, vector, fidelity="full", seed=None):
        if self.remaining <= 0:
            raise AssertionError("query budget exceeded")
        self.remaining -= 1
        valid = self.feasible(vector) and self.schedule_feasible(vector) and not self._unsupported
        score = None
        if valid:
            score = self.cheap(vector) if self._scores is None else self._scores[tuple(vector)]
        record = {"vector": list(vector), "valid": valid, "score": score, "fidelity": fidelity, "seed": seed, "metrics": {}}
        self.history.append(record)
        return record


def trap_spec():
    return {
        "id": "two-decision-local-trap",
        "domains": [2, 2],
        "initial": [0, 0],
        "unary": [[0, 0], [0, 0]],
        "factors": [{"vars": [0, 1], "table": {"0,0": 5, "0,1": 0, "1,0": 0, "1,1": 10}}],
    }


class ALNSKernelTests(unittest.TestCase):
    def test_destroy_repair_preserves_frozen_values_constraints_and_schedule(self):
        spec = {
            "domains": [3, 3, 2], "initial": [0, 1, 0],
            "unary": [[0, 2, 5], [0, 3, 6], [0, 1]],
            "forbidden": [{"vars": [0, 1], "values": [2, 2]}],
            "resources": [{"name": "beds", "capacity": 3, "usage": [[0, 1, 2], [0, 1, 2], [0, 1]]}],
            "schedule_forbidden": [[1, 2, 0]],
            "factors": [{"vars": [0, 1], "table": {"2,1": 3}}],
        }
        problem = KernelProblem(spec)
        legal = [values for values in itertools.product(*problem.domains) if values[2] == 0 and problem.feasible(values) and problem.schedule_feasible(values)]
        for operator in (_destroy_random, _destroy_related):
            removed = operator(problem, problem.initial, random.Random(8), 2)
            self.assertEqual(len(removed), len(set(removed)))
            self.assertTrue(all(index in range(3) for index in removed))
        for mode in ("greedy", "rank_randomized"):
            candidate, log = _repair(problem, problem.initial, [0, 1], random.Random(8), mode)
            self.assertIn(candidate, legal)
            self.assertEqual(candidate[2], 0)
            self.assertEqual(log["legal_completions"], len(legal))
            self.assertEqual(problem.history, [])
        greedy, _ = _repair(problem, problem.initial, [0, 1], random.Random(8))
        self.assertEqual(problem.cheap(greedy), max(map(problem.cheap, legal)))

    def test_factor_neighborhood_escapes_hand_enumerated_single_flip_trap(self):
        problem = KernelProblem(trap_spec(), budget=4)
        initial_score = problem.cheap(problem.initial)
        for neighbor in ((1, 0), (0, 1)):
            self.assertLess(problem.cheap(neighbor), initial_score)
        related = _destroy_related(problem, problem.initial, random.Random(42), 1)
        self.assertEqual(related, [0, 1])
        joint_repair, _ = _repair(problem, problem.initial, related, random.Random(42))
        self.assertEqual(joint_repair, (1, 1))
        result = solve(problem, seed=42, budget=4)
        exhaustive = max(problem.cheap(values) for values in itertools.product(*problem.domains))
        self.assertEqual(result["best_vector"], [1, 1])
        self.assertEqual(result["best_score"], exhaustive)
        self.assertTrue(any(len(operation["removed"]) == 2 for operation in result["diagnostics"]["operations"]))

    def test_adaptive_weights_change_from_actual_observed_rewards(self):
        result = solve(KernelProblem(trap_spec(), budget=4), seed=42, budget=4)
        diagnostics = result["diagnostics"]
        self.assertGreater(diagnostics["destroy_uses"]["random"], 0)
        self.assertGreater(diagnostics["destroy_uses"]["related"], 0)
        updates = diagnostics["weight_updates"]
        self.assertTrue(any(update["destroy"]["before"] != update["destroy"]["after"] for update in updates))
        self.assertTrue(any(operation["reward"] == 8 for operation in diagnostics["operations"]))
        for update in updates:
            for operator, used in update["destroy"]["uses"].items():
                if used:
                    expected = max(0.05, 0.75 * update["destroy"]["before"][operator] + 0.25 * update["destroy"]["rewards"][operator] / used)
                    self.assertAlmostEqual(update["destroy"]["after"][operator], expected)

    def test_seed_replays_all_algorithm_operations(self):
        left = solve(KernelProblem(trap_spec(), budget=4), seed=912, budget=4)
        right = solve(KernelProblem(trap_spec(), budget=4), seed=912, budget=4)
        self.assertEqual(left, right)

    def test_public_query_limits_and_no_unsupported_zero_scores(self):
        problem = KernelProblem(trap_spec(), budget=2, unsupported=True)
        result = solve(problem, budget=20)
        self.assertEqual(len(problem.history), 2)
        self.assertEqual(result["diagnostics"]["queries"], 2)
        self.assertIsNone(result["best_vector"])
        self.assertIsNone(result["best_score"])
        self.assertTrue(all(observation["valid_full_score"] is None for observation in result["diagnostics"]["observations"]))
        zero = KernelProblem(trap_spec())
        self.assertIsNone(solve(zero, budget=0)["best_vector"])
        self.assertEqual(zero.history, [])

    def test_full_oracle_controls_best_when_cheap_ranking_is_reversed(self):
        scores = {(0, 0): 2, (0, 1): 9, (1, 0): 3, (1, 1): -7}
        problem = KernelProblem(trap_spec(), budget=4, full_scores=scores)
        result = solve(problem, budget=4)
        valid_observed = [record for record in problem.history if record["valid"]]
        expected = max(valid_observed, key=lambda record: record["score"])
        self.assertEqual(result["best_vector"], expected["vector"])
        self.assertEqual(result["best_score"], expected["score"])
        self.assertNotEqual(result["best_vector"], [1, 1])

    def test_annealing_can_accept_a_worse_move_but_not_at_cold_temperature(self):
        accepted, probability = _acceptance(-1.0, 10.0, random.Random(1))
        self.assertTrue(accepted)
        self.assertGreater(probability, 0.9)
        rejected, cold_probability = _acceptance(-1.0, 0.001, random.Random(1))
        self.assertFalse(rejected)
        self.assertLess(cold_probability, 1e-100)

    def test_infeasible_initial_is_repaired_before_any_full_query(self):
        spec = trap_spec()
        spec["forbidden"] = [{"vars": [0, 1], "values": [0, 0]}]
        problem = KernelProblem(spec, budget=3)
        result = solve(problem, budget=3)
        self.assertIsNotNone(result["best_vector"])
        self.assertTrue(all(problem.feasible(record["vector"]) for record in problem.history))

    def test_repair_cap_reports_omitted_subtrees(self):
        problem = KernelProblem(trap_spec())
        candidate, log = _repair(problem, problem.initial, [0, 1], random.Random(42), node_cap=3)
        self.assertEqual(log["nodes"], 3)
        self.assertTrue(log["truncated"])
        self.assertFalse(log["covers_entire_domain"])
        self.assertIsNone(log["legal_domain_count"])
        self.assertIsNotNone(candidate)
        self.assertTrue(problem.feasible(candidate))
        self.assertEqual(problem.history, [])

    def test_public_common_smoke_and_strict_json(self):
        from scripts.experiments.roster_methods.common import make_toy_problem

        problem = make_toy_problem(budget=16)
        result = solve(problem, seed=42, budget=16)
        self.assertEqual(result["diagnostics"]["queries"], len(problem.history))
        self.assertLessEqual(len(problem.history), 16)
        self.assertTrue(problem.feasible(result["best_vector"]))
        self.assertTrue(problem.schedule_feasible(result["best_vector"]))
        self.assertEqual(result["best_vector"], problem.best()["vector"])
        self.assertEqual(result["best_score"], problem.best()["score"])
        json.dumps(result, allow_nan=False)

    def test_public_common_infeasible_initial_keeps_temperature_json_finite(self):
        from scripts.experiments.roster_methods.common import make_toy_problem

        problem = make_toy_problem(budget=3)
        problem.spec["forbidden"].append({"vars": [0, 1, 2, 3], "values": [0, 0, 0, 0]})
        self.assertFalse(problem.feasible(problem.initial))
        result = solve(problem, seed=42, budget=3)
        self.assertIsNotNone(result["best_vector"])
        self.assertTrue(all(record["valid"] for record in problem.history))
        json.dumps(result, allow_nan=False)

    def test_finite_domain_exhaustion_stops_and_limits_its_proof_to_paid_full_queries(self):
        problem = KernelProblem(trap_spec(), budget=64)
        result = solve(problem, seed=42, budget=64)
        coverage = result["diagnostics"]["coverage"]
        self.assertEqual(len(problem.history), 4)
        self.assertEqual(len({tuple(row["vector"]) for row in problem.history}), 4)
        self.assertEqual(coverage["legal_domain_count"], 4)
        self.assertTrue(coverage["complete"])
        self.assertTrue(coverage["finite_observation_maximum_proven"])
        self.assertEqual(result["diagnostics"]["status"], "declared_legal_domain_exhausted")
        self.assertLess(result["diagnostics"]["attempts"], 10)
        self.assertEqual(problem.history[1]["vector"], [1, 1])

    def test_fully_queried_unsupported_domain_is_not_an_optimality_proof(self):
        problem = KernelProblem(trap_spec(), budget=64, unsupported=True)
        result = solve(problem, seed=42, budget=64)
        coverage = result["diagnostics"]["coverage"]
        self.assertEqual(len(problem.history), 4)
        self.assertTrue(coverage["complete"])
        self.assertFalse(coverage["finite_observation_maximum_proven"])
        self.assertIsNone(result["best_score"])
        json.dumps(result, allow_nan=False)

    def test_global_restart_escapes_disconnected_legal_components_without_known_factors(self):
        class DisconnectedProblem(KernelProblem):
            def feasible(self, vector):
                return super().feasible(vector) and len(set(vector)) == 1

        spec = {"domains": [2] * 5, "initial": [0] * 5, "unary": [[0, 1]] * 5}
        scores = {(0, 0, 0, 0, 0): 3, (1, 1, 1, 1, 1): 9}
        problem = DisconnectedProblem(spec, budget=16, full_scores=scores)
        result = solve(problem, seed=42, budget=16)
        self.assertEqual(result["best_vector"], [1] * 5)
        self.assertTrue(any(operation["destroy"] == "restart" for operation in result["diagnostics"]["operations"]))
        self.assertTrue(result["diagnostics"]["coverage"]["finite_observation_maximum_proven"])


if __name__ == "__main__":
    unittest.main()
