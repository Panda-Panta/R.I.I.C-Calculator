"""Cycle/queue diagnostics and a bounded cycle-proxy proposal experiment.

No team independence, shared-state regeneration, or peak feasibility is inferred.
Only public metadata drives proposals; the returned incumbent requires full F.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence


def _number(value, name, minimum=None):
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a finite number") from exc
    if not math.isfinite(number) or (minimum is not None and number < minimum):
        raise ValueError(f"{name} must be finite and >= {minimum}")
    return number


def _required(record, name):
    if not isinstance(record, Mapping) or name not in record:
        raise ValueError(f"missing {name}")
    return record[name]


def _cycle(record):
    work = _number(_required(record, "work_hours"), "work_hours", 0)
    rest = _number(_required(record, "rest_hours"), "rest_hours", 0)
    reward = _number(_required(record, "reward"), "reward")
    wait = _number(record.get("wait_hours", 0), "wait_hours", 0)
    units = _number(record.get("bed_units", 1), "bed_units", 0)
    length = work + rest + wait
    if length <= 0:
        raise ValueError("a complete cycle must have positive length")
    return {
        "length_hours": length,
        "reward_per_hour": reward / length,
        "arrival_rate_per_hour": units / length,
        "mean_beds": units * rest / length,
        "mean_waiting_occupants": units * wait / length,
    }


def renewal_reward_summary(cycles):
    """Ratio of total reward to total complete-cycle length, not mean ratios.

    The arithmetic is exact for supplied records. Neither IID cycles nor
    regenerative shared state nor convergence can be certified from these fields.
    """
    if not cycles:
        raise ValueError("no complete cycles supplied")
    lengths, rewards = [], []
    for record in cycles:
        length = _number(_required(record, "length_hours"), "length_hours", 0)
        if length <= 0:
            raise ValueError("cycle length must be positive")
        lengths.append(length)
        rewards.append(_number(_required(record, "reward"), "reward"))
    total_length = math.fsum(lengths)
    total_reward = math.fsum(rewards)
    count = len(lengths)
    return {
        "complete_cycles": count,
        "total_length_hours": total_length,
        "total_reward": total_reward,
        "mean_cycle_length_hours": total_length / count,
        "mean_cycle_reward": total_reward / count,
        "reward_per_hour": total_reward / total_length,
        "long_run_convergence_proven": False,
        "scope": "finite supplied complete-cycle records; no regeneration proof",
    }


def recovery_load(records, *, beds):
    """Load implied by explicitly declared repeating work/rest/wait cycles.

    bed_units counts occupants per cycle entry. The implied arrival rate and
    recovery duration are occupant weighted, so lambda * mean service = mean beds.
    The aggregate reward is a heuristic when shared dynamics couple the cycles.
    """
    capacity = _number(beds, "beds", 0)
    profiles = [_cycle(record) for record in records]
    arrivals = math.fsum(p["arrival_rate_per_hour"] for p in profiles)
    load = math.fsum(p["mean_beds"] for p in profiles)
    mean_rest = load / arrivals if arrivals else None
    return {
        "aggregate_cycle_proxy_per_hour": math.fsum(p["reward_per_hour"] for p in profiles),
        "arrival_rate_per_hour": arrivals,
        "mean_recovery_hours": mean_rest,
        "mean_beds": load,
        "mean_waiting_occupants": math.fsum(p["mean_waiting_occupants"] for p in profiles),
        "little_recovery_rhs": arrivals * mean_rest if mean_rest is not None else 0.0,
        "beds": capacity,
        "utilization": load / capacity if capacity else None,
        "average_capacity_condition": load <= capacity + 1e-12,
        "peak_capacity_condition": None,
        "full_schedule_feasibility_proven": False,
        "scope": "declared-cycle necessary average-load condition; peak/eligibility unknown",
    }


def window_occupancy(stays, *, window_hours, beds):
    """Finite-window Little accounting and a sweep of supplied recovery stays.

    All supplied arrivals/departures must be inside the same window; censored
    stays require boundary accounting and are rejected. This does not certify
    completeness of a log or feasibility outside the recorded intervals.
    Recovery intervals are half open, so a departure frees a bed at its timestamp.
    """
    horizon = _number(window_hours, "window_hours", 0)
    capacity = _number(beds, "beds", 0)
    if horizon <= 0:
        raise ValueError("window_hours must be positive")
    people = 0.0
    sojourn_area = service_area = wait_area = 0.0
    events = {}
    for stay in stays:
        arrival = _number(_required(stay, "arrival_hours"), "arrival_hours", 0)
        start = _number(_required(stay, "service_start_hours"), "service_start_hours", 0)
        departure = _number(_required(stay, "departure_hours"), "departure_hours", 0)
        units = _number(stay.get("bed_units", 1), "bed_units", 0)
        if not arrival <= start <= departure <= horizon:
            raise ValueError("stays must satisfy 0 <= arrival <= service_start <= departure <= window")
        people += units
        sojourn_area += units * (departure - arrival)
        service_area += units * (departure - start)
        wait_area += units * (start - arrival)
        if start < departure:
            events[start] = events.get(start, 0.0) + units
            events[departure] = events.get(departure, 0.0) - units
    occupied = peak = 0.0
    for timestamp in sorted(events):
        occupied += events[timestamp]
        peak = max(peak, occupied)
    arrival_rate = people / horizon
    mean_sojourn = sojourn_area / people if people else None
    mean_service = service_area / people if people else None
    return {
        "window_hours": horizon,
        "arriving_occupants": people,
        "arrival_rate_per_hour": arrival_rate,
        "mean_sojourn_hours": mean_sojourn,
        "mean_recovery_hours": mean_service,
        "mean_system_occupants": sojourn_area / horizon,
        "mean_beds": service_area / horizon,
        "mean_waiting_occupants": wait_area / horizon,
        "little_system_rhs": arrival_rate * mean_sojourn if mean_sojourn is not None else 0.0,
        "little_recovery_rhs": arrival_rate * mean_service if mean_service is not None else 0.0,
        "peak_beds": peak,
        "beds": capacity,
        "average_capacity_condition": service_area / horizon <= capacity + 1e-12,
        "peak_capacity_condition": peak <= capacity + 1e-12,
        "full_schedule_feasibility_proven": False,
        "scope": "exact finite-window accounting for supplied complete stays; eligibility unchecked",
    }


def _metadata(problem):
    public = getattr(problem, "metadata", None)
    if not isinstance(public, Mapping):
        public = getattr(problem, "spec", {}).get("metadata", {})
    renewal = public.get("renewal", {})
    return renewal if isinstance(renewal, Mapping) else {}


def _read_options(problem, metadata):
    capacity = _number(_required(metadata, "beds"), "beds", 0)
    options = _required(metadata, "options")
    if not isinstance(options, Sequence) or len(options) != len(problem.domains):
        raise ValueError("renewal.options must have one row per variable")
    profiles = []
    for domain, row in zip(problem.domains, options):
        if not isinstance(row, Sequence) or len(row) != len(domain):
            raise ValueError("renewal.options row must match its variable domain")
        profiles.append([_cycle(row[value]) for value in domain])
    return options, profiles, capacity


def _proposals(problem, profiles, capacity, budget, admissible):
    """Bounded prefix beam under several explicit average-overload penalties."""
    width = min(128, max(8, budget * 4))
    rate_scale = max(1.0, math.fsum(max(abs(p["reward_per_hour"]) for p in row) for row in profiles))
    penalty_scale = rate_scale / max(1.0, capacity) ** 2
    penalties = [penalty_scale * multiplier for multiplier in (0, 0.25, 1, 4, 16)]
    rankings, pool, expansions = [], {}, 0
    for penalty in penalties:
        beam = [((), 0.0, 0.0)]
        for row in profiles:
            expanded = [
                (vector + (value,), reward + item["reward_per_hour"], load + item["mean_beds"])
                for vector, reward, load in beam
                for value, item in enumerate(row)
            ]
            expansions += len(expanded)
            expanded.sort(key=lambda entry: (
                -(entry[1] - penalty * max(0.0, entry[2] - capacity) ** 2),
                -entry[1], entry[2], entry[0],
            ))
            beam = expanded[:width]
        ranking = []
        for vector, reward, load in beam:
            if admissible(vector):
                pool[vector] = {"cycle_proxy_per_hour": reward, "mean_beds": load}
                ranking.append(vector)
        rankings.append(ranking)
    ordered = [tuple(problem.initial)]
    seen = set(ordered)
    # Round robin retains candidates preferred at different overload penalties.
    for rank in range(max((len(ranking) for ranking in rankings), default=0)):
        for ranking in rankings:
            if rank < len(ranking) and ranking[rank] not in seen:
                ordered.append(ranking[rank])
                seen.add(ranking[rank])
    return ordered, pool, {
        "cycle_model": "independent_option_proxy",
        "beam_width": width,
        "penalties": penalties,
        "model_expansions": expansions,
        "model_candidate_count": len(pool),
    }


def _context_proposals(problem, metadata, admissible):
    """Rank declared whole-vector reference cycles, including shared dorm context.

    This public model table is not an F table. Unsupported or missing contexts
    stay unscored; an independent-option fallback would invent separability.
    """
    capacity = _number(_required(metadata, "beds"), "beds", 0)
    table = _required(metadata, "vector_cycles")
    if not isinstance(table, Mapping):
        raise ValueError("renewal.vector_cycles must be a mapping")
    contexts, pool, unsupported = {}, {}, []
    for key, record in table.items():
        vector = None
        try:
            if not isinstance(key, str):
                raise ValueError("cycle-context keys must be comma-separated integer vectors")
            vector = tuple(int(value) for value in key.split(","))
            if len(vector) != len(problem.domains) or any(
                value not in domain for value, domain in zip(vector, problem.domains)
            ):
                raise ValueError("cycle-context key is outside the declared domain")
            if not isinstance(record, Mapping):
                raise ValueError("cycle context must be a mapping")
            if record.get("supported") is False:
                issues = record.get("issues") or ["unsupported cycle context"]
                unsupported.append({
                    "vector": list(vector), "score": None,
                    "issues": list(issues) if not isinstance(issues, str) else [issues],
                })
                continue
            groups = _required(record, "groups")
            if not isinstance(groups, Sequence) or isinstance(groups, (str, bytes)) or not groups:
                raise ValueError("cycle context needs nonempty complete group records")
            model = recovery_load(groups, beds=capacity)
            if vector in contexts:
                raise ValueError("duplicate normalized cycle-context key")
            contexts[vector] = record
            if admissible(vector):
                pool[vector] = {
                    "cycle_proxy_per_hour": model["aggregate_cycle_proxy_per_hour"],
                    "mean_beds": model["mean_beds"],
                }
        except (ValueError, TypeError, IndexError) as exc:
            unsupported.append({
                "vector": list(vector) if vector is not None else None,
                "key": str(key), "score": None, "issues": [str(exc)],
            })
    rate_scale = max([1.0] + [abs(row["cycle_proxy_per_hour"]) for row in pool.values()])
    penalty_scale = rate_scale / max(1.0, capacity) ** 2
    penalties = [penalty_scale * multiplier for multiplier in (0, 0.25, 1, 4, 16)]
    rankings = [sorted(pool, key=lambda vector: (
        -(pool[vector]["cycle_proxy_per_hour"]
          - penalty * max(0.0, pool[vector]["mean_beds"] - capacity) ** 2),
        -pool[vector]["cycle_proxy_per_hour"], pool[vector]["mean_beds"], vector,
    )) for penalty in penalties]
    ordered = [tuple(problem.initial)]
    seen = set(ordered)
    for rank in range(len(pool)):
        for ranking in rankings:
            if ranking[rank] not in seen:
                ordered.append(ranking[rank])
                seen.add(ranking[rank])
    # Matching reference cycles are model aliases, not equivalent F outcomes.
    # Defer repeats to cover other cycle structures, but never discard aliases.
    signatures, representatives, aliases = set(), [], []
    for vector in ordered:
        if vector not in pool:
            representatives.append(vector)
            continue
        signature = tuple(sorted(
            (
                str(group.get("group_id", "")),
                float(group["work_hours"]), float(group["rest_hours"]),
                float(group.get("wait_hours", 0)), float(group["reward"]),
                float(group.get("bed_units", 1)),
            )
            for group in contexts[vector]["groups"]
        ))
        if signature in signatures:
            aliases.append(vector)
        else:
            signatures.add(signature)
            representatives.append(vector)
    ordered = representatives + aliases
    unprovided = max(0, math.prod(len(domain) for domain in problem.domains) - len(table))
    return ordered, pool, contexts, capacity, {
        "cycle_model": "full_vector_context",
        "penalties": penalties,
        "model_expansions": len(table),
        "model_candidate_count": len(pool),
        "cycle_profile_classes": len(signatures),
        "deferred_model_aliases": len(aliases),
        "cycle_contexts_complete": not unsupported and not unprovided,
        "unprovided_cartesian_contexts": unprovided,
        "unsupported_cycle_contexts": unsupported,
    }


def solve(problem, *, seed=42, budget=16):
    """Propose via declared cycles; retain only valid full-oracle incumbents."""
    budget = max(0, int(budget))
    metadata = _metadata(problem)
    diagnostics = {
        "status": "unsupported_cycle_metadata",
        "seed": seed,
        "oracle_queries": 0,
        "metadata_errors": [],
        "observation_errors": [],
        "shared_state_regenerates_declared": metadata.get("shared_state_regenerates") is True,
        "renewal_property_proven": False,
        "long_run_convergence_proven": False,
        "full_schedule_feasibility_proven": False,
        "cycle_data_source": metadata.get("source", "declared_cycle_estimates"),
        "cycle_data_sources": metadata.get("sources", []),
        "cycle_reward_units": metadata.get("reward_units"),
        "best_cycle_diagnostics": None,
        "observed_cycle_summary": None,
        "observed_window_occupancy": None,
        "schedule_checks_complete": True,
        "unknown_schedule_candidates": [],
    }
    schedule_status = {}

    def admissible(vector):
        key = tuple(vector)
        if key not in schedule_status:
            if not problem.feasible(vector):
                schedule_status[key] = "STRUCTURALLY_INFEASIBLE"
            else:
                try:
                    feasible = problem.schedule_feasible(vector)
                except RuntimeError as exc:
                    # common reports its finite search cap as an exception.
                    # Other implementation errors must not become a fake UNKNOWN.
                    if "finite scheduler budget exhausted" not in str(exc).lower():
                        raise
                    schedule_status[key] = "UNKNOWN"
                    diagnostics["schedule_checks_complete"] = False
                    diagnostics["unknown_schedule_candidates"].append({
                        "vector": list(vector), "status": "UNKNOWN",
                        "reason": str(exc), "score": None,
                    })
                else:
                    schedule_status[key] = "FEASIBLE" if feasible else "INFEASIBLE"
        return schedule_status[key] == "FEASIBLE"

    options = None
    contexts = None
    pool = {}
    capacity = None
    ordered = [tuple(problem.initial)]
    try:
        if "vector_cycles" in metadata:
            ordered, pool, contexts, capacity, proposal_diagnostics = _context_proposals(problem, metadata, admissible)
            diagnostics.update(proposal_diagnostics)
            if contexts:
                diagnostics["status"] = "context_cycle_proxy_proposals"
            else:
                diagnostics["metadata_errors"].append("no supported complete cycle contexts")
        else:
            options, profiles, capacity = _read_options(problem, metadata)
            ordered, pool, proposal_diagnostics = _proposals(problem, profiles, capacity, budget, admissible)
            diagnostics.update(proposal_diagnostics)
            diagnostics["status"] = "cycle_proxy_proposals"
    except (ValueError, TypeError, IndexError) as exc:
        options = None
        diagnostics["metadata_errors"].append(str(exc))

    if "observed_cycles" in metadata:
        try:
            diagnostics["observed_cycle_summary"] = renewal_reward_summary(metadata["observed_cycles"])
        except (ValueError, TypeError) as exc:
            diagnostics["observation_errors"].append(str(exc))
    if "stays" in metadata:
        try:
            diagnostics["observed_window_occupancy"] = window_occupancy(
                metadata["stays"],
                window_hours=_required(metadata, "observation_window_hours"),
                beds=_required(metadata, "beds"),
            )
        except (ValueError, TypeError) as exc:
            diagnostics["observation_errors"].append(str(exc))

    best_vector = best_score = None
    trace = []
    for vector in ordered:
        if diagnostics["oracle_queries"] >= budget or getattr(problem, "remaining", budget) <= 0:
            break
        if not admissible(vector):
            continue
        record = problem.evaluate(vector, fidelity="full", seed=seed)
        diagnostics["oracle_queries"] += 1
        score = record.get("score")
        usable = (
            record.get("valid") is True
            and record.get("fidelity") == "full"
            and isinstance(score, (int, float))
            and not isinstance(score, bool)
            and math.isfinite(score)
        )
        trace.append({
            "vector": list(vector),
            "model": pool.get(vector),
            "valid_full": usable,
            "score": float(score) if usable else None,
        })
        if usable and (best_score is None or score > best_score):
            best_vector, best_score = list(vector), float(score)
    if best_vector is not None and options is not None:
        diagnostics["best_cycle_diagnostics"] = recovery_load(
            [options[index][value] for index, value in enumerate(best_vector)], beds=capacity,
        )
    if best_vector is not None and contexts is not None and tuple(best_vector) in contexts:
        context = contexts[tuple(best_vector)]
        diagnostics["best_cycle_diagnostics"] = recovery_load(context["groups"], beds=capacity)
        diagnostics["best_cycle_diagnostics"].update({
            "group_ids": [group.get("group_id") for group in context["groups"]],
            "assumptions": context.get("assumptions", metadata.get("assumptions", [])),
            "context_issues": context.get("issues", []),
            "source": context.get("source", metadata.get("source")),
            "sources": context.get("sources", metadata.get("sources", [])),
        })
    return {
        "best_vector": best_vector,
        "best_score": best_score,
        "diagnostics": diagnostics,
        "trace": trace,
        "proof_scope": (
            "Finite supplied-cycle/window arithmetic and bounded cycle-proxy proposals "
            "from an option beam or a public whole-vector reference-cycle pool. "
            "Best is selected only from queried valid/full F records. Shared-state regeneration, "
            "cycle independence, convergence, global optimality, bed eligibility and unobserved "
            "peak feasibility are not proved; average load is only a necessary condition "
            "inside the declared cycle model, not a feasibility certificate for F."
        ),
    }
