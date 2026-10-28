"""Independent tiny-tree/constraint evidence for method 14, not game evidence."""

from __future__ import annotations

import math
import json
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from methods.m14_mcts import _Node, _partial_feasible, _select_child, _uct, solve
from common import make_toy_problem


class TinyTreeProblem:
    """An explicitly declared test oracle; the solver only calls its public API."""

    def __init__(self, domains=(2, 2), *, budget=128, rewards=None,
                 forbidden=None, resources=None, schedule=lambda vector: True,
                 unsupported=(), metadata=None):
        self.domains = [range(size) for size in domains]
        self.initial = tuple(0 for _ in domains)
        self.spec = {"domains": list(domains), "initial": list(self.initial),
                     "forbidden": forbidden or [], "resources": resources or []}
        # Classical replicated-leaf MCTS remains an explicit mechanism test.
        self.metadata = metadata if metadata is not None else {"mcts": {"repeat_evaluated_leaves": True}}
        self.remaining = budget
        self.history = []
        self._test_rewards = rewards or {(0, 0): 0.0, (0, 1): 0.0,
                                        (1, 0): 1.0, (1, 1): 1.0}
        self._schedule = schedule
        self._unsupported = set(unsupported)

    def cheap(self, vector):
        return 1.0  # The construction policy receives no target reward table.

    def feasible(self, vector):
        return (len(vector) == len(self.domains)
                and all(value in domain for value, domain in zip(vector, self.domains))
                and _partial_feasible(tuple(vector), self.spec,
                                      [list(domain) for domain in self.domains]))

    def schedule_feasible(self, vector):
        return self._schedule(tuple(vector))

    def evaluate(self, vector, fidelity="full", seed=None):
        if self.remaining <= 0:
            raise AssertionError("evaluate exceeded the available budget")
        vector = tuple(vector)
        if not self.feasible(vector) or not self.schedule_feasible(vector):
            raise AssertionError("an incomplete or illegal vector reached the oracle")
        self.remaining -= 1
        unsupported = vector in self._unsupported
        result = {"vector": list(vector), "valid": not unsupported,
                  "score": None if unsupported else self._test_rewards[vector],
                  "metrics": {}, "fidelity": fidelity, "seed": seed,
                  "elapsed_ms": 0, "reason": "unsupported" if unsupported else None}
        self.history.append(result)
        return result


class MctsTests(unittest.TestCase):
    def test_default_queries_each_complete_leaf_at_most_once(self):
        problem = TinyTreeProblem(metadata={})
        result = solve(problem, seed=42, budget=128)
        self.assertEqual(result["diagnostics"]["queries"], 4)
        self.assertEqual(result["diagnostics"]["unique_queried_leaves"], 4)
        self.assertEqual(result["diagnostics"]["duplicate_queries"], 0)
        self.assertEqual(len({tuple(row["vector"]) for row in problem.history}), 4)
        self.assertEqual(result["diagnostics"]["stop_reason"], "all_available_legal_leaves_queried")

    def test_public_G_guides_rollout_without_an_F_lookup(self):
        from methods.m14_mcts import _complete_rollout

        problem = TinyTreeProblem(metadata={})
        problem.cheap = lambda vector: 2 * vector[1]
        vector, _, _, _ = _complete_rollout(
            problem, (0,), [[0, 1], [0, 1]], problem.spec,
            random.Random(42), set(), 100, greedy_probability=1)
        self.assertEqual(vector, (0, 1))
        self.assertEqual(problem.history, [])

    def test_root_warm_start_only_updates_visited_root(self):
        problem = TinyTreeProblem(metadata={})
        result = solve(problem, seed=42, budget=2)
        self.assertEqual(result["diagnostics"]["queries"], 2)
        self.assertEqual(result["diagnostics"]["node_count"], 1)
        self.assertEqual(result["diagnostics"]["expansion_steps"], 0)
        self.assertEqual([step["phase"] for step in result["trace"]], ["baseline", "root_rollout"])
        self.assertTrue(all(step["backprop_prefixes"] == [[]] for step in result["trace"]))
        self.assertTrue(all(step["expanded_prefix"] is None for step in result["trace"]))

    def test_budget_one_preserves_better_initial_against_misleading_G(self):
        problem = TinyTreeProblem(domains=(2,), rewards={(0,): 100, (1,): 0}, metadata={})
        problem.cheap = lambda vector: vector[0]
        result = solve(problem, seed=42, budget=1)
        self.assertEqual([row["vector"] for row in problem.history], [[0]])
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["best_score"], 100)
        self.assertEqual(result["diagnostics"]["queries"], 1)
        self.assertEqual(result["diagnostics"]["baseline"]["status"], "valid")
        self.assertEqual(result["diagnostics"]["tree"][0]["visits"], 1)
        self.assertEqual(result["diagnostics"]["node_count"], 1)
        extended = TinyTreeProblem(domains=(2,), rewards={(0,): 100, (1,): 0}, metadata={})
        extended.cheap = lambda vector: vector[0]
        extended_result = solve(extended, seed=42, budget=2)
        self.assertEqual([row["vector"] for row in extended.history], [[0], [1]])
        self.assertEqual(extended_result["best_vector"], [0])
        self.assertEqual(extended_result["best_score"], 100)

    def test_infeasible_initial_is_skipped_without_spending_F_budget(self):
        problem = TinyTreeProblem(domains=(2,), rewards={(1,): 20}, metadata={},
                                  forbidden=[{"vars": [0], "values": [0]}])
        result = solve(problem, seed=42, budget=1)
        self.assertEqual([row["vector"] for row in problem.history], [[1]])
        self.assertEqual(result["best_vector"], [1])
        self.assertEqual(result["diagnostics"]["queries"], 1)
        self.assertEqual(result["diagnostics"]["baseline"]["status"], "public_structure_infeasible")

    def test_tree_search_recovers_when_public_G_prefers_wrong_leaf(self):
        problem = TinyTreeProblem(metadata={})
        problem.cheap = lambda vector: -sum(vector)
        result = solve(problem, seed=42, budget=4)
        self.assertEqual(problem.history[0]["vector"], [0, 0])
        self.assertEqual(problem.history[0]["score"], 0)
        self.assertEqual(result["best_score"], 1)
        self.assertGreater(result["diagnostics"]["expansion_steps"], 0)
        self.assertGreater(result["diagnostics"]["selection_steps"], 0)
        self.assertEqual(result["diagnostics"]["duplicate_queries"], 0)

    def test_shared_contract_and_strict_json_smoke(self):
        problem = make_toy_problem(budget=16)
        result = solve(problem, seed=42, budget=16)
        self.assertEqual(result["diagnostics"]["queries"], len(problem.history))
        self.assertEqual(len(problem.history), 16)
        self.assertEqual(result["best_vector"], problem.best()["vector"])
        self.assertTrue(all(problem.feasible(row["vector"])
                            and problem.schedule_feasible(row["vector"])
                            and row["fidelity"] == "full"
                            and row["seed"] == 42 for row in problem.history))
        self.assertFalse(result["proof_scope"]["dynamic_event_policy_verified"])
        json.dumps(result, allow_nan=False)

    def test_uct_numeric_formula_and_exploration(self):
        parent = _Node((), visits=100)
        frequent = _Node((0,), visits=90, reward_samples=90, reward_sum=81)
        rare = _Node((1,), visits=10, reward_samples=10, reward_sum=5)
        parent.children = {0: frequent, 1: rare}
        self.assertAlmostEqual(_uct(parent, rare, 1), .5 + math.sqrt(2 * math.log(100) / 10))
        self.assertIs(_select_child(parent, random.Random(1), 1), rare)
        unvisited = _Node((2,))
        parent.children[2] = unvisited
        self.assertIs(_select_child(parent, random.Random(1), 1), unvisited)

    def test_real_tree_phases_and_reward_backprop(self):
        problem = TinyTreeProblem()
        result = solve(problem, seed=7, budget=128)
        diagnostics = result["diagnostics"]
        tree = {tuple(node["prefix"]): node for node in diagnostics["tree"]}
        self.assertEqual(result["best_score"], 1)
        self.assertEqual(result["best_vector"][0], 1)
        self.assertEqual(diagnostics["queries"], 128)
        self.assertEqual(tree[()]["visits"], 128)
        self.assertEqual(tree[()]["reward_samples"], 128)
        self.assertEqual(tree[()]["reward_sum"], sum(row["score"] for row in problem.history))
        self.assertEqual(tree[(0,)]["mean_score"], 0)
        self.assertEqual(tree[(1,)]["mean_score"], 1)
        self.assertGreater(tree[(1,)]["visits"], tree[(0,)]["visits"])
        self.assertGreater(tree[(0,)]["visits"], 1)  # UCT continues exploring.
        self.assertGreater(diagnostics["selection_steps"], 0)
        self.assertGreater(diagnostics["expansion_steps"], 2)
        self.assertGreater(diagnostics["backprop_steps"], 128)
        self.assertTrue(all(len(step["terminal_leaf"]) == 2 for step in result["trace"]))

    def test_known_non_additive_four_leaf_optimum(self):
        rewards = {(0, 0): 0.3, (0, 1): 0.4, (1, 0): 0.1, (1, 1): 0.9}
        result = solve(TinyTreeProblem(rewards=rewards), seed=42, budget=64)
        # Explicit enumeration is a test-only oracle, not a solver operation.
        expected = max(rewards, key=rewards.get)
        self.assertEqual(tuple(result["best_vector"]), expected)
        self.assertEqual(result["best_score"], rewards[expected])

    def test_seed_replay_and_strict_query_budget(self):
        first = solve(TinyTreeProblem(budget=7), seed=91, budget=20)
        second = solve(TinyTreeProblem(budget=7), seed=91, budget=20)
        self.assertEqual(first, second)
        self.assertEqual(first["diagnostics"]["queries"], 7)
        self.assertEqual(first["diagnostics"]["stop_reason"], "problem_budget")
        self.assertEqual(len([step for step in first["trace"] if step["queried"]]), 7)
        empty = solve(TinyTreeProblem(), budget=0)
        self.assertIsNone(empty["best_vector"])
        self.assertEqual(empty["diagnostics"]["queries"], 0)

    def test_only_full_legal_scheduled_leaves_are_evaluated(self):
        problem = TinyTreeProblem(
            forbidden=[{"vars": [0, 1], "values": [0, 0]}],
            resources=[{"name": "beds", "capacity": 1, "usage": [[0, 1], [0, 1]]}],
            schedule=lambda vector: vector != (0, 1),
            rewards={(1, 0): 4.0})
        result = solve(problem, seed=11, budget=12)
        self.assertEqual(result["best_vector"], [1, 0])
        self.assertEqual(len(problem.history), 12)
        self.assertTrue(all(row["vector"] == [1, 0] for row in problem.history))

    def test_unsupported_observation_is_missing_and_consumes_budget(self):
        problem = TinyTreeProblem(domains=(2,), rewards={(1,): -3.0}, unsupported={(0,)})
        result = solve(problem, seed=42, budget=8)
        tree = {tuple(node["prefix"]): node for node in result["diagnostics"]["tree"]}
        self.assertEqual(result["best_vector"], [1])
        self.assertEqual(result["best_score"], -3)
        self.assertEqual(result["diagnostics"]["queries"], 8)
        self.assertEqual(result["diagnostics"]["invalid_evaluations"], 1)
        self.assertIsNone(tree[(0,)]["mean_score"])
        self.assertEqual(tree[(0,)]["reward_samples"], 0)
        self.assertEqual(tree[()]["reward_samples"], 7)
        self.assertEqual(tree[()]["mean_score"], -3)
        self.assertTrue(all(row["score"] is None for row in result["trace"] if not row["valid_reward"]))

    def test_all_unsupported_has_no_best_or_synthetic_zero(self):
        problem = TinyTreeProblem(domains=(2,), unsupported={(0,), (1,)})
        result = solve(problem, budget=12)
        self.assertEqual(result["diagnostics"]["queries"], 2)
        self.assertEqual(result["diagnostics"]["valid_rollouts"], 0)
        self.assertIsNone(result["best_vector"])
        self.assertIsNone(result["best_score"])
        self.assertIsNone(result["diagnostics"]["tree"][0]["mean_score"])

    def test_generation_limit_does_not_claim_infeasibility_or_spend_F(self):
        problem = TinyTreeProblem(metadata={"mcts": {"rollout_node_limit": 1,
                                                     "iteration_limit": 1}})
        problem.initial = (2, 0)  # Skip baseline; this test isolates rollout generation.
        result = solve(problem, budget=5)
        self.assertEqual(result["diagnostics"]["queries"], 0)
        self.assertEqual(result["diagnostics"]["truncated_rollouts"], 1)
        self.assertEqual(result["diagnostics"]["stop_reason"], "tree_iteration_limit")
        self.assertFalse(result["diagnostics"]["tree"][0]["closed"])

    def test_negative_resource_usage_is_not_unsoundly_pruned(self):
        spec = {"resources": [{"capacity": 0, "usage": [[2], [-2]]}]}
        self.assertTrue(_partial_feasible((0,), spec, [[0], [0]]))

    def test_infeasible_initial_does_not_make_reward_scale_infinite(self):
        problem = TinyTreeProblem()
        problem.cheap = lambda vector: -math.inf
        result = solve(problem, budget=3)
        self.assertEqual(result["diagnostics"]["reward_scale"], 1)
        self.assertEqual(result["diagnostics"]["queries"], 3)

    def test_unknown_schedule_is_not_infeasible_or_a_zero_reward(self):
        def unknown(vector):
            raise RuntimeError("Finite scheduler budget exhausted")

        problem = TinyTreeProblem(schedule=unknown,
                                  metadata={"mcts": {"iteration_limit": 2}})
        result = solve(problem, budget=3)
        self.assertEqual(result["diagnostics"]["queries"], 0)
        self.assertEqual(result["diagnostics"]["unknown_schedule_rollouts"], 2)
        self.assertFalse(result["diagnostics"]["tree"][0]["closed"])
        self.assertIsNone(result["best_score"])
        self.assertTrue(all("schedule_check_unknown" in row["reason"] for row in result["trace"]))


if __name__ == "__main__":
    unittest.main()
