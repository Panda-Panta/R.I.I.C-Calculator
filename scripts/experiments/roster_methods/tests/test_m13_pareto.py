"""Independent hand-checkable NSGA-II mechanics, not RIIC game evidence."""

from __future__ import annotations

import itertools
import json
import math
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from methods import m13_pareto as m13


class MeasuredProblem:
    """Explicit finite test oracle; scores are never exposed through metadata."""

    def __init__(self, budget=16, *, missing=False, configured=True):
        self.domains = [range(6)]
        self.initial = (0,)
        self.scene_id = "hand-checkable-pareto"
        self.spec = {"domains": [6], "initial": [0], "forbidden": [], "resources": []}
        self.metadata = {"pareto_population_size": 2}
        if configured:
            self.metadata["pareto_objectives"] = [{"name": "exp", "direction": "max"}, {"name": "gold", "direction": "max"}]
        self.remaining, self.history, self.missing = budget, [], missing

    def vectors(self, *args, **kwargs):
        raise AssertionError("the method must not enumerate the oracle domain")

    def feasible(self, vector):
        return len(vector) == 1 and vector[0] in self.domains[0]

    def schedule_feasible(self, vector):
        return True

    def evaluate(self, vector, fidelity="full", seed=None):
        assert self.remaining > 0 and self.feasible(vector) and self.schedule_feasible(vector)
        self.remaining -= 1
        exp, gold = [(5, 0), (4, 3), (2, 4), (0, 5), (1, 1), (2, 2)][vector[0]]
        metrics = {"exp": exp} if self.missing else {"exp": exp, "gold": gold, "order_lmd": gold * 2, "change_cost": int(tuple(vector) != self.initial)}
        record = {"vector": list(vector), "score": 10 * exp + gold, "valid": True, "metrics": metrics, "fidelity": fidelity, "seed": seed}
        self.history.append(record)
        return record


class ConstrainedProblem(MeasuredProblem):
    def __init__(self, budget=16):
        super().__init__(budget)
        self.domains = [range(2)] * 3
        self.initial = (0, 0, 0)
        self.spec = {
            "forbidden": [{"vars": [0, 1], "values": [1, 1]}],
            "resources": [{"name": "capacity", "capacity": 1, "usage": [[0, 1]] * 3}],
        }

    def feasible(self, vector):
        return len(vector) == 3 and all(value in (0, 1) for value in vector) and sum(vector) <= 1

    def schedule_feasible(self, vector):
        return vector[2] == 0

    def evaluate(self, vector, fidelity="full", seed=None):
        assert self.remaining > 0 and self.feasible(vector) and self.schedule_feasible(vector)
        self.remaining -= 1
        metrics = {"exp": 3 * vector[0], "gold": 4 * vector[1]}
        record = {"vector": list(vector), "score": metrics["exp"] + metrics["gold"], "valid": True, "metrics": metrics, "fidelity": fidelity, "seed": seed}
        self.history.append(record)
        return record


class ParetoKernelTests(unittest.TestCase):
    def test_known_fronts_and_duplicate_points(self):
        points = [(4, 1), (3, 3), (1, 4), (2, 1), (1, 1), (3, 3)]
        self.assertEqual(m13.nondominated_sort(points), [[0, 1, 2, 5], [3], [4]])

    def test_grid_layers_against_independent_filter(self):
        points = list(itertools.product(range(3), repeat=2))
        remaining, reference = set(range(len(points))), []
        while remaining:
            front = {i for i in remaining if not any(
                j != i and points[j][0] >= points[i][0] and points[j][1] >= points[i][1] and points[j] != points[i]
                for j in remaining
            )}
            reference.append(front)
            remaining -= front
        self.assertEqual([set(front) for front in m13.nondominated_sort(points)], reference)

    def test_hand_computed_normalized_crowding(self):
        points = [(0, 10), (1, 9), (3, 7), (7, 3), (10, 0)]
        distance = m13.crowding_distance(points, list(range(5)))
        self.assertTrue(math.isinf(distance[0]) and math.isinf(distance[4]))
        for i, expected in [(1, 0.6), (2, 1.2), (3, 1.4)]:
            self.assertAlmostEqual(distance[i], expected)
        self.assertEqual(m13.select_survivors(points, 3), [0, 4, 3])

    def test_zero_range_has_no_artificial_extremes(self):
        self.assertEqual(m13.crowding_distance([(1, 1)] * 3, [0, 1, 2]), {0: 0, 1: 0, 2: 0})

    def test_elitism_uses_parent_and_child_union(self):
        # Parent 0 dominates all children and must survive environment selection.
        points = [(5, 5), (0, 0), (4, 1), (1, 4)]
        selected = m13.select_survivors(points, 2)
        self.assertIn(0, selected)
        self.assertNotIn(1, selected)
        self.assertEqual(len(selected), 2)

    def test_categorical_mutation_never_interpolates_categories(self):
        domains = [range(3), range(1), range(4)]
        rng = random.Random(12)
        for _ in range(30):
            child, mutations = m13._variation((0, 0, 0), (2, 0, 3), domains, rng)
            self.assertTrue(all(value in domain for value, domain in zip(child, domains)))
            self.assertGreaterEqual(mutations, 1)

    def test_balanced_proposal_covers_unqueried_categories(self):
        # Category 2 of the first variable has never been queried; category 1
        # of the second variable was queried less often. No scores are supplied.
        candidate = m13._balanced_proposal([range(3), range(2)], {(0, 0), (0, 1), (1, 0)}, random.Random(8))
        self.assertEqual(candidate, (2, 1))


class ParetoSolverTests(unittest.TestCase):
    def test_finite_oracle_known_front_and_unchanged_score_best(self):
        problem = MeasuredProblem(budget=6)
        result = m13.solve(problem, seed=7, budget=6)
        self.assertEqual(len(problem.history), 6)
        self.assertEqual({tuple(item["vector"]) for item in result["pareto_front"]}, {(0,), (1,), (2,), (3,)})
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["best_score"], 50)
        self.assertGreater(result["diagnostics"]["parent_child_selections"], 0)
        for generation in result["diagnostics"]["generation_trace"]:
            union = generation["parents"] + generation["children"]
            self.assertTrue(all(vector in union for vector in generation["selected"]))
        json.dumps(result, allow_nan=False)

    def test_minimization_and_default_measured_fields(self):
        problem = MeasuredProblem(budget=6, configured=False)
        result = m13.solve(problem, seed=7, budget=6)
        self.assertIn({"name": "change_cost", "direction": "min"}, result["objectives"])
        point = m13._point({"metrics": {"exp": 4, "change_cost": 2}}, [("exp", "max"), ("change_cost", "min")])
        self.assertEqual(point, (4, -2))

    def test_repair_respects_forbidden_resource_and_schedule(self):
        problem = ConstrainedProblem()
        repaired = m13.repair_candidate(problem, (1, 1, 1), random.Random(1), fallback=problem.initial)
        self.assertIsNotNone(repaired)
        self.assertNotEqual(repaired, (1, 1, 1))
        self.assertTrue(problem.feasible(repaired) and problem.schedule_feasible(repaired))
        result = m13.solve(problem, seed=4, budget=16)
        self.assertTrue(problem.history)
        self.assertTrue(all(problem.feasible(record["vector"]) and problem.schedule_feasible(record["vector"]) for record in problem.history))
        self.assertLessEqual(len(problem.history), 16)
        self.assertEqual(result["best_score"], max(record["score"] for record in problem.history))

    def test_zero_budget_and_external_remaining_cap(self):
        empty = MeasuredProblem(budget=3)
        result = m13.solve(empty, budget=0)
        self.assertIsNone(result["best_vector"])
        self.assertEqual(empty.history, [])
        limited = MeasuredProblem(budget=3)
        result = m13.solve(limited, budget=100)
        self.assertEqual(len(limited.history), 3)
        self.assertEqual(result["diagnostics"]["queries"], 3)

    def test_no_fabricated_missing_objectives(self):
        problem = MeasuredProblem(budget=6, missing=True, configured=False)
        result = m13.solve(problem, budget=6)
        self.assertEqual(result["diagnostics"]["status"], "unsupported_objectives")
        self.assertEqual(len(problem.history), 1)
        self.assertEqual(result["pareto_front"], [])
        self.assertEqual(result["best_vector"], [0])

    def test_explicit_missing_objective_cannot_enter_front(self):
        problem = MeasuredProblem(budget=3, missing=True)
        result = m13.solve(problem, budget=3)
        self.assertEqual(result["pareto_front"], [])
        self.assertIsNotNone(result["best_vector"])
        self.assertEqual(result["diagnostics"]["missing_objectives"], 3)
        self.assertEqual(result["diagnostics"]["status"], "unsupported_objectives")

    def test_common_problem_interface_and_observed_front(self):
        from common import make_toy_problem

        problem = make_toy_problem(budget=16)
        result = m13.solve(problem, seed=42, budget=16)
        self.assertEqual(result["best_vector"], problem.best()["vector"])
        self.assertEqual(result["diagnostics"]["queries"], len(problem.history))
        self.assertLessEqual(len(problem.history), 16)
        self.assertGreater(result["diagnostics"]["parent_child_selections"], 0)
        # Independent direct pairwise filter uses declared mixed directions.
        records = [record for record in problem.history if record["valid"]]
        def metric_tuple(record):
            metrics = record["metrics"]
            return (metrics["exp"], metrics["order_lmd"], -metrics["change_cost"])
        reference = {
            tuple(record["vector"]) for record in records
            if not any(
                all(a >= b for a, b in zip(metric_tuple(other), metric_tuple(record)))
                and any(a > b for a, b in zip(metric_tuple(other), metric_tuple(record)))
                for other in records
            )
        }
        self.assertEqual({tuple(record["vector"]) for record in result["pareto_front"]}, reference)

    def test_invalid_or_incomplete_oracle_result_is_not_zero(self):
        problem = MeasuredProblem(budget=3)
        original = problem.evaluate

        def invalid(vector, fidelity="full", seed=None):
            record = original(vector, fidelity, seed)
            record.update(valid=False, score=None)
            return record

        problem.evaluate = invalid
        result = m13.solve(problem, budget=3)
        self.assertIsNone(result["best_score"])
        self.assertIsNone(result["best_vector"])
        self.assertEqual(result["pareto_front"], [])
        self.assertEqual(result["diagnostics"]["invalid_or_incomplete"], 3)

    def test_seed_replays_queries_and_selection(self):
        first, second = MeasuredProblem(budget=6), MeasuredProblem(budget=6)
        self.assertEqual(m13.solve(first, seed=17, budget=6), m13.solve(second, seed=17, budget=6))
        self.assertEqual(first.history, second.history)

    def test_tiny_domain_still_performs_parent_child_selection(self):
        problem = MeasuredProblem(budget=128)
        del problem.metadata["pareto_population_size"]
        result = m13.solve(problem, budget=128)
        self.assertLess(result["diagnostics"]["population_size"], 6)
        self.assertGreater(result["diagnostics"]["parent_child_selections"], 0)
        self.assertEqual(result["diagnostics"]["queried_unique"], len(problem.history))

    def test_declared_score_mating_can_be_disabled_without_changing_objectives(self):
        pure, hybrid = MeasuredProblem(budget=6), MeasuredProblem(budget=6)
        pure.metadata["pareto_score_mating_probability"] = 0
        hybrid.metadata["pareto_score_mating_probability"] = 1
        pure_result = m13.solve(pure, budget=6)
        hybrid_result = m13.solve(hybrid, budget=6)
        self.assertEqual(pure_result["diagnostics"]["score_elite_matings"], 0)
        self.assertGreater(pure_result["diagnostics"]["tournaments"], 0)
        self.assertGreater(hybrid_result["diagnostics"]["score_elite_matings"], 0)
        self.assertEqual(pure_result["objectives"], hybrid_result["objectives"])
        for result, problem in [(pure_result, pure), (hybrid_result, hybrid)]:
            self.assertEqual(result["best_score"], max(record["score"] for record in problem.history))
            curve = result["diagnostics"]["score_curve"]
            self.assertTrue(all(a["query"] < b["query"] and a["score"] < b["score"] for a, b in zip(curve, curve[1:])))


if __name__ == "__main__":
    unittest.main()
