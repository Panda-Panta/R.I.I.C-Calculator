"""Auxiliary G-initialized ALNS/CP-SAT hybrid with one full-query ledger.

This combines actual proposal builders, never three separately budgeted solves.
No oracle call occurs during G ranking, destroy, repair or CP model solving.
"""
from __future__ import annotations

import math
import random

try:
    from . import m01_pool, m02_alns, m03_cpsat
except ImportError:  # run_suite loads individual modules from its own directory.
    from methods import m01_pool, m02_alns, m03_cpsat


def _cp_repair(problem, anchor, removed, excluded, *, seed, seconds=1.0):
    """Optimize public G inside an ALNS neighborhood using actual CP-SAT."""
    log = {"component": "m03_cpsat._build_model + ortools.CpSolver.solve",
           "removed": list(removed), "fixed": [i for i in range(len(anchor)) if i not in removed],
           "solver_calls": 0, "solver_seconds": 0.0, "statuses": [], "schedule_rejections": 0}
    if seconds <= 0:
        log["reason"] = "cumulative_cp_time_budget_exhausted"
        return None, log
    try:
        import ortools
        from ortools.sat.python import cp_model
    except ImportError:
        log["reason"] = "ortools_unavailable"
        return None, log
    log["solver_version"] = ortools.__version__
    model, variables, choices, metadata, _ = m03_cpsat._build_model(problem.spec, cp_model)
    log["model"] = metadata
    for index in log["fixed"]:
        model.add(variables[index] == anchor[index])
    for vector in excluded:
        model.add_bool_or([choices[index][value].Not() for index, value in enumerate(vector)])
    # Schedule is independently checked. Its rejection only excludes that vector;
    # it is not generalized to an unproved Benders cut or a full-F constraint.
    for _ in range(16):
        remaining = seconds - log["solver_seconds"]
        if remaining <= 0:
            break
        solver = cp_model.CpSolver()
        solver.parameters.num_search_workers = 1
        solver.parameters.random_seed = int(seed) & 0x7FFFFFFF
        solver.parameters.max_time_in_seconds = remaining
        status = solver.solve(model)
        log["solver_calls"] += 1
        log["solver_seconds"] += solver.wall_time
        log["statuses"].append(solver.status_name(status))
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return None, log
        candidate = tuple(solver.value(variable) for variable in variables)
        if m02_alns._legal(problem, candidate):
            log["candidate"] = list(candidate)
            log["scaled_G"] = solver.objective_value
            log["scaled_G_bound"] = solver.best_objective_bound
            return candidate, log
        log["schedule_rejections"] += 1
        model.add_bool_or([choices[index][value].Not() for index, value in enumerate(candidate)])
    log["reason"] = "repair_time_or_schedule_attempt_limit"
    return None, log


def solve(problem, *, seed=42, budget=16):
    """Spend at most min(budget, public remaining) across the whole hybrid."""
    if type(budget) is not int or budget < 0:
        raise ValueError("budget must be a nonnegative integer")
    rng = random.Random(seed)
    query_limit = min(budget, max(0, int(problem.remaining)))
    start_history = len(problem.history)
    seen = {tuple(row["vector"]) for row in problem.history if row.get("fidelity") == "full"}
    existing = problem.best()
    current = tuple(existing["vector"]) if existing is not None else tuple(problem.initial)
    current_score = m02_alns._observed_score(existing) if existing is not None else None
    best_vector = tuple(existing["vector"]) if existing is not None else None
    best_score = current_score
    queries, cp_seconds, valid_new = 0, 0.0, 0
    ledger, operations = [], []
    component_calls = {"m01.build_pools": 0, "m02.destroy": 0, "m02.repair": 0,
                       "m03.cp_repair": 0, "ortools.CpSolver.solve": 0}
    stage_queries = {"initial": 0, "G_champion": 0, "cp_repair": 0, "alns_repair": 0, "alns_fallback": 0}
    weights = m02_alns._AdaptiveWeights(["related", "random", "restart"])
    weight_updates = []
    pool = None
    champion = None
    coverage_size = None

    def available():
        return queries < query_limit and problem.remaining > 0

    def query(candidate, stage):
        nonlocal queries, best_vector, best_score, valid_new
        if not available() or candidate in seen:
            raise RuntimeError("hybrid attempted an unallocated or duplicate full query")
        record = problem.evaluate(candidate, fidelity="full", seed=seed)
        queries += 1
        stage_queries[stage] += 1
        seen.add(candidate)
        score = m02_alns._observed_score(record)
        improved = score is not None and (best_score is None or score > best_score)
        if score is not None:
            valid_new += 1
        if improved:
            best_vector, best_score = candidate, score
        ledger.append({"query": queries, "history_index": start_history + queries - 1,
                       "stage": stage, "vector": list(candidate), "score": score,
                       "valid_full": score is not None, "best_score_so_far": best_score})
        return score, improved

    initial = tuple(problem.initial)
    if available() and initial not in seen and m02_alns._legal(problem, initial):
        current = initial
        current_score, _ = query(initial, "initial")
    if available():
        component_calls["m01.build_pools"] += 1
        pool = m01_pool.build_pools(problem, 1)
        if pool["model_complete"]:
            coverage_size = pool["unique_model_candidates"]
        if pool["top_k"]:
            champion = tuple(pool["top_k"][0])
            if champion not in seen:
                score, _ = query(champion, "G_champion")
                if score is not None and (current_score is None or score >= current_score):
                    current, current_score = champion, score
    proposal_quota = query_limit - queries
    planned_queries = {"initial": stage_queries["initial"], "G_champion": stage_queries["G_champion"],
                       "cp_repair_slots": (proposal_quota + 1) // 2, "alns_repair_slots": proposal_quota // 2}
    scale = abs(current_score) if current_score is not None else 1.0
    initial_temperature = max(1.0, scale) * 0.1
    proposal_index = 0
    status = "query_budget_exhausted" if query_limit else "no_query_budget"
    for attempt in range(max(16, query_limit * 8)):
        if not available():
            break
        if coverage_size is not None and len(seen) == coverage_size:
            status = "declared_legal_domain_exhausted"
            break
        destroy_name = weights.choose(rng)
        count = rng.randint(1, max(1, math.ceil(len(current) * 0.6)))
        component_calls["m02.destroy"] += 1
        if destroy_name == "restart" or not m02_alns._legal(problem, current):
            removed = list(range(len(current)))
        elif destroy_name == "related":
            removed = m02_alns._destroy_related(problem, current, rng, count)
        else:
            removed = m02_alns._destroy_random(problem, current, rng, count)
        phase = "cp_repair" if proposal_index % 2 == 0 else "alns_repair"
        candidate = None
        repair_log = {}
        if phase == "cp_repair":
            component_calls["m03.cp_repair"] += 1
            candidate, repair_log = _cp_repair(problem, current, removed, seen,
                                                seed=seed, seconds=min(1.0, max(0.0, 8.0 - cp_seconds)))
            cp_seconds += repair_log["solver_seconds"]
            component_calls["ortools.CpSolver.solve"] += repair_log["solver_calls"]
        if phase == "alns_repair" or candidate is None:
            component_calls["m02.repair"] += 1
            fallback, alns_log = m02_alns._repair(problem, current, removed, rng,
                                                "rank_randomized" if phase == "alns_repair" else "greedy", seen)
            repair_log = {"cp": repair_log, "alns": alns_log} if phase == "cp_repair" else {"alns": alns_log}
            candidate = fallback
            if alns_log["covers_entire_domain"]:
                coverage_size = alns_log["legal_domain_count"]
            if phase == "cp_repair":
                phase = "alns_fallback"
        if candidate is None and len(removed) < len(current):
            component_calls["m02.repair"] += 1
            candidate, restart_log = m02_alns._repair(problem, current, list(range(len(current))), rng, "rank_randomized", seen)
            repair_log["global_fallback"] = restart_log
            if restart_log["covers_entire_domain"]:
                coverage_size = restart_log["legal_domain_count"]
            phase = "alns_fallback"
        reward, accepted, probability = 0.0, False, None
        candidate_score = None
        temperature = initial_temperature * (0.05 ** (queries / max(1, query_limit)))
        if candidate is not None:
            candidate_score, improved = query(candidate, phase)
            proposal_index += 1
            if candidate_score is not None:
                if current_score is None:
                    accepted, probability = True, 1.0
                else:
                    accepted, probability = m02_alns._acceptance(candidate_score - current_score, temperature, rng)
                reward = 8.0 if improved else 4.0 if accepted and (current_score is None or candidate_score > current_score) else 1.0 if accepted else 0.0
                if accepted:
                    current, current_score = candidate, candidate_score
        weights.reward(destroy_name, reward)
        operations.append({"attempt": attempt + 1, "destroy": destroy_name, "removed": removed,
                           "phase": phase, "candidate": list(candidate) if candidate is not None else None,
                           "score": candidate_score, "accepted": accepted, "probability": probability,
                           "temperature": temperature, "reward": reward, "repair": repair_log})
        if (attempt + 1) % 4 == 0:
            weight_updates.append(weights.update())
    else:
        status = "proposal_attempt_limit"
    if any(weights.uses.values()):
        weight_updates.append(weights.update())
    complete = coverage_size is not None and len(seen) == coverage_size
    if complete:
        status = "declared_legal_domain_exhausted"
    champion_record = next((record for record in problem.history
                            if champion is not None and tuple(record["vector"]) == champion and record["fidelity"] == "full"), None)
    return {"best_vector": list(best_vector) if best_vector is not None else None,
            "best_score": best_score,
            "G_champion": {"vector": list(champion) if champion is not None else None,
                           "G": float(problem.cheap(champion)) if champion is not None else None,
                           "model_complete": pool["model_complete"] if pool else False,
                           "observed_full_F": m02_alns._observed_score(champion_record) if champion_record else None},
            "diagnostics": {"method": "m16_auxiliary_hybrid", "status": status, "seed": seed,
                            "requested_budget": budget, "effective_query_budget": query_limit, "queries": queries,
                            "planned_query_allocation": planned_queries, "stage_queries": stage_queries,
                            "allocation_rule": "Initial and G champion first; remaining successful proposal slots alternate CP-SAT/ALNS. Failed repair may transfer its slot to a logged ALNS fallback; no extra full query allocation.",
                            "component_calls": component_calls, "CP_solver_seconds": cp_seconds,
                            "actual_composition_verified": all(component_calls[name] > 0 for name in
                                                               ("m01.build_pools", "m02.destroy", "m02.repair", "ortools.CpSolver.solve")),
                            "CP_solver_time_budget": 8.0, "query_ledger": ledger, "operations": operations,
                            "destroy_weights": dict(weights.weights), "weight_updates": weight_updates,
                            "coverage": {"legal_domain_count": coverage_size, "queried_unique": len(seen), "complete": complete,
                                         "finite_observation_maximum_proven": complete and valid_new == queries and start_history == 0 and best_vector is not None}},
            "proof_scope": "Auxiliary hybrid using actual G ranking, ALNS destroy/repair/acceptance and OR-Tools CP-SAT neighborhood optimization with one shared full-query budget. G/CP proof is only the declared proxy; F best is observed valid/full history. No generic hybrid superiority, expected-income or real-game optimum claim. No statistical racing in this first hybrid."}
