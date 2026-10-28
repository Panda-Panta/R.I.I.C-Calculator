"""Algorithm-kernel checks independent of the game's full objective adapter."""

from itertools import product
import json
import math

import numpy as np
import pytest

from scripts.experiments.roster_methods.methods.m07_bayes import (
    GaussianProcess,
    _candidate_pool,
    _one_hot,
    expected_improvement,
    solve,
)


class SmallProblem:
    """A finite oracle with deliberately inaccessible history/held-out storage."""

    def __init__(self, domains=(2, 2, 2), initial=None, budget=16, oracle=None,
                 feasible=None, scheduling=None):
        self.domains = [range(size) for size in domains]
        self.initial = tuple(initial or [0] * len(domains))
        self.remaining = budget
        self.calls = []
        self._function = oracle or (lambda vector: sum((i + 1) * v for i, v in enumerate(vector)))
        self._feasible = feasible or (lambda vector: True)
        self._scheduling = scheduling or (lambda vector: True)

    @property
    def history(self):
        raise AssertionError("Training must not inspect external history/held-out data")

    @property
    def hidden_scores(self):
        raise AssertionError("Only evaluate may access hidden objective values")

    def feasible(self, vector):
        return self._feasible(vector)

    def schedule_feasible(self, vector):
        return self._scheduling(vector)

    def evaluate(self, vector, fidelity="full", seed=None):
        assert self.remaining > 0
        assert self.feasible(vector) and self.schedule_feasible(vector)
        assert fidelity == "full"
        self.remaining -= 1
        self.calls.append(tuple(vector))
        score = self._function(tuple(vector))
        return {"vector": list(vector), "valid": score is not None, "score": score,
                "fidelity": fidelity, "seed": seed}


def test_ei_hand_computable_and_zero_variance_limits():
    actual = expected_improvement([2.0, 4.0, 1.0], [1.0, 0.0, 0.0], 2.0, xi=0.0)
    assert actual == pytest.approx([1.0 / math.sqrt(2.0 * math.pi), 2.0, 0.0])
    # A sufficiently uncertain candidate can outrank a deterministic mean gain.
    assert expected_improvement(0.0, 4.0, 0.0, xi=0.0) > expected_improvement(1.0, 0.0, 0.0, xi=0.0)


def test_gp_matches_independent_two_observation_conditioning():
    x = np.array([[0.0], [1.0]])
    gp = GaussianProcess(length_scale=1.0, noise=1e-6).fit(x, [-1.0, 1.0])
    mean, std = gp.predict([[0.25]])
    correlation = math.exp(-0.5)
    diagonal = 1.0 + 1e-6
    determinant = diagonal**2 - correlation**2
    inverse = np.array([[diagonal, -correlation], [-correlation, diagonal]]) / determinant
    k = np.array([math.exp(-0.25**2 / 2), math.exp(-0.75**2 / 2)])
    assert mean[0] == pytest.approx(k @ inverse @ [-1.0, 1.0])
    assert std[0] ** 2 == pytest.approx(1.0 - k @ inverse @ k)


def test_posterior_changes_and_uncertainty_falls_after_new_f():
    x = np.array([[1.0, 0.0], [0.0, 1.0]])
    before = GaussianProcess().fit(x[:1], [0.0]).predict(x[1:])
    after = GaussianProcess().fit(x, [0.0, 2.0]).predict(x[1:])
    assert after[0][0] > before[0][0] + 1.0
    assert after[1][0] < before[1][0] / 100.0


def test_budget_baseline_model_updates_and_fixed_seed():
    first, second = SmallProblem(budget=6), SmallProblem(budget=6)
    a, b = solve(first, seed=23, budget=6), solve(second, seed=23, budget=6)
    assert a == b
    assert first.calls == second.calls
    assert len(first.calls) == len(set(first.calls)) == 6
    assert first.calls[0] == first.initial
    diagnostics = a["diagnostics"]
    assert diagnostics["baseline"]["score"] == 0.0
    assert diagnostics["baseline"]["status"] == "valid"
    assert [step["training_count"] for step in diagnostics["model_updates"]] == [3, 4, 5]
    for update in diagnostics["model_updates"]:
        assert all(index < update["before_query"] for index in update["training_query_indices"])
    assert all(record["posterior_std"] > 0 for record in diagnostics["evaluations"][3:])


def test_actual_ei_argmax_drives_query_after_initial_design(monkeypatch):
    from scripts.experiments.roster_methods.methods import m07_bayes

    predictions = []
    real_predict = GaussianProcess.predict

    def spy_predict(model, candidates):
        result = real_predict(model, candidates)
        predictions.append((candidates.copy(), result, model.y_scale))
        return result

    monkeypatch.setattr(GaussianProcess, "predict", spy_predict)
    problem = SmallProblem(budget=4)
    result = solve(problem, budget=4)
    features, (means, stds), scale = predictions[0]
    incumbent = max(record["score"] for record in result["diagnostics"]["evaluations"][:3])
    # Independent scalar normal formula rather than using expected_improvement.
    scores = []
    for mean, std in zip(means, stds):
        delta = mean - incumbent - 0.01 * scale
        z = delta / std
        scores.append(delta * (1.0 + math.erf(z / math.sqrt(2.0))) / 2.0
                      + std * math.exp(-z * z / 2.0) / math.sqrt(2.0 * math.pi))
    chosen = _one_hot([problem.calls[-1]], [tuple(d) for d in problem.domains])[0]
    selected_index = next(i for i, feature in enumerate(features) if np.array_equal(chosen, feature))
    assert scores[selected_index] == pytest.approx(max(scores))
    assert result["diagnostics"]["evaluations"][-1]["phase"] == "expected_improvement"


def test_invalid_f_never_becomes_zero_or_model_training_data():
    problem = SmallProblem(domains=(5,), budget=5,
                           oracle=lambda vector: None if vector == (0,) else -float(vector[0]))
    result = solve(problem, budget=5)
    assert result["best_vector"] == [1]
    assert result["best_score"] == -1.0
    assert result["diagnostics"]["baseline"]["score"] is None
    assert result["diagnostics"]["invalid_or_incomplete_count"] == 1
    for update in result["diagnostics"]["model_updates"]:
        assert 1 not in update["training_query_indices"]


def test_incomplete_or_nonfinite_result_is_not_a_training_label():
    class IncompleteProblem(SmallProblem):
        def evaluate(self, vector, fidelity="full", seed=None):
            result = super().evaluate(vector, fidelity, seed)
            if tuple(vector) == (0,):
                result.update(valid=True, score=10**9, fidelity="partial")
            elif tuple(vector) == (2,):
                result.update(valid=True, score=float("nan"))
            return result

    problem = IncompleteProblem(domains=(6,), budget=6, oracle=lambda vector: -float(vector[0]))
    result = solve(problem, budget=6)
    assert result["best_score"] == -1.0
    records = result["diagnostics"]["evaluations"]
    excluded = {record["query"] for record in records if record["vector"] in ([0], [2])}
    assert all(record["score"] is None for record in records if record["query"] in excluded)
    for update in result["diagnostics"]["model_updates"]:
        assert not excluded.intersection(update["training_query_indices"])


def test_public_constraints_and_schedule_are_used_before_f():
    problem = SmallProblem(domains=(3, 3), initial=[2, 2], budget=9,
                           feasible=lambda vector: sum(vector) <= 2,
                           scheduling=lambda vector: vector != (1, 1))
    result = solve(problem, budget=9)
    expected = {vector for vector in product(range(3), repeat=2)
                if sum(vector) <= 2 and vector != (1, 1)}
    assert set(problem.calls) == expected
    assert result["diagnostics"]["baseline"]["status"] == "public_constraints_infeasible"
    assert result["diagnostics"]["query_count"] == 5


def test_best_observed_matches_exhaustive_small_domain_reference():
    function = lambda vector: -7 + vector[0] + 2 * vector[1] + 9 * vector[0] * vector[1]
    problem = SmallProblem(domains=(2, 2), budget=4, oracle=function)
    result = solve(problem, budget=4)
    reference = max((function(vector), vector) for vector in product(range(2), repeat=2))
    assert (result["best_score"], tuple(result["best_vector"])) == reference


def test_oracle_budget_and_empty_budget_do_not_fabricate_best():
    limited = SmallProblem(budget=2)
    result = solve(limited, budget=100)
    assert result["diagnostics"]["query_count"] == 2
    empty = SmallProblem(budget=10)
    result = solve(empty, budget=0)
    assert not empty.calls
    assert result["best_vector"] is None and result["best_score"] is None


def test_unqueried_holdout_scores_cannot_change_training_or_search():
    first = SmallProblem(domains=(3, 3, 3), budget=6)
    original = solve(first, seed=11, budget=6)
    queried = set(first.calls)
    second = SmallProblem(domains=(3, 3, 3), budget=6,
                          oracle=lambda vector: sum((i + 1) * v for i, v in enumerate(vector))
                          if vector in queried else 10**9)
    changed = solve(second, seed=11, budget=6)
    assert original == changed
    assert first.calls == second.calls


def test_large_domain_pool_is_bounded_and_never_queries_f_during_decoding():
    problem = SmallProblem(domains=(4,) * 7, budget=3)
    pool, info = _candidate_pool(problem, [tuple(d) for d in problem.domains],
                                 problem.initial, np.random.default_rng(5), cap=32)
    assert len(pool) == 32
    assert problem.initial in pool
    assert info["complete_domain"] is False
    assert not problem.calls


def test_all_invalid_returns_no_best_and_no_posterior():
    problem = SmallProblem(budget=5, oracle=lambda vector: None)
    result = solve(problem, budget=5)
    assert result["best_vector"] is None and result["best_score"] is None
    assert result["diagnostics"]["model_updates"] == []


def test_common_toy_smoke_json_budget_and_valid_full_best():
    from scripts.experiments.roster_methods.common import make_toy_problem

    problem = make_toy_problem(budget=16)
    result = solve(problem, seed=42, budget=16)
    assert json.loads(json.dumps(result, allow_nan=False)) == result
    assert len(problem.history) == result["diagnostics"]["query_count"] == 16
    assert problem.remaining == 0
    assert all(record["fidelity"] == "full" for record in problem.history)
    best = problem.best()
    assert best is not None
    assert result["best_vector"] == best["vector"]
    assert result["best_score"] == best["score"]
    assert problem.feasible(result["best_vector"])
    assert problem.schedule_feasible(result["best_vector"])


def test_unknown_candidate_schedule_keeps_valid_initial_and_incomplete_evidence():
    class UnknownScheduleProblem(SmallProblem):
        def schedule_feasible(self, vector):
            if tuple(vector) == (1,):
                raise RuntimeError("Finite scheduler budget exhausted; this is not an infeasibility proof")
            return True

    problem = UnknownScheduleProblem(domains=(2,), budget=2, oracle=lambda vector: -4.0)
    result = solve(problem, budget=2)
    assert result["best_vector"] == [0] and result["best_score"] == -4.0
    assert problem.calls == [(0,)]
    assert result["diagnostics"]["baseline"]["status"] == "valid"
    assert result["diagnostics"]["stop_reason"] == "public_feasibility_incomplete"
    pool = result["diagnostics"]["candidate_pool"]
    assert pool["complete_domain"] is False and pool["enumeration_complete"] is True
    checks = pool["feasibility_checks"]
    assert checks["unknown_count"] == 1 and checks["infeasible_count"] == 0
    assert checks["unknown_records"][0]["vector"] == [1]
    assert result["proof_scope"]["public_feasibility_complete"] is False
    json.dumps(result, allow_nan=False)


def test_unknown_initial_schedule_is_not_called_infeasible_or_evaluated():
    class UnknownInitialProblem(SmallProblem):
        def schedule_feasible(self, vector):
            if tuple(vector) == (0,):
                raise RuntimeError("Finite scheduler budget exhausted; this is not an infeasibility proof")
            return True

    problem = UnknownInitialProblem(domains=(3,), budget=2)
    result = solve(problem, budget=2)
    assert result["diagnostics"]["baseline"]["status"] == "public_constraints_unknown"
    assert (0,) not in problem.calls
    assert result["best_vector"] == [2]


def test_categorical_additive_and_mixed_kernels_are_psd():
    vectors = list(product(range(2), repeat=3))
    features = _one_hot(vectors, [(0, 1)] * 3)
    for kernel in ("additive", "mixed"):
        model = GaussianProcess(kernel=kernel, categorical_dimensions=3)
        covariance = model._kernel(features, features)
        assert np.diag(covariance) == pytest.approx(np.ones(len(vectors)))
        assert np.min(np.linalg.eigvalsh(covariance)) >= -1e-12
        model.fit(features[:4], [-4, -2, 1, 2])
        mean, std = model.predict(features[4:])
        assert np.isfinite(mean).all() and np.isfinite(std).all()


def test_affine_cheap_mean_is_learned_only_from_supplied_observations():
    # Two queried labels establish F = 5 + 10*G; no held-out F is supplied.
    model = GaussianProcess(linear_feature=2).fit(
        [[1, 0, -1], [0, 1, 1]], [-5, 15]
    )
    mean, std = model.predict([[1, 0, 2]])
    assert model.linear_coefficient == pytest.approx(10.0)
    assert mean[0] == pytest.approx(25.0, abs=1e-5)
    assert std[0] > 0.0


def test_configured_ucb_and_cheap_mean_keep_budget_and_actual_query_training(monkeypatch):
    problem = SmallProblem(budget=8)
    problem.metadata = {"m07_bayes": {"kernel": "mixed", "acquisition": "ucb",
                                    "ucb_beta": 0.5, "cheap_mean": True,
                                    "initial_strategy": "cheap_then_diverse"}}
    problem.cheap = lambda vector: 2 * vector[0] + vector[1] - vector[2]
    original_predict = GaussianProcess.predict
    predictions = []

    def record_predict(model, candidates):
        mean, std = original_predict(model, candidates)
        predictions.append((candidates.copy(), mean.copy(), std.copy()))
        return mean, std

    monkeypatch.setattr(GaussianProcess, "predict", record_predict)
    result = solve(problem, seed=7, budget=6)
    assert result["diagnostics"]["query_count"] == 6
    assert result["diagnostics"]["configuration"]["cheap_mean"] is True
    for (features, means, stds), record in zip(predictions, result["diagnostics"]["evaluations"][3:]):
        chosen = _one_hot([tuple(record["vector"])], [(0, 1)] * 3)[0]
        selected = next(i for i, row in enumerate(features) if np.array_equal(row[:-1], chosen))
        assert means[selected] + 0.5 * stds[selected] == pytest.approx(max(means + 0.5 * stds))
        assert record["phase"] == "upper_confidence_bound"
    assert result["best_score"] == max(sum((i + 1) * value for i, value in enumerate(v)) for v in problem.calls)
    json.dumps(result, allow_nan=False)


def test_default_initial_design_uses_one_public_g_champion_then_diversity():
    problem = SmallProblem(domains=(3, 3), budget=4, oracle=lambda vector: -10 * vector[0] + vector[1])
    problem.metadata = {}
    problem.cheap = lambda vector: 10 * vector[0] + vector[1]
    result = solve(problem, seed=42, budget=4)
    assert problem.calls[0] == (0, 0)
    assert problem.calls[1] == (2, 2)
    assert len(problem.calls) == 4
    assert result["diagnostics"]["configuration"]["initial_strategy"] == "cheap_then_diverse"
    # The G champion has F=-18. Returned best follows queried F, never G ranking.
    expected = max(-10 * vector[0] + vector[1] for vector in problem.calls)
    assert result["best_score"] == expected
    assert result["best_score"] > -18


def test_common_unknown_scheduler_preserves_queried_legal_baseline(monkeypatch):
    from scripts.experiments.roster_methods import common

    def bounded_schedule(spec, vector, max_nodes=1_000_000):
        return {"status": "UNKNOWN" if tuple(vector) == (1,) else "FEASIBLE",
                "witness": [], "nodes": max_nodes + 1 if tuple(vector) == (1,) else 1}

    monkeypatch.setattr(common, "finite_schedule", bounded_schedule)
    problem = common.Problem({"id": "m07-common-unknown", "domains": [2], "initial": [0]},
                             evaluator=lambda vector, **kwargs: {"valid": True, "score": -7.0},
                             budget=2)
    result = solve(problem, budget=2)
    assert result["best_vector"] == [0] and result["best_score"] == -7.0
    assert len(problem.history) == 1 and problem.history[0]["valid"]
    checks = result["diagnostics"]["candidate_pool"]["feasibility_checks"]
    assert checks["unknown_count"] == 1 and checks["infeasible_count"] == 0
    assert "not an infeasibility proof" in checks["unknown_records"][0]["detail"]
