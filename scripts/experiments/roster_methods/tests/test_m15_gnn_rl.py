"""Algorithm-kernel checks; these synthetic oracles do not model the game."""

import copy
import importlib.util
import itertools
from pathlib import Path
import sys
import unittest

import torch


MODULE_PATH = Path(__file__).resolve().parents[1] / "methods" / "m15_gnn_rl.py"
MODULE_SPEC = importlib.util.spec_from_file_location("roster_m15_test_module", MODULE_PATH)
m15 = importlib.util.module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = m15
MODULE_SPEC.loader.exec_module(m15)


class TinyProblem:
    def __init__(self, spec=None, *, scene_id="train", budget=20, invalid=False):
        self.spec = copy.deepcopy(spec or {
            "id": scene_id, "domains": [2, 2], "initial": [0, 0],
            "unary": [[0.0, 1.0], [0.0, 2.0]],
            "factors": [{"vars": [0, 1], "table": {"0,0": 0, "0,1": -2, "1,0": 1, "1,1": 4}}],
            "forbidden": [], "resources": [],
        })
        self.scene_id = scene_id
        self.domains = [range(size) for size in self.spec["domains"]]
        self.initial = tuple(self.spec["initial"])
        self.remaining = budget
        self.history = []
        self.invalid = invalid

    def feasible(self, vector):
        if len(vector) != len(self.domains) or any(v not in d for v, d in zip(vector, self.domains)):
            return False
        if any(all(vector[i] == v for i, v in zip(f["vars"], f["values"])) for f in self.spec.get("forbidden", [])):
            return False
        return all(sum(r["usage"][i][v] for i, v in enumerate(vector)) <= r["capacity"] for r in self.spec.get("resources", []))

    def schedule_feasible(self, vector):
        return not (self.spec.get("reject_11") and tuple(vector) == (1, 1))

    def full_score(self, vector):
        # F includes a term absent from the public cheap factor graph.
        return 5.0 + self.cheap(vector) + 3.0 * int(tuple(vector) == (1, 0))

    def cheap(self, vector):
        unary = sum(self.spec["unary"][i][v] for i, v in enumerate(vector))
        factors = sum(f["table"].get(",".join(str(vector[i]) for i in f["vars"]), 0) for f in self.spec.get("factors", []))
        return unary + factors

    def vectors(self, feasible_only=True):
        for vector in itertools.product(*self.domains):
            if not feasible_only or self.feasible(vector):
                yield vector

    def evaluate(self, vector, fidelity="full", seed=None):
        if self.remaining <= 0:
            raise RuntimeError("budget exhausted")
        self.remaining -= 1
        valid = self.feasible(vector) and self.schedule_feasible(vector) and not self.invalid
        result = {
            "vector": list(vector), "valid": valid,
            "score": self.full_score(vector) if valid else None,
            "metrics": {}, "fidelity": fidelity, "seed": seed,
        }
        self.history.append(result)
        return result


class GnnReinforceTests(unittest.TestCase):
    def setUp(self):
        torch.set_num_threads(1)

    def test_real_message_passing_depends_on_edges_and_backpropagates(self):
        problem = TinyProblem()
        graph = m15.build_graph(problem, [None, None])
        with torch.random.fork_rng(devices=[]):
            torch.manual_seed(3)
            network = m15.GraphPolicy()
        no_edges = m15.GraphState(graph.features, torch.empty((2, 0), dtype=torch.long), 2)
        embedded = network.encode(graph)
        self.assertFalse(torch.allclose(embedded[:2], network.encode(no_edges)[:2]))
        logits = network(graph, 0, m15._action_features(problem, 0))
        (logits[1] - logits[0]).backward()
        self.assertGreater(sum(float(p.grad.abs().sum()) for p in network.message_layers.parameters()), 0)

    def test_mask_covers_forbidden_resources_and_final_schedule_check(self):
        problem = TinyProblem()
        problem.spec["forbidden"] = [{"vars": [0, 1], "values": [0, 1]}]
        problem.spec["resources"] = [{"name": "cap", "capacity": 1, "usage": [[0, 1], [0, 1]]}]
        self.assertEqual(m15.legal_action_mask(problem, [0, None], 1).tolist(), [True, False])
        self.assertEqual(m15.legal_action_mask(problem, [1, None], 1).tolist(), [True, False])
        problem.spec["forbidden"] = []
        problem.spec["resources"] = []
        problem.spec["reject_11"] = True
        self.assertEqual(m15.legal_action_mask(problem, [1, None], 1).tolist(), [True, False])

    def test_resource_lower_bound_preserves_negative_remaining_usage(self):
        problem = TinyProblem()
        problem.spec["resources"] = [{"name": "signed", "capacity": 1, "usage": [[0, 2], [-1, -1]]}]
        self.assertEqual(m15.legal_action_mask(problem, [None, None], 0).tolist(), [True, True])

    def test_terminal_F_updates_encoder_and_parameters_with_exact_budget(self):
        problem = TinyProblem(budget=5)
        policy, diagnostics = m15.train_policy([problem], seed=42, budget=5)
        self.assertEqual(diagnostics["query_count"], 5)
        self.assertEqual(len(problem.history), 5)
        self.assertEqual(diagnostics["optimizer_updates"], 4)
        self.assertEqual(diagnostics["records"][0]["role"], "initial_baseline")
        self.assertGreater(diagnostics["max_gradient_l2"], 0)
        self.assertGreater(diagnostics["max_encoder_gradient_l2"], 0)
        self.assertGreater(diagnostics["parameter_delta_l2"], 0)
        self.assertGreater(diagnostics["encoder_parameter_delta_l2"], 0)
        for record, result in zip(diagnostics["records"], problem.history):
            self.assertEqual(record["terminal_F_reward"], result["score"])
            self.assertEqual(record["terminal_F_reward"], problem.full_score(record["vector"]))
            self.assertEqual(result["fidelity"], "full")
        self.assertTrue(all(not p.requires_grad and p.grad is None for p in policy.network.parameters()))

    def test_reward_sign_reverses_the_policy_update_not_just_entropy(self):
        initial, _ = m15.train_policy([], seed=42, budget=0)
        positive = TinyProblem(budget=2)
        negative = TinyProblem(budget=2)
        positive.full_score = lambda vector: float(sum(vector))
        negative.full_score = lambda vector: -float(sum(vector))
        positive_policy, _ = m15.train_policy([positive], seed=42, budget=2)
        negative_policy, _ = m15.train_policy([negative], seed=42, budget=2)
        self.assertEqual([r["vector"] for r in positive.history], [r["vector"] for r in negative.history])
        initial_parameters = m15._parameter_vector(initial.network)
        positive_delta = m15._parameter_vector(positive_policy.network) - initial_parameters
        negative_delta = m15._parameter_vector(negative_policy.network) - initial_parameters
        self.assertLess(float(torch.dot(positive_delta, negative_delta)), 0.0)

    def test_explicit_holdout_is_frozen_and_uses_only_its_own_scores(self):
        train = TinyProblem(budget=4)
        policy, training = m15.train_policy([train], seed=7, budget=4)
        holdout = TinyProblem(scene_id="holdout", budget=2)
        holdout.spec["unary"] = [[-20, -10], [-8, -6]]
        before = m15.parameter_digest(policy.network)
        result = m15.evaluate_frozen_policy(policy, holdout, seed=9, budget=1)
        self.assertEqual(training["query_count"], 4)
        self.assertEqual(result["diagnostics"]["query_count"], 1)
        self.assertEqual(result["diagnostics"]["optimizer_updates"], 0)
        self.assertEqual(before, m15.parameter_digest(policy.network))
        self.assertTrue(result["diagnostics"]["parameters_unchanged"])
        self.assertFalse(result["diagnostics"]["training_input_reused"])
        self.assertEqual(result["best_score"], holdout.history[0]["score"])
        self.assertLess(result["best_score"], 0)
        self.assertTrue(all(p.grad is None for p in policy.network.parameters()))

    def test_renaming_identical_inputs_does_not_claim_holdout(self):
        train = TinyProblem(budget=2)
        policy, _ = m15.train_policy([train], budget=2)
        renamed = TinyProblem(scene_id="renamed", budget=1)
        result = m15.evaluate_frozen_policy(policy, renamed, budget=1)
        self.assertTrue(result["diagnostics"]["training_input_reused"])

    def test_solve_separates_frozen_initial_and_training_best_and_respects_remaining(self):
        problem = TinyProblem(budget=6)
        result = m15.solve(problem, seed=42, budget=6)
        diagnostics = result["diagnostics"]
        self.assertEqual(diagnostics["query_count"], 6)
        self.assertEqual(diagnostics["training"]["query_count"] + diagnostics["public_G_pool"]["query_count"], 5)
        self.assertEqual(diagnostics["frozen_validation"]["query_count"], 1)
        frozen_record = diagnostics["frozen_validation"]["records"][0]
        self.assertEqual(result["frozen_policy_vector"], frozen_record["vector"])
        self.assertEqual(result["frozen_policy_score"], frozen_record["score"])
        self.assertFalse(diagnostics["training_best_used_for_selection"])
        self.assertGreaterEqual(result["best_score"], problem.history[0]["score"])
        self.assertFalse(diagnostics["generalization_evidence"])
        self.assertTrue(diagnostics["frozen_validation"]["training_input_reused"])
        tiny = TinyProblem(budget=2)
        self.assertEqual(m15.solve(tiny, budget=99)["diagnostics"]["query_count"], 2)

    def test_public_G_pool_is_exact_bounded_and_has_no_F_labels(self):
        problem = TinyProblem()
        candidates, diagnostics = m15.public_G_maximizers(problem)
        reference = max(problem.cheap(v) for v in itertools.product(*problem.domains))
        self.assertEqual(candidates, [(1, 1)])
        self.assertEqual(diagnostics["maximum_G"], reference)
        self.assertEqual(diagnostics["F_queries"], 0)
        self.assertEqual(problem.history, [])
        omitted, unsupported = m15.public_G_maximizers(problem, enumeration_limit=3)
        self.assertEqual(omitted, [])
        self.assertEqual(unsupported["status"], "omitted_domain_above_limit")

    def _shared_incumbent_problem(self, budget):
        sys.path.insert(0, str(MODULE_PATH.parents[1]))
        from common import Problem
        return Problem(
            {"id": "shared-incumbent", "domains": [2], "initial": [0], "unary": [[0, 1]]},
            lambda vector, *, fidelity, seed: {
                "valid": True, "score": 100 if vector[0] == 0 else 0, "metrics": {},
            },
            budget=budget,
        )

    def test_budget_one_evaluates_and_protects_legal_initial_before_G_or_policy(self):
        problem = self._shared_incumbent_problem(1)
        result = m15.solve(problem, seed=42, budget=1)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["best_score"], 100)
        self.assertEqual([r["vector"] for r in problem.history], [[0]])
        self.assertEqual(result["diagnostics"]["query_count"], 1)
        self.assertEqual(result["diagnostics"]["training"]["optimizer_updates"], 0)
        self.assertEqual(result["diagnostics"]["rl_training_status"], "not_trained_insufficient_budget")
        self.assertIsNone(result["frozen_policy_vector"])
        self.assertEqual(result["diagnostics"]["frozen_validation"]["query_count"], 0)

    def test_budget_two_preserves_initial_and_does_not_label_G_check_as_RL(self):
        problem = self._shared_incumbent_problem(2)
        result = m15.solve(problem, seed=42, budget=2)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["best_score"], 100)
        self.assertEqual([r["vector"] for r in problem.history], [[0], [1]])
        self.assertEqual(result["diagnostics"]["query_count"], 2)
        self.assertEqual(result["diagnostics"]["public_G_pool"]["query_count"], 1)
        self.assertEqual(result["diagnostics"]["selection_source"], "verified_initial_incumbent")
        self.assertEqual(result["diagnostics"]["training"]["optimizer_updates"], 0)
        self.assertEqual(result["diagnostics"]["rl_training_status"], "not_trained_insufficient_budget")
        self.assertIsNone(result["frozen_policy_vector"])

    def test_action_features_keep_large_unary_differences_and_condition_factors(self):
        problem = TinyProblem()
        problem.spec["unary"][0] = [10000.0, 10001.0]
        features = m15._action_features(problem, 0)
        self.assertEqual(features[:, 0].tolist(), [-0.5, 0.5])
        factor = {"vars": [0, 1], "table": {"0,1": 10000.0, "1,0": 20000.0}}
        self.assertEqual(m15._factor_expectation(problem, factor, [None, None]), 7500.0)
        self.assertEqual(m15._factor_expectation(problem, factor, [0, None]), 5000.0)
        self.assertEqual(m15._factor_expectation(problem, factor, [None, 1]), 5000.0)
        problem.spec["factors"] = [factor]
        left = m15._action_features(problem, 0, [None, 0])
        right = m15._action_features(problem, 0, [None, 1])
        self.assertGreater(float(left[1, 5]), float(left[0, 5]))
        self.assertLess(float(right[1, 5]), float(right[0, 5]))

    def test_invalid_F_is_never_zero_reward_or_an_optimizer_update(self):
        problem = TinyProblem(budget=3, invalid=True)
        policy, training = m15.train_policy([problem], budget=3)
        self.assertEqual(training["query_count"], 3)
        self.assertEqual(training["optimizer_updates"], 0)
        self.assertEqual(training["parameter_delta_l2"], 0)
        self.assertTrue(all(not r["accepted_reward"] for r in training["records"]))
        invalid_holdout = TinyProblem(scene_id="invalid", budget=1, invalid=True)
        result = m15.evaluate_frozen_policy(policy, invalid_holdout, budget=1)
        self.assertIsNone(result["best_vector"])
        self.assertIsNone(result["best_score"])

    def test_impossible_domain_and_zero_budget_make_no_F_call(self):
        impossible = TinyProblem()
        impossible.spec["forbidden"] = [{"vars": [0], "values": [v]} for v in range(2)]
        result = m15.solve(impossible, budget=4)
        self.assertIsNone(result["best_vector"])
        self.assertEqual(result["diagnostics"]["query_count"], 0)
        self.assertEqual(len(impossible.history), 0)
        zero = TinyProblem()
        self.assertIsNone(m15.solve(zero, budget=0)["best_vector"])
        self.assertEqual(zero.history, [])

    def test_seed_is_reproducible_and_no_hidden_enumeration_is_needed(self):
        first = TinyProblem(budget=4)
        second = TinyProblem(budget=4)
        a, _ = m15.train_policy([first], seed=123, budget=4)
        b, _ = m15.train_policy([second], seed=123, budget=4)
        self.assertEqual(a.digest, b.digest)
        self.assertEqual([r["vector"] for r in first.history], [r["vector"] for r in second.history])
        # Exhaustive values are an independent test reference, never used by train.
        reference = {v: first.full_score(v) for v in itertools.product(*first.domains)}
        for evaluated in first.history:
            self.assertEqual(evaluated["score"], reference[tuple(evaluated["vector"])])


if __name__ == "__main__":
    unittest.main(verbosity=2)
