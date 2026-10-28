"""A cheap-objective solution pool followed by budgeted full evaluation.

The top-k ranking concerns the declared finite surrogate model only.  Diversity
uses categorical decisions, never unqueried oracle scores.  No Gurobi runtime is
required; its documented distinction between retained solutions and systematic
top-k search motivates the explicit model-completeness record here.
"""

from math import isfinite


def _nonnegative_integer(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} must be a nonnegative integer")
    return value


def build_pools(problem, k, *, candidate_limit=100000, elite_multiplier=8,
                excluded=()):
    """Rank G and greedily maximize minimum Hamming distance in its elite set.

    ``excluded`` is normally the set of already queried full vectors.  Ranking
    and completeness refer to the remaining model-feasible vectors.  The scan
    bound counts yielded model vectors, including duplicates, not F evaluations.
    """
    _nonnegative_integer(k, "k")
    if _nonnegative_integer(candidate_limit, "candidate_limit") == 0:
        raise ValueError("candidate_limit must be positive")
    if _nonnegative_integer(elite_multiplier, "elite_multiplier") == 0:
        raise ValueError("elite_multiplier must be positive")
    excluded = {tuple(v) for v in excluded}
    candidates = {}
    scanned = 0
    complete = True
    nonfinite_scores = 0
    for raw in problem.vectors(feasible_only=True):
        if scanned >= candidate_limit:
            complete = False
            break
        scanned += 1
        vector = tuple(raw)
        if vector in candidates or vector in excluded:
            continue
        if not problem.feasible(vector) or not problem.schedule_feasible(vector):
            continue
        score = float(problem.cheap(vector))
        if not isfinite(score):
            nonfinite_scores += 1
            continue
        candidates[vector] = score
    ranked = sorted(candidates, key=lambda v: (-candidates[v], v))
    top_k = ranked[:k]
    elite = ranked[:min(len(ranked), k * elite_multiplier)]
    diverse = elite[:1] if k else []
    remaining = elite[1:]
    while remaining and len(diverse) < k:
        # Stable ranked order breaks equal distance/quality ties canonically.
        selected = max(remaining, key=lambda vector: (
            min(sum(a != b for a, b in zip(vector, chosen))
                for chosen in diverse), candidates[vector]))
        diverse.append(selected)
        remaining.remove(selected)
    retained = dict.fromkeys(top_k + diverse)
    return {
        "top_k": [list(v) for v in top_k],
        "diverse": [list(v) for v in diverse],
        "cheap_scores": [{"vector": list(v), "score": candidates[v]}
                         for v in retained],
        "scanned_model_rows": scanned,
        "unique_model_candidates": len(candidates),
        "model_complete": complete and nonfinite_scores == 0,
        "enumeration_complete": complete,
        "nonfinite_cheap_scores": nonfinite_scores,
        "elite_size": len(elite),
    }


def solve(problem, *, seed=42, budget=16):
    """Return the best valid/full observation within the caller's query budget.

    Optional public configuration: ``metadata['m01_pool']`` accepts ``mode``
    (``'top-k'`` or ``'diverse'``), ``candidate_limit`` and ``elite_multiplier``.
    The initial vector is evaluated first unless already present in full history;
    that evaluation counts against this method's budget, even on an external
    cache hit.  Every additional query is a distinct retained pool vector.
    """
    _nonnegative_integer(budget, "budget")
    config = problem.metadata.get("m01_pool", {})
    mode = config.get("mode", "diverse")
    if mode not in {"top-k", "diverse"}:
        raise ValueError("m01_pool.mode must be 'top-k' or 'diverse'")
    query_limit = min(budget, max(0, problem.remaining))
    queries = []
    prior_full = {tuple(r["vector"]) for r in problem.history
                  if r.get("fidelity") == "full"}
    initial = tuple(problem.initial)
    if (query_limit and initial not in prior_full and problem.feasible(initial)
            and problem.schedule_feasible(initial)):
        problem.evaluate(initial, fidelity="full", seed=seed)
        queries.append(list(initial))
        prior_full.add(initial)
    slots = min(query_limit - len(queries), max(0, problem.remaining))
    pools = None
    diagnostics = []
    if slots:
        pools = build_pools(
            problem, slots, excluded=prior_full,
            candidate_limit=config.get("candidate_limit", 100000),
            elite_multiplier=config.get("elite_multiplier", 8),
        )
        if not pools["model_complete"]:
            diagnostics.append("G pool is restricted to a bounded/partially scored model scan.")
        for vector in pools["top_k" if mode == "top-k" else "diverse"]:
            if len(queries) >= query_limit or problem.remaining <= 0:
                break
            problem.evaluate(vector, fidelity="full", seed=seed)
            queries.append(vector)
    else:
        diagnostics.append("No F query budget remains after initial/past evidence.")
    best = problem.best()
    if best is None:
        diagnostics.append("No valid full-fidelity score was observed; no fallback zero score.")
    return {
        "best_vector": list(best["vector"]) if best is not None else None,
        "best_score": best["score"] if best is not None else None,
        "diagnostics": diagnostics,
        "proof_scope": (
            "Top-k concerns G in the enumerated feasible finite model, excluding prior full queries; "
            "complete G ranking only if model_complete is true. Diversity is greedy Hamming coverage "
            "within a G-elite set. F best is restricted to valid/full observed records; no global-F proof."
        ),
        "pool_mode": mode,
        "seed": seed,
        "queries_used": len(queries),
        "evaluated_vectors": queries,
        "top_k_pool": pools["top_k"] if pools else [],
        "diverse_pool": pools["diverse"] if pools else [],
        "model_complete": pools["model_complete"] if pools else False,
        "pool_details": pools,
        "structure_measure": "categorical-vector Hamming distance; scene decisions must be canonical",
    }
