"""Independent tiny-domain checks for the solution-pool experiment."""

from itertools import product
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from methods.m01_pool import build_pools, solve


def guarded_problem(model_scores, full_scores, *, initial=None, budget=16,
                    repeated=(), schedule_rejected=(), config=None):
    """Keep F in a closure: the method receives no hidden score attribute."""
    vectors = list(model_scores)
    dimension = len(vectors[0]) if vectors else len(initial or ())
    rejected = set(schedule_rejected)
    audit = {"cheap": [], "queries": []}

    class PublicProblem:
        def __init__(self):
            self.spec = {"id": "pool-independent-test", "domains": [2] * dimension}
            self.domains = [range(2) for _ in range(dimension)]
            self.initial = tuple(initial if initial is not None else vectors[0])
            self.scene_id = self.spec["id"]
            self.metadata = {"m01_pool": config or {}}
            self.history = []

        def __getattr__(self, name):
            raise AssertionError(f"Undeclared/hidden attribute accessed: {name}")

        @property
        def remaining(self):
            return budget - len(self.history)

        def vectors(self, feasible_only=True):
            yield from vectors
            yield from repeated

        def feasible(self, vector):
            return tuple(vector) in model_scores

        def schedule_feasible(self, vector):
            return tuple(vector) not in rejected

        def cheap(self, vector):
            audit["cheap"].append(tuple(vector))
            return model_scores[tuple(vector)]

        def evaluate(self, vector, fidelity="full", seed=None):
            if self.remaining <= 0:
                raise AssertionError("F budget exceeded")
            vector = tuple(vector)
            audit["queries"].append((vector, fidelity, seed))
            score = full_scores.get(vector)
            record = {"vector": list(vector), "valid": score is not None,
                      "score": score, "fidelity": fidelity, "seed": seed,
                      "metrics": {}, "elapsed_ms": 0}
            self.history.append(record)
            return record

        def best(self):
            valid = [r for r in self.history
                     if r["valid"] and r["fidelity"] == "full"]
            return max(valid, key=lambda r: r["score"], default=None)

    return PublicProblem(), audit


class PoolTests(unittest.TestCase):
    def test_model_top_k_matches_independent_exhaustive_ranking(self):
        vectors = list(product(range(2), repeat=3))
        # Deliberately include an interaction: not a coordinate-only ranking.
        cheap = {v: 7 * v[0] + 3 * v[1] + v[2] + 5 * v[0] * v[2]
                 for v in vectors}
        problem, audit = guarded_problem(cheap, {}, repeated=[vectors[-1]] * 2)
        pools = build_pools(problem, 4)
        expected = sorted(vectors, key=lambda v: (-cheap[v], v))[:4]
        self.assertEqual(pools["top_k"], [list(v) for v in expected])
        self.assertEqual(pools["unique_model_candidates"], 8)
        self.assertTrue(pools["model_complete"])
        self.assertEqual(audit["queries"], [])

    def test_farthest_first_changes_structure_instead_of_reordering_top_k(self):
        cheap = {(0, 0, 0, 0): 100, (0, 0, 0, 1): 99,
                 (1, 1, 1, 1): 98, (1, 1, 1, 0): 97}
        problem, _ = guarded_problem(cheap, {})
        pools = build_pools(problem, 2)
        self.assertEqual(pools["top_k"], [[0, 0, 0, 0], [0, 0, 0, 1]])
        self.assertEqual(pools["diverse"], [[0, 0, 0, 0], [1, 1, 1, 1]])
        self.assertEqual(len({tuple(v) for v in pools["diverse"]}), 2)

    def test_candidate_cap_has_an_explicit_incomplete_model_claim(self):
        cheap = {v: sum(v) for v in product(range(2), repeat=3)}
        problem, _ = guarded_problem(cheap, {})
        pools = build_pools(problem, 2, candidate_limit=3)
        self.assertFalse(pools["model_complete"])
        self.assertEqual(pools["scanned_model_rows"], 3)
        self.assertEqual(pools["unique_model_candidates"], 3)

    def test_budgeted_pool_finds_queried_f_winner_without_hidden_access(self):
        cheap = {(0, 0, 0, 0): 100, (0, 0, 0, 1): 99,
                 (1, 1, 1, 1): 98, (1, 1, 1, 0): 97}
        full = {(0, 0, 0, 0): 10, (0, 0, 0, 1): 11,
                (1, 1, 1, 1): 50, (1, 1, 1, 0): 9}
        problem, audit = guarded_problem(cheap, full, initial=(1, 1, 1, 0), budget=3)
        result = solve(problem, seed=123, budget=3)
        self.assertEqual(result["best_vector"], [1, 1, 1, 1])
        self.assertEqual(result["best_score"], 50)
        self.assertEqual(result["queries_used"], 3)
        self.assertTrue(all(fidelity == "full" and seed == 123
                            for _, fidelity, seed in audit["queries"]))
        self.assertEqual(len({v for v, _, _ in audit["queries"]}), 3)
        self.assertEqual(len(audit["queries"]), len(problem.history))

    def test_top_k_and_diverse_are_distinct_under_the_same_f_budget(self):
        cheap = {(0, 0, 0): 100, (0, 0, 1): 99, (1, 1, 1): 98,
                 (1, 1, 0): 1}
        full = {v: score for v, score in zip(cheap, [10, 11, 50, 0])}
        outcomes = {}
        for mode in ["top-k", "diverse"]:
            problem, _ = guarded_problem(cheap, full, initial=(1, 1, 0), budget=3,
                                         config={"mode": mode})
            outcomes[mode] = solve(problem, budget=3)
        self.assertEqual(outcomes["top-k"]["best_score"], 11)
        self.assertEqual(outcomes["diverse"]["best_score"], 50)
        self.assertEqual(outcomes["top-k"]["queries_used"],
                         outcomes["diverse"]["queries_used"])

    def test_structural_schedule_constraints_and_invalid_f_are_not_zero_scores(self):
        cheap = {(0, 0): 10, (0, 1): 9, (1, 0): 8, (1, 1): 7}
        problem, audit = guarded_problem(cheap, {(0, 0): None, (1, 0): -2},
                                         initial=(0, 0), budget=3,
                                         schedule_rejected=[(0, 1), (1, 1)])
        result = solve(problem, budget=3)
        self.assertEqual(result["best_vector"], [1, 0])
        self.assertEqual(result["best_score"], -2)
        self.assertEqual(len(audit["queries"]), 2)
        self.assertNotIn((0, 1), [v for v, _, _ in audit["queries"]])

    def test_zero_budget_returns_only_previously_verified_evidence(self):
        problem, audit = guarded_problem({(0,): 1, (1,): 2}, {(0,): 10}, budget=1)
        problem.evaluate((0,), seed=42)
        result = solve(problem, budget=0)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["queries_used"], 0)
        self.assertEqual(len(audit["queries"]), 1)
        self.assertEqual(audit["cheap"], [])

    def test_no_valid_full_result_returns_none(self):
        problem, _ = guarded_problem({(0,): 1, (1,): 2}, {}, budget=2)
        result = solve(problem, budget=2)
        self.assertIsNone(result["best_vector"])
        self.assertIsNone(result["best_score"])

    def test_large_budget_exhausts_tiny_domain_and_matches_independent_f_maximum(self):
        vectors = list(product(range(2), repeat=3))
        cheap = {v: 3 * v[0] + 2 * v[1] + v[2] for v in vectors}
        full = {v: 2 * v[0] - 5 * v[1] + 7 * v[2] + 12 * (v[0] == v[1])
                for v in vectors}
        problem, audit = guarded_problem(cheap, full, budget=128)
        result = solve(problem, budget=128)
        self.assertEqual(result["queries_used"], 8)
        self.assertEqual(len({v for v, _, _ in audit["queries"]}), 8)
        self.assertEqual(result["best_score"], max(full.values()))
        self.assertEqual(result["best_score"], full[tuple(result["best_vector"])])


if __name__ == "__main__":
    unittest.main()
