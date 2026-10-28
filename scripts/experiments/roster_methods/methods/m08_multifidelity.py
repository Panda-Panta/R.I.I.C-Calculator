"""Budgeted successive halving with explicit fidelity and elimination audits.

This is one halving bracket, not Hyperband or BOHB.  Cheap scores are public
features; every short/full observation comes from ``problem.evaluate``.
"""

from __future__ import annotations

import math
import random
from itertools import product
from collections import defaultdict


def _rank_comparison(low, full):
    """Describe only the overlap actually observed at both fidelities."""
    overlap = sorted(set(low) & set(full))
    reversals = []
    concordant = discordant = ties = 0
    for i, left in enumerate(overlap):
        for right in overlap[i + 1 :]:
            direction = (low[left] - low[right]) * (full[left] - full[right])
            if direction < 0:
                discordant += 1
                reversals.append([list(left), list(right)])
            elif direction > 0:
                concordant += 1
            else:
                ties += 1

    def ranks(values):
        ordered = sorted(overlap, key=lambda vector: values[vector])
        result = {}
        start = 0
        while start < len(ordered):
            stop = start + 1
            while stop < len(ordered) and values[ordered[stop]] == values[ordered[start]]:
                stop += 1
            for vector in ordered[start:stop]:
                result[vector] = (start + stop - 1) / 2
            start = stop
        return result

    rho = None
    if len(overlap) >= 2:
        left_ranks, right_ranks = ranks(low), ranks(full)
        center = (len(overlap) - 1) / 2
        covariance = sum((left_ranks[v] - center) * (right_ranks[v] - center) for v in overlap)
        denominator = math.sqrt(
            sum((left_ranks[v] - center) ** 2 for v in overlap)
            * sum((right_ranks[v] - center) ** 2 for v in overlap)
        )
        if denominator:
            rho = covariance / denominator
    return {
        "observed_overlap": len(overlap),
        "spearman_rho": rho,
        "concordant_pairs": concordant,
        "reversed_pairs": discordant,
        "tied_pairs": ties,
        "reversal_vectors": reversals,
        "scope": "observed full-checked overlap at the primary seed only",
    }


def solve(problem, *, seed=42, budget=16):
    """Search feasible public vectors and return an incumbent checked at full.

    ``budget`` counts evaluate calls, including invalid/unsupported results and
    cached calls. Direct cheap calls are counted separately. With fewer than
    four available queries, the routine uses full-only evaluation rather than
    inventing an incomplete halving round.
    """
    seed = int(seed)
    requested_budget = max(0, int(budget))
    query_limit = min(requested_budget, max(0, int(problem.remaining)))
    rng = random.Random(seed)
    initial = tuple(problem.initial)
    queries = []
    rounds = []
    cheap_scores = {}
    short_scores = {}
    full_records = defaultdict(list)
    primary_full = {}
    counts = {"short": 0, "full": 0}
    cheap_calls = 0
    if not problem.feasible(initial):
        initial_validation = {"eligible": False, "reason": "structurally-infeasible"}
    elif not problem.schedule_feasible(initial):
        initial_validation = {"eligible": False, "reason": "finite-schedule-infeasible"}
    else:
        initial_validation = {"eligible": True, "reason": "public-constraints-passed"}
    initial_validation["vector"] = list(initial)

    def remaining():
        return min(query_limit - len(queries), max(0, int(problem.remaining)))

    def evaluate(vector, fidelity, role, query_seed=seed):
        if remaining() <= 0:
            return None
        # Count the invocation even if the adapter raises unsupported-fidelity.
        counts[fidelity] += 1
        try:
            record = dict(problem.evaluate(vector, fidelity=fidelity, seed=query_seed))
        except NotImplementedError as error:
            record = {"valid": False, "score": None, "fidelity": fidelity, "error": str(error)}
        score = record.get("score")
        usable = (
            record.get("valid") is True
            and record.get("fidelity") == fidelity
            and tuple(record.get("vector", vector)) == vector
            and isinstance(score, (int, float))
            and math.isfinite(score)
        )
        observation = {
            "vector": list(vector), "fidelity": fidelity, "seed": query_seed,
            "role": role, "valid": bool(usable),
            "score": float(score) if usable else None,
            "reported_fidelity": record.get("fidelity"),
        }
        if "error" in record:
            observation["error"] = record["error"]
        queries.append(observation)
        if usable and fidelity == "full":
            full_records[vector].append(observation)
            if query_seed == seed:
                primary_full[vector] = float(score)
        return observation

    if remaining() and initial_validation["eligible"]:
        initial_record = evaluate(initial, "full", "initial")
        rounds.append({"stage": "initial_full", "evaluated_count": 1, "records": [initial_record]})

    # Solve n + ceil(n/2) + one full audit <= remaining query allowance.
    # A two-candidate bracket still runs when there is room for no audit.
    available = remaining()
    short_target = 0
    for count in range(2, available + 1):
        audit_cost = 1 if available >= 4 else 0
        if count + math.ceil(count / 2) + audit_cost <= available:
            short_target = count
    pool_target = max(4, 2 * short_target) if available else 0
    candidates = []
    seen = {initial}
    attempts = 0
    rejected = 0
    domains = [list(domain) for domain in problem.domains]

    def propose(vector):
        nonlocal attempts, rejected
        vector = tuple(vector)
        attempts += 1
        if vector in seen:
            return
        seen.add(vector)
        if not problem.feasible(vector) or not problem.schedule_feasible(vector):
            rejected += 1
            return
        candidates.append(vector)

    domain_cardinality = math.prod(len(domain) for domain in domains)
    candidate_mode = "sampled_public_candidates"
    if pool_target and domain_cardinality <= 4096:
        # The complete scan is of public legality/cheap G, never oracle F.
        # A small random proposal pool can otherwise miss known model leaders.
        candidate_mode = "complete_public_feasibility_scan"
        initial_in_domain = len(initial) == len(domains) and all(initial[i] in domain for i, domain in enumerate(domains))
        pool_target = domain_cardinality - int(initial_in_domain)
        for vector in product(*domains):
            propose(vector)
    else:
        # Mix local changes and random complete vectors; never inspect hidden F.
        coordinates = list(range(len(domains))) if pool_target else []
        rng.shuffle(coordinates)
        local_target = max(1, pool_target // 2)
        for coordinate in coordinates:
            values = list(domains[coordinate])
            rng.shuffle(values)
            for value in values:
                vector = list(initial)
                vector[coordinate] = value
                propose(vector)
                if len(candidates) >= local_target:
                    break
            if len(candidates) >= local_target:
                break
        while len(candidates) < pool_target and attempts < max(64, pool_target * 40):
            if any(not domain for domain in domains):
                break
            propose([rng.choice(domain) for domain in domains])

    if query_limit:
        for vector in ([initial] if initial_validation["eligible"] else []) + candidates:
            value = float(problem.cheap(vector))
            cheap_calls += 1
            if math.isfinite(value):
                cheap_scores[vector] = value
    ranked = sorted(candidates, key=lambda v: (-cheap_scores.get(v, -math.inf), v))
    public_scan_complete = candidate_mode == "complete_public_feasibility_scan"
    reserve_complete_full = public_scan_complete and available >= len(candidates)
    if reserve_complete_full:
        # Full coverage is possible: short screening must not consume its slots.
        short_target = min(short_target, available - len(candidates))
        if short_target < 2:
            short_target = 0
    cheap_exploration = None
    promoted = []
    audit = None
    discarded_short = []
    discarded_cheap = []
    short_records = []
    full_round_records = []

    if short_target and ranked:
        actual_short = min(short_target, len(ranked))
        selected = ranked[:actual_short]
        # Keep a slot from below the cheap cutoff when such candidates exist.
        if actual_short >= 2 and len(ranked) > actual_short:
            cheap_exploration = rng.choice(ranked[actual_short:])
            selected = ranked[: actual_short - 1] + [cheap_exploration]
        discarded_cheap = [v for v in ranked if v not in selected]
        rounds.append({
            "stage": "cheap", "evaluated_count": len(ranked),
            "advanced_count": len(selected), "advanced": [list(v) for v in selected],
            "discarded": [list(v) for v in discarded_cheap],
            "exploration": list(cheap_exploration) if cheap_exploration is not None else None,
            "resource": "direct problem.cheap calls; no native simulation",
        })
        for vector in selected:
            observation = evaluate(vector, "short", "short_screen")
            if observation is None:
                break
            short_records.append(observation)
            if observation["valid"]:
                short_scores[vector] = observation["score"]
        ranked_short = sorted(short_scores, key=lambda v: (-short_scores[v], v))
        # Invalid/unsupported short results stay unranked, never become score 0.
        promoted = ranked_short[: math.ceil(len(selected) / 2)]
        if not promoted and remaining():
            promoted = selected[:1]
        discarded_short = [v for v in selected if v not in promoted]
        if discarded_short and remaining() > len(promoted):
            audit = rng.choice(discarded_short)
        rounds.append({
            "stage": "short", "evaluated_count": len(short_records),
            "valid_count": len(short_scores), "promoted_count": len(promoted),
            "promoted": [list(v) for v in promoted],
            "discarded": [list(v) for v in discarded_short],
            "audit": list(audit) if audit is not None else None,
            "fallback_if_no_valid_short": not bool(ranked_short),
            "records": short_records,
        })
        for vector in promoted:
            observation = evaluate(vector, "full", "short_promoted")
            if observation is not None:
                full_round_records.append(observation)
        if audit is not None:
            observation = evaluate(audit, "full", "elimination_audit")
            if observation is not None:
                full_round_records.append(observation)
    elif ranked:
        # A small budget must still return only a genuinely full-checked result.
        selected = ranked[:remaining()]
        if len(selected) >= 2 and len(ranked) > len(selected):
            selected[-1] = rng.choice(ranked[len(selected):])
        rounds.append({
            "stage": "cheap", "evaluated_count": len(ranked),
            "advanced_count": len(selected), "advanced": [list(v) for v in selected],
            "discarded": [list(v) for v in ranked if v not in selected],
            "resource": "direct problem.cheap calls; full-only small-budget fallback",
        })
        for vector in selected:
            observation = evaluate(vector, "full", "small_budget_full")
            if observation is not None:
                full_round_records.append(observation)
    if full_round_records:
        rounds.append({"stage": "full", "evaluated_count": len(full_round_records), "records": full_round_records})

    # Spend spare resources on unqueried discards before repeating observations.
    # This makes complete fixed-seed coverage possible when it was reserved.
    queried_full = {tuple(q["vector"]) for q in queries if q["fidelity"] == "full"}
    extra_short = sorted(
        (v for v in discarded_short if v not in queried_full),
        key=lambda v: (-short_scores.get(v, -math.inf), v),
    )
    extra_order = extra_short + [v for v in ranked if v not in queried_full and v not in extra_short]
    extra_full_records = []
    for vector in extra_order:
        role = "additional_short_audit" if vector in discarded_short else "additional_cheap_audit"
        observation = evaluate(vector, "full", role)
        if observation is None:
            break
        extra_full_records.append(observation)
    if extra_full_records:
        rounds.append({"stage": "full_audit_expansion", "evaluated_count": len(extra_full_records), "records": extra_full_records})

    # Then reuse resources for new-seed full replications of every contender.
    # These are observations, not a sequential confidence guarantee.
    recheck_records = []
    contenders = list(dict.fromkeys(
        ([initial] if initial_validation["eligible"] else [])
        + [tuple(r["vector"]) for r in full_round_records + extra_full_records]
    ))
    recheck_index = 0
    while remaining() and contenders:
        vector = contenders[recheck_index % len(contenders)]
        query_seed = seed + 1 + recheck_index // len(contenders)
        observation = evaluate(vector, "full", "full_recheck", query_seed)
        if observation is None:
            break
        recheck_records.append(observation)
        recheck_index += 1
    if recheck_records:
        rounds.append({"stage": "full_recheck", "evaluated_count": len(recheck_records), "records": recheck_records})

    means = {v: sum(r["score"] for r in records) / len(records) for v, records in full_records.items()}
    best = min(means, key=lambda v: (-means[v], v)) if means else None
    promoted_full = {v: primary_full[v] for v in promoted if v in primary_full}
    false_eliminations = []
    for stage, discarded in (("short", discarded_short), ("cheap", discarded_cheap)):
        for vector in discarded:
            if vector in primary_full and promoted_full and primary_full[vector] > max(promoted_full.values()):
                false_eliminations.append({
                    "vector": list(vector), "full_score": primary_full[vector],
                    "best_promoted_full_score": max(promoted_full.values()),
                    "stage": stage, "rescued_by": "full elimination audit",
                })
    public_vectors = set(candidates) | ({initial} if initial_validation["eligible"] else set())
    primary_queried = {tuple(q["vector"]) for q in queries if q["fidelity"] == "full" and q["seed"] == seed}
    finite_certified = public_scan_complete and bool(public_vectors) and public_vectors <= primary_full.keys()
    primary_best = min(primary_full, key=lambda v: (-primary_full[v], v)) if primary_full else None
    coverage_curve = []
    seen_full, seen_valid_primary = set(), set()
    for index, observation in enumerate(queries):
        if observation["fidelity"] == "full":
            vector = tuple(observation["vector"])
            seen_full.add(vector)
            if observation["seed"] == seed and observation["valid"]:
                seen_valid_primary.add(vector)
            coverage_curve.append({
                "queries_consumed": index + 1, "unique_full_queried": len(seen_full),
                "valid_primary_full": len(seen_valid_primary), "last_role": observation["role"],
            })
    diagnostics = {
        "method": "one successive-halving bracket with exploration and a full audit",
        "seed": seed, "requested_budget": requested_budget, "query_limit": query_limit,
        "initial_validation": initial_validation,
        "queries_used": len(queries), "query_counts": counts, "cheap_calls": cheap_calls,
        "candidate_count": len(candidates),
        "candidate_generation": {
            "attempts": attempts, "rejected_by_public_constraints": rejected,
            "mode": candidate_mode, "domain_cardinality": domain_cardinality,
            "complete_public_scan_limit": 4096,
        },
        "resource_plan": {
            "eta": 2, "cheap_pool_target": pool_target, "short_target": short_target,
            "promotion_target": math.ceil(short_target / 2),
            "audit_reserved": bool(short_target and available >= 4),
            "complete_full_coverage_reserved": reserve_complete_full,
            "mode": "successive_halving" if short_target else "full_only_complete_domain" if reserve_complete_full else "full_only_insufficient_budget",
            "query_budget_semantics": "each evaluate call counts; direct cheap calls are separate",
        },
        "rounds": rounds, "queries": queries, "full_coverage_curve": coverage_curve,
        "finite_full_coverage": {
            "public_domain_completely_scanned": public_scan_complete,
            "public_feasible_count": len(public_vectors) if public_scan_complete else None,
            "unique_primary_full_queried_count": len(primary_queried),
            "valid_primary_full_count": len(primary_full),
            "unqueried_count": len(public_vectors - primary_queried) if public_scan_complete else None,
            "fixed_seed_maximum_certified": bool(finite_certified), "primary_seed": seed,
            "fixed_seed_best_vector": list(primary_best) if finite_certified else None,
            "fixed_seed_best_score": primary_full[primary_best] if finite_certified else None,
            "assumption": "full oracle is a deterministic function of vector, fidelity, and seed",
            "scope": "declared public-feasible finite domain and supplied full oracle at primary_seed only; not an expectation or game optimum",
        },
        "full_candidates": [
            {"vector": list(v), "samples": len(full_records[v]), "mean_score": means[v]}
            for v in sorted(means)
        ],
        "selection_criterion": "highest mean among this run's valid/full observations",
        "rank_diagnostics": {
            "cheap_vs_full": _rank_comparison(cheap_scores, primary_full),
            "short_vs_full": _rank_comparison(short_scores, primary_full),
        },
        "elimination_audit": {
            "cheap_exploration": list(cheap_exploration) if cheap_exploration is not None else None,
            "short_audit": list(audit) if audit is not None else None,
            "additional_short_audits": [r["vector"] for r in extra_full_records if r["role"] == "additional_short_audit"],
            "additional_cheap_audits": [r["vector"] for r in extra_full_records if r["role"] == "additional_cheap_audit"],
            "confirmed_false_eliminations": false_eliminations,
            "unobserved_short_discards": sum(v not in primary_full for v in discarded_short),
            "global_false_elimination_rate": None,
            "scope": "audited discards only; global error rates are not inferred from a partial overlap",
        },
        "problem_remaining": max(0, int(problem.remaining)),
    }
    return {
        "best_vector": list(best) if best is not None else None,
        "best_score": means.get(best), "diagnostics": diagnostics,
        "proof_scope": (
            "Budgeted empirical heuristic over sampled public-feasible vectors. Only valid/full "
            "observations can win. Cheap estimates are not short native simulations. Ranking "
            "diagnostics cover the full-checked overlap at one seed. A finite fixed-seed oracle "
            "maximum is certified only when finite_full_coverage explicitly reports complete "
            "valid coverage; no unrestricted, expected-score, statistical selection, or long-run RIIC guarantee. "
            "This is neither a Hyperband multi-bracket implementation nor BOHB model fitting."
        ),
    }
