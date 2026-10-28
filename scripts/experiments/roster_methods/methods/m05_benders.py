"""Method 05: finite-domain logic-based Benders feasibility decomposition.

The master maximizes the public cheap objective G.  A separate, exhaustive
integer-start cumulative-bed scheduler either supplies a witness, exhausts its
finite search, or reports UNKNOWN.  Only the second outcome generates a cut.
F is queried through problem.evaluate and is never used to infer infeasibility.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
from types import SimpleNamespace


DEFAULT_MASTER_LIMIT = 200_000
DEFAULT_SUBPROBLEM_LIMIT = 200_000
DEFAULT_ITERATION_LIMIT = 1_024
DEFAULT_CORE_REDUCTION_LIMIT = 32
SCHEMA = "integer_bed_jobs_v1"


def _integer(value, *, minimum=0):
    return isinstance(value, int) and not isinstance(value, bool) and value >= minimum


def _parse_schedule(problem, vector):
    """Validate the entire declared schema; never ignore unknown constraints."""
    scheduling = problem.spec.get("scheduling")
    if scheduling is None:
        return {"horizon": 0, "beds": 0, "jobs": []}, None
    if not isinstance(scheduling, dict):
        return None, "scheduling must be a dict"
    extra = set(scheduling) - {"schema", "horizon", "beds", "jobs"}
    if extra:
        return None, "unsupported scheduling fields: " + ", ".join(sorted(extra))
    if scheduling.get("schema", SCHEMA) != SCHEMA:
        return None, "unsupported scheduling schema"
    horizon, beds = scheduling.get("horizon"), scheduling.get("beds")
    if not _integer(horizon) or not _integer(beds):
        return None, "horizon and beds must be nonnegative integers"
    # This is a memory bound, not a claim that larger horizons are infeasible.
    if horizon > 1_000_000:
        return None, "horizon exceeds this exhaustive scheduler's memory bound"
    if not isinstance(scheduling.get("jobs"), list):
        return None, "jobs must be a list"
    if len(vector) != len(problem.domains) or any(value not in domain for value, domain in zip(vector, problem.domains)):
        return None, "vector is outside the declared assignment domain"
    active, ids = [], set()
    for index, original in enumerate(scheduling["jobs"]):
        if not isinstance(original, dict):
            return None, "every job must be a dict"
        extra = set(original) - {"id", "var", "values", "duration", "release", "deadline", "demand"}
        if extra:
            return None, "unsupported job fields: " + ", ".join(sorted(extra))
        job_id = original.get("id", f"job-{index}")
        if not isinstance(job_id, str) or job_id in ids:
            return None, "job ids must be unique strings"
        ids.add(job_id)
        var = original.get("var")
        if var is not None and (not _integer(var) or var >= len(problem.domains)):
            return None, "job var is outside the declared assignment variables"
        values = original.get("values", list(problem.domains[var]) if var is not None else [])
        if not isinstance(values, list) or (var is not None and any(not _integer(value) or value not in problem.domains[var] for value in values)):
            return None, "job values must be a list of declared integer choices"
        duration, demand = original.get("duration"), original.get("demand", 1)
        release, deadline = original.get("release", 0), original.get("deadline", horizon)
        if not all(_integer(value) for value in (duration, demand, release, deadline)):
            return None, "job times and demand must be nonnegative integers"
        if release > horizon or deadline > horizon:
            return None, "job time windows must be inside the declared horizon"
        if var is None or vector[var] in values:
            active.append({"id": job_id, "var": var, "values": values,
                           "duration": duration, "demand": demand,
                           "release": release, "deadline": deadline})
    return {"horizon": horizon, "beds": beds, "jobs": active}, None


def schedule_subproblem(problem, vector, *, node_limit=DEFAULT_SUBPROBLEM_LIMIT):
    """Find a finite bed schedule, prove none exists, or return UNKNOWN.

    An iterative DFS enumerates every integer start combination, pruning only
    prefixes already exceeding bed capacity.  A node limit never means UNSAT.
    The witness uses half-open intervals [start, end).
    """
    if not _integer(node_limit):
        raise ValueError("node_limit must be a nonnegative integer")
    model, error = _parse_schedule(problem, tuple(vector))
    if error is not None:
        return {"status": "UNKNOWN", "reason": error, "method": "exhaustive_integer_start_dfs",
                "nodes": 0, "search_exhausted": False, "witness": None}
    canonical = json.dumps({"vector": list(vector), "model": model}, sort_keys=True, separators=(",", ":"))
    jobs = sorted(model["jobs"], key=lambda job: (
        job["deadline"] - job["duration"] - job["release"],
        -job["demand"], -job["duration"], job["id"]))
    starts = [range(job["release"], job["deadline"] - job["duration"] + 1) for job in jobs]
    size = math.prod(len(domain) for domain in starts)
    base = {
        "method": "exhaustive_integer_start_dfs", "schema": SCHEMA,
        "model_sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "model": model, "job_order": [job["id"] for job in jobs],
        "start_domain_sizes": [len(domain) for domain in starts],
        "cartesian_start_combinations": size, "node_limit": node_limit,
    }
    if not jobs:
        return {**base, "status": "FEASIBLE", "reason": "no active recovery jobs",
                "nodes": 0, "capacity_prunes": 0, "search_exhausted": False, "witness": []}
    loads = [0] * model["horizon"]
    selected = [None] * len(jobs)
    next_start = [0] * len(jobs)
    depth, nodes, prunes = 0, 0, 0
    while depth >= 0:
        if depth == len(jobs):
            witness = [{"job": job["id"], "start": start,
                        "end": start + job["duration"], "demand": job["demand"]}
                       for job, start in zip(jobs, selected)]
            return {**base, "status": "FEASIBLE", "reason": "complete integer-start witness",
                    "nodes": nodes, "capacity_prunes": prunes,
                    "search_exhausted": False, "witness": witness}
        job, domain = jobs[depth], starts[depth]
        if next_start[depth] >= len(domain):
            next_start[depth] = 0
            depth -= 1
            if depth >= 0:
                previous, start = jobs[depth], selected[depth]
                for time in range(start, start + previous["duration"]):
                    loads[time] -= previous["demand"]
            continue
        if nodes >= node_limit:
            return {**base, "status": "UNKNOWN", "reason": "subproblem node limit reached",
                    "nodes": nodes, "capacity_prunes": prunes,
                    "search_exhausted": False, "witness": None}
        start = domain[next_start[depth]]
        next_start[depth] += 1
        nodes += 1
        interval = range(start, start + job["duration"])
        if any(loads[time] + job["demand"] > model["beds"] for time in interval):
            prunes += 1
            continue
        for time in interval:
            loads[time] += job["demand"]
        selected[depth] = start
        depth += 1
        if depth < len(jobs):
            next_start[depth] = 0
    return {**base, "status": "INFEASIBLE", "reason": "all integer starts exhausted with sound capacity pruning",
            "nodes": nodes, "capacity_prunes": prunes,
            "search_exhausted": True, "witness": None}


def _compile_master(problem, limit):
    """Enumerate structural assignments and their public G, without querying F."""
    candidates, scanned, complete = [], 0, True
    for vector in itertools.product(*problem.domains):
        if scanned >= limit:
            complete = False
            break
        scanned += 1
        if problem.feasible(vector):
            score = float(problem.cheap(vector))
            if not math.isfinite(score):
                raise ValueError("The declared cheap G must be finite")
            candidates.append((score, tuple(vector)))
    return candidates, {"method": "finite_domain_exhaustive_master", "objective": "maximize public G = unary + factors",
                        "scanned_vectors": scanned, "structural_candidates": len(candidates),
                        "vector_limit": limit, "complete": complete}


def _conflict_cut(problem, vector, answer, *, node_limit, reduction_limit):
    """Lift a proven unschedulable job subset to its activation conditions.

    Every omitted job only relaxes a nonnegative cumulative-capacity model.
    Thus retaining all jobs of a proved infeasible core remains infeasible,
    regardless of changes to unrelated assignment variables or added jobs.
    Core shrinking removes a job only after another complete INFEASIBLE proof.
    """
    original_jobs = answer["model"]["jobs"]
    core, certificate = list(original_jobs), answer
    attempts, removed = [], []
    for job in original_jobs[:reduction_limit]:
        trial = [item for item in core if item["id"] != job["id"]]
        view = SimpleNamespace(domains=problem.domains, spec={"scheduling": {
            "horizon": answer["model"]["horizon"], "beds": answer["model"]["beds"], "jobs": trial}})
        proof = schedule_subproblem(view, vector, node_limit=node_limit)
        attempts.append({"remove_job": job["id"], "status": proof["status"], "nodes": proof["nodes"]})
        if proof["status"] == "INFEASIBLE" and proof["search_exhausted"]:
            core, certificate = trial, proof
            removed.append(job["id"])
    retained_values = {}
    for job in core:
        var = job["var"]
        if var is not None:
            retained_values.setdefault(var, set(problem.domains[var]))
            retained_values[var].intersection_update(job["values"])
    literals = [{"var": var, "value": vector[var], "values": sorted(values)}
                for var, values in sorted(retained_values.items()) if values != set(problem.domains[var])]
    assert all(vector[item["var"]] in item["values"] for item in literals)
    return {
        "kind": "proven_recovery_core_no_good", "formula": "sum(x_i not in retained_values_i) >= 1",
        "literals": literals, "rejected_vector": list(vector), "certificate": certificate,
        "derivation": "a proved infeasible subset of nonnegative recovery jobs stays infeasible whenever its activation conditions are retained",
        "core_reduction": {"original_jobs": len(original_jobs), "core_jobs": len(core),
                           "removed_jobs": removed, "attempts": attempts, "attempt_limit": reduction_limit,
                           "subset_minimal_proved": len(attempts) == len(original_jobs)
                           and all(item["status"] != "UNKNOWN" for item in attempts)},
    }


def _cut_rejects(cut, vector):
    return all(vector[item["var"]] in item["values"] for item in cut["literals"])


def solve(problem, *, seed=42, budget=16):
    """Run feasibility-cut LBBD, then enumerate further G-ranked feasible models.

    The initial candidate is checked and its first full evaluation counts against
    budget.  K-best candidate visitation exclusions are logged separately from
    Benders cuts, because excluding a visited feasible vector proves nothing.
    """
    if not _integer(budget):
        raise ValueError("budget must be a nonnegative integer")
    metadata = getattr(problem, "metadata", problem.spec.get("metadata", {}))
    options = metadata.get("m05", {})
    master_limit = options.get("master_vector_limit", DEFAULT_MASTER_LIMIT)
    node_limit = options.get("subproblem_node_limit", DEFAULT_SUBPROBLEM_LIMIT)
    iteration_limit = options.get("iteration_limit", DEFAULT_ITERATION_LIMIT)
    reduction_limit = options.get("core_reduction_limit", DEFAULT_CORE_REDUCTION_LIMIT)
    if any(not _integer(value) for value in (master_limit, node_limit, iteration_limit, reduction_limit)):
        raise ValueError("m05 work limits must be nonnegative integers")
    pool, master = _compile_master(problem, master_limit)
    cuts, exclusions, deferred, iterations = [], [], [], []
    cut_vectors, visited = set(), set()
    visited_order, seen_G_strata, valid_full_vectors = [], set(), set()
    witnessed = {}
    best_vector, best_score, queries = None, None, 0

    def can_query():
        return queries < budget and getattr(problem, "remaining", budget - queries) > 0

    def process(vector, stage):
        nonlocal queries, best_vector, best_score
        answer = schedule_subproblem(problem, vector, node_limit=node_limit)
        record = {"stage": stage, "vector": list(vector), "G": float(problem.cheap(vector)), "subproblem": answer}
        if answer["status"] == "INFEASIBLE":
            # Only a complete, fixed-assignment infeasibility proof enters here.
            assert answer["search_exhausted"]
            cut = _conflict_cut(problem, vector, answer, node_limit=node_limit, reduction_limit=reduction_limit)
            covered = {candidate for _, candidate in pool if _cut_rejects(cut, candidate)}
            cut.update(id=len(cuts) + 1, covered_master_vectors=len(covered))
            cuts.append(cut)
            cut_vectors.update(covered)
            cut_vectors.add(vector)
            record["added_cut"] = cut["id"]
            return record
        visited.add(vector)
        visited_order.append(vector)
        if answer["status"] == "UNKNOWN":
            deferred.append({"vector": list(vector), "G": record["G"], "reason": answer["reason"]})
            record["added_cut"] = None
            return record
        witnessed[vector] = {"G": record["G"], "witness": answer["witness"]}
        # This exclusion is for distinct candidate visitation, never a proof cut.
        exclusions.append({"vector": list(vector), "reason": "visited finite-schedule-feasible candidate",
                           "is_benders_cut": False})
        if not can_query():
            record["evaluation"] = None
            return record
        queries += 1
        try:
            evaluation = problem.evaluate(vector, fidelity="full", seed=seed)
        except Exception as exc:
            evaluation = {"vector": list(vector), "valid": False, "score": None,
                          "fidelity": "full", "seed": seed,
                          "error": f"{type(exc).__name__}: {exc}"}
        record["evaluation"] = evaluation
        score = evaluation.get("score")
        if (evaluation.get("valid") and evaluation.get("fidelity") == "full"
                and isinstance(score, (int, float)) and math.isfinite(score)):
            valid_full_vectors.add(vector)
            if best_score is None or score > best_score:
                best_vector, best_score = list(vector), float(score)
        return record

    initial_record = None
    initial = tuple(problem.initial)
    if can_query() and problem.feasible(initial):
        initial_record = process(initial, "initial")
    termination = "ITERATION_LIMIT"
    for index in range(iteration_limit):
        if not can_query():
            termination = "F_BUDGET_EXHAUSTED"
            break
        available = [(score, vector) for score, vector in pool if vector not in cut_vectors and vector not in visited]
        if not available:
            termination = "MASTER_EXHAUSTED" if master["complete"] else "MASTER_VECTOR_LIMIT"
            break
        # This exactly re-optimizes G after all current proof cuts and explicitly
        # labelled k-best visitation exclusions.  No F or hidden oracle data enter.
        score = max(item[0] for item in available)
        tied = sorted((item for item in available if item[0] == score), key=lambda item: item[1])
        tie_break = "lexicographic_first_in_G_stratum"
        if score in seen_G_strata and visited_order and len(tied) > 1:
            # Bound coverage work without changing the master G optimum: every
            # item in this sampled tie set has exactly the same maximal G.
            anchors = visited_order[-16:]
            step = max(1, math.ceil(len(tied) / 512))
            tie_sample = tied[::step]
            _, vector = min(tie_sample, key=lambda item: (
                -min(sum(a != b for a, b in zip(item[1], other)) for other in anchors), item[1]))
            tie_break = "maximin_hamming_within_equal_G" if step == 1 else "bounded_maximin_hamming_within_equal_G"
        else:
            _, vector = tied[0]
        seen_G_strata.add(score)
        record = {"iteration": index + 1, "master_status": "OPTIMAL" if master["complete"] else "PARTIAL_POOL_BEST",
                  "active_benders_cuts": len(cuts), "active_visitation_exclusions": len(visited),
                  "remaining_master_candidates": len(available), "G_tie_count": len(tied), "tie_break": tie_break}
        record.update(process(vector, "master"))
        iterations.append(record)
    remaining_G = [score for score, vector in pool if vector not in cut_vectors]
    upper_bound = max(remaining_G) if master["complete"] and remaining_G else None
    model_best = min(witnessed, key=lambda vector: (-witnessed[vector]["G"], vector)) if witnessed else None
    model_value = witnessed[model_best]["G"] if model_best is not None else None
    # An initial vector may be outside a truncated pool, so truncation cannot
    # certify optimality even if that initial vector is the best witnessed one.
    model_optimal = bool(master["complete"] and model_value is not None and upper_bound is not None and model_value >= upper_bound)
    model_infeasible = bool(master["complete"] and not remaining_G and not witnessed)
    unqueried = [vector for _, vector in pool if vector not in cut_vectors and vector not in valid_full_vectors]
    full_coverage = bool(master["complete"] and not unqueried)
    all_full_queried = bool(master["complete"] and all(vector in valid_full_vectors for _, vector in pool))
    return {
        "best_vector": best_vector,
        "diagnostics": {
            "algorithm": "logic_based_benders_feasibility_cuts",
            "proxy": "G = problem.cheap(vector); F = queried public full evaluation",
            "queries": queries, "budget": budget, "best_score": best_score,
            "master": master, "initial": initial_record, "iterations": iterations,
            "cuts": cuts, "enumeration_exclusions": exclusions, "deferred": deferred,
            "scheduling_feedback": "declared_finite_recovery_model" if problem.spec.get("scheduling") else "no_declared_scheduling; candidate_search_only",
            "coverage": {"valid_full_vectors": len(valid_full_vectors), "proven_infeasible_vectors": len(cut_vectors),
                         "remaining_without_valid_full": len(unqueried), "complete": full_coverage,
                         "meaning": "every structural vector either proved scheduling-infeasible or valid/full queried"},
            "termination": termination, "seed": seed,
        },
        "model_objective": {"name": "maximize G subject to structural and finite bed-scheduling constraints",
                            "best_feasible_value": model_value,
                            "best_vector": list(model_best) if model_best is not None else None,
                            "upper_bound": upper_bound, "optimal": model_optimal},
        "proof_scope": {
            "domain": "declared finite assignment domains and integer_bed_jobs_v1 only",
            "finite_G_optimality": model_optimal, "finite_model_infeasible": model_infeasible,
            "cut_validity": "only complete exhaustive INFEASIBLE core certificates generate activation-condition no-goods",
            "finite_model_covered_by_proofs_or_full_queries": full_coverage,
            "all_finite_candidates_valid_full_queried": all_full_queried,
            "scheduling_declared": bool(problem.spec.get("scheduling")),
            "F_global_optimality": False,
            "limitations": "no continuous-time, game-morale, policy, or long-run production guarantee; UNKNOWN is not infeasible",
        },
    }
