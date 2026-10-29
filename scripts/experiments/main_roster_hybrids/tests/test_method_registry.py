"""Registry tests use synthetic responses only; they never start a native oracle."""
from __future__ import annotations

import copy
import importlib
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
registry = importlib.import_module("method_registry")


def public_spec():
    # A dense three-variable factor exercises real higher-order public-G support.
    return {
        "id": "registry-toy-v1", "domains": [2, 2, 2], "initial": [0, 0, 0],
        "unary": [[0, 0], [0, 0], [0, 0]],
        "factors": [{"vars": [0, 1, 2], "table": {
            f"{a},{b},{c}": 10 * a + 3 * b + c
            for a in range(2) for b in range(2) for c in range(2)
        }}],
        "forbidden": [], "resources": [],
        "metadata": {"evaluation_protocol": {
            "kind": "native", "fixed_seed": 42, "short_supported": True,
            "domain_schema_version": 1,
            "metrics": ["exp", "order_lmd", "gold", "change_cost"],
        }},
    }


class RegistryDefinitionsTests(unittest.TestCase):
    def test_fifteen_real_implementations_and_two_distinct_hybrids_are_registered(self):
        old = [row for row in registry.METHOD_REGISTRY.values() if row.legacy_module]
        self.assertEqual(len(old), 15)
        self.assertEqual({row.legacy_module[:3] for row in old}, {f"m{i:02}" for i in range(1, 16)})
        self.assertIn("g_baseline", registry.METHOD_REGISTRY)
        self.assertIn("alns_cp", registry.METHOD_REGISTRY)
        self.assertIn("alns_factor_dp", registry.METHOD_REGISTRY)
        self.assertEqual(registry.canonical_method_id("alns_dp"), "alns_factor_dp")
        self.assertEqual(registry.canonical_method_id("02"), "m02_alns")

    def test_legacy_path_requires_explicit_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(ValueError):
                registry.resolve_legacy_root()


@unittest.skipUnless(os.environ.get("RIIC_ROSTER_METHODS_ROOT"), "set the explicit read-only legacy root")
class RealLegacyRegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(os.environ["RIIC_ROSTER_METHODS_ROOT"]).resolve()
        cls.common = registry.load_legacy_common(cls.root)

    def problem(self, budget=4, *, spec=None, invalid=False, short_high=False):
        calls = []
        def evaluator(vector, *, fidelity, seed):
            calls.append((tuple(vector), fidelity, seed))
            score = (1_000_000 if fidelity == "short" and short_high else 100 + sum(vector))
            return {"valid": not invalid, "score": score if not invalid else None,
                    "metrics": {"exp": 10 + vector[0], "order_lmd": 20 + vector[1],
                                "gold": 5 + vector[2], "change_cost": sum(vector)},
                    "shared_cache_hit": len(calls) > 1 and tuple(vector) == calls[0][0],
                    "evidence_type": "synthetic-registry-test-only"}
        return self.common.Problem(spec or public_spec(), evaluator, budget=budget), calls

    def run_method(self, name, problem, budget):
        return registry.run_method(name, problem, seed=42, budget=budget, legacy_root=self.root)

    def test_real_common_is_cached_by_source_and_no_bytecode_is_enabled(self):
        self.assertIs(self.common, registry.load_legacy_common(self.root))
        self.assertTrue(sys.dont_write_bytecode)
        self.assertEqual(Path(self.common.__file__).resolve(), self.root / "common.py")

    def test_all_fifteen_modules_are_really_loaded_and_charge_two_and_four_budgets(self):
        coverage = []
        for budget in (2, 4):
            for identifier, definition in registry.METHOD_REGISTRY.items():
                with self.subTest(method=identifier, budget=budget):
                    problem, calls = self.problem(budget)
                    result = self.run_method(identifier, problem, budget)
                    coverage.append({"method": identifier, "budget": budget, "result": result,
                                     "toy_evaluator_calls": len(calls), "native_F_calls": 0,
                                     "history": copy.deepcopy(problem.history)})
                    if identifier in ("m09_ranking", "m10_renewal"):
                        self.assertEqual(result["status"], "unsupported")
                        self.assertEqual(calls, [])
                        continue
                    self.assertIn(result["status"], ("supported_full", "supported_reduced"), result)
                    self.assertGreater(len(problem.history), 0, result)
                    self.assertLessEqual(len(problem.history), budget)
                    self.assertEqual(tuple(problem.history[0]["vector"]), problem.initial)
                    self.assertEqual(problem.history[0]["fidelity"], "full")
                    self.assertEqual(problem.history[0]["seed"], 42)
                    self.assertEqual(len(calls), len(problem.history))
                    filename = definition.legacy_module + ".py" if definition.legacy_module else (
                        "alns_hybrids.py" if definition.hybrid_entry else "method_registry.py")
                    self.assertTrue(result["registry"]["implementation"]["path"].endswith(filename))
                    if result["best_vector"] is not None:
                        self.assertTrue(any(row["valid"] and row["fidelity"] == "full" and
                                            row["vector"] == result["best_vector"] for row in problem.history))
        output = os.environ.get("RIIC_HYBRID_COVERAGE_OUT")
        if output:
            Path(output).write_text(json.dumps(self.common.json_evidence(coverage), indent=2, allow_nan=False), encoding="utf-8")

    def test_ocba_and_renewal_actual_solve_can_run_only_under_their_explicit_toy_assumptions(self):
        for identifier in ("m09_ranking", "m10_renewal"):
            for budget in (2, 4):
                with self.subTest(method=identifier, budget=budget):
                    problem = self.common.make_toy_problem(budget=budget)
                    result = self.run_method(identifier, problem, budget)
                    self.assertIn(result["status"], ("supported_full", "supported_reduced"), result)
                    self.assertGreater(len(problem.history), 0)
                    self.assertLessEqual(len(problem.history), budget)
                    self.assertTrue(result["registry"]["implementation"]["path"].endswith(registry.METHOD_REGISTRY[identifier].legacy_module + ".py"))

    def test_declared_dense_G_missing_key_is_unsupported_unless_explicitly_excluded(self):
        spec = public_spec()
        spec["metadata"].update(modelKind="fully-measured-high-order-table", initialStatus="ready")
        del spec["factors"][0]["table"]["1,1,1"]
        problem, calls = self.problem(2, spec=spec)
        result = self.run_method("g_baseline", problem, 2)
        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(calls, [])
        spec["forbidden"].append({"vars": [0, 1, 2], "values": [1, 1, 1]})
        problem, _ = self.problem(2, spec=spec)
        self.assertEqual(self.run_method("g_baseline", problem, 2)["status"], "supported_full")

    def test_multifidelity_short_queries_are_charged_and_never_select_a_short_winner(self):
        problem, calls = self.problem(4, short_high=True)
        result = self.run_method("m08_multifidelity", problem, 4)
        self.assertEqual(len(calls), 4)
        self.assertEqual(result["registry"]["budget"]["short"], 2)
        self.assertEqual(result["registry"]["budget"]["full"], 2)
        self.assertLess(result["best_score"], 1000)
        problem2, _ = self.problem(2)
        reduced = self.run_method("m08_multifidelity", problem2, 2)
        self.assertEqual(reduced["status"], "supported_reduced")

    def test_bo_and_gnn_report_actual_low_budget_mechanisms_and_training_input_version(self):
        for name in ("m07_bayes", "m15_gnn_rl"):
            problem, _ = self.problem(2)
            result = self.run_method(name, problem, 2)
            self.assertEqual(result["status"], "supported_reduced")
        problem, _ = self.problem(4)
        result = self.run_method("m15_gnn_rl", problem, 4)
        self.assertGreater(result["diagnostics"]["training"]["optimizer_updates"], 0)
        self.assertEqual(result["registry"]["training_input"]["domain_schema_version"], 1)
        self.assertEqual(len(result["registry"]["training_input"]["public_spec_sha256"]), 64)
        self.assertEqual(result["registry"]["budget"]["logical_queries"], len(problem.history))
        costs = result["registry"]["training_cost"]
        self.assertEqual(costs["charged_full_training_queries"] + costs["frozen_validation_queries"] + costs["public_G_deployment_queries"], len(problem.history))
        self.assertIsNone(costs["separate_training_wall_ms"])

    def test_benders_without_declared_scheduling_is_reduced_not_rest_schedule_proof(self):
        problem, _ = self.problem(2)
        result = self.run_method("m05_benders", problem, 2)
        self.assertEqual(result["status"], "supported_reduced")
        self.assertIn("missing_scheduling_metadata", result["registry"]["capability"]["limitations"])

    def test_gnn_failure_keeps_charged_history_and_restores_problem_without_a_second_exception(self):
        for query_before_failure in (False, True):
            with self.subTest(query_before_failure=query_before_failure):
                problem, calls = self.problem(4)
                original_evaluate = problem.evaluate
                def fail(actual, *, seed, budget):
                    if query_before_failure:
                        actual.evaluate(actual.initial, seed=seed)
                    raise RuntimeError("deliberate toy GNN failure")
                with patch.object(registry, "_load_implementation", return_value=(fail, {})):
                    result = self.run_method("m15_gnn_rl", problem, 2)
                self.assertEqual(result["status"], "protocol_error")
                self.assertIsNone(result["best_vector"])
                self.assertEqual(len(problem.history), int(query_before_failure))
                self.assertEqual(len(calls), int(query_before_failure))
                self.assertEqual(problem.budget, 4)
                self.assertEqual(problem.evaluate, original_evaluate)
                self.assertEqual(result["registry"]["training_cost"]["optimizer_updates"], 0)

    def test_invalid_or_unknown_G_is_not_zero_and_unsupported_makes_no_F_calls(self):
        spec = public_spec()
        spec["factors"][0]["table"]["1,1,1"] = None
        problem, calls = self.problem(2, spec=spec)
        result = self.run_method("m01_pool", problem, 2)
        self.assertEqual(result["status"], "unsupported")
        self.assertIsNone(result["best_score"])
        self.assertEqual(calls, [])
        self.assertEqual(problem.history, [])

    def test_initial_cache_and_duplicate_queries_all_charge_without_replacing_the_problem(self):
        problem, calls = self.problem(4)
        def duplicate_solver(actual, *, seed, budget):
            self.assertIs(actual, problem)
            rows = [actual.evaluate(actual.initial, seed=seed) for _ in range(budget)]
            return {"best_vector": rows[-1]["vector"], "diagnostics": {}, "proof_scope": "test only"}
        with patch.object(registry, "_load_implementation", return_value=(duplicate_solver, {})):
            result = self.run_method("m01_pool", problem, 4)
        self.assertEqual(len(calls), 4)
        self.assertEqual(result["registry"]["budget"]["initial_queries"], 4)
        self.assertEqual(result["registry"]["budget"]["duplicates"], 3)
        self.assertEqual(result["registry"]["budget"]["cache_hits"], 3)

    def test_guard_stops_extra_evaluation_and_rejects_unqueried_or_short_only_winners(self):
        problem, calls = self.problem(4)
        def broken(actual, *, seed, budget):
            actual.evaluate(actual.initial, seed=seed)
            for _ in range(9):
                actual.evaluate((1, 1, 1), fidelity="short", seed=seed)
            return {"best_vector": [1, 1, 1], "best_score": 1e20, "diagnostics": {}, "proof_scope": "broken toy"}
        with patch.object(registry, "_load_implementation", return_value=(broken, {})):
            result = self.run_method("m01_pool", problem, 2)
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(problem.history), 2)
        self.assertEqual(result["status"], "protocol_error")
        self.assertIsNone(result["best_vector"])
        self.assertEqual(problem.budget, 4)

    def test_seed_protocol_and_initial_order_violation_never_call_the_toy_oracle(self):
        for candidate, seed in (((1, 1, 1), 42), ((0, 0, 0), 43)):
            problem, calls = self.problem(2)
            def broken(actual, *, seed=seed, budget=2):
                actual.evaluate(candidate, seed=seed)
                return {"best_vector": list(candidate), "diagnostics": {}, "proof_scope": "broken toy"}
            # Capture the requested illegal seed instead of the run's legal seed.
            def invoke(actual, **kwargs):
                return broken(actual, seed=seed, budget=kwargs["budget"])
            with patch.object(registry, "_load_implementation", return_value=(invoke, {})):
                result = self.run_method("m01_pool", problem, 2)
            self.assertEqual(result["status"], "protocol_error")
            self.assertEqual(calls, [])
            self.assertEqual(len(problem.history), 1)

    def test_later_replication_seed_is_counted_unsupported_and_never_clamped(self):
        problem, calls = self.problem(4)
        def replicate(actual, *, seed, budget):
            row = actual.evaluate(actual.initial, seed=seed)
            rejected = actual.evaluate(actual.initial, seed=seed + 1)
            self.assertIsNone(rejected["score"])
            self.assertEqual(rejected["reason"], "unsupported-seed")
            return {"best_vector": row["vector"], "diagnostics": {}, "proof_scope": "toy only"}
        with patch.object(registry, "_load_implementation", return_value=(replicate, {})):
            result = self.run_method("m08_multifidelity", problem, 4)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(problem.history), 2)
        self.assertEqual(problem.history[1]["seed"], 43)
        self.assertEqual(result["registry"]["budget"]["logical_queries"], 2)
        self.assertEqual(result["status"], "protocol_error")

    def test_invalid_F_does_not_manufacture_zero_and_existing_history_is_not_training_input(self):
        problem, _ = self.problem(2, invalid=True)
        result = self.run_method("g_baseline", problem, 2)
        self.assertIsNone(result["best_vector"])
        self.assertIsNone(result["best_score"])
        other, calls = self.problem(2)
        other.evaluate(other.initial)
        previous = copy.deepcopy(other.history)
        result = self.run_method("m15_gnn_rl", other, 1)
        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(other.history, previous)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
