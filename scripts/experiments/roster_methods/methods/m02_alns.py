"""Budgeted adaptive large-neighborhood search over the public Problem API.

Repair examines only the declared cheap model and constraints.  Its candidates
are proposals: only valid, full oracle observations can become the returned best.
"""

from __future__ import annotations

import math
import random


class _AdaptiveWeights:
    """Roulette selection with segment rewards and a nonzero exploration floor."""

    def __init__(self, names, reaction=0.25):
        self.weights = {name: 1.0 for name in names}
        self.uses = {name: 0 for name in names}
        self.scores = {name: 0.0 for name in names}
        self.total_uses = {name: 0 for name in names}
        self.reaction = reaction

    def choose(self, rng):
        # One warm-up use per operator prevents a tiny experiment missing one.
        for name in self.weights:
            if self.total_uses[name] == 0:
                return name
        return rng.choices(list(self.weights), weights=list(self.weights.values()))[0]

    def reward(self, name, value):
        self.uses[name] += 1
        self.total_uses[name] += 1
        self.scores[name] += value

    def update(self):
        before = dict(self.weights)
        uses, scores = dict(self.uses), dict(self.scores)
        for name in self.weights:
            if self.uses[name]:
                mean_reward = self.scores[name] / self.uses[name]
                self.weights[name] = max(
                    0.05,
                    (1.0 - self.reaction) * self.weights[name]
                    + self.reaction * mean_reward,
                )
            self.uses[name] = 0
            self.scores[name] = 0.0
        return {"before": before, "after": dict(self.weights), "uses": uses, "rewards": scores}


def _blocks(problem, vector):
    """Known interaction blocks, with cheap lost-factor value as a priority."""
    spec = problem.spec
    blocks = []
    for factor in spec.get("factors", []):
        variables = list(dict.fromkeys(factor["vars"]))
        if not variables:
            continue
        table = factor.get("table", {})
        key = ",".join(str(vector[index]) for index in variables)
        current = float(table.get(key, 0.0))
        potential = max([current] + [float(value) for value in table.values()])
        blocks.append((variables, 1.0 + max(0.0, potential - current)))
    for forbidden in spec.get("forbidden", []):
        variables = list(dict.fromkeys(forbidden["vars"]))
        if variables:
            blocks.append((variables, 1.0))
    for resource in spec.get("resources", []):
        variables = [
            index for index, usage in enumerate(resource["usage"])
            if any(float(value) != 0.0 for value in usage)
        ]
        if variables:
            load = sum(float(resource["usage"][index][vector[index]]) for index in variables)
            capacity = float(resource["capacity"])
            pressure = load / max(1.0, abs(capacity))
            blocks.append((variables, 1.0 + max(0.0, pressure)))
    return blocks


def _destroy_random(problem, vector, rng, count):
    return sorted(rng.sample(range(len(vector)), min(count, len(vector))))


def _destroy_related(problem, vector, rng, count):
    """Release a complete interaction block, then adjacent decisions if needed."""
    blocks = _blocks(problem, vector)
    if not blocks:
        return _destroy_random(problem, vector, rng, count)
    chosen = rng.choices(blocks, weights=[priority for _, priority in blocks])[0][0]
    removed = set(chosen)
    # Keeping the whole chosen factor is essential for coordinated moves.
    target = min(len(vector), max(count, len(removed)))
    while len(removed) < target:
        related = set()
        for variables, _ in blocks:
            if removed.intersection(variables):
                related.update(variables)
        candidates = sorted(related - removed)
        if not candidates:
            candidates = sorted(set(range(len(vector))) - removed)
        removed.add(rng.choice(candidates))
    return sorted(removed)


def _partial_feasible(problem, partial):
    """Sound pruning of explicitly declared forbidden tuples and resources."""
    for forbidden in problem.spec.get("forbidden", []):
        if all(partial[index] == value for index, value in zip(forbidden["vars"], forbidden["values"])):
            return False
    for resource in problem.spec.get("resources", []):
        # Minimum possible unassigned usage also supports negative resource use.
        lower_load = sum(
            min(float(usage[value]) for value in problem.domains[index])
            if partial[index] is None else float(usage[partial[index]])
            for index, usage in enumerate(resource["usage"])
        )
        if lower_load > float(resource["capacity"]) + 1e-12:
            return False
    return True


def _legal(problem, vector):
    return problem.feasible(vector) and problem.schedule_feasible(vector)


def _repair(problem, vector, removed, rng, mode="greedy", excluded=None, node_cap=4096):
    """Bounded backtracking repair; never queries the expensive oracle.

    Enumeration is confined to the released decisions and uses early structural
    pruning.  The node cap deliberately makes this a heuristic on large blocks.
    """
    excluded = set() if excluded is None else excluded
    partial = list(vector)
    for index in removed:
        partial[index] = None
    order = list(removed)
    rng.shuffle(order)
    nodes = 0
    completed = 0
    truncated = False
    proposals = []

    def visit(depth):
        nonlocal nodes, completed, truncated
        if nodes >= node_cap:
            truncated = True
            return
        nodes += 1
        if not _partial_feasible(problem, partial):
            return
        if depth == len(order):
            candidate = tuple(partial)
            if _legal(problem, candidate):
                completed += 1
                if candidate not in excluded:
                    proposals.append((float(problem.cheap(candidate)), candidate))
            return
        index = order[depth]
        ranked = []
        for value in problem.domains[index]:
            partial[index] = value
            completion = tuple(vector[pos] if entry is None else entry for pos, entry in enumerate(partial))
            ranked.append((float(problem.cheap(completion)), rng.random(), value))
        partial[index] = None
        ordered_values = sorted(ranked, reverse=True)
        for position, (_, _, value) in enumerate(ordered_values):
            partial[index] = value
            visit(depth + 1)
            partial[index] = None
            if nodes >= node_cap:
                if position + 1 < len(ordered_values):
                    truncated = True
                break

    visit(0)
    proposals.sort(key=lambda entry: (-entry[0], entry[1]))
    candidate = None
    if proposals:
        if mode == "greedy":
            candidate = proposals[0][1]
        elif mode == "rank_randomized":
            candidate = rng.choices(proposals, weights=[1.0 / (rank + 1) for rank in range(len(proposals))])[0][1]
        else:
            raise ValueError("unknown ALNS repair operator: " + mode)
    covers_entire_domain = sorted(removed) == list(range(len(problem.domains))) and not truncated
    return candidate, {
        "nodes": nodes,
        "legal_completions": completed,
        "unseen_proposals": len(proposals),
        "node_cap": node_cap,
        "truncated": truncated,
        "covers_entire_domain": covers_entire_domain,
        "legal_domain_count": completed if covers_entire_domain else None,
    }


def _observed_score(record):
    score = record.get("score")
    if not record.get("valid") or record.get("fidelity") != "full":
        return None
    if score is None or isinstance(score, bool):
        return None
    value = float(score)
    return value if math.isfinite(value) else None


def _acceptance(delta, temperature, rng):
    probability = 1.0 if delta >= 0 else math.exp(max(-745.0, delta / max(temperature, 1e-12)))
    return (delta >= 0 or rng.random() < probability), probability


def solve(problem, *, seed=42, budget=16):
    """Return the best valid/full observation found within both query limits."""
    rng = random.Random(seed)
    requested_budget = max(0, int(budget))
    # Begin with the known interaction block instead of spending warm-up on a
    # random coordinate. A separate global restart still competes on rewards.
    destroy = _AdaptiveWeights(["related", "random", "restart"])
    repair = _AdaptiveWeights(["greedy", "rank_randomized"])
    initial = tuple(problem.initial)
    current, current_score = initial, None
    best_vector, best_score = None, None
    queried = set()
    operations, weight_updates, observations = [], [], []
    queries = 0
    segment_size = 4
    attempt_limit = max(16, requested_budget * 12)
    legal_domain_count = None
    coverage_witness_attempt = None
    valid_full_observations = 0

    def can_query():
        return queries < requested_budget and problem.remaining > 0

    def observe(candidate):
        nonlocal queries, best_vector, best_score, valid_full_observations
        queries += 1
        queried.add(candidate)
        record = problem.evaluate(candidate, fidelity="full", seed=seed)
        score = _observed_score(record)
        if score is not None:
            valid_full_observations += 1
        improved = score is not None and (best_score is None or score > best_score)
        if improved:
            best_vector, best_score = candidate, score
        observations.append({"query": queries, "vector": list(candidate), "valid_full_score": score, "valid": bool(record.get("valid")), "fidelity": record.get("fidelity"), "best_score_so_far": best_score})
        return score, improved

    if can_query() and _legal(problem, initial):
        current_score, _ = observe(initial)
    temperature_scale = abs(current_score) if current_score is not None else abs(float(problem.cheap(initial)))
    # Public cheap() may return -inf for an infeasible initial vector. This is a
    # temperature-scale fallback only; it never manufactures an oracle score.
    if not math.isfinite(temperature_scale):
        temperature_scale = 1.0
    initial_temperature = max(1.0, temperature_scale) * 0.1
    status = "no_query_budget" if not can_query() and queries == 0 else "budget_exhausted"

    for attempt in range(attempt_limit):
        if not can_query():
            break
        if legal_domain_count is not None and len(queried) == legal_domain_count:
            status = "declared_legal_domain_exhausted"
            break
        if not current:
            status = "empty_neighborhood"
            break
        destroy_name, repair_name = destroy.choose(rng), repair.choose(rng)
        count = rng.randint(1, max(1, math.ceil(len(current) * 0.6)))
        if destroy_name == "restart":
            removed = list(range(len(current)))
        elif destroy_name == "random":
            removed = _destroy_random(problem, current, rng, count)
        else:
            removed = _destroy_related(problem, current, rng, count)
        # An invalid initial vector may require a larger reconstruction.
        if not _legal(problem, current):
            removed = list(range(len(current)))
        weights_before = {"destroy": dict(destroy.weights), "repair": dict(repair.weights)}
        candidate, repair_log = _repair(problem, current, removed, rng, repair_name, queried)
        if repair_log["covers_entire_domain"]:
            legal_domain_count = repair_log["legal_domain_count"]
            coverage_witness_attempt = attempt + 1
        temperature = initial_temperature * (0.05 ** (queries / max(1, requested_budget)))
        reward, accepted, probability = 0.0, False, None
        previous_score = current_score
        candidate_score = None
        if candidate is None:
            decision = "no_unqueried_legal_repair"
        else:
            candidate_score, improved_best = observe(candidate)
            if candidate_score is None:
                decision = "invalid_or_unsupported_full_observation"
            elif current_score is None:
                accepted, probability, decision = True, 1.0, "first_valid_full_observation"
                reward = 8.0 if improved_best else 1.0
            else:
                accepted, probability = _acceptance(candidate_score - current_score, temperature, rng)
                decision = "accepted" if accepted else "rejected_by_annealing"
                if improved_best:
                    reward = 8.0
                elif accepted and candidate_score > current_score:
                    reward = 4.0
                elif accepted:
                    reward = 1.0
            if accepted:
                current, current_score = candidate, candidate_score
        destroy.reward(destroy_name, reward)
        repair.reward(repair_name, reward)
        operations.append({
            "attempt": attempt + 1,
            "destroy": destroy_name,
            "repair": repair_name,
            "removed": removed,
            "candidate": list(candidate) if candidate is not None else None,
            "candidate_score": candidate_score,
            "previous_score": previous_score,
            "current_score": current_score,
            "best_score": best_score,
            "accepted": accepted,
            "decision": decision,
            "temperature": temperature,
            "acceptance_probability": probability,
            "reward": reward,
            "weights_before": weights_before,
            "repair_search": repair_log,
        })
        if (attempt + 1) % segment_size == 0:
            weight_updates.append({"attempt": attempt + 1, "destroy": destroy.update(), "repair": repair.update()})
    else:
        status = "proposal_attempt_limit"

    if any(destroy.uses.values()):
        weight_updates.append({"attempt": len(operations), "destroy": destroy.update(), "repair": repair.update()})
    complete_coverage = legal_domain_count is not None and len(queried) == legal_domain_count
    all_full_valid = valid_full_observations == queries
    if complete_coverage:
        status = "declared_legal_domain_exhausted"
    finite_observation_maximum = bool(complete_coverage and all_full_valid and best_vector is not None)
    return {
        "best_vector": list(best_vector) if best_vector is not None else None,
        "best_score": best_score,
        "diagnostics": {
            "method": "m02_alns",
            "configuration": "v2-related-first-adaptive-global-restart-finite-coverage-stop",
            "status": status,
            "seed": seed,
            "requested_budget": requested_budget,
            "queries": queries,
            "attempts": len(operations),
            "acceptance": "maximization simulated annealing; p=exp((new-current)/T) for worse moves",
            "initial_temperature": initial_temperature,
            "segment_size": segment_size,
            "destroy_weights": dict(destroy.weights),
            "repair_weights": dict(repair.weights),
            "destroy_uses": dict(destroy.total_uses),
            "repair_uses": dict(repair.total_uses),
            "weight_updates": weight_updates,
            "operations": operations,
            "observations": observations,
            "coverage": {
                "legal_domain_count": legal_domain_count,
                "queried_unique": len(queried),
                "valid_full_observations": valid_full_observations,
                "complete": complete_coverage,
                "witness_attempt": coverage_witness_attempt,
                "finite_observation_maximum_proven": finite_observation_maximum,
                "scope": "One full observation at the declared search seed per public-legal vector; no expected-value, other-seed, expanded-domain, or real-game optimum claim.",
            },
        },
        "proof_scope": "Heuristic search in the declared finite decision domain; repair checks public structural and finite scheduling constraints. Best is selected only from this run's valid/full oracle observations. No global optimality, expected-score, real-game, or all-roster feasibility guarantee.",
    }
