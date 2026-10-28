"""Budgeted categorical NSGA-II; every objective comes from queried metrics.

The public score still chooses best_vector.  The additional Pareto archive only
claims nondominance among this run's valid, full-fidelity observations.
"""

from __future__ import annotations

import math
import random
from numbers import Real


DEFAULT_OBJECTIVES = (
    ("exp", "max"),
    ("order_lmd", "max"),
    ("gold", "max"),
    ("change_cost", "min"),
)


def _finite(value):
    return isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(value)


def dominates(left, right):
    """Both points use the internal all-maximization convention."""
    return all(a >= b for a, b in zip(left, right)) and any(
        a > b for a, b in zip(left, right)
    )


def nondominated_sort(points):
    """Deb et al. III.A: domination counts and dominated sets, O(M N**2)."""
    dominated = [[] for _ in points]
    counts = [0] * len(points)
    for i, left in enumerate(points):
        for j in range(i + 1, len(points)):
            if dominates(left, points[j]):
                dominated[i].append(j)
                counts[j] += 1
            elif dominates(points[j], left):
                dominated[j].append(i)
                counts[i] += 1
    front = [i for i, count in enumerate(counts) if count == 0]
    fronts = []
    while front:
        fronts.append(front)
        following = []
        for i in front:
            for j in dominated[i]:
                counts[j] -= 1
                if counts[j] == 0:
                    following.append(j)
        front = sorted(following)
    return fronts


def crowding_distance(points, front):
    """Normalized objective-space neighbor gaps, with infinite boundaries.

    A constant objective contributes zero (including no arbitrary boundary
    preference). This makes the otherwise undefined zero-range case explicit.
    """
    distance = dict.fromkeys(front, 0.0)
    if len(front) <= 2:
        return dict.fromkeys(front, math.inf)
    for axis in range(len(points[front[0]])):
        order = sorted(front, key=lambda i: (points[i][axis], i))
        span = points[order[-1]][axis] - points[order[0]][axis]
        if span == 0:
            continue
        distance[order[0]] = distance[order[-1]] = math.inf
        for previous, current, following in zip(order, order[1:], order[2:]):
            distance[current] += (
                points[following][axis] - points[previous][axis]
            ) / span
    return distance


def select_survivors(points, size):
    """Fill complete fronts; truncate only the last by descending crowding."""
    chosen = []
    for front in nondominated_sort(points):
        if len(chosen) + len(front) <= size:
            chosen.extend(front)
        else:
            distance = crowding_distance(points, front)
            chosen.extend(sorted(front, key=lambda i: (-distance[i], i))[: size - len(chosen)])
            break
    return chosen


def _legal(problem, vector):
    return (
        len(vector) == len(problem.domains)
        and all(value in domain for value, domain in zip(vector, problem.domains))
        and problem.feasible(vector)
        and problem.schedule_feasible(vector)
    )


def _violation(problem, vector):
    """Repair heuristic only; not a substitute for the public legality checks."""
    spec = problem.spec
    amount = float(not problem.feasible(vector)) + float(not problem.schedule_feasible(vector))
    for forbidden in spec.get("forbidden", []):
        amount += all(
            vector[i] == value
            for i, value in zip(forbidden["vars"], forbidden["values"])
        )
    for resource in spec.get("resources", []):
        used = sum(row[value] for row, value in zip(resource["usage"], vector))
        capacity = resource["capacity"]
        amount += max(0.0, used - capacity) / max(1.0, abs(capacity))
    return amount


def repair_candidate(problem, vector, rng, fallback=None):
    """Bounded categorical min-conflict moves, then a verified legal anchor.

    Failure returns None, never an unverified assignment. No oracle is queried
    and no Cartesian-product enumeration is used during repair.
    """
    domains = problem.domains
    if len(vector) != len(domains) or any(not domain for domain in domains):
        return None
    current = tuple(
        value if value in domain else rng.choice(domain)
        for value, domain in zip(vector, domains)
    )
    visited = {current}
    for _ in range(2 * len(domains) + 4):
        if _legal(problem, current):
            return current
        neighbors = []
        for i, domain in enumerate(domains):
            for value in domain:
                candidate = current[:i] + (value,) + current[i + 1 :]
                if candidate not in visited:
                    if _legal(problem, candidate):
                        return candidate
                    neighbors.append(candidate)
        if not neighbors:
            break
        rng.shuffle(neighbors)
        current = min(neighbors, key=lambda candidate: _violation(problem, candidate))
        visited.add(current)
    if fallback is not None and _legal(problem, fallback):
        return tuple(fallback)
    return None


def _schema(metadata):
    configured = metadata.get("pareto_objectives")
    if configured is None:
        return None
    if not isinstance(configured, (list, tuple)):
        raise ValueError("pareto_objectives must be a list of {name, direction}")
    schema = []
    for objective in configured:
        if not isinstance(objective, dict):
            raise ValueError("each objective must contain name and direction")
        name, direction = objective.get("name"), objective.get("direction")
        if not isinstance(name, str) or not name or direction not in ("max", "min"):
            raise ValueError("each objective needs a metric name and max/min direction")
        schema.append((name, direction))
    if len(schema) < 2 or len({name for name, _ in schema}) != len(schema):
        raise ValueError("at least two distinct measured objectives are required")
    return schema


def _point(record, schema):
    metrics = record.get("metrics") or {}
    if not all(_finite(metrics.get(name)) for name, _ in schema):
        return None
    return tuple(float(metrics[name]) * (1 if direction == "max" else -1) for name, direction in schema)


def _variation(left, right, domains, rng):
    # Categories have no ordinal geometry: inherit a parent's category per gene.
    child = [a if rng.random() < 0.5 else b for a, b in zip(left, right)]
    mutable = [i for i, domain in enumerate(domains) if len(domain) > 1]
    changed = []
    for i in mutable:
        if rng.random() < 1 / max(1, len(domains)):
            child[i] = rng.choice([value for value in domains[i] if value != child[i]])
            changed.append(i)
    # A forced categorical mutation prevents zero-mutation clones consuming the
    # small proposal budget; this is a disclosed discrete-domain adaptation.
    if mutable and not changed:
        i = rng.choice(mutable)
        child[i] = rng.choice([value for value in domains[i] if value != child[i]])
        changed.append(i)
    return tuple(child), len(changed)


def _balanced_proposal(domains, queried, rng):
    """Cover underrepresented categories using only this run's queried vectors."""
    candidate = []
    for i, domain in enumerate(domains):
        counts = {value: sum(vector[i] == value for vector in queried) for value in domain}
        minimum = min(counts.values())
        candidate.append(rng.choice([value for value in domain if counts[value] == minimum]))
    return tuple(candidate)


def solve(problem, *, seed=42, budget=16):
    rng = random.Random(seed)
    metadata = getattr(problem, "metadata", {}) or {}
    limit = min(max(0, int(budget)), max(0, int(problem.remaining)))
    population_size = min(limit, max(2, min(8, limit // 4)))
    # Count categories, not unqueried F labels; leave room for actual evolution
    # on tiny domains rather than filling an oversized initial population.
    cardinality = math.prod(len(domain) for domain in problem.domains)
    population_size = min(population_size, max(1, cardinality // 2))
    if "pareto_population_size" in metadata:
        population_size = min(limit, max(1, int(metadata["pareto_population_size"])))
    initialization = metadata.get("pareto_initialization", "balanced")
    score_mating_probability = float(metadata.get("pareto_score_mating_probability", 0.35))
    if initialization not in ("balanced", "random"):
        raise ValueError("pareto_initialization must be balanced or random")
    if not math.isfinite(score_mating_probability) or not 0 <= score_mating_probability <= 1:
        raise ValueError("pareto_score_mating_probability must be between zero and one")
    diagnostics = {
        "algorithm": "categorical NSGA-II",
        "seed": seed,
        "budget": max(0, int(budget)),
        "effective_budget": limit,
        "queries": 0,
        "population_size": population_size,
        "initialization": initialization,
        "score_mating_probability": score_mating_probability,
        "score_elite_matings": 0,
        "generations": 0,
        "parent_child_selections": 0,
        "tournaments": 0,
        "crossovers": 0,
        "mutated_genes": 0,
        "repair_changed": 0,
        "repair_failed": 0,
        "duplicate_proposals": 0,
        "invalid_or_incomplete": 0,
        "missing_objectives": 0,
        "generation_trace": [],
        "score_curve": [],
        "objective_source": "metadata.pareto_objectives" if "pareto_objectives" in metadata else "observed metrics",
    }
    all_valid, archive, population, seen = [], [], [], set()
    schema = None
    status = "budget_exhausted"
    reason = None

    def available():
        return diagnostics["queries"] < limit and problem.remaining > 0

    def evaluate(candidate):
        nonlocal schema, status, reason
        seen.add(candidate)
        diagnostics["queries"] += 1  # Count even when an external cache answers.
        record = problem.evaluate(candidate, fidelity="full", seed=seed)
        if not (record.get("valid") and record.get("fidelity") == "full" and _finite(record.get("score"))):
            diagnostics["invalid_or_incomplete"] += 1
            return None
        record = {**record, "vector": list(candidate)}
        if not all_valid or record["score"] > max(row["score"] for row in all_valid):
            diagnostics["score_curve"].append({"query": diagnostics["queries"], "score": record["score"], "vector": list(candidate)})
        all_valid.append(record)
        if schema is None:
            metrics = record.get("metrics") or {}
            schema = [(name, direction) for name, direction in DEFAULT_OBJECTIVES if _finite(metrics.get(name))]
            if len(schema) < 2:
                status = "unsupported_objectives"
                reason = "fewer than two finite measured metrics; no synthetic objective was created"
                return None
        point = _point(record, schema)
        if point is None:
            diagnostics["missing_objectives"] += 1
            return None
        item = {"record": record, "point": point}
        archive.append(item)
        return item

    def propose(vector, fallback):
        repaired = repair_candidate(problem, vector, rng, fallback=fallback)
        if repaired is None:
            diagnostics["repair_failed"] += 1
            return None
        diagnostics["repair_changed"] += repaired != tuple(vector)
        if repaired in seen:
            diagnostics["duplicate_proposals"] += 1
            return None
        return evaluate(repaired)

    try:
        schema = _schema(metadata)
    except ValueError as error:
        status, reason = "unsupported_objectives", str(error)
    if status != "unsupported_objectives" and available():
        if any(not domain for domain in problem.domains):
            status, reason = "no_feasible_population", "an empty categorical domain was declared"
        else:
            attempts = 0
            while available() and len(population) < population_size and attempts < max(32, 12 * population_size):
                if attempts == 0:
                    raw = tuple(problem.initial)
                elif initialization == "balanced" and attempts % 5:
                    raw = _balanced_proposal(problem.domains, seen, rng)
                else:
                    raw = tuple(rng.choice(domain) for domain in problem.domains)
                fallback = population[0]["record"]["vector"] if population else None
                item = propose(raw, fallback)
                attempts += 1
                if item is not None:
                    population.append(item)
                if status == "unsupported_objectives":
                    break
            if not population and status != "unsupported_objectives":
                if all_valid and diagnostics["missing_objectives"]:
                    status, reason = "unsupported_objectives", "valid scores were observed but declared measured objectives were missing or nonfinite"
                else:
                    status, reason = "no_feasible_population", "bounded initialization found no legal full-fidelity multiobjective observation"

    while population and available() and status != "unsupported_objectives":
        points = [item["point"] for item in population]
        rank, distance = {}, {}
        for level, front in enumerate(nondominated_sort(points)):
            rank.update(dict.fromkeys(front, level))
            distance.update(crowding_distance(points, front))

        def tournament():
            diagnostics["tournaments"] += 1
            left, right = rng.randrange(len(population)), rng.randrange(len(population))
            key_left, key_right = (rank[left], -distance[left]), (rank[right], -distance[right])
            if key_left == key_right:
                return population[rng.choice((left, right))]["record"]["vector"]
            return population[left if key_left < key_right else right]["record"]["vector"]

        def mating_parent():
            # This is an explicit hybrid mating policy, not an extra objective:
            # official-score incumbents can breed after crowding discards them.
            if all_valid and rng.random() < score_mating_probability:
                diagnostics["score_elite_matings"] += 1
                return max(all_valid, key=lambda record: record["score"])["vector"]
            return tournament()

        children = []
        for attempt in range(max(40, 12 * population_size)):
            if not available() or len(children) >= population_size:
                break
            # Occasional fresh proposals combat repeated repaired clones.
            if attempt > 0 and attempt % 5 == 0:
                raw = tuple(rng.choice(domain) for domain in problem.domains)
            else:
                raw, mutations = _variation(mating_parent(), mating_parent(), problem.domains, rng)
                diagnostics["crossovers"] += 1
                diagnostics["mutated_genes"] += mutations
            item = propose(raw, population[0]["record"]["vector"])
            if item is not None:
                children.append(item)
        if not children:
            status, reason = "search_stalled", "bounded categorical proposals produced no unseen valid child; this does not prove domain exhaustion"
            break
        combined = population + children
        combined_points = [item["point"] for item in combined]
        selected = select_survivors(combined_points, population_size)
        diagnostics["parent_child_selections"] += 1
        diagnostics["generations"] += 1
        diagnostics["generation_trace"].append({
            "parents": [item["record"]["vector"] for item in population],
            "children": [item["record"]["vector"] for item in children],
            "front_sizes": [len(front) for front in nondominated_sort(combined_points)],
            "selected": [combined[i]["record"]["vector"] for i in selected],
        })
        population = [combined[i] for i in selected]

    best = max(all_valid, key=lambda record: record["score"], default=None)
    pareto = []
    if archive:
        archive_points = [item["point"] for item in archive]
        front = nondominated_sort(archive_points)[0]
        distance = crowding_distance(archive_points, front)
        for i in front:
            record = archive[i]["record"]
            pareto.append({
                "vector": record["vector"],
                "score": record["score"],
                "objectives": {name: record["metrics"][name] for name, _ in schema},
                "crowding_distance": distance[i] if math.isfinite(distance[i]) else None,
                "boundary": math.isinf(distance[i]),
            })
    diagnostics.update({
        "status": status, "reason": reason, "valid_scores": len(all_valid),
        "multiobjective_observations": len(archive), "queried_unique": len(seen),
        "observed_category_counts": [len({vector[i] for vector in seen}) for i in range(len(problem.domains))],
    })
    return {
        "best_vector": best["vector"] if best else None,
        "best_score": best["score"] if best else None,
        "pareto_front": pareto,
        "objectives": [{"name": name, "direction": direction} for name, direction in (schema or [])],
        "diagnostics": diagnostics,
        "proof_scope": {
            "pareto": "nondominated among queried valid full-fidelity observations with the declared metrics",
            "best": "highest existing score among this run's queried valid full-fidelity observations; weights are unchanged",
            "constraints": "public structural and declared schedule checks before evaluation, then oracle validity",
            "excluded": "no global Pareto/optimality guarantee, no real-game improvement claim, no physical operation-count interpretation of change_cost",
        },
    }
