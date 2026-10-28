"""Independent simulation-kernel checks; these do not exercise native RIIC."""

import json
import math
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from methods.m09_ranking import _ocba_weights, solve


class NoiseProblem:
    """Explicit oracle: candidate-specific RNG streams, not assumed effective CRN."""

    def __init__(self, means, budget=48, sigma=0.25, sequences=None, invalid=()):
        self.domains = [range(len(means))]
        self.initial = (0,)
        self.scene_id = "independent-noise-toy"
        self.spec = {"domains": [len(means)], "initial": [0]}
        self.metadata = {"oracle": "independent Gaussian toy"}
        self.remaining = budget
        self.history = []
        self._means = means
        self._sigma = sigma
        self._sequences = sequences
        self._invalid = set(invalid)
        self._counts = [0] * len(means)

    def feasible(self, vector):
        return len(vector) == 1 and vector[0] in self.domains[0]

    def schedule_feasible(self, vector):
        return True

    def cheap(self, vector):
        # Deliberately uninformative: no hidden means exposed to the method.
        return 0.0

    def evaluate(self, vector, fidelity="full", seed=None):
        if self.remaining <= 0:
            raise AssertionError("method exceeded the evaluation budget")
        if seed is None:
            raise AssertionError("replication must explicitly pass its seed")
        index = vector[0]
        count = self._counts[index]
        self._counts[index] += 1
        self.remaining -= 1
        valid = index not in self._invalid
        if not valid:
            score = None
        elif self._sequences is not None:
            sequence = self._sequences[index]
            value = sequence[min(count, len(sequence) - 1)]
            valid = value is not None
            score = float(value) if valid else None
        else:
            score = self._means[index] + self._sigma * random.Random(
                int(seed) * 1_000_003 + index * 97
            ).gauss(0.0, 1.0)
        result = {
            "vector": list(vector), "valid": valid, "score": score,
            "metrics": {}, "fidelity": fidelity, "seed": seed,
            "elapsed_ms": 0.0,
        }
        self.history.append(result)
        return result


class RankingTests(unittest.TestCase):
    def test_ocba_formula_matches_hand_calculation(self):
        # Nonbest ratios are variance / squared mean gap: 4 and 9/4.
        # Best weight is sqrt(v_best * sum(w_i^2 / v_i)).
        raw = [math.sqrt(4.0 + 9.0 / 16.0), 4.0, 9.0 / 4.0]
        expected = [value / sum(raw) for value in raw]
        actual = _ocba_weights([10.0, 9.0, 8.0], [1.0, 4.0, 9.0])
        for observed, reference in zip(actual, expected):
            self.assertAlmostEqual(observed, reference, places=12)
        self.assertGreater(actual[1], actual[2])

    def test_final_selection_uses_mean_instead_of_lucky_maximum(self):
        problem = NoiseProblem(
            [10.0, -10.0], budget=16,
            sequences=[[10.0], [100.0, -100.0, -100.0]],
        )
        result = solve(problem, seed=17, budget=16)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(max(problem.history, key=lambda row: row["score"])["vector"], [1])
        self.assertEqual(result["diagnostics"]["selection_rule"], "largest_valid_sample_mean")
        self.assertFalse(result["diagnostics"]["selection_certified"])

    def test_multiple_seed_pairs_and_independent_noise(self):
        problem = NoiseProblem([0.0, 1.0, 2.0, 3.0], budget=48)
        result = solve(problem, seed=42, budget=48)
        diagnostics = result["diagnostics"]
        self.assertEqual(result["best_vector"], [3])
        self.assertEqual(len(problem.history), 48)
        self.assertEqual(diagnostics["evaluations"], 48)
        self.assertEqual(len(diagnostics["allocation_steps"]), 36)
        statistics = diagnostics["candidate_statistics"]
        first_seeds = [row["seeds"][:3] for row in statistics]
        self.assertTrue(all(seeds == first_seeds[0] for seeds in first_seeds))
        self.assertEqual(len(set(first_seeds[0])), 3)
        self.assertTrue(all(row["sample_variance"] > 0 for row in statistics))
        self.assertTrue(all(row["n_valid"] >= 3 for row in statistics))
        self.assertEqual(len(diagnostics["paired_statistics"]), 6)
        self.assertTrue(all(row["n_shared"] >= 3 for row in diagnostics["paired_statistics"]))
        self.assertFalse(diagnostics["crn"]["event_alignment_verified"])
        self.assertFalse(diagnostics["crn"]["variance_reduction_guaranteed"])

    def test_insufficient_budget_is_explicit(self):
        problem = NoiseProblem([1.0, 2.0], budget=1)
        result = solve(problem, budget=1)
        self.assertEqual(len(problem.history), 1)
        diagnostics = result["diagnostics"]
        self.assertEqual(diagnostics["comparison_status"], "insufficient_budget_for_replicated_comparison")
        self.assertIsNone(diagnostics["candidate_statistics"][0]["sample_variance"])
        self.assertFalse(diagnostics["selection_certified"])
        self.assertTrue(diagnostics["undistinguished"])

    def test_remaining_budget_caps_requested_budget(self):
        problem = NoiseProblem([0.0, 1.0, 2.0], budget=5)
        result = solve(problem, budget=16)
        self.assertEqual(len(problem.history), 5)
        self.assertEqual(result["diagnostics"]["effective_budget"], 5)
        self.assertTrue(all(row["n_valid"] >= 2 for row in result["diagnostics"]["candidate_statistics"]))

    def test_invalid_observations_are_not_zero_or_conditional_winners(self):
        problem = NoiseProblem([0.0, -10.0], budget=12, sigma=0, invalid=[0])
        result = solve(problem, budget=12)
        self.assertEqual(result["best_vector"], [1])
        invalid = next(row for row in result["diagnostics"]["candidate_statistics"] if row["vector"] == [0])
        self.assertIsNone(invalid["mean"])
        self.assertIsNone(invalid["sample_variance"])
        self.assertGreater(invalid["n_invalid"], 0)
        self.assertFalse(invalid["eligible"])

    def test_partially_invalid_candidate_cannot_win_by_conditional_success_mean(self):
        problem = NoiseProblem(
            [100.0, -10.0], budget=12,
            sequences=[[100.0, None, 100.0], [-10.0]],
        )
        result = solve(problem, budget=12)
        self.assertEqual(result["best_vector"], [1])
        partial = result["diagnostics"]["candidate_statistics"][0]
        self.assertEqual(partial["mean"], 100.0)
        self.assertEqual(partial["n_valid"], 2)
        self.assertEqual(partial["n_invalid"], 1)
        self.assertFalse(partial["eligible"])

    def test_public_problem_contract_budget_json_and_paired_noise(self):
        from common import make_toy_problem

        problem = make_toy_problem(budget=16)
        result = solve(problem, seed=42, budget=16)
        json.dumps(result, allow_nan=False)
        diagnostics = result["diagnostics"]
        self.assertEqual(len(problem.history), 16)
        self.assertEqual(problem.remaining, 0)
        self.assertEqual(diagnostics["evaluations"], 16)
        self.assertTrue(all(row["counted"] and row["fidelity"] == "full" for row in problem.history))
        expected = max(
            (row for row in diagnostics["candidate_statistics"] if row["eligible"]),
            key=lambda row: row["mean"],
        )
        self.assertEqual(result["best_vector"], expected["vector"])
        self.assertEqual(result["best_vector"], [1, 1, 1, 1])
        self.assertTrue(all(row["n_shared"] >= 3 for row in diagnostics["paired_statistics"]))
        self.assertTrue(all(
            row["sample_variance_difference"] < 1e-20
            for row in diagnostics["paired_statistics"]
        ))
        self.assertFalse(diagnostics["crn"]["event_alignment_verified"])

    def test_no_feasible_candidate_uses_no_queries(self):
        problem = NoiseProblem([0.0, 1.0], budget=8)
        problem.feasible = lambda vector: False
        result = solve(problem, budget=8)
        self.assertIsNone(result["best_vector"])
        self.assertEqual(problem.history, [])
        self.assertEqual(result["diagnostics"]["comparison_status"], "no_feasible_candidates")

    def test_unknown_schedule_preserves_baseline_and_other_verified_candidates(self):
        problem = NoiseProblem([0.0, 100.0, 2.0], budget=16, sigma=0)
        checked = []

        def schedule(vector):
            checked.append(tuple(vector))
            if vector[0] == 1:
                raise RuntimeError("Finite scheduler budget exhausted; UNKNOWN")
            return True

        problem.schedule_feasible = schedule
        result = solve(problem, budget=16)
        self.assertEqual(result["best_vector"], [2])
        self.assertEqual({tuple(row["vector"]) for row in problem.history}, {(0,), (2,)})
        diagnostic = result["diagnostics"]["candidate_generation_details"]
        self.assertEqual(diagnostic["schedule_unknown_count"], 1)
        self.assertEqual(diagnostic["schedule_infeasible_count"], 0)
        self.assertEqual(diagnostic["schedule_unknown_candidates"][0]["vector"], [1])
        self.assertEqual(checked.count((1,)), 1)

    def test_all_schedule_unknown_is_not_reported_infeasible(self):
        problem = NoiseProblem([1.0, 2.0], budget=8)

        def unknown(vector):
            raise RuntimeError("Finite scheduler budget exhausted; UNKNOWN")

        problem.schedule_feasible = unknown
        result = solve(problem, budget=8)
        self.assertIsNone(result["best_vector"])
        self.assertEqual(problem.history, [])
        self.assertEqual(result["diagnostics"]["comparison_status"], "schedule_feasibility_unknown")
        diagnostic = result["diagnostics"]["candidate_generation_details"]
        self.assertEqual(diagnostic["schedule_unknown_count"], 2)
        self.assertEqual(diagnostic["schedule_infeasible_count"], 0)

    def test_96_domain_controls_extend_shortlist_and_pilot_with_budget(self):
        from common import Problem

        for total_budget, candidate_count, pilot in ((32, 8, 2), (64, 8, 4)):
            with self.subTest(budget=total_budget, pilot=pilot):
                spec = {
                    "id": "declared-96-grid", "domains": [4, 4, 6], "initial": [0, 0, 0],
                    "unary": [[0, 10, 20, 30], [0, 1, 2, 3], [0, .1, .2, .3, .4, .5]],
                    "metadata": {"m09_ranking": {
                        "candidate_count": candidate_count, "pilot_replications": pilot,
                        "proposal_pool_limit": 128,
                    }},
                }
                problem = Problem(spec, lambda vector, **kwargs: {
                    "valid": True, "score": 10 * vector[0] + vector[1] + .1 * vector[2], "metrics": {},
                }, budget=total_budget)
                result = solve(problem, budget=total_budget)
                diagnostics = result["diagnostics"]
                self.assertEqual(diagnostics["candidate_pool_size"], 96)
                self.assertEqual(diagnostics["candidate_count"], candidate_count)
                self.assertEqual(diagnostics["pilot_replications"], pilot)
                self.assertEqual(diagnostics["evaluations"], total_budget)
                self.assertEqual(len(diagnostics["allocation_steps"]), total_budget - candidate_count * pilot)
                self.assertEqual(result["best_vector"], [3, 3, 5])
                self.assertEqual(diagnostics["candidate_generation_details"]["proposal_mode"], "complete_public_G_small_domain")

    def test_controls_reserve_two_observations_per_compared_candidate(self):
        problem = NoiseProblem(list(range(96)), budget=16, sigma=0)
        problem.metadata["m09_ranking"] = {"candidate_count": 96, "pilot_replications": 4}
        result = solve(problem, budget=16)
        diagnostics = result["diagnostics"]
        self.assertEqual(diagnostics["candidate_count"], 8)
        self.assertEqual(diagnostics["pilot_replications"], 2)
        self.assertTrue(all(row["n_valid"] == 2 for row in diagnostics["candidate_statistics"]))
        self.assertEqual(diagnostics["evaluations"], 16)

    def test_public_structural_diversity_can_escape_a_cheap_shortlist_miss(self):
        from common import Problem

        def run(fraction):
            spec = {
                "id": "cheap-disagrees-with-full", "domains": [4, 4], "initial": [0, 0],
                "unary": [[0, 100, 200, 300], [0, 1, 2, 3]],
                "metadata": {"m09_ranking": {
                    "candidate_count": 4, "pilot_replications": 2,
                    "diversity_fraction": fraction,
                }},
            }
            problem = Problem(spec, lambda vector, **kwargs: {
                "valid": True,
                "score": 1000.0 if vector == (2, 1) else 100.0 * vector[0] + vector[1],
                "metrics": {},
            }, budget=16)
            return solve(problem, budget=16)

        cheap_only = run(0.0)
        diverse = run(0.5)
        self.assertEqual(cheap_only["best_vector"], [3, 3])
        self.assertEqual(diverse["best_vector"], [2, 1])
        self.assertEqual(diverse["diagnostics"]["best_sample_mean"], 1000.0)

    def test_zero_budget_preserves_unknown_result(self):
        problem = NoiseProblem([1.0, 2.0], budget=0)
        result = solve(problem, budget=0)
        self.assertIsNone(result["best_vector"])
        self.assertEqual(result["diagnostics"]["evaluations"], 0)
        self.assertEqual(problem.history, [])

    def test_seeded_run_is_reproducible(self):
        first = NoiseProblem([0.0, 1.0, 2.0])
        second = NoiseProblem([0.0, 1.0, 2.0])
        a = solve(first, seed=819, budget=24)
        b = solve(second, seed=819, budget=24)
        self.assertEqual(first.history, second.history)
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
