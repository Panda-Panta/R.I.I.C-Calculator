"""Fixed-budget OCBA simulation ranking with explicit seed-pair diagnostics.

This is an allocation heuristic, not the Kim--Nelson sequential procedure.
No probability-of-correct-selection or confidence-sequence claim is made.
"""

from itertools import combinations, islice, product
import math
import random
from statistics import mean, variance


def _ocba_weights(means, variances):
    """Plug-in OCBA proportions, maximizing means; ties use small floors.

    For nonbest i: w_i = s_i^2 / (mean_best - mean_i)^2.
    For the best b: w_b = s_b * sqrt(sum(w_i^2 / s_i^2)).
    Marginal-variance OCBA is only a heuristic for correlated CRN outputs.
    """
    if not means:
        return []
    if len(means) == 1:
        return [1.0]
    if max(variances) <= 0.0:
        return [1.0 / len(means)] * len(means)
    best = max(range(len(means)), key=lambda index: means[index])
    variance_floor = max(1e-12, max(variances) * 1e-12)
    gap_floor = max(1.0, max(abs(value) for value in means)) * 1e-9
    stabilized = [max(value, variance_floor) for value in variances]
    weights = [0.0] * len(means)
    for index in range(len(means)):
        if index != best:
            gap = max(means[best] - means[index], gap_floor)
            weights[index] = stabilized[index] / (gap * gap)
    weights[best] = math.sqrt(stabilized[best] * sum(
        weights[index] ** 2 / stabilized[index]
        for index in range(len(means)) if index != best
    ))
    total = sum(weights)
    return [value / total for value in weights]


def _candidates(problem, limit, rng, options):
    """Public-G proposal pool plus optional Hamming diversity; no hidden F labels."""
    domains = [tuple(domain) for domain in problem.domains]
    pool_limit = max(1, int(options.get("proposal_pool_limit", 128)))
    random_proposals = max(0, int(options.get("random_proposals", 2 * pool_limit)))
    diversity_fraction = float(options.get("diversity_fraction", 0.0))
    if not math.isfinite(diversity_fraction) or not 0.0 <= diversity_fraction <= 1.0:
        raise ValueError("m09_ranking.diversity_fraction must be between zero and one")
    pool = set()
    checked = set()
    details = {
        "structurally_infeasible_count": 0,
        "schedule_infeasible_count": 0,
        "schedule_unknown_count": 0,
        "schedule_unknown_candidates": [],
        "public_domain_size": math.prod(len(domain) for domain in domains),
        "proposal_pool_limit": pool_limit,
        "diversity_fraction": diversity_fraction,
    }

    def offer(vector):
        vector = tuple(vector)
        if vector in checked:
            return
        checked.add(vector)
        if not (len(vector) == len(domains)
                and all(value in domain for value, domain in zip(vector, domains))
                and problem.feasible(vector)):
            details["structurally_infeasible_count"] += 1
            return
        try:
            scheduled = problem.schedule_feasible(vector)
        except RuntimeError as error:
            details["schedule_unknown_count"] += 1
            details["schedule_unknown_candidates"].append({"vector": list(vector), "reason": str(error)})
            return
        if not scheduled:
            details["schedule_infeasible_count"] += 1
            return
        pool.add(vector)

    initial = tuple(problem.initial)
    offer(initial)
    if details["public_domain_size"] <= pool_limit:
        # Cover cheap G on small declared domains, not the full-F response table.
        details["proposal_mode"] = "complete_public_G_small_domain"
        for vector in product(*domains):
            offer(vector)
    else:
        details["proposal_mode"] = "bounded_structural_sampling"
        probes = 0
        if len(initial) == len(domains):
            for index, domain in enumerate(domains):
                for value in islice(domain, min(32, pool_limit)):
                    vector = list(initial)
                    vector[index] = value
                    offer(vector)
                    probes += 1
                    if probes >= pool_limit:
                        break
                if probes >= pool_limit:
                    break
        if all(domains):
            for _ in range(random_proposals):
                offer([rng.choice(domain) for domain in domains])
                if len(pool) >= pool_limit:
                    break
    cheap_scores = {vector: float(problem.cheap(vector)) for vector in pool}
    ordered = sorted(pool, key=lambda vector: (-cheap_scores[vector], vector))
    elite_count = max(1, math.ceil(limit * (1.0 - diversity_fraction)))
    selected = ordered[:elite_count]
    # Keep a legal baseline even when G puts it outside the shortlist.
    if selected and initial in pool and initial not in selected:
        if len(selected) < limit:
            selected.append(initial)
        else:
            selected[-1] = initial
    while len(selected) < min(limit, len(pool)):
        remaining = [vector for vector in ordered if vector not in selected]
        selected.append(max(remaining, key=lambda vector: (
            min(sum(a != b for a, b in zip(vector, anchor)) for anchor in selected),
            cheap_scores[vector],
            tuple(-value for value in vector),
        )))
    details["unique_public_candidates_checked"] = len(checked)
    details["shortlist_cheap_scores"] = [cheap_scores[vector] for vector in selected]
    return selected, len(pool), details


def _statistics(vector, observations):
    valid = [row for row in observations if row["valid"]]
    values = [row["score"] for row in valid]
    sample_variance = variance(values) if len(values) >= 2 else None
    return {
        "vector": list(vector),
        "n_attempted": len(observations),
        "n_valid": len(values),
        "n_invalid": len(observations) - len(values),
        "mean": mean(values) if values else None,
        "sample_variance": sample_variance,
        "standard_error": math.sqrt(sample_variance / len(values))
        if sample_variance is not None else None,
        "seeds": [row["seed"] for row in observations],
        # Dropping invalid outputs could reward a design's conditional successes.
        "eligible": bool(values) and len(values) == len(observations),
    }


def _paired_statistics(observations):
    pairs = []
    for left, right in combinations(range(len(observations)), 2):
        x = {row["seed"]: row["score"] for row in observations[left] if row["valid"]}
        y = {row["seed"]: row["score"] for row in observations[right] if row["valid"]}
        shared = sorted(x.keys() & y.keys())
        differences = [x[seed] - y[seed] for seed in shared]
        xs, ys = [x[seed] for seed in shared], [y[seed] for seed in shared]
        n = len(shared)
        vx, vy = (variance(xs), variance(ys)) if n >= 2 else (None, None)
        vd = variance(differences) if n >= 2 else None
        covariance = (sum((a - mean(xs)) * (b - mean(ys)) for a, b in zip(xs, ys))
                      / (n - 1)) if n >= 2 else None
        pairs.append({
            "left": left, "right": right, "n_shared": n,
            "seeds": shared,
            "mean_difference": mean(differences) if n else None,
            "sample_variance_difference": vd,
            "standard_error_difference": math.sqrt(vd / n) if vd is not None else None,
            "sum_marginal_sample_variances": vx + vy if n >= 2 else None,
            "sample_covariance": covariance,
            "sample_correlation": covariance / math.sqrt(vx * vy)
            if n >= 2 and vx > 0 and vy > 0 else None,
            "observed_variance_reduction": vd < vx + vy if n >= 2 else None,
            "variance_reduction_ratio": (vx + vy) / vd
            if vd is not None and vd > 0 else None,
            "interpretation": "descriptive_shared_seed_outputs_only",
        })
    return pairs


def solve(problem, *, seed=42, budget=16):
    """Spend at most budget full calls; select the largest clean sample mean.

    At least two observations per contender are reserved when budget >= 4.
    Three pilot observations are preferred; remaining calls track OCBA deficits.
    A partially invalid design is excluded rather than assigned a zero score.
    """
    requested_budget = max(0, int(budget))
    effective_budget = min(requested_budget, max(0, int(problem.remaining)))
    options = (getattr(problem, "metadata", {}) or {}).get("m09_ranking", {}) or {}
    default_count = min(4, max(2, effective_budget // 3)) if effective_budget >= 4 else 1
    requested_count = max(1, int(options.get("candidate_count", default_count)))
    requested_pilot = max(2, int(options.get("pilot_replications", 3)))
    candidate_limit = min(requested_count, effective_budget // 2) if effective_budget >= 4 else 1
    candidates, pool_size, generation_details = _candidates(problem, candidate_limit, random.Random(seed), options)
    observations = [[] for _ in candidates]
    pilot = min(requested_pilot, effective_budget // len(candidates)) if candidates else 0
    seed_rng = random.Random(int(seed) ^ 0x9E3779B9)
    seeds = []
    while len(seeds) < effective_budget:
        next_seed = seed_rng.randrange(1, 2**31 - 1)
        if next_seed not in seeds:
            seeds.append(next_seed)
    evaluations = 0
    steps = []

    def evaluate(index):
        nonlocal evaluations
        if evaluations >= effective_budget or problem.remaining <= 0:
            return False
        replication_seed = seeds[len(observations[index])]
        result = problem.evaluate(candidates[index], fidelity="full", seed=replication_seed)
        evaluations += 1
        value = result.get("score")
        valid = (bool(result.get("valid")) and value is not None
                 and math.isfinite(float(value)) and result.get("fidelity", "full") == "full")
        observations[index].append({
            "seed": replication_seed, "score": float(value) if valid else None, "valid": valid,
        })
        return True

    # Balanced pilot creates genuinely paired seed prefixes, not one lucky draw.
    for _ in range(pilot):
        for index in range(len(candidates)):
            if not evaluate(index):
                break

    while evaluations < effective_budget and problem.remaining > 0:
        statistics = [_statistics(vector, rows) for vector, rows in zip(candidates, observations)]
        eligible = [index for index, row in enumerate(statistics)
                    if row["eligible"] and row["n_valid"] >= 2]
        if not eligible:
            break
        weights = _ocba_weights(
            [statistics[index]["mean"] for index in eligible],
            [statistics[index]["sample_variance"] for index in eligible],
        )
        next_total = sum(statistics[index]["n_attempted"] for index in eligible) + 1
        local = max(range(len(eligible)), key=lambda pos: (
            next_total * weights[pos] - statistics[eligible[pos]]["n_attempted"],
            -eligible[pos],
        ))
        chosen = eligible[local]
        global_weights = [0.0] * len(candidates)
        for index, weight in zip(eligible, weights):
            global_weights[index] = weight
        steps.append({
            "evaluation": evaluations + 1, "chosen_candidate": chosen,
            "reason": "ocba_ratio_deficit" if len(eligible) >= 2 else "single_eligible_candidate",
            "weights": global_weights,
            "means_before": [row["mean"] for row in statistics],
            "variances_before": [row["sample_variance"] for row in statistics],
            "counts_before": [row["n_attempted"] for row in statistics],
        })
        evaluate(chosen)

    statistics = [_statistics(vector, rows) for vector, rows in zip(candidates, observations)]
    eligible = [index for index, row in enumerate(statistics) if row["eligible"]]
    best = max(eligible, key=lambda index: (statistics[index]["mean"], -index)) if eligible else None
    paired = _paired_statistics(observations)
    unresolved = []
    if best is not None:
        for index in eligible:
            if index == best:
                continue
            pair = next(row for row in paired if {row["left"], row["right"]} == {best, index})
            gap = pair["mean_difference"]
            if gap is not None and pair["right"] == best:
                gap = -gap
            if (pair["n_shared"] < 2 or gap is None
                    or gap <= 2 * pair["standard_error_difference"]):
                unresolved.append(index)
    if not candidates:
        status = "schedule_feasibility_unknown" if generation_details["schedule_unknown_count"] else "no_feasible_candidates"
    elif effective_budget < 4:
        status = "insufficient_budget_for_replicated_comparison"
    elif not eligible:
        status = "no_fully_valid_candidates"
    elif len(candidates) == 1:
        status = "single_shortlisted_candidate" if pool_size > 1 else "single_feasible_candidate"
    elif len(eligible) == 1:
        status = "only_one_fully_valid_candidate"
    else:
        status = "fixed_budget_mean_selection"
    return {
        "best_vector": list(candidates[best]) if best is not None else None,
        "diagnostics": {
            "algorithm": "fixed_budget_ocba_with_seed_pairing",
            "selection_rule": "largest_valid_sample_mean",
            "selection_certified": False,
            "comparison_status": status,
            "requested_budget": requested_budget,
            "effective_budget": effective_budget,
            "evaluations": evaluations,
            "candidate_pool_size": pool_size,
            "candidate_count": len(candidates),
            "candidate_generation": generation_details["proposal_mode"],
            "candidate_generation_details": generation_details,
            "configuration": {"candidate_count_requested": requested_count,
                              "candidate_limit_applied": candidate_limit,
                              "pilot_replications_requested": requested_pilot},
            "pilot_replications": pilot,
            "candidate_statistics": statistics,
            "paired_statistics": paired,
            "allocation_steps": steps,
            "best_sample_mean": statistics[best]["mean"] if best is not None else None,
            "undistinguished_candidates": unresolved,
            "undistinguished": bool(unresolved) or len(eligible) < 2,
            "undistinguished_rule": "paired_gap_le_2_standard_errors_descriptive_only",
            "crn": {
                "same_replication_seed_supplied": True,
                "event_alignment_verified": False,
                "variance_reduction_guaranteed": False,
                "note": "Same seed alone does not align random events; pairing statistics are empirical.",
            },
            "held_out_validation_performed": False,
        },
        "proof_scope": {
            "claim": "Finite-budget empirical ranking of a bounded feasible candidate shortlist.",
            "limitations": [
                "No KN implementation, sequential confidence interval, or PCS guarantee.",
                "Marginal OCBA ratios are heuristic under correlated or nonnormal outputs.",
                "Zero pilot variance does not prove deterministic outcomes.",
                "Adaptive selection means are optimistic; independent held-out validation remains necessary.",
                "Structural feasibility and toy verification do not establish native RIIC correctness.",
                "Schedule UNKNOWN proposals are recorded and not evaluated or classified infeasible.",
            ],
        },
    }
