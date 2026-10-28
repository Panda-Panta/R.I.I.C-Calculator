"""Independent arithmetic and oracle-budget checks for method 10."""

from __future__ import annotations

import math
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from methods import m10_renewal
import common


class FakeProblem:
    def __init__(self, *, remaining=16, renewal=True):
        self.initial = (0, 0)
        self.domains = [range(2), range(2)]
        self.metadata = {}
        if renewal:
            self.metadata["renewal"] = {
                "beds": 1,
                "options": [
                    [
                        {"work_hours": 6, "rest_hours": 2, "reward": 8},
                        {"work_hours": 6, "rest_hours": 2, "reward": 24},
                    ],
                    [
                        {"work_hours": 6, "rest_hours": 2, "reward": 8},
                        {"work_hours": 6, "rest_hours": 2, "reward": 32},
                    ],
                ],
                "shared_state_regenerates": False,
            }
        self.spec = {"metadata": self.metadata}
        self.remaining = remaining
        self.history = []

    def feasible(self, vector):
        return len(vector) == 2 and all(value in range(2) for value in vector)

    def schedule_feasible(self, vector):
        return True

    def evaluate(self, vector, fidelity="full", seed=None):
        if self.remaining <= 0:
            raise AssertionError("oracle called beyond remaining budget")
        self.remaining -= 1
        vector = tuple(vector)
        valid = vector != (1, 1)
        scores = {(0, 0): 1.0, (1, 0): 2.0, (0, 1): 20.0}
        record = {
            "vector": list(vector),
            "valid": valid,
            "score": scores.get(vector),
            "metrics": {},
            "fidelity": fidelity,
            "seed": seed,
        }
        self.history.append(record)
        return record


class RenewalArithmeticTests(unittest.TestCase):
    def test_reward_is_ratio_of_totals_not_mean_of_cycle_rates(self):
        result = m10_renewal.renewal_reward_summary([
            {"length_hours": 10, "reward": 100},
            {"length_hours": 20, "reward": 100},
        ])
        self.assertAlmostEqual(result["reward_per_hour"], 200 / 30)
        self.assertEqual(result["total_length_hours"], 30)
        self.assertEqual(result["complete_cycles"], 2)
        self.assertNotAlmostEqual(result["reward_per_hour"], (10 + 5) / 2)
        self.assertFalse(result["long_run_convergence_proven"])

    def test_recovery_load_and_little_product_by_hand(self):
        records = [
            {"work_hours": 6, "rest_hours": 2, "reward": 80},
            {"work_hours": 3, "rest_hours": 1, "wait_hours": 2, "reward": 30},
        ]
        result = m10_renewal.recovery_load(records, beds=1)
        self.assertAlmostEqual(result["aggregate_cycle_proxy_per_hour"], 10 + 5)
        self.assertAlmostEqual(result["arrival_rate_per_hour"], 1 / 8 + 1 / 6)
        self.assertAlmostEqual(result["mean_beds"], 2 / 8 + 1 / 6)
        self.assertAlmostEqual(result["mean_waiting_occupants"], 2 / 6)
        self.assertAlmostEqual(result["little_recovery_rhs"], result["mean_beds"])
        self.assertTrue(result["average_capacity_condition"])
        self.assertIsNone(result["peak_capacity_condition"])

    def test_bed_units_are_people_not_arrival_events(self):
        result = m10_renewal.recovery_load([
            {"work_hours": 6, "rest_hours": 2, "reward": 8, "bed_units": 4},
        ], beds=1)
        self.assertAlmostEqual(result["arrival_rate_per_hour"], 4 / 8)
        self.assertAlmostEqual(result["mean_beds"], 1)
        self.assertAlmostEqual(result["mean_recovery_hours"], 2)

    def test_finite_window_little_and_touching_half_open_intervals(self):
        result = m10_renewal.window_occupancy([
            {"arrival_hours": 0, "service_start_hours": 2, "departure_hours": 4},
            {"arrival_hours": 4, "service_start_hours": 4, "departure_hours": 8},
        ], window_hours=10, beds=1)
        self.assertAlmostEqual(result["arrival_rate_per_hour"], 0.2)
        self.assertAlmostEqual(result["mean_sojourn_hours"], 4)
        self.assertAlmostEqual(result["mean_system_occupants"], 0.8)
        self.assertAlmostEqual(result["little_system_rhs"], 0.8)
        self.assertAlmostEqual(result["mean_beds"], 0.6)
        self.assertAlmostEqual(result["little_recovery_rhs"], 0.6)
        self.assertEqual(result["peak_beds"], 1)

    def test_average_sufficient_but_peak_conflict_counterexample(self):
        # Four synchronized 6h-work/2h-rest cycles need four beds at t=6,
        # although their 8h average requires only one bed.
        result = m10_renewal.window_occupancy([
            {"arrival_hours": 6, "service_start_hours": 6, "departure_hours": 8}
            for _ in range(4)
        ], window_hours=8, beds=1)
        self.assertEqual(result["mean_beds"], 1)
        self.assertEqual(result["peak_beds"], 4)
        self.assertTrue(result["average_capacity_condition"])
        self.assertFalse(result["peak_capacity_condition"])
        self.assertFalse(result["full_schedule_feasibility_proven"])

    def test_censored_stay_is_not_silently_treated_as_complete(self):
        with self.assertRaises(ValueError):
            m10_renewal.window_occupancy([
                {"arrival_hours": -1, "service_start_hours": 0, "departure_hours": 4},
            ], window_hours=8, beds=1)

    def test_invalid_or_empty_cycles_are_not_zero_reward(self):
        with self.assertRaises(ValueError):
            m10_renewal.renewal_reward_summary([])
        with self.assertRaises(ValueError):
            m10_renewal.recovery_load([
                {"work_hours": 0, "rest_hours": 0, "reward": 5},
            ], beds=1)
        with self.assertRaises(ValueError):
            m10_renewal.renewal_reward_summary([
                {"length_hours": 1, "reward": math.nan},
            ])


class RenewalSolveTests(unittest.TestCase):
    def test_best_is_real_valid_full_record_not_highest_cycle_proxy(self):
        problem = FakeProblem()
        result = m10_renewal.solve(problem, seed=19, budget=4)
        self.assertEqual(result["best_vector"], [0, 1])
        self.assertEqual(result["best_score"], 20)
        self.assertEqual(result["diagnostics"]["oracle_queries"], 4)
        self.assertEqual(len(problem.history), 4)
        self.assertEqual({tuple(r["vector"]) for r in problem.history}, {
            (0, 0), (0, 1), (1, 0), (1, 1),
        })
        self.assertTrue(all(r["seed"] == 19 for r in problem.history))
        self.assertFalse(result["diagnostics"]["shared_state_regenerates_declared"])
        self.assertFalse(result["diagnostics"]["renewal_property_proven"])

    def test_zero_and_remaining_budget_are_respected(self):
        problem = FakeProblem()
        result = m10_renewal.solve(problem, budget=0)
        self.assertIsNone(result["best_vector"])
        self.assertEqual(problem.history, [])
        problem = FakeProblem(remaining=1)
        result = m10_renewal.solve(problem, budget=16)
        self.assertEqual(len(problem.history), 1)
        self.assertEqual(result["best_vector"], [0, 0])

    def test_missing_metadata_marks_unsupported_and_only_checks_baseline(self):
        problem = FakeProblem(renewal=False)
        result = m10_renewal.solve(problem, budget=8)
        self.assertEqual(result["diagnostics"]["status"], "unsupported_cycle_metadata")
        self.assertEqual(len(problem.history), 1)
        self.assertIsNone(result["diagnostics"]["best_cycle_diagnostics"])

    def test_malformed_metadata_does_not_supply_fake_zero_estimates(self):
        problem = FakeProblem()
        del problem.metadata["renewal"]["options"][0][0]["reward"]
        result = m10_renewal.solve(problem, budget=8)
        self.assertEqual(result["diagnostics"]["status"], "unsupported_cycle_metadata")
        self.assertTrue(result["diagnostics"]["metadata_errors"])
        self.assertEqual(len(problem.history), 1)

    def test_declared_schedule_rejections_are_not_sent_to_oracle(self):
        problem = FakeProblem()
        problem.schedule_feasible = lambda vector: tuple(vector) != (1, 0)
        result = m10_renewal.solve(problem, budget=8)
        self.assertEqual(result["best_vector"], [0, 1])
        self.assertNotIn((1, 0), [tuple(r["vector"]) for r in problem.history])

    def test_penalty_beams_include_lower_load_candidates(self):
        problem = FakeProblem()
        problem.metadata["renewal"]["options"] = [
            [
                {"work_hours": 9, "rest_hours": 1, "reward": 60},
                {"work_hours": 2, "rest_hours": 8, "reward": 100},
            ] for _ in range(2)
        ]
        result = m10_renewal.solve(problem, budget=3)
        trace = result["trace"]
        self.assertEqual(trace[1]["vector"], [1, 1])
        self.assertAlmostEqual(trace[1]["model"]["mean_beds"], 1.6)
        self.assertLessEqual(trace[2]["model"]["mean_beds"], 1)
        self.assertEqual(result["best_vector"], [0, 1])

    def test_observed_cycle_and_stay_metadata_remain_finite_diagnostics(self):
        problem = FakeProblem()
        problem.metadata["renewal"].update({
            "observed_cycles": [{"length_hours": 8, "reward": 80}],
            "observation_window_hours": 8,
            "stays": [{"arrival_hours": 6, "service_start_hours": 6, "departure_hours": 8}],
            "shared_state_regenerates": True,
        })
        result = m10_renewal.solve(problem, budget=1)
        diagnostics = result["diagnostics"]
        self.assertEqual(diagnostics["observed_cycle_summary"]["reward_per_hour"], 10)
        self.assertEqual(diagnostics["observed_window_occupancy"]["mean_beds"], 0.25)
        self.assertTrue(diagnostics["shared_state_regenerates_declared"])
        self.assertFalse(diagnostics["renewal_property_proven"])

    def test_common_schedule_unknown_keeps_valid_initial(self):
        problem = common.make_toy_problem(budget=8)
        finite_schedule = common.finite_schedule

        def bounded_schedule(spec, vector, max_nodes=1_000_000):
            if tuple(vector) != problem.initial:
                return {"status": "UNKNOWN", "witness": [], "nodes": 1}
            return finite_schedule(spec, vector, max_nodes=max_nodes)

        with patch.object(common, "finite_schedule", side_effect=bounded_schedule):
            result = m10_renewal.solve(problem, budget=8)
        self.assertEqual(result["best_vector"], list(problem.initial))
        self.assertGreater(result["best_score"], 0)
        self.assertEqual(result["diagnostics"]["oracle_queries"], 1)
        self.assertFalse(result["diagnostics"]["schedule_checks_complete"])
        unknown = result["diagnostics"]["unknown_schedule_candidates"]
        self.assertGreater(len(unknown), 0)
        self.assertEqual(len({tuple(row["vector"]) for row in unknown}), len(unknown))
        self.assertTrue(all(row["status"] == "UNKNOWN" for row in unknown))
        self.assertTrue(all(row["score"] is None for row in unknown))

    def test_unknown_initial_is_skipped_while_other_valid_candidates_remain(self):
        problem = FakeProblem()

        def bounded_schedule(vector):
            if tuple(vector) == problem.initial:
                raise RuntimeError("Finite scheduler budget exhausted; this is not an infeasibility proof")
            return True

        problem.schedule_feasible = bounded_schedule
        result = m10_renewal.solve(problem, budget=4)
        self.assertEqual(result["best_vector"], [0, 1])
        self.assertNotIn(problem.initial, [tuple(row["vector"]) for row in problem.history])
        self.assertEqual(len(result["diagnostics"]["unknown_schedule_candidates"]), 1)
        self.assertFalse(result["diagnostics"]["schedule_checks_complete"])

    def test_unrelated_scheduler_error_is_not_hidden_as_unknown(self):
        problem = FakeProblem()

        def broken_schedule(vector):
            raise RuntimeError("unexpected scheduler implementation failure")

        problem.schedule_feasible = broken_schedule
        with self.assertRaisesRegex(RuntimeError, "implementation failure"):
            m10_renewal.solve(problem, budget=4)

    def test_full_vector_cycles_cover_context_variables_without_fake_cycles(self):
        problem = FakeProblem()
        problem.metadata["renewal"] = {
            "beds": 1,
            "source": "explicit-test-context",
            "vector_cycles": {
                "0,0": {"groups": [{"group_id": "work", "work_hours": 6,
                                      "rest_hours": 2, "reward": 8}]},
                "0,1": {"groups": [{"group_id": "work", "work_hours": 6,
                                      "rest_hours": 1, "reward": 28}],
                          "assumptions": ["selected recovery provider"]},
                "1,0": {"groups": [{"group_id": "work", "work_hours": 6,
                                      "rest_hours": 2, "reward": 16}]},
                "1,1": {"groups": [{"group_id": "work", "work_hours": 6,
                                      "rest_hours": 1, "reward": 56}]},
            },
        }
        result = m10_renewal.solve(problem, budget=4)
        self.assertEqual(result["best_vector"], [0, 1])
        self.assertEqual(result["diagnostics"]["status"], "context_cycle_proxy_proposals")
        self.assertEqual(result["diagnostics"]["cycle_model"], "full_vector_context")
        self.assertEqual(result["diagnostics"]["model_candidate_count"], 4)
        best = result["diagnostics"]["best_cycle_diagnostics"]
        self.assertAlmostEqual(best["mean_beds"], 1 / 7)
        self.assertEqual(best["group_ids"], ["work"])
        self.assertIn("selected recovery provider", best["assumptions"])

    def test_unsupported_context_is_unscored_not_zero_or_independent_fallback(self):
        problem = FakeProblem()
        problem.metadata["renewal"]["vector_cycles"] = {
            "0,0": {"groups": [{"group_id": "work", "work_hours": 6,
                                  "rest_hours": 2, "reward": 8}]},
            "0,1": {"supported": False, "groups": [], "issues": ["missing dormitory rate"]},
            "1,0": {"groups": [{"group_id": "work", "work_hours": 6,
                                  "rest_hours": 2, "reward": 16}]},
        }
        result = m10_renewal.solve(problem, budget=8)
        self.assertEqual(result["best_vector"], [1, 0])
        self.assertEqual(len(problem.history), 2)
        self.assertFalse(result["diagnostics"]["cycle_contexts_complete"])
        unsupported = result["diagnostics"]["unsupported_cycle_contexts"]
        self.assertEqual(unsupported[0]["vector"], [0, 1])
        self.assertIsNone(unsupported[0]["score"])
        self.assertIn("missing dormitory rate", unsupported[0]["issues"])

    def test_no_supported_context_keeps_baseline_and_marks_missing_data(self):
        problem = FakeProblem()
        problem.metadata["renewal"]["vector_cycles"] = {
            "0,0": {"supported": False, "issues": ["cycle observations unavailable"]},
        }
        result = m10_renewal.solve(problem, budget=8)
        self.assertEqual(result["diagnostics"]["status"], "unsupported_cycle_metadata")
        self.assertEqual(result["best_vector"], [0, 0])
        self.assertEqual(len(problem.history), 1)
        self.assertIsNone(result["diagnostics"]["best_cycle_diagnostics"])

    def test_unknown_context_does_not_discard_other_context_proposals(self):
        problem = FakeProblem()
        problem.metadata["renewal"]["vector_cycles"] = {
            "0,0": {"groups": [{"work_hours": 6, "rest_hours": 2, "reward": 8}]},
            "0,1": {"groups": [{"work_hours": 6, "rest_hours": 2, "reward": 32}]},
            "1,0": {"groups": [{"work_hours": 6, "rest_hours": 2, "reward": 64}]},
        }

        def bounded_schedule(vector):
            if tuple(vector) == (1, 0):
                raise RuntimeError("Finite scheduler budget exhausted; this is not an infeasibility proof")
            return True

        problem.schedule_feasible = bounded_schedule
        result = m10_renewal.solve(problem, budget=8)
        self.assertEqual(result["best_vector"], [0, 1])
        self.assertEqual(len(problem.history), 2)
        self.assertFalse(result["diagnostics"]["schedule_checks_complete"])

    def test_cycle_profile_aliases_are_deferred_for_new_cycle_structures(self):
        problem = FakeProblem()
        group = lambda reward: {"group_id": "work", "work_hours": 6, "rest_hours": 2, "reward": reward}
        problem.metadata["renewal"]["vector_cycles"] = {
            "0,0": {"groups": [group(8)]},
            "0,1": {"groups": [group(80)]},
            "1,0": {"groups": [group(72)]},
            "1,1": {"groups": [group(80)]},
        }
        result = m10_renewal.solve(problem, budget=3)
        self.assertEqual([row["vector"] for row in problem.history], [[0, 0], [0, 1], [1, 0]])
        self.assertEqual(result["diagnostics"]["cycle_profile_classes"], 3)
        self.assertEqual(result["diagnostics"]["deferred_model_aliases"], 1)

    def test_profile_aliases_are_not_pruned_or_assumed_equal_in_full_f(self):
        problem = FakeProblem()
        group = lambda reward: {"group_id": "work", "work_hours": 6, "rest_hours": 2, "reward": reward}
        problem.metadata["renewal"]["vector_cycles"] = {
            "0,0": {"groups": [group(8)]},
            "0,1": {"groups": [group(80)]},
            "1,0": {"groups": [group(72)]},
            "1,1": {"groups": [group(80)]},
        }
        evaluate = problem.evaluate

        def different_alias(vector, fidelity="full", seed=None):
            record = evaluate(vector, fidelity=fidelity, seed=seed)
            if tuple(vector) == (1, 1):
                record.update(valid=True, score=1000.0)
            return record

        problem.evaluate = different_alias
        result = m10_renewal.solve(problem, budget=4)
        self.assertEqual(len(problem.history), 4)
        self.assertEqual(result["best_vector"], [1, 1])
        self.assertEqual(result["best_score"], 1000)


if __name__ == "__main__":
    unittest.main()
