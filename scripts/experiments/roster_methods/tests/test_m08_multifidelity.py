"""Mechanism tests; these toy oracles make no claim about real RIIC output."""

import importlib.util
import math
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "methods" / "m08_multifidelity.py"
SPEC = importlib.util.spec_from_file_location("m08_multifidelity", MODULE_PATH)
METHOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(METHOD)
COMMON_SPEC = importlib.util.spec_from_file_location("m08_public_common", MODULE_PATH.parents[1] / "common.py")
COMMON = importlib.util.module_from_spec(COMMON_SPEC)
COMMON_SPEC.loader.exec_module(COMMON)


class ToyProblem:
    def __init__(self, *, budget=16, cheap=None, short=None, full=None, size=25):
        self.domains = [range(size)]
        self.initial = (0,)
        self.scene_id = "m08-mechanism-toy"
        self.metadata = {"oracle": "explicit toy, not native RIIC"}
        self.remaining = budget
        self.history = []
        self.cheap_values = cheap or {i: float(i) for i in range(size)}
        self.short_values = short or self.cheap_values
        self.full_values = full or self.cheap_values
        self.cheap_queries = []

    def feasible(self, vector):
        return len(vector) == 1 and vector[0] in self.domains[0]

    def schedule_feasible(self, vector):
        return True

    def cheap(self, vector):
        self.cheap_queries.append(tuple(vector))
        return self.cheap_values[vector[0]]

    def evaluate(self, vector, fidelity="full", seed=None):
        if self.remaining <= 0:
            raise AssertionError("method exceeded oracle budget")
        if fidelity not in ("short", "full"):
            raise AssertionError("cheap features must not masquerade as native simulation")
        self.remaining -= 1
        values = self.short_values if fidelity == "short" else self.full_values
        score = values[vector[0]]
        record = {
            "vector": list(vector), "valid": score is not None,
            "score": score, "metrics": {}, "fidelity": fidelity,
            "seed": seed, "elapsed_ms": 0,
        }
        self.history.append(record)
        return record


class MultiFidelityTests(unittest.TestCase):
    def test_publicly_forbidden_initial_does_not_spend_query_or_recheck_budget(self):
        spec = {
            "id": "m08-invalid-initial", "domains": [2], "initial": [0],
            "forbidden": [{"vars": [0], "values": [0]}],
        }
        for budget in (1, 16):
            with self.subTest(budget=budget):
                problem = COMMON.Problem(spec, lambda vector, **kw: {"valid": True, "score": -3}, budget=budget)
                result = METHOD.solve(problem, budget=budget)
                self.assertEqual(result["best_vector"], [1])
                self.assertEqual(result["best_score"], -3)
                self.assertEqual(len(problem.history), budget)
                self.assertTrue(all(q["vector"] == [1] and q["valid"] for q in problem.history))
                initial = result["diagnostics"]["initial_validation"]
                self.assertFalse(initial["eligible"])
                self.assertEqual(initial["reason"], "structurally-infeasible")

    def test_publicly_unschedulable_initial_is_skipped_with_its_reason(self):
        spec = {
            "id": "m08-unschedulable-initial", "domains": [2], "initial": [0],
            "scheduling": {"horizon": 1, "beds": 1, "jobs": [
                {"id": "impossible", "var": 0, "values": [0], "duration": 2,
                 "release": 0, "deadline": 1},
            ]},
        }
        for budget in (1, 16):
            with self.subTest(budget=budget):
                problem = COMMON.Problem(spec, lambda vector, **kw: {"valid": True, "score": -3}, budget=budget)
                result = METHOD.solve(problem, budget=budget)
                self.assertEqual(result["best_vector"], [1])
                self.assertTrue(all(q["vector"] == [1] for q in problem.history))
                self.assertEqual(result["diagnostics"]["initial_validation"]["reason"], "finite-schedule-infeasible")

    def test_actual_queries_and_successive_reduction(self):
        problem = ToyProblem()
        result = METHOD.solve(problem, seed=42, budget=16)
        diagnostic = result["diagnostics"]
        rounds = {record["stage"]: record for record in diagnostic["rounds"]}
        self.assertEqual(diagnostic["queries_used"], 16)
        self.assertEqual(diagnostic["query_counts"], {"short": 9, "full": 7})
        self.assertEqual(diagnostic["candidate_count"], 24)
        self.assertEqual(rounds["cheap"]["evaluated_count"], 24)
        self.assertEqual(rounds["cheap"]["advanced_count"], 9)
        self.assertEqual(rounds["short"]["promoted_count"], 5)
        self.assertEqual(rounds["full"]["evaluated_count"], 6)
        self.assertEqual(len(rounds["short"]["discarded"]), 4)
        self.assertIsNotNone(rounds["cheap"]["exploration"])
        self.assertIsNotNone(rounds["short"]["audit"])
        self.assertEqual(diagnostic["cheap_calls"], len(problem.cheap_queries))
        self.assertEqual(len(problem.history), 16)
        self.assertTrue(any(
            r["fidelity"] == "full" and r["valid"] and r["vector"] == result["best_vector"]
            for r in problem.history
        ))

    def test_small_finite_domain_scans_only_public_cheap_model_before_halving(self):
        target = (1, 1, 2, 1, 1, 1)
        spec = {
            "id": "m08-public-96", "domains": [2, 2, 3, 2, 2, 2], "initial": [0] * 6,
            "factors": [{"vars": list(range(6)), "table": {"1,1,2,1,1,1": 1000}}],
        }
        problem = COMMON.Problem(
            spec, lambda vector, **kw: {"valid": True, "score": 1000 if vector == target else 0}, budget=16,
        )
        result = METHOD.solve(problem, seed=42, budget=16)
        diagnostic = result["diagnostics"]
        self.assertEqual(diagnostic["candidate_count"], 95)
        self.assertEqual(diagnostic["cheap_calls"], 96)
        self.assertEqual(diagnostic["candidate_generation"]["mode"], "complete_public_feasibility_scan")
        self.assertEqual(result["best_vector"], list(target))
        self.assertEqual(len(problem.history), 16)
        self.assertEqual(diagnostic["query_counts"], {"short": 9, "full": 7})

    def test_large_domains_keep_bounded_public_sampling(self):
        result = METHOD.solve(ToyProblem(size=5001), seed=42, budget=16)
        diagnostic = result["diagnostics"]
        self.assertEqual(diagnostic["candidate_generation"]["mode"], "sampled_public_candidates")
        self.assertEqual(diagnostic["candidate_count"], 18)
        self.assertEqual(diagnostic["cheap_calls"], 19)

    def test_sufficient_budget_reserves_complete_fixed_seed_full_coverage(self):
        target = (0, 1, 2, 1, 0, 1)
        spec = {"id": "m08-full-96", "domains": [2, 2, 3, 2, 2, 2], "initial": [0] * 6}
        problem = COMMON.Problem(
            spec, lambda vector, **kw: {"valid": True, "score": 1000 if vector == target else -3}, budget=128,
        )
        result = METHOD.solve(problem, seed=42, budget=128)
        diagnostic = result["diagnostics"]
        self.assertEqual(result["best_vector"], list(target))
        self.assertEqual(diagnostic["query_counts"], {"short": 32, "full": 96})
        self.assertEqual(len(problem.history), 128)
        coverage = diagnostic["finite_full_coverage"]
        self.assertTrue(coverage["fixed_seed_maximum_certified"])
        self.assertEqual(coverage["valid_primary_full_count"], 96)
        self.assertEqual(coverage["unqueried_count"], 0)
        self.assertEqual(coverage["fixed_seed_best_vector"], list(target))

    def test_spare_budget_audits_short_discards_before_rechecking_known_vectors(self):
        problem = ToyProblem(budget=16, size=6)
        result = METHOD.solve(problem, budget=16)
        diagnostic = result["diagnostics"]
        first_recheck = next(i for i, q in enumerate(diagnostic["queries"]) if q["role"] == "full_recheck")
        covered_before_recheck = {tuple(q["vector"]) for q in diagnostic["queries"][:first_recheck] if q["fidelity"] == "full"}
        self.assertEqual(len(covered_before_recheck), 6)
        self.assertEqual(diagnostic["elimination_audit"]["unobserved_short_discards"], 0)
        self.assertTrue(diagnostic["finite_full_coverage"]["fixed_seed_maximum_certified"])
        expansion = next(r for r in diagnostic["rounds"] if r["stage"] == "full_audit_expansion")
        self.assertEqual(expansion["evaluated_count"], 1)

    def test_invalid_full_prevents_a_finite_maximum_certificate(self):
        problem = ToyProblem(budget=9, size=3, full={0: 0, 1: 1, 2: None})
        result = METHOD.solve(problem, budget=9)
        coverage = result["diagnostics"]["finite_full_coverage"]
        self.assertEqual(coverage["unique_primary_full_queried_count"], 3)
        self.assertEqual(coverage["valid_primary_full_count"], 2)
        self.assertFalse(coverage["fixed_seed_maximum_certified"])

    def test_slow_warmup_candidate_overtakes_short_winner_in_full_audit(self):
        # Hand reference: short ranks 1 > 2; full ranks 2 > 1 > initial.
        problem = ToyProblem(
            budget=5, size=3, cheap={0: 0, 1: 10, 2: 1},
            short={0: 0, 1: 10, 2: 1}, full={0: 0, 1: 5, 2: 100},
        )
        result = METHOD.solve(problem, seed=42, budget=5)
        diagnostic = result["diagnostics"]
        self.assertEqual(result["best_vector"], [2])
        self.assertEqual(result["best_score"], 100)
        self.assertEqual(diagnostic["query_counts"], {"short": 2, "full": 3})
        comparison = diagnostic["rank_diagnostics"]["short_vs_full"]
        self.assertEqual(comparison["observed_overlap"], 2)
        self.assertEqual(comparison["reversed_pairs"], 1)
        self.assertAlmostEqual(comparison["spearman_rho"], -1)
        false_eliminations = diagnostic["elimination_audit"]["confirmed_false_eliminations"]
        self.assertEqual(len(false_eliminations), 1)
        self.assertEqual(false_eliminations[0]["vector"], [2])
        self.assertIsNone(diagnostic["elimination_audit"]["global_false_elimination_rate"])

    def test_zero_and_small_budgets_keep_only_full_incumbents(self):
        for budget in range(4):
            with self.subTest(budget=budget):
                problem = ToyProblem(budget=budget)
                result = METHOD.solve(problem, budget=budget)
                self.assertEqual(result["diagnostics"]["queries_used"], budget)
                self.assertEqual(result["diagnostics"]["query_counts"]["short"], 0)
                self.assertEqual(problem.remaining, 0)
                if budget == 0:
                    self.assertIsNone(result["best_vector"])
                    self.assertEqual(result["diagnostics"]["cheap_calls"], 0)
                    self.assertEqual(result["diagnostics"]["candidate_count"], 0)
                    self.assertEqual(result["diagnostics"]["rounds"], [])
                else:
                    self.assertIsNotNone(result["best_vector"])
                    self.assertEqual(problem.history[0]["vector"], [0])
                    self.assertTrue(all(r["fidelity"] == "full" for r in problem.history))

    def test_remaining_oracle_budget_caps_larger_requested_budget(self):
        problem = ToyProblem(budget=2)
        result = METHOD.solve(problem, budget=16)
        self.assertEqual(result["diagnostics"]["query_limit"], 2)
        self.assertEqual(result["diagnostics"]["queries_used"], 2)
        self.assertEqual(problem.remaining, 0)

    def test_invalid_short_is_unranked_and_full_can_still_rescue_it(self):
        problem = ToyProblem(
            budget=5, size=3, short={0: 0, 1: 10, 2: None}, full={0: 0, 1: 5, 2: 100},
        )
        result = METHOD.solve(problem, budget=5)
        short_round = next(r for r in result["diagnostics"]["rounds"] if r["stage"] == "short")
        self.assertEqual(short_round["valid_count"], 1)
        self.assertEqual(result["best_vector"], [2])
        invalid = next(r for r in short_round["records"] if r["vector"] == [2])
        self.assertFalse(invalid["valid"])
        self.assertIsNone(invalid["score"])
        self.assertEqual(result["diagnostics"]["rank_diagnostics"]["short_vs_full"]["observed_overlap"], 1)

    def test_a_short_score_cannot_win_without_matching_full_fidelity(self):
        class WrongFidelity(ToyProblem):
            def evaluate(self, vector, fidelity="full", seed=None):
                record = super().evaluate(vector, fidelity, seed)
                if vector[0] != 0 and fidelity == "full":
                    record["fidelity"] = "short"
                return record

        problem = WrongFidelity(budget=5, size=3)
        result = METHOD.solve(problem, budget=5)
        self.assertEqual(result["best_vector"], [0])
        self.assertEqual(result["diagnostics"]["full_candidates"], [{"vector": [0], "samples": 1, "mean_score": 0.0}])

    def test_spare_queries_replicate_full_at_new_seeds(self):
        problem = ToyProblem(budget=9, size=3)
        result = METHOD.solve(problem, seed=42, budget=9)
        rechecks = [q for q in result["diagnostics"]["queries"] if q["role"] == "full_recheck"]
        self.assertEqual(result["diagnostics"]["queries_used"], 9)
        self.assertEqual(len(rechecks), 4)
        self.assertTrue(all(q["fidelity"] == "full" and q["seed"] > 42 for q in rechecks))
        self.assertTrue(all(math.isfinite(c["mean_score"]) for c in result["diagnostics"]["full_candidates"]))

    def test_reproducible_seed_and_no_hidden_oracle_access(self):
        left = METHOD.solve(ToyProblem(), seed=123, budget=16)
        right = METHOD.solve(ToyProblem(), seed=123, budget=16)
        self.assertEqual(left, right)
        self.assertNotIn("optimal", left["diagnostics"])


if __name__ == "__main__":
    unittest.main()
