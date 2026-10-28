"""Budgeted categorical cross-entropy search on the declared finite vector domain.

Only ``evaluate(..., fidelity='full')`` observations rank elites.  Cheap public
constraints repair samples toward a known legal anchor; neither repair nor
sampling reads the oracle's unevaluated objective values.
"""

from __future__ import annotations

import math
from numbers import Real
import random
from typing import Any, Sequence


_BATCH_SIZE = 4
_ELITE_FRACTION = 0.25
_SMOOTHING = 0.9
_EXPLORATION = 0.05
_ATTEMPTS_PER_ROUND = 128


def _sample_vector(
    domains: Sequence[Sequence[int]], probabilities: Sequence[Sequence[float]], rng: Any,
) -> tuple[int, ...]:
    """Draw the actual product-categorical proposal, without consulting F or G."""
    vector = []
    for domain, row in zip(domains, probabilities):
        draw = rng.random()
        cumulative = 0.0
        selected = domain[-1]  # Covers harmless final-sum floating point error.
        for value, probability in zip(domain, row):
            cumulative += probability
            if draw < cumulative:
                selected = value
                break
        vector.append(selected)
    return tuple(vector)


def _sample_novel_vector(
    domains: Sequence[Sequence[int]], probabilities: Sequence[Sequence[float]],
    blocked: set[tuple[int, ...]], rng: Any,
) -> tuple[int, ...] | None:
    """Sample the product law conditional on not having proposed a blocked vector.

    A trie stores only blocked vectors.  Unblocked subtrees retain their full
    probability mass, so this computes conditional categorical branch weights
    without enumerating candidates or reading any objective labels.  Summing
    unblocked mass directly avoids subtracting nearly equal floating values.
    """
    if not domains:
        return None if () in blocked else ()
    trie: dict[int, Any] = {}
    for vector in sorted(blocked):
        node = trie
        for value in vector:
            node = node.setdefault(value, {})
    masses: dict[int, float] = {}

    def unseen_mass(node: dict | None, depth: int) -> float:
        if node is None:
            return 1.0
        if depth == len(domains):
            return 0.0
        key = id(node)
        if key not in masses:
            masses[key] = sum(
                probability * unseen_mass(node.get(value), depth + 1)
                for value, probability in zip(domains[depth], probabilities[depth])
            )
        return masses[key]

    if unseen_mass(trie, 0) <= 0:
        return None
    vector = []
    node = trie
    for depth, (domain, row) in enumerate(zip(domains, probabilities)):
        weights = [
            probability * unseen_mass(node.get(value) if node is not None else None, depth + 1)
            for value, probability in zip(domain, row)
        ]
        draw = rng.random() * sum(weights)
        cumulative = 0.0
        selected = next(value for value, weight in reversed(list(zip(domain, weights))) if weight > 0)
        for value, weight in zip(domain, weights):
            cumulative += weight
            if draw < cumulative:
                selected = value
                break
        vector.append(selected)
        node = node.get(selected) if node is not None else None
    return tuple(vector)


def _update_probabilities(
    domains: Sequence[Sequence[int]], probabilities: Sequence[Sequence[float]],
    elites: Sequence[Sequence[int]], *, smoothing: float, exploration: float,
) -> tuple[list[list[float]], list[list[float]] | None]:
    """Categorical elite MLE, smoothed and mixed with a uniform exploration law."""
    if not elites:
        return [list(row) for row in probabilities], None
    frequencies = [
        [sum(elite[index] == value for elite in elites) / len(elites) for value in domain]
        for index, domain in enumerate(domains)
    ]
    updated = [
        [
            (1.0 - exploration) * ((1.0 - smoothing) * old + smoothing * empirical)
            + exploration / len(domain)
            for old, empirical in zip(row, frequency)
        ]
        for domain, row, frequency in zip(domains, probabilities, frequencies)
    ]
    return updated, frequencies


def _repair_toward_anchor(
    proposal: tuple[int, ...], anchor: tuple[int, ...] | None, legal: Any, rng: random.Random,
) -> tuple[int, ...] | None:
    """Bounded structural repair; failure rejects the proposal without querying F.

    Each step restores one changed decision to an already legal anchor.  A legal
    anchor guarantees termination at a legal vector, but this decoder can bias
    proposals and does not enumerate or certify the entire feasible domain.
    """
    if anchor is None:
        return None
    repaired = list(proposal)
    changed = [index for index, (value, reference) in enumerate(zip(proposal, anchor)) if value != reference]
    rng.shuffle(changed)
    for index in changed:
        repaired[index] = anchor[index]
        candidate = tuple(repaired)
        if legal(candidate):
            return candidate
    return anchor if legal(anchor) else None


def solve(problem: Any, *, seed: int = 42, budget: int = 16) -> dict[str, Any]:
    """Return the best valid queried full-F vector, with replayable CE operations.

    An initial feasible vector is evaluated as a baseline but is not inserted
    into a sampled round's elite pool.  Full evaluations are unique within this
    run; repeated proposals are recorded and skipped rather than charged again.
    """
    requested_budget = max(0, int(budget))
    domains = [tuple(domain) for domain in problem.domains]
    probabilities = [[1.0 / len(domain)] * len(domain) if domain else [] for domain in domains]
    rng = random.Random(seed)
    diagnostics: dict[str, Any] = {
        "method": "categorical_cross_entropy", "seed": seed,
        "requested_budget": requested_budget, "queries_used": 0,
        "batch_size": _BATCH_SIZE, "elite_fraction": _ELITE_FRACTION,
        "smoothing": _SMOOTHING, "exploration": _EXPLORATION,
        "sampling_policy": "product_categorical_conditioned_on_unproposed",
        "probability_floor_by_variable": [_EXPLORATION / len(domain) if domain else None for domain in domains],
        "max_proposal_attempts_per_round": _ATTEMPTS_PER_ROUND,
        "proposal_attempts": 0, "repaired_proposals": 0,
        "rejected_proposals": 0, "duplicate_proposals": 0,
        "evaluations": [], "distribution_history": [{
            "round": 0, "reason": "uniform_initialization", "sample_query_indices": [],
            "elite_query_indices": [], "elite_count": 0, "elite_threshold": None,
            "elite_frequencies": None, "probabilities_before": [row[:] for row in probabilities],
            "probabilities_after": [row[:] for row in probabilities],
        }],
        "termination": None,
        "repair_policy": "restore sampled decisions toward a known legal anchor; reject without one",
        "elite_policy": f"top ceil({_ELITE_FRACTION} * valid round observations), tie-break by vector; no invalid/partial F",
    }
    best: dict[str, Any] | None = None
    seen: set[tuple[int, ...]] = set()
    blocked: set[tuple[int, ...]] = set()
    domain_size = math.prod(len(domain) for domain in domains)

    def legal(vector: Sequence[int]) -> bool:
        return (
            len(vector) == len(domains)
            and all(value in domain for value, domain in zip(vector, domains))
            and bool(problem.feasible(vector))
            and bool(problem.schedule_feasible(vector))
        )

    def can_query() -> bool:
        return diagnostics["queries_used"] < requested_budget and problem.remaining > 0

    def query(vector: tuple[int, ...], raw: tuple[int, ...], source: str) -> dict[str, Any]:
        nonlocal best
        diagnostics["queries_used"] += 1
        seen.add(vector)
        blocked.add(vector)
        observation = problem.evaluate(vector, fidelity="full", seed=seed)
        score = observation.get("score")
        finite = isinstance(score, Real) and not isinstance(score, bool) and math.isfinite(float(score))
        full = observation.get("fidelity") == "full"
        valid = bool(observation.get("valid")) and full and finite
        record = {
            "query_index": diagnostics["queries_used"], "vector": list(vector),
            "raw_proposal": list(raw), "source": source,
            "oracle_valid": bool(observation.get("valid")), "valid": valid,
            "fidelity": observation.get("fidelity"), "score": float(score) if valid else None,
            "status": "valid" if valid else (
                "invalid_oracle" if not observation.get("valid") else "non_full_fidelity" if not full else "nonfinite_score"
            ),
        }
        diagnostics["evaluations"].append(record)
        if valid and (best is None or record["score"] > best["score"]):
            best = record
        return record

    if any(not domain for domain in domains):
        diagnostics["termination"] = "empty_domain"
    elif not can_query():
        diagnostics["termination"] = "budget_exhausted"
    else:
        initial = tuple(problem.initial)
        anchor = initial if legal(initial) else None
        if anchor is not None:
            query(anchor, anchor, "initial")
        round_index = 0
        while can_query():
            if len(seen) == domain_size:
                diagnostics["termination"] = "declared_domain_exhausted"
                break
            round_index += 1
            before = [row[:] for row in probabilities]
            samples = []
            attempts = repaired_count = rejected_count = duplicate_count = 0
            while len(samples) < _BATCH_SIZE and can_query() and attempts < _ATTEMPTS_PER_ROUND:
                raw = _sample_novel_vector(domains, before, blocked, rng)
                if raw is None:
                    break
                attempts += 1
                blocked.add(raw)
                if legal(raw):
                    candidate, source = raw, "sampled"
                else:
                    candidate = _repair_toward_anchor(raw, anchor, legal, rng)
                    if candidate is None:
                        rejected_count += 1
                        continue
                    repaired_count += 1
                    source = "repaired"
                if candidate in seen:
                    duplicate_count += 1
                    continue
                record = query(candidate, raw, source)
                samples.append(record)
                # Any structurally legal sample is an anchor even if F is unsupported.
                # Prefer the best verified vector once one has been observed.
                anchor = tuple(best["vector"]) if best is not None else candidate
            eligible = sorted(
                (record for record in samples if record["valid"]),
                key=lambda record: (-record["score"], tuple(record["vector"])),
            )
            elite_count = math.ceil(_ELITE_FRACTION * len(eligible))
            elites = eligible[:elite_count]
            probabilities, frequencies = _update_probabilities(
                domains, before, [record["vector"] for record in elites],
                smoothing=_SMOOTHING, exploration=_EXPLORATION,
            )
            diagnostics["proposal_attempts"] += attempts
            diagnostics["repaired_proposals"] += repaired_count
            diagnostics["rejected_proposals"] += rejected_count
            diagnostics["duplicate_proposals"] += duplicate_count
            diagnostics["distribution_history"].append({
                "round": round_index, "sample_query_indices": [record["query_index"] for record in samples],
                "elite_query_indices": [record["query_index"] for record in elites],
                "elite_count": elite_count, "elite_threshold": elites[-1]["score"] if elites else None,
                "elite_frequencies": frequencies, "probabilities_before": before,
                "probabilities_after": [row[:] for row in probabilities],
                "proposal_attempts": attempts, "repaired_proposals": repaired_count,
                "rejected_proposals": rejected_count, "duplicate_proposals": duplicate_count,
            })
            if not samples:
                diagnostics["termination"] = "candidate_generation_exhausted"
                break
        if diagnostics["termination"] is None:
            diagnostics["termination"] = "budget_exhausted"

    diagnostics["final_probabilities"] = [row[:] for row in probabilities]
    diagnostics["declared_domain_size"] = domain_size
    diagnostics["unique_evaluated_vectors"] = len(seen)
    diagnostics["all_declared_vectors_evaluated"] = len(seen) == domain_size
    return {
        "best_vector": best["vector"][:] if best is not None else None,
        "best_score": best["score"] if best is not None else None,
        "diagnostics": diagnostics,
        "proof_scope": (
            "Budgeted finite-domain categorical CE heuristic. Best means highest valid full-F score "
            "queried during this run; unqueried F is never inspected. Feasibility/schedule predicates "
            "cover only the declared problem. Smoothing, uniform exploration, repair and novelty "
            "filtering do not certify global optimality, stochastic ranking reliability or real-game output."
        ),
    }
