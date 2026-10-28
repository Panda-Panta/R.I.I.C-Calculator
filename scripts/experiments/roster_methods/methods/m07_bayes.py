"""Discrete Gaussian-process Bayesian optimization with expected improvement.

Only completed, valid full-fidelity calls made by this solve are training data.
Candidate enumeration concerns public constraints, never the unknown objective.
This is a small GP/EI prototype, not an implementation of SMAC3 or BOCS.
"""

from __future__ import annotations

from itertools import product
import math

import numpy as np
from scipy.special import ndtr


def expected_improvement(mean, std, incumbent, *, xi=0.01):
    """EI for maximization; the zero-variance limit is deterministic gain."""
    mean, std = np.broadcast_arrays(np.asarray(mean, float), np.asarray(std, float))
    gain = mean - float(incumbent) - float(xi)
    positive = std > 0.0
    z = np.divide(gain, std, out=np.zeros_like(gain), where=positive)
    density = np.exp(-0.5 * z * z) / math.sqrt(2.0 * math.pi)
    value = gain * ndtr(z) + std * density
    return np.where(positive, np.maximum(value, 0.0), np.maximum(gain, 0.0))


class GaussianProcess:
    """Exact fixed-kernel GP, with normalization fitted on observed y only."""

    def __init__(self, *, length_scale=1.0, noise=1e-6, kernel="rbf",
                 categorical_dimensions=None, linear_feature=None):
        if length_scale <= 0 or noise <= 0:
            raise ValueError("length_scale and noise must be positive")
        if kernel not in {"rbf", "additive", "mixed"}:
            raise ValueError("unknown categorical GP kernel")
        self.length_scale = float(length_scale)
        self.noise = float(noise)
        self.kernel = kernel
        self.categorical_dimensions = categorical_dimensions
        self.linear_feature = linear_feature

    def _kernel(self, left, right):
        if self.linear_feature is not None:
            left, right = left[:, :self.linear_feature], right[:, :self.linear_feature]
        squared = (
            np.sum(left * left, axis=1)[:, None]
            + np.sum(right * right, axis=1)[None, :]
            - 2.0 * left @ right.T
        )
        rbf = np.exp(-0.5 * np.maximum(squared, 0.0) / self.length_scale**2)
        if self.kernel == "rbf":
            return rbf
        dimensions = max(1, int(self.categorical_dimensions))
        matching = left @ right.T
        additive = matching / dimensions
        if self.kernel == "additive":
            return additive
        pairwise = ((matching * matching - matching) / (dimensions * (dimensions - 1))
                    if dimensions > 1 else additive)
        # Positive mixtures of valid categorical kernels retain positive semidefiniteness.
        return 0.5 * additive + 0.3 * pairwise + 0.2 * rbf

    def fit(self, features, scores):
        self.x = np.asarray(features, dtype=float)
        y = np.asarray(scores, dtype=float)
        if self.x.ndim != 2 or y.shape != (len(self.x),) or len(y) == 0:
            raise ValueError("GP requires nonempty aligned features and scores")
        if not np.isfinite(self.x).all() or not np.isfinite(y).all():
            raise ValueError("GP cannot train on invalid/nonfinite observations")
        self.y_mean = float(np.mean(y))
        self.y_scale = float(np.std(y))
        if self.y_scale < 1e-12:
            self.y_scale = 1.0
        kernel = self._kernel(self.x, self.x)
        self.cholesky = np.linalg.cholesky(kernel + self.noise * np.eye(len(y)))
        self.linear_center, self.linear_coefficient = 0.0, 0.0
        mean = np.full(len(y), self.y_mean)
        if self.linear_feature is not None:
            cheap = self.x[:, self.linear_feature]
            self.linear_center = float(np.mean(cheap))
            centered = cheap - self.linear_center
            self.linear_coefficient = float(centered @ (y - self.y_mean) / (centered @ centered + 1e-8))
            mean += self.linear_coefficient * centered
        normalized = (y - mean) / self.y_scale
        self.alpha = np.linalg.solve(
            self.cholesky.T, np.linalg.solve(self.cholesky, normalized)
        )
        return self

    def predict(self, features):
        query = np.asarray(features, dtype=float)
        cross = self._kernel(self.x, query)
        mean = self.y_mean + self.y_scale * (cross.T @ self.alpha)
        if self.linear_feature is not None:
            mean += self.linear_coefficient * (query[:, self.linear_feature] - self.linear_center)
        projected = np.linalg.solve(self.cholesky, cross)
        variance = np.maximum(1.0 - np.sum(projected * projected, axis=0), 0.0)
        return mean, self.y_scale * np.sqrt(variance)


def _one_hot(vectors, domains):
    offsets = np.cumsum([0] + [len(domain) for domain in domains])
    encoded = np.zeros((len(vectors), int(offsets[-1])), dtype=float)
    lookups = [{value: index for index, value in enumerate(domain)} for domain in domains]
    for row, vector in enumerate(vectors):
        for column, value in enumerate(vector):
            encoded[row, offsets[column] + lookups[column][value]] = 1.0
    return encoded


class _FeasibilityChecks:
    """Keep an incomplete schedule check distinct from proved infeasibility."""

    def __init__(self, problem, domains):
        self.problem, self.domains = problem, domains
        self.records = {}

    def check(self, vector):
        vector = tuple(vector)
        if vector not in self.records:
            record = {"vector": list(vector)}
            if (len(vector) != len(self.domains)
                    or not all(value in domain for value, domain in zip(vector, self.domains))
                    or not bool(self.problem.feasible(vector))):
                record.update(status="INFEASIBLE", reason="public_structural_constraints")
            else:
                try:
                    legal = bool(self.problem.schedule_feasible(vector))
                except RuntimeError as error:
                    # common.schedule_feasible raises when its finite check is UNKNOWN.
                    # A failed schedule check cannot prove that the vector is infeasible.
                    record.update(status="UNKNOWN", reason="schedule_check_incomplete", detail=str(error))
                else:
                    record.update(status="FEASIBLE" if legal else "INFEASIBLE",
                                  reason="public_finite_schedule")
            self.records[vector] = record
        return self.records[vector]["status"]

    def report(self):
        records = list(self.records.values())
        return {"checked_count": len(records),
                "feasible_count": sum(r["status"] == "FEASIBLE" for r in records),
                "infeasible_count": sum(r["status"] == "INFEASIBLE" for r in records),
                "unknown_count": sum(r["status"] == "UNKNOWN" for r in records),
                "unknown_records": [dict(r) for r in records if r["status"] == "UNKNOWN"]}


def _candidate_pool(problem, domains, initial, rng, *, cap=1024, enumeration_limit=4096, checks=None):
    """Enumerate a small public domain or sample a bounded legal candidate pool."""
    raw_size = math.prod(len(domain) for domain in domains)
    checks = checks or _FeasibilityChecks(problem, domains)
    if raw_size <= enumeration_limit:
        pool = [vector for vector in product(*domains) if checks.check(vector) == "FEASIBLE"]
        audit = checks.report()
        return pool, {"mode": "public_feasible_enumeration", "raw_size": raw_size,
                      "candidate_count": len(pool), "enumeration_complete": True,
                      "complete_domain": audit["unknown_count"] == 0, "feasibility_checks": audit}

    pool = set()

    def add(vector):
        if len(pool) < cap and checks.check(vector) == "FEASIBLE":
            pool.add(tuple(vector))

    add(initial)
    # Reserve half of the pool for global draws, even with a large neighbourhood.
    neighbour_cap = max(1, cap // 2)
    # Baseline neighbours improve coverage when random decoding is constraint sparse.
    if len(initial) == len(domains) and all(v in d for v, d in zip(initial, domains)):
        coordinates = list(range(len(domains)))
        rng.shuffle(coordinates)
        for index in coordinates:
            for value in rng.permutation(domains[index]):
                vector = list(initial)
                vector[index] = int(value)
                add(tuple(vector))
                if len(pool) >= neighbour_cap:
                    break
            if len(pool) >= neighbour_cap:
                break
    attempts = 0
    while len(pool) < cap and attempts < 24 * cap:
        attempts += 1
        add(tuple(int(rng.choice(domain)) for domain in domains))
    return sorted(pool), {"mode": "bounded_public_candidate_pool", "raw_size": raw_size,
                          "candidate_count": len(pool), "complete_domain": False,
                          "enumeration_complete": False, "feasibility_checks": checks.report(),
                          "random_attempts": attempts, "cap": cap}


def _diverse_choice(candidates, queried, rng):
    if not queried:
        return int(rng.integers(len(candidates)))
    distance = [min(sum(a != b for a, b in zip(vector, old)) for old in queried)
                for vector in candidates]
    tied = np.flatnonzero(np.asarray(distance) == max(distance))
    return int(rng.choice(tied))


def solve(problem, *, seed=42, budget=16):
    """Return the best actually observed F under a strict full-query budget."""
    requested_budget = max(0, int(budget))
    available = max(0, int(problem.remaining))
    query_limit = min(requested_budget, available)
    rng = np.random.default_rng(seed)
    domains = [tuple(int(v) for v in domain) for domain in problem.domains]
    initial = tuple(int(v) for v in problem.initial)
    config = dict(getattr(problem, "metadata", {}).get("m07_bayes", {}))
    config.setdefault("initial_strategy", "cheap_then_diverse"
                      if callable(getattr(problem, "cheap", None)) else "diverse")
    kernel = config.get("kernel", "rbf")
    acquisition_name = config.get("acquisition", "ei")
    if acquisition_name not in {"ei", "ucb"}:
        raise ValueError("m07 acquisition must be ei or ucb")
    length_scale = math.sqrt(max(1, len(domains))) * float(config.get("length_scale_multiplier", 1.0))
    xi_factor = float(config.get("xi_factor", 0.01))
    ucb_beta = float(config.get("ucb_beta", 2.0))
    if xi_factor < 0 or ucb_beta < 0:
        raise ValueError("exploration coefficients must be nonnegative")
    checks = _FeasibilityChecks(problem, domains)
    baseline_status = checks.check(initial)
    pool, pool_info = _candidate_pool(problem, domains, initial, rng, checks=checks)
    cheap_values = {}
    cheap_required = bool(config.get("cheap_mean", False)) or config.get("initial_strategy") == "cheap_then_diverse"
    if cheap_required:
        for vector in pool:
            value = float(problem.cheap(vector))
            if math.isfinite(value):
                cheap_values[vector] = value
    use_cheap_mean = bool(config.get("cheap_mean", False)) and len(cheap_values) == len(pool) and bool(pool)
    cheap_center = float(np.mean(list(cheap_values.values()))) if cheap_values else 0.0
    cheap_scale = float(np.std(list(cheap_values.values()))) if cheap_values else 1.0
    if cheap_scale < 1e-12:
        cheap_scale = 1.0

    def encode(vectors):
        encoded = _one_hot(vectors, domains)
        if use_cheap_mean:
            public_feature = np.array([(cheap_values[v] - cheap_center) / cheap_scale for v in vectors])
            encoded = np.column_stack([encoded, public_feature])
        return encoded

    baseline_legal = baseline_status == "FEASIBLE"
    baseline = {"vector": list(initial), "status": "not_queried_no_budget"
                if baseline_legal else "public_constraints_unknown" if baseline_status == "UNKNOWN"
                else "public_constraints_infeasible", "score": None,
                "public_feasibility": baseline_status}
    records = []
    observed_vectors, observed_scores, observed_queries = [], [], []
    queried = set()
    model_updates = []
    best_vector, best_score = None, None
    initial_design_size = min(max(1, int(config.get("initial_design_size", 3))), query_limit)
    guided_design_used = False

    while len(records) < query_limit and int(problem.remaining) > 0:
        candidates = [vector for vector in pool if vector not in queried]
        if not candidates:
            break
        details = {"training_count": len(observed_scores)}
        if not records and baseline_legal:
            selected = initial
            phase = "baseline"
        elif len(records) < initial_design_size or not observed_scores:
            if config.get("initial_strategy") == "cheap_then_diverse" and not guided_design_used and cheap_values:
                maximum_cheap = max(cheap_values.get(v, -math.inf) for v in candidates)
                elite = [v for v in candidates if cheap_values.get(v, -math.inf) == maximum_cheap]
                selected = elite[_diverse_choice(elite, queried, rng)]
                guided_design_used = True
            else:
                selected = candidates[_diverse_choice(candidates, queried, rng)]
            phase = "initial_design" if len(records) < initial_design_size else "no_valid_model_data"
        else:
            model = GaussianProcess(length_scale=length_scale, kernel=kernel,
                                    categorical_dimensions=len(domains),
                                    linear_feature=sum(map(len, domains)) if use_cheap_mean else None)
            model.fit(encode(observed_vectors), observed_scores)
            mean, std = model.predict(encode(candidates))
            # xi scales with observed F, never with candidate or held-out scores.
            xi = xi_factor * model.y_scale
            ei = expected_improvement(mean, std, best_score, xi=xi)
            acquisition = ei if acquisition_name == "ei" else mean + ucb_beta * std
            maximum = float(np.max(acquisition))
            tied = np.flatnonzero(np.isclose(acquisition, maximum, rtol=1e-12, atol=1e-14))
            chosen = int(rng.choice(tied))
            selected = candidates[chosen]
            phase = "expected_improvement" if acquisition_name == "ei" else "upper_confidence_bound"
            details.update({"posterior_mean": float(mean[chosen]),
                            "posterior_std": float(std[chosen]),
                            "expected_improvement": float(ei[chosen]), "xi": xi,
                            "acquisition": acquisition_name, "acquisition_value": float(acquisition[chosen]),
                            "cheap_mean_coefficient": model.linear_coefficient if use_cheap_mean else None})
            model_updates.append({"before_query": len(records) + 1,
                                  "training_query_indices": list(observed_queries),
                                  "training_count": len(observed_scores)})

        # All candidates already passed public structure and finite schedule checks.
        result = problem.evaluate(selected, fidelity="full", seed=int(seed))
        queried.add(selected)
        score = result.get("score")
        full_valid = (bool(result.get("valid")) and result.get("fidelity", "full") == "full"
                      and score is not None and math.isfinite(float(score)))
        record = {"query": len(records) + 1, "vector": list(selected), "phase": phase,
                  "valid": full_valid, "score": float(score) if full_valid else None,
                  "fidelity": result.get("fidelity", "full"), **details}
        records.append(record)
        if phase == "baseline":
            baseline.update({"status": "valid" if full_valid else "invalid_or_incomplete",
                             "score": record["score"], "query": record["query"]})
        if full_valid:
            observed_vectors.append(selected)
            observed_scores.append(float(score))
            observed_queries.append(record["query"])
            if best_score is None or float(score) > best_score:
                best_score, best_vector = float(score), list(selected)

    if len(records) >= query_limit:
        stop_reason = "budget_exhausted" if query_limit else "no_query_budget"
    elif int(problem.remaining) <= 0:
        stop_reason = "oracle_budget_exhausted"
    elif pool_info["feasibility_checks"]["unknown_count"]:
        stop_reason = "public_feasibility_incomplete"
    else:
        stop_reason = "candidate_pool_exhausted"
    return {
        "best_vector": best_vector,
        "best_score": best_score,
        "diagnostics": {
            "method": "discrete_gp_expected_improvement", "seed": int(seed),
            "requested_budget": requested_budget, "query_limit": query_limit,
            "query_count": len(records), "valid_observation_count": len(observed_scores),
            "invalid_or_incomplete_count": len(records) - len(observed_scores),
            "baseline": baseline, "candidate_pool": pool_info,
            "initial_design_size": initial_design_size, "model_updates": model_updates,
            "configuration": {"kernel": kernel, "acquisition": acquisition_name,
                              "length_scale_multiplier": float(config.get("length_scale_multiplier", 1.0)),
                              "xi_factor": xi_factor, "ucb_beta": ucb_beta,
                              "cheap_mean": use_cheap_mean,
                              "initial_strategy": config.get("initial_strategy", "diverse")},
            "cheap_calls": len(pool) if cheap_required else 0,
            "evaluations": records, "stop_reason": stop_reason,
            "surrogate": {"type": "exact_gp", "kernel": kernel + "_on_categorical_one_hot",
                          "mean": "queried_F_affine_public_G" if use_cheap_mean else "queried_F_constant",
                          "length_scale": length_scale,
                          "observation_noise": 1e-6, "hyperparameter_fitting": False,
                          "training_scope": "this_solve_valid_full_queries_only"},
        },
        "proof_scope": {
            "algorithm": "Sequential GP posterior and EI over legal discrete candidates.",
            "objective": "Best valid/full score actually queried in this solve only.",
            "exclusions": ["No SMAC3/BOCS package reproduction", "No F optimality certificate",
                           "No held-out evaluation or game/runtime validation"],
            "candidate_domain_complete": pool_info["complete_domain"],
            "public_feasibility_complete": pool_info["feasibility_checks"]["unknown_count"] == 0,
        },
    }
