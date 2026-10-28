"""Exact finite-domain LP pricing followed by a restricted integer master.

This is column generation, not branch-and-price.  Pricing scans every local
pattern in the declared small domain; no saving in pattern enumeration is claimed.
Only evaluate() reveals the expensive objective.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import product
from math import isfinite, prod
from typing import Any

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, linprog, milp


_TOL = 1e-8
_MAX_PATTERNS = 50_000


@dataclass(frozen=True)
class _Column:
    block: int
    values: tuple[int, ...]
    reward: float
    usage: tuple[float, ...]


@dataclass
class _Model:
    blocks: list[tuple[int, ...]]
    patterns: list[list[_Column]]
    capacities: np.ndarray
    resource_names: list[str]
    initial: tuple[int, ...]


def _build_model(problem: Any) -> _Model:
    """Absorb every factor/forbidden hyperedge inside a pattern block."""
    spec = problem.spec
    domains = [tuple(int(v) for v in d) for d in problem.domains]
    n = len(domains)
    if n == 0 or any(not d for d in domains):
        raise ValueError("column-generation prototype requires nonempty domains")
    initial = tuple(int(v) for v in problem.initial)
    if len(initial) != n:
        raise ValueError("initial vector length differs from domains")
    parent = list(range(n))

    def root(i: int) -> int:
        while i != parent[i]:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def scope(entry: dict) -> tuple[int, ...]:
        values = tuple(int(i) for i in entry["vars"])
        if any(i < 0 or i >= n for i in values):
            raise ValueError("factor or forbidden scope outside domains")
        return values

    factors = [(scope(f), f["table"]) for f in spec.get("factors", [])]
    forbidden = [(scope(f), tuple(f["values"])) for f in spec.get("forbidden", [])]
    if any(len(indices) != len(values) for indices, values in forbidden):
        raise ValueError("forbidden scope/value length mismatch")
    for indices, _ in factors + forbidden:
        for i in indices[1:]:
            parent[root(i)] = root(indices[0])
    components: dict[int, list[int]] = {}
    for i in range(n):
        components.setdefault(root(i), []).append(i)
    blocks = [tuple(v) for v in sorted(components.values(), key=lambda v: v[0])]
    total_patterns = sum(prod(len(domains[i]) for i in block) for block in blocks)
    if total_patterns > _MAX_PATTERNS:
        raise ValueError(f"pricing domain has {total_patterns} patterns; cap is {_MAX_PATTERNS}")
    resources = spec.get("resources", [])
    capacities = np.asarray([float(r["capacity"]) for r in resources], dtype=float)
    if not np.all(np.isfinite(capacities)):
        raise ValueError("resource capacities must be finite")
    unary = spec.get("unary", [[0.0] * len(d) for d in domains])
    patterns: list[list[_Column]] = []
    for b, block in enumerate(blocks):
        block_set = set(block)
        local_factors = [(s, t) for s, t in factors if (s and s[0] in block_set) or (not s and b == 0)]
        local_forbidden = [(s, v) for s, v in forbidden if (s and s[0] in block_set) or not s]
        columns = []
        for values in product(*(domains[i] for i in block)):
            assignment = dict(zip(block, values))
            if any(tuple(assignment[i] for i in s) == v for s, v in local_forbidden):
                continue
            reward = sum(float(unary[i][assignment[i]]) for i in block)
            reward += sum(float(t.get(",".join(str(assignment[i]) for i in s), 0.0)) for s, t in local_factors)
            usage = tuple(sum(float(r["usage"][i][assignment[i]]) for i in block) for r in resources)
            if not isfinite(reward) or any(not isfinite(x) for x in usage):
                raise ValueError("pattern rewards and resource usage must be finite")
            columns.append(_Column(b, tuple(values), reward, usage))
        patterns.append(columns)
    return _Model(blocks, patterns, capacities, [str(r.get("name", i)) for i, r in enumerate(resources)], initial)


def _matrices(model: _Model, columns: list[_Column]) -> tuple[np.ndarray, np.ndarray]:
    eq = np.zeros((len(model.blocks), len(columns)))
    ub = np.zeros((len(model.capacities), len(columns)))
    for j, column in enumerate(columns):
        eq[column.block, j] = 1.0
        ub[:, j] = column.usage
    return eq, ub


def _column_generation(model: _Model) -> dict:
    """Two-phase RMP; an exhaustive pricer makes the LP claim finite and exact."""
    if any(not patterns for patterns in model.patterns):
        return {"status": "full_model_infeasible", "reason": "empty local pattern block", "columns": [],
                "iterations": [], "full_pricing_complete": True, "lp_objective": None}
    columns = []
    for block, patterns in zip(model.blocks, model.patterns):
        initial_values = tuple(model.initial[i] for i in block)
        columns.append(next((p for p in patterns if p.values == initial_values), patterns[0]))
    present = {(c.block, c.values) for c in columns}
    iterations = []
    # Each nonterminal iteration adds at least one previously absent column.
    for phase in ("phase_i", "phase_ii"):
        for _ in range(sum(map(len, model.patterns)) + 1):
            eq, ub = _matrices(model, columns)
            costs = np.array([0.0 if phase == "phase_i" else -c.reward for c in columns])
            if phase == "phase_i" and len(model.capacities):
                # z >= 0 measures capacity violation.  All convexity rows still
                # hold, so a bad initial assignment cannot imply infeasibility.
                k = len(model.capacities)
                costs = np.r_[costs, np.ones(k)]
                eq = np.c_[eq, np.zeros((len(model.blocks), k))]
                ub = np.c_[ub, -np.eye(k)]
            result = linprog(costs, A_ub=ub if len(ub) else None,
                             b_ub=model.capacities if len(ub) else None,
                             A_eq=eq, b_eq=np.ones(len(model.blocks)),
                             bounds=(0.0, None), method="highs")
            if not result.success:
                return {"status": "lp_solver_failed", "message": result.message,
                        "columns": columns, "iterations": iterations,
                        "full_pricing_complete": False, "lp_objective": None}
            dual_eq = np.asarray(result.eqlin.marginals)
            dual_ub = np.asarray(result.ineqlin.marginals) if len(ub) else np.zeros(0)
            additions: list[_Column] = []
            minima = []
            scanned = 0
            for b, patterns in enumerate(model.patterns):
                priced = []
                for pattern in patterns:
                    scanned += 1
                    c = 0.0 if phase == "phase_i" else -pattern.reward
                    reduced = float(c - dual_eq[b] - np.dot(dual_ub, pattern.usage))
                    priced.append((reduced, pattern.values, pattern))
                best = min(priced, key=lambda item: (item[0], item[1]))
                minima.append(best[0])
                # Price the best absent column independently of existing columns
                # so numeric noise on an existing zero-cost column cannot stall.
                absent = [item for item in priced if (b, item[1]) not in present]
                if absent:
                    reduced, _, pattern = min(absent, key=lambda item: (item[0], item[1]))
                    if reduced < -_TOL:
                        additions.append(pattern)
            row = {"phase": phase, "rmp_columns": len(columns), "lp_min_objective": float(result.fun),
                   "block_duals": dual_eq.tolist(), "resource_duals": dual_ub.tolist(),
                   "resource_scarcity_prices": (-dual_ub).tolist(), "pricing_complete": True,
                   "patterns_scanned": scanned, "minimum_reduced_cost_by_block": minima,
                   "added_columns": [{"block": c.block, "values": list(c.values),
                                      "reward": c.reward, "usage": list(c.usage)} for c in additions]}
            iterations.append(row)
            if not additions:
                if phase == "phase_i":
                    if result.fun > _TOL:
                        return {"status": "full_model_infeasible", "reason": "positive fully priced Phase-I objective",
                                "phase_i_objective": float(result.fun), "columns": columns,
                                "iterations": iterations, "full_pricing_complete": True, "lp_objective": None}
                    break
                return {"status": "full_model_lp_optimal", "columns": columns, "iterations": iterations,
                        "full_pricing_complete": True, "lp_objective": float(-result.fun),
                        "lp_weights": result.x[:len(columns)].tolist(),
                        "fractional_columns": int(sum(_TOL < x < 1.0 - _TOL for x in result.x[:len(columns)]))}
            columns.extend(additions)
            present.update((c.block, c.values) for c in additions)
        else:
            return {"status": "iteration_limit", "columns": columns, "iterations": iterations,
                    "full_pricing_complete": False, "lp_objective": None}
    raise AssertionError("phase loop must return after Phase II")


def _integer_candidates(model: _Model, columns: list[_Column], limit: int) -> tuple[list[tuple[int, ...]], list[dict]]:
    """Solve only the restricted IP; no pricing inside the MIP search tree."""
    eq, ub = _matrices(model, columns)
    matrix = np.vstack([eq, ub])
    lower = np.r_[np.ones(len(eq)), np.full(len(ub), -np.inf)]
    upper = np.r_[np.ones(len(eq)), model.capacities]
    candidates, records = [], []
    for _ in range(limit):
        result = milp(-np.array([c.reward for c in columns]), integrality=np.ones(len(columns)),
                      bounds=Bounds(0.0, 1.0), constraints=LinearConstraint(matrix, lower, upper),
                      options={"time_limit": 5.0, "mip_rel_gap": 0.0})
        records.append({"status": int(result.status), "message": result.message,
                        "objective": float(-result.fun) if result.fun is not None else None,
                        "optimal": result.status == 0})
        if result.x is None:
            break
        selected = np.flatnonzero(result.x > 0.5)
        vector = [0] * len(model.initial)
        for j in selected:
            for i, value in zip(model.blocks[columns[j].block], columns[j].values):
                vector[i] = value
        candidates.append(tuple(vector))
        no_good = np.zeros(len(columns))
        no_good[selected] = 1.0
        matrix = np.vstack([matrix, no_good])
        lower = np.r_[lower, -np.inf]
        upper = np.r_[upper, len(model.blocks) - 1.0]
    return candidates, records


def _integer_enrichment(model: _Model, columns: list[_Column], duals: dict,
                        max_rounds: int = 8) -> tuple[list[_Column], list[dict]]:
    """Add improving feasible single-block substitutions after LP pricing.

    These columns may have positive LP reduced cost.  This is an integer local
    neighborhood heuristic, not node pricing or an integer optimality proof.
    """
    columns = list(columns)
    present = {(c.block, c.values) for c in columns}
    records = []
    for _ in range(max_rounds):
        incumbents, runs = _integer_candidates(model, columns, 1)
        row = {"restricted_objective": runs[0]["objective"], "restricted_ip_optimal": runs[0]["optimal"],
               "patterns_scanned": 0, "added_columns": [], "scope": "single-block integer neighborhood"}
        if not incumbents:
            row["status"] = "restricted_ip_has_no_incumbent"
            records.append(row)
            break
        vector = incumbents[0]
        selected = [next(c for c in patterns if c.values == tuple(vector[i] for i in block))
                    for block, patterns in zip(model.blocks, model.patterns)]
        total_usage = sum((np.array(c.usage) for c in selected), np.zeros(len(model.capacities)))
        additions = []
        for b, patterns in enumerate(model.patterns):
            improving = []
            for column in patterns:
                row["patterns_scanned"] += 1
                if (b, column.values) in present:
                    continue
                gain = column.reward - selected[b].reward
                usage = total_usage - np.array(selected[b].usage) + np.array(column.usage)
                if gain > _TOL and np.all(usage <= model.capacities + _TOL):
                    improving.append((gain, column.values, column))
            if improving:
                gain, _, column = min(improving, key=lambda item: (-item[0], item[1]))
                reduced = float(-column.reward - duals["block_duals"][b]
                                - np.dot(duals["resource_duals"], column.usage))
                additions.append(column)
                row["added_columns"].append({"block": b, "values": list(column.values),
                                             "reward": column.reward, "usage": list(column.usage),
                                             "single_block_gain": float(gain), "lp_reduced_cost": reduced})
        row["status"] = "columns_added" if additions else "single_block_neighborhood_exhausted"
        records.append(row)
        if not additions:
            break
        columns.extend(additions)
        present.update((c.block, c.values) for c in additions)
    else:
        records[-1]["status"] = "round_limit_after_adding_columns"
    return columns, records


def _diversify_columns(model: _Model, columns: list[_Column], duals: dict,
                       target_per_block: int) -> tuple[list[_Column], dict]:
    """Retain near-price and distant modes that LP optimization need not use.

    The expensive objective may disagree with G.  Half of this bounded bundle
    has low LP reduced cost; the other half spreads Hamming distance.  This is
    explicit post-pricing diversification, never a negative-cost pricing claim.
    """
    columns = list(columns)
    present = {(c.block, c.values) for c in columns}
    record = {"target_per_block": target_per_block, "patterns_scanned": 0, "added_columns": []}
    minima = [np.min(np.array([c.usage for c in patterns]), axis=0) for patterns in model.patterns]
    minimum_usage = sum(minima, np.zeros(len(model.capacities)))
    for b, patterns in enumerate(model.patterns):
        existing = [c for c in columns if c.block == b]
        needed = max(0, target_per_block - len(existing))
        if not needed:
            continue
        eligible = []
        for column in patterns:
            record["patterns_scanned"] += 1
            if (b, column.values) in present:
                continue
            # Necessary resource bound only; candidate feasibility remains a
            # separate guard, and this does not certify a completion exists.
            if np.any(np.array(column.usage) + minimum_usage - minima[b] > model.capacities + _TOL):
                continue
            reduced = float(-column.reward - duals["block_duals"][b]
                            - np.dot(duals["resource_duals"], column.usage))
            eligible.append((reduced, column))
        eligible.sort(key=lambda item: (item[0], -item[1].reward, item[1].values))
        chosen = [(c, rc, "low_reduced_cost_bundle") for rc, c in eligible[:(needed + 1) // 2]]
        used = {c.values for c, _, _ in chosen}
        remaining = [(rc, c) for rc, c in eligible if c.values not in used]
        distance = lambda left, right: sum(x != y for x, y in zip(left, right))
        anchors = [c.values for c in existing] + [c.values for c, _, _ in chosen]
        nearest = {c.values: min(distance(c.values, anchor) for anchor in anchors) for _, c in remaining}
        while remaining and len(chosen) < needed:
            rc, column = min(remaining, key=lambda item: (-nearest[item[1].values], item[0],
                                                         -item[1].reward, item[1].values))
            chosen.append((column, rc, "hamming_diversity_bundle"))
            remaining = [(r, c) for r, c in remaining if c.values != column.values]
            for _, other in remaining:
                nearest[other.values] = min(nearest[other.values], distance(other.values, column.values))
        for column, reduced, reason in chosen:
            columns.append(column)
            present.add((b, column.values))
            record["added_columns"].append({"block": b, "values": list(column.values),
                                            "reward": column.reward, "lp_reduced_cost": reduced,
                                            "reason": reason})
    return columns, record


def solve(problem: Any, *, seed: int = 42, budget: int = 16) -> dict:
    """Return the best actually evaluated full-fidelity legal candidate."""
    query_limit = max(0, int(budget))
    diagnostics: dict = {"method": "column_generation_plus_restricted_ip", "seed": seed,
                         "pricing_enumerates_all_local_patterns": True,
                         "branch_and_price": False, "pricing_tolerance": _TOL, "evaluations_used": 0}
    proof = {"lp": "not established", "integer": "restricted master only; no full integer optimality proof",
             "expensive_objective": "only full-fidelity evaluated candidates; no global optimum claim",
             "schedule": "candidate feasibility guard; not encoded in LP"}
    evaluations, rejected, schedule_unknown, seen = [], [], [], set()
    best = None

    def has_budget() -> bool:
        return len(evaluations) < query_limit and getattr(problem, "remaining", query_limit) > 0

    def query(vector: tuple[int, ...], stage: str) -> None:
        nonlocal best
        if vector in seen:
            return
        seen.add(vector)
        if not has_budget():
            return
        if not problem.feasible(vector):
            rejected.append(list(vector))
            return
        try:
            scheduled = problem.schedule_feasible(vector)
        except RuntimeError as error:
            schedule_unknown.append({"vector": list(vector), "reason": str(error)})
            return
        if not scheduled:
            rejected.append(list(vector))
            return
        record = problem.evaluate(vector, fidelity="full", seed=seed)
        evaluations.append(record)
        diagnostics.setdefault("evaluation_stages", []).append(stage)
        score = record.get("score")
        if (record.get("valid") and record.get("fidelity", "full") == "full"
                and score is not None and isfinite(float(score))
                and (best is None or float(score) > float(best["score"]))):
            best = record

    def finish() -> dict:
        diagnostics.update(evaluations_used=len(evaluations), rejected_before_evaluation=rejected,
                           schedule_guard_unknown=schedule_unknown, candidate_count=len(seen),
                           best_observed_score=float(best["score"]) if best is not None else None)
        return {"best_vector": list(best["vector"]) if best is not None else None,
                "diagnostics": diagnostics, "proof_scope": proof, "evaluations": evaluations}

    # Protect the actual incumbent before spending a query on any proxy winner.
    # This full query is charged even if the proxy model is later unsupported.
    query(tuple(problem.initial), "initial")
    try:
        model = _build_model(problem)
    except (ValueError, KeyError, IndexError, TypeError) as error:
        diagnostics.update(status="unsupported_model", reason=str(error))
        return finish()
    generated = _column_generation(model)
    columns = generated.pop("columns")
    diagnostics.update(generated)
    diagnostics.update(blocks=[list(b) for b in model.blocks],
                       total_local_patterns=sum(map(len, model.patterns)), lp_column_count=len(columns),
                       final_columns=len(columns))
    if generated["full_pricing_complete"]:
        proof["lp"] = ("optimal LP of the declared unary/factor/forbidden/resource model within HiGHS tolerances"
                       if generated["status"] == "full_model_lp_optimal" else
                       "infeasible declared unary/factor/forbidden/resource model")
    candidates: list[tuple[int, ...]] = []
    mip_records = []
    diagnostics["integer_enrichment"] = []
    if generated["status"] == "full_model_lp_optimal" and has_budget():
        final_duals = generated["iterations"][-1]
        columns, enrichment = _integer_enrichment(model, columns, final_duals)
        columns, diversity = _diversify_columns(model, columns, final_duals, min(128, max(8, query_limit * 2)))
        diagnostics.update(integer_enrichment=enrichment, diversity_enrichment=diversity, final_columns=len(columns))
        candidates, mip_records = _integer_candidates(model, columns, min(128, max(16, query_limit * 4)))
    diagnostics["restricted_ip_runs"] = mip_records
    for vector in candidates:
        if not has_budget():
            break
        query(vector, "restricted_ip")
    return finish()
