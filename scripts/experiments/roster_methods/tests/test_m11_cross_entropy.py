"""Independent algorithm-kernel checks; these do not exercise RIIC native F."""

from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import unittest


_MODULE_PATH = Path(__file__).resolve().parents[1] / "methods" / "m11_cross_entropy.py"
_SPEC = importlib.util.spec_from_file_location("m11_cross_entropy", _MODULE_PATH)
assert _SPEC is not None and _SPEC.loader is not None
ce = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(ce)


class RecordingProblem:
    """A deliberately opaque F: all full values are available only via evaluate."""

    def __init__(self, sizes, score, *, budget=16, initial=None, legal=None, schedule=None):
        self.domains = [range(size) for size in sizes]
        self.initial = tuple(initial if initial is not None else [0] * len(sizes))
        self.scene_id = "m11-independent-kernel"
        self.spec = {"id": self.scene_id, "domains": sizes, "initial": list(self.initial)}
        self.metadata = {}
        self.remaining = budget
        self.history = []
        self._score = score
        self._legal = legal or (lambda vector: True)
        self._schedule = schedule or (lambda vector: True)

    def feasible(self, vector):
        return len(vector) == len(self.domains) and all(
            value in domain for value, domain in zip(vector, self.domains)
        ) and self._legal(tuple(vector))

    def schedule_feasible(self, vector):
        return self._schedule(tuple(vector))

    def evaluate(self, vector, fidelity="full", seed=None):
        assert self.remaining > 0, "the algorithm exceeded the oracle budget"
        assert self.feasible(vector) and self.schedule_feasible(vector)
        self.remaining -= 1
        value = self._score(tuple(vector))
        record = {
            "vector": list(vector), "valid": value is not None, "score": value,
            "metrics": {}, "fidelity": fidelity, "seed": seed, "elapsed_ms": 0,
        }
        self.history.append(record)
        return record

    def cheap(self, vector):
        raise AssertionError("CE must not rank the hidden objective via G")

    def vectors(self, feasible_only=True):
        raise AssertionError("CE must sample rather than enumerate the F search space")


class FixedDraws:
    def __init__(self, draws):
        self.draws = iter(draws)

    def random(self):
        return next(self.draws)


class CrossEntropyTests(unittest.TestCase):
    def test_categorical_sampling_obeys_probability_intervals(self):
        domains = [(0, 1, 2)]
        probabilities = [[0.1, 0.2, 0.7]]
        draws = FixedDraws([0.05, 0.15, 0.9])
        self.assertEqual(
            [ce._sample_vector(domains, probabilities, draws) for _ in range(3)],
            [(0,), (1,), (2,)],
        )

    def test_novel_sampling_has_the_conditional_product_distribution(self):
        domains = [(0, 1), (0, 1)]
        probabilities = [[0.5, 0.5], [0.5, 0.5]]
        # Removing (0,0) leaves three equiprobable vectors.  The first
        # coordinate's conditional weights are therefore [1/3,2/3].
        self.assertEqual(ce._sample_novel_vector(domains, probabilities, {(0, 0)}, FixedDraws([0.3, 0.01])), (0, 1))
        self.assertEqual(ce._sample_novel_vector(domains, probabilities, {(0, 0)}, FixedDraws([0.4, 0.01])), (1, 0))
        self.assertEqual(ce._sample_novel_vector(domains, probabilities, {(0, 0)}, FixedDraws([0.9, 0.9])), (1, 1))
        self.assertIsNone(ce._sample_novel_vector(domains, probabilities, {(0, 0), (0, 1), (1, 0), (1, 1)}, FixedDraws([])))

    def test_novel_sampling_preserves_nonuniform_weights_and_tiny_remaining_mass(self):
        domains = [(0, 1), (0, 1)]
        probabilities = [[0.8, 0.2], [0.1, 0.9]]
        # Excluding (0,1) leaves weights .08, .02, .18.  The first
        # coordinate threshold is .08/.28 = 2/7, rather than 1/3 or 1/2.
        self.assertEqual(ce._sample_novel_vector(domains, probabilities, {(0, 1)}, FixedDraws([0.28, 0.9])), (0, 0))
        self.assertEqual(ce._sample_novel_vector(domains, probabilities, {(0, 1)}, FixedDraws([0.29, 0.05])), (1, 0))
        tiny = [[1e-14, 1-1e-14], [1e-14, 1-1e-14]]
        blocked = {(0, 1), (1, 0), (1, 1)}
        self.assertEqual(ce._sample_novel_vector(domains, tiny, blocked, FixedDraws([0.9, 0.9])), (0, 0))

    def test_finite_unconstrained_domain_is_covered_without_duplicate_queries(self):
        problem = RecordingProblem([3, 2], lambda x: 10*x[0]+x[1], budget=16)
        result = ce.solve(problem, budget=16)
        self.assertEqual(len(problem.history), 6)
        self.assertEqual(result["best_vector"], [2, 1])
        self.assertEqual(result["diagnostics"]["duplicate_proposals"], 0)
        self.assertEqual(result["diagnostics"]["termination"], "declared_domain_exhausted")
        self.assertEqual(result["diagnostics"]["proposal_attempts"], 5)

    def test_elite_update_matches_independent_hand_calculation(self):
        updated, frequencies = ce._update_probabilities(
            [(0, 1)], [[0.5, 0.5]], [(1,)], smoothing=0.7, exploration=0.1,
        )
        self.assertEqual(frequencies, [[0.0, 1.0]])
        # (1 - .1) * ((1 - .7) * [.5,.5] + .7 * [0,1]) + .1 * [.5,.5]
        self.assertAlmostEqual(updated[0][0], 0.185)
        self.assertAlmostEqual(updated[0][1], 0.815)

    def test_selected_defaults_match_an_independent_hand_calculation(self):
        updated, _ = ce._update_probabilities(
            [(0, 1)], [[0.5, 0.5]], [(1,)],
            smoothing=ce._SMOOTHING, exploration=ce._EXPLORATION,
        )
        self.assertAlmostEqual(updated[0][0], 0.0725)
        self.assertAlmostEqual(updated[0][1], 0.9275)

    def test_every_elite_is_a_queried_valid_full_f_and_updates_are_replayable(self):
        problem = RecordingProblem([3, 3, 2], lambda x: -30 + 9*x[0] - x[1] + 3*x[2])
        result = ce.solve(problem, seed=42, budget=16)
        diagnostics = result["diagnostics"]
        self.assertEqual(diagnostics["queries_used"], len(problem.history))
        self.assertGreaterEqual(len(diagnostics["distribution_history"]), 2)
        records = {record["query_index"]: record for record in diagnostics["evaluations"]}
        for iteration in diagnostics["distribution_history"][1:]:
            elites = [records[index] for index in iteration["elite_query_indices"]]
            self.assertTrue(all(record["valid"] and record["fidelity"] == "full" for record in elites))
            eligible = [records[index] for index in iteration["sample_query_indices"] if records[index]["valid"]]
            expected = sorted(eligible, key=lambda item: (-item["score"], tuple(item["vector"])))[:iteration["elite_count"]]
            self.assertEqual(elites, expected)
            probabilities, frequencies = ce._update_probabilities(
                [tuple(domain) for domain in problem.domains], iteration["probabilities_before"],
                [tuple(record["vector"]) for record in elites],
                smoothing=diagnostics["smoothing"], exploration=diagnostics["exploration"],
            )
            self.assertEqual(iteration["probabilities_after"], probabilities)
            self.assertEqual(iteration["elite_frequencies"], frequencies)
        best = max(problem.history, key=lambda item: item["score"])
        self.assertEqual(result["best_vector"], best["vector"])
        self.assertEqual(result["best_score"], best["score"])

    def test_seed_replays_full_proposal_and_distribution_trace(self):
        first = RecordingProblem([4, 4, 4], lambda x: 3*x[0] - x[1] + x[2])
        second = RecordingProblem([4, 4, 4], lambda x: 3*x[0] - x[1] + x[2])
        self.assertEqual(ce.solve(first, seed=19), ce.solve(second, seed=19))

    def test_budget_and_oracle_remaining_are_both_enforced(self):
        problem = RecordingProblem([8, 8], lambda x: sum(x), budget=3)
        result = ce.solve(problem, budget=16)
        self.assertEqual(result["diagnostics"]["queries_used"], 3)
        empty = RecordingProblem([2], lambda x: 1)
        result = ce.solve(empty, budget=0)
        self.assertIsNone(result["best_vector"])
        self.assertEqual(empty.history, [])
        self.assertEqual(result["diagnostics"]["termination"], "budget_exhausted")

    def test_sparse_feasible_domain_is_repaired_without_illegal_evaluation(self):
        problem = RecordingProblem(
            [2] * 10, lambda x: -20 + sum(x), budget=6,
            legal=lambda x: sum(x) <= 1, schedule=lambda x: x[0] == 0,
        )
        result = ce.solve(problem, seed=42, budget=6)
        self.assertEqual(result["diagnostics"]["queries_used"], 6)
        self.assertGreater(result["diagnostics"]["repaired_proposals"], 0)
        self.assertTrue(all(problem.feasible(item["vector"]) and problem.schedule_feasible(item["vector"]) for item in problem.history))
        self.assertTrue(any(item["source"] == "repaired" for item in result["diagnostics"]["evaluations"]))
        self.assertLess(result["best_score"], 0)

    def test_invalid_f_is_not_zero_or_an_elite(self):
        problem = RecordingProblem([2], lambda x: -7 if x == (0,) else None)
        result = ce.solve(problem, seed=42, budget=16)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["best_score"], -7)
        invalid = [item for item in result["diagnostics"]["evaluations"] if not item["valid"]]
        self.assertEqual(len(invalid), 1)
        self.assertIsNone(invalid[0]["score"])
        elite_ids = {index for iteration in result["diagnostics"]["distribution_history"] for index in iteration["elite_query_indices"]}
        self.assertNotIn(invalid[0]["query_index"], elite_ids)

    def test_all_invalid_or_no_structural_candidate_returns_unknown(self):
        invalid = ce.solve(RecordingProblem([2, 2], lambda x: None), budget=4)
        self.assertIsNone(invalid["best_vector"])
        self.assertIsNone(invalid["best_score"])
        self.assertTrue(all(item["score"] is None for item in invalid["diagnostics"]["evaluations"]))
        impossible = RecordingProblem([2, 2], lambda x: 0, legal=lambda x: False)
        result = ce.solve(impossible)
        self.assertEqual(impossible.history, [])
        self.assertIsNone(result["best_score"])
        self.assertEqual(result["diagnostics"]["termination"], "candidate_generation_exhausted")

    def test_smoothing_keeps_positive_exploration_after_repeated_same_elite(self):
        domains = [(0, 1), (0, 1, 2)]
        probabilities = [[0.5, 0.5], [1/3, 1/3, 1/3]]
        for _ in range(500):
            probabilities, _ = ce._update_probabilities(
                domains, probabilities, [(1, 2)], smoothing=0.7, exploration=0.1,
            )
        for domain, row in zip(domains, probabilities):
            self.assertAlmostEqual(sum(row), 1.0)
            self.assertTrue(all(value >= 0.1/len(domain) - 1e-15 for value in row))
            self.assertTrue(all(0 < value < 1 for value in row))

    def test_nonfinite_full_score_is_excluded(self):
        problem = RecordingProblem([3], lambda x: {0: -9, 1: math.nan, 2: math.inf}[x[0]])
        result = ce.solve(problem)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["best_score"], -9)
        self.assertEqual(sum(item["valid"] for item in result["diagnostics"]["evaluations"]), 1)

    def test_non_full_result_is_neither_a_best_nor_an_elite(self):
        class PartialProblem(RecordingProblem):
            def evaluate(self, vector, fidelity="full", seed=None):
                result = super().evaluate(vector, fidelity=fidelity, seed=seed)
                result["fidelity"] = "short"
                return result

        result = ce.solve(PartialProblem([3], lambda x: 1000 + x[0]), budget=3)
        self.assertIsNone(result["best_vector"])
        self.assertIsNone(result["best_score"])
        for iteration in result["diagnostics"]["distribution_history"]:
            self.assertEqual(iteration["elite_query_indices"], [])
            self.assertEqual(iteration["probabilities_before"], iteration["probabilities_after"])

    def test_invalid_initial_needs_no_anchor_to_accept_a_direct_legal_draw(self):
        problem = RecordingProblem([2, 2], lambda x: -3, legal=lambda x: sum(x) == 2)
        result = ce.solve(problem, seed=42, budget=4)
        self.assertEqual(result["best_vector"], [1, 1])
        self.assertEqual(result["best_score"], -3)
        self.assertEqual(len(problem.history), 1)
        self.assertGreater(result["diagnostics"]["rejected_proposals"], 0)


if __name__ == "__main__":
    unittest.main()
