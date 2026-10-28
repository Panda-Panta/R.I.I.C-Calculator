"""Finite-budget simulated annealing over the public discrete problem API."""

from __future__ import annotations

import math
import random


def _metropolis(delta, temperature, rng):
    """Maximization form; return the decision, probability and sampled uniform."""
    if delta >= 0:
        return True, 1.0, None
    probability = math.exp(delta / temperature)
    draw = rng.random()
    return draw < probability, probability, draw


def _legal(problem, domains, vector):
    return (
        len(vector) == len(domains)
        and all(value in domain for value, domain in zip(vector, domains))
        and problem.feasible(vector)
        and problem.schedule_feasible(vector)
    )


def _proposal(vector, domains, rng):
    """Symmetric raw mutations; infeasible proposals become unqueried self holds."""
    mutable = [i for i, domain in enumerate(domains) if len(domain) > 1]
    if not mutable:
        return None, "fixed"
    operator = rng.randrange(3) if len(mutable) >= 2 else 0
    candidate = list(vector)
    if operator == 2:
        i, j = rng.sample(mutable, 2)
        if vector[i] == vector[j] or vector[j] not in domains[i] or vector[i] not in domains[j]:
            return None, "swap"
        candidate[i], candidate[j] = vector[j], vector[i]
        return tuple(candidate), "swap"
    if operator == 0:
        indices = [rng.choice(mutable)]
        name = "single"
    else:
        indices = rng.sample(mutable, rng.randint(2, min(4, len(mutable))))
        name = "block"
    for i in indices:
        candidate[i] = rng.choice([value for value in domains[i] if value != vector[i]])
    return tuple(candidate), name


def solve(problem, *, seed=42, budget=16):
    """Return the best *queried valid/full* vector, never a model-only guess.

    Each epoch has a geometric schedule from T0 to .01*T0. Its first transition
    screens up to 64 random legal neighbors with public G, and subsequent proposals
    screen four. Metropolis still decides using full F. Already queried vectors
    never spend another F.
    The first nonzero
    observed full-score difference fixes T0 = abs(delta)/(-log(.8)); before that,
    the fallback is one score unit. At most two independently sampled restarts
    reheat to T0. These finite, short epochs do not establish equilibrium or a
    global optimum.
    """
    rng = random.Random(seed)
    domains = [tuple(domain) for domain in problem.domains]
    initial_remaining = max(0, int(problem.remaining))
    limit = min(max(0, int(budget)), initial_remaining)
    restart_limit = min(2, max(0, (limit - 1) // 6))
    epoch_span = max(1, math.ceil(limit / (restart_limit + 1)))
    trace = []
    queried = set()
    domain_size = math.prod(len(domain) for domain in domains)
    queries = 0
    epochs_started = 0
    restarts_started = 0
    proposal_attempts = 0
    rejected_proposals = 0
    duplicate_proposals = 0
    start_attempts = 0
    invalid_evaluations = 0
    accepted_worse = 0
    rejected_worse = 0
    temperature_start = 1.0
    scale_source = "fallback_one_score_unit"
    scale_calibrated = False
    best_vector = None
    best_score = None
    termination = "restart_limit"

    def can_query():
        return queries < limit and problem.remaining > 0

    def evaluate(vector):
        nonlocal queries, invalid_evaluations, best_vector, best_score
        # Count every public F invocation, including invalid and repeated vectors.
        queries += 1
        queried.add(vector)
        record = problem.evaluate(vector, fidelity="full", seed=seed)
        score = record.get("score")
        valid = (
            bool(record.get("valid"))
            and record.get("fidelity") == "full"
            and record.get("vector") is not None
            and tuple(record["vector"]) == vector
            and isinstance(score, (int, float))
            and not isinstance(score, bool)
            and math.isfinite(score)
        )
        if not valid:
            invalid_evaluations += 1
            return None
        score = float(score)
        if best_score is None or score > best_score:
            best_score, best_vector = score, vector
        return score

    if any(not domain for domain in domains):
        termination = "empty_domain"
    elif limit == 0:
        termination = "budget_exhausted"
    else:
        for epoch in range(restart_limit + 1):
            if len(queried) == domain_size:
                termination = "declared_domain_covered"
                break
            if not can_query():
                termination = "budget_exhausted"
                break
            start = None
            initial = tuple(problem.initial)
            if epoch == 0 and _legal(problem, domains, initial):
                start = initial
            else:
                # Bounded feasibility sampling is not a proof of infeasibility.
                for _ in range(128):
                    start_attempts += 1
                    candidate = tuple(rng.choice(domain) for domain in domains)
                    if candidate not in queried and _legal(problem, domains, candidate):
                        start = candidate
                        break
            if start is None:
                termination = "start_sampling_exhausted"
                continue
            epochs_started += 1
            if epoch > 0:
                restarts_started += 1
            score = evaluate(start)
            trace.append({
                "query": queries, "epoch": epoch, "kind": "initial" if epoch == 0 else "restart",
                "vector": list(start), "valid": score is not None, "score": score,
                "accepted": score is not None, "best_score": best_score,
            })
            if score is None:
                termination = "no_valid_start"
                continue
            termination = "restart_limit"
            current, current_score = start, score
            for step in range(1, epoch_span):
                if not can_query():
                    termination = "budget_exhausted"
                    break
                candidate = None
                operator = None
                proposal_pool = []
                pool_vectors = set()
                proxy = getattr(problem, "cheap", None)
                lookahead = (64 if step == 1 else 4) if callable(proxy) else 1
                proposal_limit = 256 if step == 1 and callable(proxy) else 64
                for _ in range(proposal_limit):
                    proposal_attempts += 1
                    proposed, operator = _proposal(current, domains, rng)
                    if (proposed is not None and proposed not in queried
                            and proposed not in pool_vectors and _legal(problem, domains, proposed)):
                        proposal_pool.append((proposed, operator))
                        pool_vectors.add(proposed)
                        if len(proposal_pool) >= lookahead:
                            break
                        continue
                    if proposed in queried:
                        duplicate_proposals += 1
                    rejected_proposals += 1
                    if operator == "fixed":
                        break
                if proposal_pool:
                    if lookahead > 1:
                        candidate, operator = max(proposal_pool, key=lambda item: proxy(item[0]))
                    else:
                        candidate, operator = proposal_pool[0]
                if candidate is None:
                    termination = "neighborhood_sampling_exhausted"
                    break
                candidate_score = evaluate(candidate)
                entry = {
                    "query": queries, "epoch": epoch, "kind": "transition", "operator": operator,
                    "vector": list(candidate), "current_before": list(current),
                    "changed_variables": sum(a != b for a, b in zip(current, candidate)),
                    "valid": candidate_score is not None, "score": candidate_score,
                    "accepted": False, "best_score": best_score,
                    "proxy_lookahead_candidates": len(proposal_pool),
                }
                if callable(proxy):
                    entry["proxy_score"] = proxy(candidate)
                if candidate_score is not None:
                    delta = candidate_score - current_score
                    if not scale_calibrated and delta != 0 and math.isfinite(delta):
                        calibrated = abs(delta) / -math.log(0.8)
                        if math.isfinite(calibrated) and calibrated > 0:
                            temperature_start = calibrated
                            scale_source = "first_nonzero_observed_full_score_difference"
                            scale_calibrated = True
                    progress = (step - 1) / max(1, epoch_span - 2)
                    temperature = max(math.ulp(0.0), temperature_start * 0.01 ** progress)
                    accepted, probability, draw = _metropolis(delta, temperature, rng)
                    entry.update({
                        "delta": delta, "temperature": temperature,
                        "acceptance_probability": probability, "draw": draw, "accepted": accepted,
                    })
                    if delta < 0:
                        if accepted:
                            accepted_worse += 1
                        else:
                            rejected_worse += 1
                    if accepted:
                        current, current_score = candidate, candidate_score
                trace.append(entry)
                if len(queried) == domain_size:
                    termination = "declared_domain_covered"
                    break
            if not can_query():
                termination = "budget_exhausted"
                break

    return {
        "best_vector": list(best_vector) if best_vector is not None else None,
        "best_score": best_score,
        "diagnostics": {
            "algorithm": "simulated_annealing", "seed": seed,
            "queries": queries, "query_limit": limit,
            "initial_problem_remaining": initial_remaining, "problem_remaining": problem.remaining,
            "epochs_started": epochs_started, "restarts_started": restarts_started,
            "restart_limit": restart_limit, "epoch_span": epoch_span,
            "proposal_attempts": proposal_attempts, "rejected_proposals": rejected_proposals,
            "duplicate_proposals": duplicate_proposals, "unique_queried_vectors": len(queried),
            "declared_domain_size": domain_size,
            "proxy_lookahead_limit": 64,
            "proxy_subsequent_lookahead_limit": 4,
            "first_transition_proposal_limit": 256,
            "subsequent_transition_proposal_limit": 64,
            "start_sampling_attempts": start_attempts, "invalid_evaluations": invalid_evaluations,
            "accepted_worse": accepted_worse, "rejected_worse": rejected_worse,
            "temperature_scale_source": scale_source, "temperature_start": temperature_start,
            "temperature_end_ratio": 0.01, "termination": termination, "trace": trace,
        },
        "proof_scope": (
            "Finite-budget heuristic over public feasible/schedule-feasible vectors; best is drawn "
            "only from this run's valid full evaluations. No global-optimality, equilibrium, "
            "game-mechanic, or installed-runtime proof."
        ),
    }
