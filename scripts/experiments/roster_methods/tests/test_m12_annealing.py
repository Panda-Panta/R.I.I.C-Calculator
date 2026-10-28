"""Hand-checkable algorithm-kernel tests; no native/game claims."""

import itertools
import json
import math
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from methods.m12_annealing import _metropolis, solve
from common import make_toy_problem


class KernelProblem:
    def __init__(self, domains, initial, oracle, *, budget=32, feasible=None, schedule=None):
        self.domains = [range(size) for size in domains]
        self.initial = tuple(initial)
        self.scene_id = "m12_kernel"
        self.oracle = oracle
        self.remaining = budget
        self.history = []
        self._feasible = feasible or (lambda vector: True)
        self._schedule = schedule or (lambda vector: True)

    def feasible(self, vector):
        return self._feasible(vector)

    def schedule_feasible(self, vector):
        return self._schedule(vector)

    def evaluate(self, vector, fidelity="full", seed=None):
        if self.remaining <= 0:
            raise AssertionError("budget overrun")
        assert self.feasible(vector) and self.schedule_feasible(vector)
        self.remaining -= 1
        score = self.oracle(tuple(vector))
        record = {"vector": list(vector), "valid": score is not None, "score": score,
                  "fidelity": fidelity, "seed": seed, "metrics": {}, "elapsed_ms": 0}
        self.history.append(record)
        return record


class SimulatedAnnealingTests(unittest.TestCase):
    def test_public_problem_smoke_preserves_queried_full_best(self):
        problem = make_toy_problem(budget=16)
        result = solve(problem, seed=42, budget=16)
        json.dumps(result, allow_nan=False)
        self.assertEqual(result["diagnostics"]["queries"], len(problem.history))
        self.assertLessEqual(len(problem.history), 16)
        self.assertTrue(all(row["fidelity"] == "full" and row["counted"] for row in problem.history))
        self.assertTrue(problem.feasible(result["best_vector"]))
        self.assertTrue(problem.schedule_feasible(result["best_vector"]))
        self.assertEqual(problem.best()["score"], result["best_score"])
        self.assertTrue(any(row["valid"] and row["fidelity"] == "full"
                            and row["vector"] == result["best_vector"]
                            and row["score"] == result["best_score"] for row in problem.history))

    def test_metropolis_probability_and_actual_draw(self):
        temperature = 2.0
        delta = -2.0
        accepted, probability, draw = _metropolis(delta, temperature, random.Random(1))
        self.assertAlmostEqual(probability, math.exp(-1.0))
        self.assertTrue(accepted)
        self.assertLess(draw, probability)
        accepted, probability, draw = _metropolis(delta, temperature, random.Random(2))
        self.assertFalse(accepted)
        self.assertGreaterEqual(draw, probability)
        self.assertEqual(_metropolis(0, temperature, random.Random(0)), (True, 1.0, None))

    def test_escape_requires_accepted_loss_and_matches_small_domain_reference(self):
        # A block changes at most four bits: the first step from 00000 must lose.
        def score(vector):
            return 10.0 if sum(vector) == 5 else (5.0 if sum(vector) == 0 else 4.0)

        problem = KernelProblem([2] * 5, [0] * 5, score, budget=64)
        result = solve(problem, seed=42, budget=64)
        exhaustive_best = max(score(vector) for vector in itertools.product(range(2), repeat=5))
        self.assertEqual(result["best_score"], exhaustive_best)
        losses = [row for row in result["diagnostics"]["trace"]
                  if row.get("delta", 0) < 0 and row["accepted"]]
        self.assertTrue(losses)
        first = losses[0]
        self.assertAlmostEqual(first["acceptance_probability"], 0.8)
        self.assertLess(first["draw"], first["acceptance_probability"])
        self.assertEqual(result["best_vector"], [1] * 5)

    def test_legal_multivariable_move_crosses_constraint_barrier(self):
        # Single flips violate the equality; a paired change or swap is needed.
        problem = KernelProblem([2, 2], [0, 1], lambda v: 2 * v[0], budget=6,
                                feasible=lambda v: sum(v) == 1)
        result = solve(problem, seed=3, budget=6)
        self.assertEqual(result["best_vector"], [1, 0])
        transitions = [row for row in result["diagnostics"]["trace"] if row["kind"] == "transition"]
        self.assertTrue(transitions)
        self.assertTrue(all(row["changed_variables"] == 2 for row in transitions))
        self.assertGreater(result["diagnostics"]["rejected_proposals"], 0)

    def test_negative_scores_and_best_survives_accepted_loss(self):
        problem = KernelProblem([2], [0], lambda v: -10.0 - v[0], budget=2)
        result = solve(problem, seed=1, budget=2)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["best_score"], -10.0)
        self.assertEqual(result["diagnostics"]["accepted_worse"], 1)
        self.assertEqual(result["diagnostics"]["queries"], 2)

    def test_invalid_full_result_is_counted_and_not_promoted(self):
        problem = KernelProblem([2], [0], lambda v: -5.0 if v == (0,) else None, budget=3)
        result = solve(problem, seed=1, budget=3)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["best_score"], -5.0)
        self.assertEqual(result["diagnostics"]["queries"], 2)
        self.assertEqual(result["diagnostics"]["invalid_evaluations"], 1)
        self.assertEqual(len(problem.history), 2)
        self.assertEqual(result["diagnostics"]["termination"], "declared_domain_covered")

    def test_seen_vectors_do_not_spend_repeated_full_queries(self):
        problem = KernelProblem([2, 2], [0, 0], lambda v: sum(v), budget=128)
        result = solve(problem, seed=42, budget=128)
        vectors = [tuple(row["vector"]) for row in problem.history]
        self.assertEqual(len(vectors), len(set(vectors)))
        self.assertEqual(len(vectors), 4)
        self.assertEqual(result["diagnostics"]["queries"], 4)
        self.assertEqual(result["diagnostics"]["termination"], "declared_domain_covered")

    def test_public_proxy_screening_keeps_full_metropolis_and_verified_best(self):
        problem = KernelProblem([2, 2], [0, 0], lambda v: 5.0 if v == (0, 0) else 4.0, budget=8)
        problem.cheap = lambda v: 2 * v[0] + v[1]  # Deliberately wrong about F's champion.
        result = solve(problem, seed=42, budget=8)
        transition = result["diagnostics"]["trace"][1]
        self.assertEqual(transition["vector"], [1, 1])
        self.assertEqual(transition["proxy_lookahead_candidates"], 3)
        self.assertEqual(transition["delta"], -1.0)
        self.assertAlmostEqual(transition["acceptance_probability"], 0.8)
        self.assertTrue(transition["accepted"])
        self.assertLess(transition["draw"], transition["acceptance_probability"])
        self.assertEqual(result["best_vector"], [0, 0])
        self.assertEqual(result["diagnostics"]["queries"], len(problem.history))

    def test_schedule_filter_and_all_invalid_do_not_invent_a_solution(self):
        filtered = KernelProblem([2, 2], [0, 0], lambda v: sum(v), budget=8,
                                 schedule=lambda v: v[0] == 0)
        result = solve(filtered, seed=9, budget=8)
        self.assertTrue(all(row["vector"][0] == 0 for row in filtered.history))
        self.assertTrue(filtered.schedule_feasible(result["best_vector"]))
        invalid = KernelProblem([2], [0], lambda v: None, budget=16)
        failed = solve(invalid, seed=2, budget=16)
        self.assertIsNone(failed["best_vector"])
        self.assertIsNone(failed["best_score"])
        self.assertLessEqual(failed["diagnostics"]["restarts_started"], 2)
        self.assertLessEqual(failed["diagnostics"]["queries"], 16)

    def test_nonfinite_scores_and_unsampled_feasibility_are_not_proofs(self):
        nonfinite = KernelProblem([2], [0], lambda v: float("nan"), budget=1)
        result = solve(nonfinite, budget=1)
        self.assertIsNone(result["best_vector"])
        self.assertEqual(result["diagnostics"]["invalid_evaluations"], 1)
        blocked = KernelProblem([2, 2], [0, 0], lambda v: 99.0, budget=16,
                                feasible=lambda v: False)
        result = solve(blocked, seed=3, budget=16)
        self.assertIsNone(result["best_vector"])
        self.assertEqual(result["diagnostics"]["queries"], 0)
        self.assertEqual(result["diagnostics"]["termination"], "start_sampling_exhausted")
        self.assertLessEqual(result["diagnostics"]["start_sampling_attempts"], 3 * 128)

    def test_budget_cap_zero_budget_and_seed_replay(self):
        oracle = lambda v: sum((i + 1) * value for i, value in enumerate(v))
        first = KernelProblem([3, 3, 3], [0, 0, 0], oracle, budget=20)
        second = KernelProblem([3, 3, 3], [0, 0, 0], oracle, budget=20)
        self.assertEqual(solve(first, seed=87, budget=16), solve(second, seed=87, budget=16))
        self.assertEqual(len(first.history), 16)
        self.assertTrue(all(row["seed"] == 87 for row in first.history))
        capped = KernelProblem([2], [0], oracle, budget=2)
        self.assertEqual(solve(capped, seed=1, budget=20)["diagnostics"]["queries"], 2)
        unused = KernelProblem([2], [0], oracle, budget=2)
        result = solve(unused, budget=0)
        self.assertEqual(result["diagnostics"]["queries"], 0)
        self.assertIsNone(result["best_vector"])
        self.assertEqual(unused.remaining, 2)

    def test_temperature_cools_in_score_units_and_restarts_are_bounded(self):
        make = lambda scale, offset: KernelProblem(
            [2, 2, 2], [0, 0, 0], lambda v: offset + scale * sum(v), budget=20)
        base = solve(make(1.0, 0.0), seed=8, budget=20)
        scaled = solve(make(100.0, -5000.0), seed=8, budget=20)
        base_rows = base["diagnostics"]["trace"]
        scaled_rows = scaled["diagnostics"]["trace"]
        self.assertEqual([row["vector"] for row in base_rows], [row["vector"] for row in scaled_rows])
        self.assertEqual([row["accepted"] for row in base_rows], [row["accepted"] for row in scaled_rows])
        for left, right in zip(base_rows, scaled_rows):
            if "temperature" in left:
                self.assertAlmostEqual(right["temperature"], 100 * left["temperature"])
        by_epoch = {}
        for row in base_rows:
            if "temperature" in row:
                by_epoch.setdefault(row["epoch"], []).append(row["temperature"])
        for temperatures in by_epoch.values():
            self.assertTrue(all(a >= b for a, b in zip(temperatures, temperatures[1:])))
        self.assertLessEqual(base["diagnostics"]["restarts_started"], 2)


if __name__ == "__main__":
    unittest.main()
