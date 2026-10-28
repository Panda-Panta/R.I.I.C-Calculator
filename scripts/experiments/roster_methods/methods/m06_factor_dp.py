"""Exact max-sum bucket elimination for the declared finite cheap model.

The full simulator is an oracle: its values are never factors of this DP.  A
Lawler partition queue generates further cheap-model solutions for a bounded
number of full-oracle checks.  No complete-domain vector iterator is used.
"""

from __future__ import annotations

from dataclasses import dataclass
import heapq
from itertools import combinations, product
import math
from typing import Callable


_NEG_INF = float("-inf")
_MAX_MESSAGE_ROWS = 100_000
_MAX_JOIN_ASSIGNMENTS = 2_000_000
_MAX_DP_SOLVES = 512


@dataclass(frozen=True)
class _Factor:
    scope: tuple[int, ...]
    values: dict[tuple[int, ...], float] | None = None
    default: float = 0.0
    function: Callable[[tuple[int, ...]], float] | None = None
    kind: str = "message"

    def at(self, values: tuple[int, ...]) -> float:
        if self.function is not None:
            return self.function(values)
        return self.values.get(values, self.default)


class _ComplexityLimit(RuntimeError):
    def __init__(self, reason: str, **detail):
        super().__init__(reason)
        self.detail = {"reason": reason, **detail}


@dataclass
class _Work:
    solves: int = 0
    assignments: int = 0
    lookups: int = 0
    max_rows: int = 0


def _cardinality(scope, domains) -> int:
    return math.prod(len(domains[i]) for i in scope)


def _number(value, label: str) -> float:
    if isinstance(value, int):
        return value
    value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"{label} must be finite")
    return value


def _scope(raw, n: int) -> tuple[int, ...]:
    scope = tuple(int(i) for i in raw)
    if len(set(scope)) != len(scope) or any(i < 0 or i >= n for i in scope):
        raise ValueError("factor scope must contain distinct valid variables")
    return scope


def _compile(problem, domains) -> tuple[list[_Factor], dict]:
    """Keep every factor, including negative rewards and global constraints."""
    spec = problem.spec
    n = len(domains)
    unary = spec.get("unary", [[0.0] * len(d) for d in domains])
    if len(unary) != n or any(len(row) != len(domains[i]) for i, row in enumerate(unary)):
        raise ValueError("unary dimensions do not match domains")
    factors = [
        _Factor((i,), {(v,): _number(row[v], "unary") for v in domains[i]}, kind="unary")
        for i, row in enumerate(unary)
    ]
    counts = {"unary": n, "reward": 0, "forbidden": 0, "resource": 0}
    for raw in spec.get("factors", []):
        original = _scope(raw["vars"], n)
        canonical = tuple(sorted(original))
        positions = tuple(original.index(i) for i in canonical)
        values = {}
        for key, score in raw.get("table", {}).items():
            vals = tuple(int(v) for v in key.split(",")) if isinstance(key, str) and key else tuple(key)
            if len(vals) != len(original):
                raise ValueError("factor table key has wrong arity")
            if any(v not in domains[i] for i, v in zip(original, vals)):
                raise ValueError("factor table key is outside a variable domain")
            values[tuple(vals[p] for p in positions)] = _number(score, "factor reward")
        factors.append(_Factor(canonical, values, kind="reward"))
        counts["reward"] += 1
    for raw in spec.get("forbidden", []):
        original = _scope(raw["vars"], n)
        vals = tuple(int(v) for v in raw["values"])
        if len(vals) != len(original):
            raise ValueError("forbidden tuple has wrong arity")
        if any(v not in domains[i] for i, v in zip(original, vals)):
            raise ValueError("forbidden tuple is outside a variable domain")
        ordered = tuple(sorted(zip(original, vals)))
        factors.append(_Factor(tuple(i for i, _ in ordered), {tuple(v for _, v in ordered): _NEG_INF}, kind="forbidden"))
        counts["forbidden"] += 1
    for raw in spec.get("resources", []):
        usage = tuple(tuple(_number(v, "resource usage") for v in row) for row in raw["usage"])
        if len(usage) != n or any(len(row) != len(domains[i]) for i, row in enumerate(usage)):
            raise ValueError("resource dimensions do not match domains")
        capacity = _number(raw["capacity"], "resource capacity")
        # Include every nonzero row.  Constant use is retained, rather than
        # relying on sign assumptions or a resource-state rounding scheme.
        resource_scope = tuple(i for i, row in enumerate(usage) if any(v != 0 for v in row))

        def capacity_factor(vals, scope=resource_scope, rows=usage, cap=capacity):
            return 0.0 if sum(rows[i][v] for i, v in zip(scope, vals)) <= cap else _NEG_INF

        factors.append(_Factor(resource_scope, function=capacity_factor, kind="resource"))
        counts["resource"] += 1
    return factors, counts


def _condition(factor: _Factor, fixed: dict[int, int]) -> _Factor:
    if not any(i in fixed for i in factor.scope):
        return factor
    remaining = tuple(i for i in factor.scope if i not in fixed)
    remaining_positions = {i: p for p, i in enumerate(remaining)}

    def conditioned(vals, source=factor, known=fixed, positions=remaining_positions):
        full = tuple(known[i] if i in known else vals[positions[i]] for i in source.scope)
        return source.at(full)

    return _Factor(remaining, function=conditioned, kind=factor.kind)


def _min_fill(factors, domains, variables) -> tuple[list[int], int]:
    graph = {i: set() for i in variables}
    for factor in factors:
        for i, j in combinations(factor.scope, 2):
            graph[i].add(j)
            graph[j].add(i)
    order = []
    width = 0
    while graph:
        def key(i):
            neighbors = graph[i]
            fill = sum(j not in graph[k] for j, k in combinations(neighbors, 2))
            # Fill count alone cannot distinguish a mixed-cardinality clique:
            # every joint table has the same size, but eliminating the larger
            # domain leaves a smaller message and reduces later bucket work.
            message_rows = _cardinality(neighbors, domains)
            return fill, message_rows, message_rows * len(domains[i]), len(neighbors), i

        variable = min(graph, key=key)
        neighbors = graph[variable]
        width = max(width, len(neighbors))
        for i, j in combinations(neighbors, 2):
            graph[i].add(j)
            graph[j].add(i)
        for i in neighbors:
            graph[i].remove(variable)
        del graph[variable]
        order.append(variable)
    return order, width


def _eliminate(factors, domains, work: _Work) -> dict:
    """M(separator) = max_x sum(bucket); retain argmax for reverse recovery."""
    if work.solves >= _MAX_DP_SOLVES:
        raise _ComplexityLimit("dp_solve_limit", limit=_MAX_DP_SOLVES)
    work.solves += 1
    if any(not d for d in domains):
        return {"vector": None, "score": None, "trace": [], "elimination_order": [], "induced_width": 0, "max_table_entries": 0}
    fixed = {i: d[0] for i, d in enumerate(domains) if len(d) == 1}
    active = [_condition(f, fixed) for f in factors]
    variables = [i for i in range(len(domains)) if i not in fixed]
    order, width = _min_fill(active, domains, variables)
    trace = []
    backpointers = []
    max_rows = 0
    for variable in order:
        bucket = [f for f in active if variable in f.scope]
        active = [f for f in active if variable not in f.scope]
        separator = tuple(sorted(set().union(*(set(f.scope) for f in bucket)) - {variable}))
        rows = _cardinality(separator, domains)
        assignments = rows * len(domains[variable])
        if rows > _MAX_MESSAGE_ROWS:
            raise _ComplexityLimit("message_table_limit", variable=variable, separator=list(separator), required_rows=rows, limit=_MAX_MESSAGE_ROWS, induced_width=width, elimination_order=order, completed_buckets=len(trace), max_completed_table_entries=max_rows)
        if work.assignments + assignments > _MAX_JOIN_ASSIGNMENTS:
            raise _ComplexityLimit("join_assignment_limit", variable=variable, required_assignments=assignments, used_assignments=work.assignments, limit=_MAX_JOIN_ASSIGNMENTS, induced_width=width, elimination_order=order, completed_buckets=len(trace), max_completed_table_entries=max_rows)
        work.assignments += assignments
        max_rows = max(max_rows, rows)
        work.max_rows = max(work.max_rows, rows)
        union = separator + (variable,)
        projections = [tuple(union.index(i) for i in f.scope) for f in bucket]
        message = {}
        argmax = {}
        for context in product(*(domains[i] for i in separator)):
            best_score, best_value = _NEG_INF, None
            for value in domains[variable]:
                assignment = context + (value,)
                score = 0.0
                for factor, positions in zip(bucket, projections):
                    term = factor.at(tuple(assignment[p] for p in positions))
                    work.lookups += 1
                    if term == _NEG_INF:
                        score = _NEG_INF
                        break
                    score += term
                if best_value is None or score > best_score:
                    best_score, best_value = score, value
            message[context] = best_score
            if best_score != _NEG_INF:
                argmax[context] = best_value
        active.append(_Factor(separator, message, default=_NEG_INF))
        backpointers.append((variable, separator, argmax))
        trace.append({"variable": variable, "bucket_scope": sorted(union), "separator": list(separator), "input_factors": len(bucket), "message_rows": rows, "joint_assignments": assignments, "argmax_rows": len(argmax)})
    total = 0.0
    for factor in active:
        term = factor.at(())
        work.lookups += 1
        if term == _NEG_INF:
            total = _NEG_INF
            break
        total += term
    vector = None
    if total != _NEG_INF:
        assignment = dict(fixed)
        for variable, separator, argmax in reversed(backpointers):
            context = tuple(assignment[i] for i in separator)
            assignment[variable] = argmax[context]
        vector = tuple(assignment[i] for i in range(len(domains)))
    return {"vector": vector, "score": None if vector is None else total, "trace": trace, "elimination_order": order, "conditioned_variables": sorted(fixed), "induced_width": width, "max_table_entries": max_rows}


def solve(problem, *, seed=42, budget=16) -> dict:
    """Optimize declared factors exactly where feasible, then query bounded F.

    Limits bound model work independently of expensive oracle calls.  Hitting
    one stops the exact search; it never triggers mini-bucket factor deletion.
    """
    budget = max(0, int(budget))
    domains = tuple(tuple(int(v) for v in domain) for domain in problem.domains)
    work = _Work()
    factors, factor_counts = _compile(problem, domains)
    diagnostics = {
        "algorithm": "max-sum bucket elimination with argmax traceback and Lawler partitions",
        "seed": seed,
        "query_budget": budget,
        "factor_counts": factor_counts,
        "factors_dropped": 0,
        "limits": {"message_rows": _MAX_MESSAGE_ROWS, "join_assignments": _MAX_JOIN_ASSIGNMENTS, "dp_solves": _MAX_DP_SOLVES},
        "query_policy": "legal initial candidate, then descending-G Lawler candidates with deduplication",
        "queries": 0,
        "candidate_pops": 0,
        "structural_rejections": 0,
        "schedule_rejections": 0,
        "status": "completed",
    }
    proof_scope = (
        "Exact max-sum optimum, when root_dp completes, only for the declared "
        "finite unary + factors model with forbidden tuples and additive resource "
        "capacities. Scheduling is checked on proposals, not optimized as a DP "
        "factor. The returned best_vector is selected only from valid full-oracle "
        "queries; no full-oracle, stochastic, game, or unrestricted-roster optimum "
        "is proved. Complexity limits preserve factors and stop the search."
    )
    seen = set()
    queried = []
    best = None
    stopped = False

    def can_query():
        return not stopped and diagnostics["queries"] < budget and getattr(problem, "remaining", budget) > 0

    def query(vector):
        nonlocal best, stopped
        vector = tuple(vector)
        if vector in seen or not can_query():
            return
        seen.add(vector)
        if not problem.feasible(vector):
            diagnostics["structural_rejections"] += 1
            return
        try:
            schedulable = problem.schedule_feasible(vector)
        except RuntimeError as error:
            # The public finite scheduler raises on UNKNOWN: absence of a
            # witness must not be labelled infeasibility or a zero F score.
            stopped = True
            diagnostics["status"] = "schedule_check_incomplete"
            diagnostics["schedule_check_error"] = {"vector": list(vector), "reason": str(error)}
            return
        if not schedulable:
            diagnostics["schedule_rejections"] += 1
            return
        diagnostics["queries"] += 1
        record = problem.evaluate(vector, fidelity="full", seed=seed)
        queried.append(list(vector))
        if record.get("valid") and record.get("score") is not None and record.get("fidelity", "full") == "full":
            if best is None or record["score"] > best["score"]:
                best = {"vector": list(vector), "score": record["score"]}

    # Preserve the supplied baseline even when only one F call is available.
    # Its validation and full query use the same gates and counted budget as
    # every later DP proposal.  The shared seen set also removes DP duplicates.
    query(problem.initial)
    root = None
    heap = []
    serial = 0
    try:
        root = _eliminate(factors, domains, work)
        diagnostics["root_dp"] = root
        diagnostics["model_optimum_proved"] = True
        if root["vector"] is None:
            diagnostics["status"] = "model_infeasible"
        else:
            heapq.heappush(heap, (-root["score"], root["vector"], serial, domains, 0))
        while heap and can_query():
            _, vector, _, node_domains, prefix = heapq.heappop(heap)
            diagnostics["candidate_pops"] += 1
            query(vector)
            if not can_query():
                break
            # Disjoint children cover this partition except its best vector.
            # Earlier values are fixed; the first differing value is excluded.
            for split in range(prefix, len(domains)):
                alternative = tuple(v for v in node_domains[split] if v != vector[split])
                if not alternative:
                    continue
                child = list(node_domains)
                for i in range(prefix, split):
                    child[i] = (vector[i],)
                child[split] = alternative
                child = tuple(child)
                result = _eliminate(factors, child, work)
                if result["vector"] is not None:
                    serial += 1
                    heapq.heappush(heap, (-result["score"], result["vector"], serial, child, split))
    except _ComplexityLimit as error:
        diagnostics["status"] = "complexity_limit"
        diagnostics["limit_hit"] = error.detail
        diagnostics["model_optimum_proved"] = root is not None
    diagnostics.update({"dp_solves": work.solves, "join_assignment_evaluations": work.assignments, "factor_lookups": work.lookups, "max_table_entries": work.max_rows, "queued_partitions": len(heap), "queried_vectors": queried, "remaining_oracle_budget": getattr(problem, "remaining", None)})
    if not can_query() and diagnostics["status"] == "completed":
        diagnostics["status"] = "oracle_budget_exhausted"
    return {
        "best_vector": None if best is None else best["vector"],
        "best_score": None if best is None else best["score"],
        "model_best_vector": None if root is None or root["vector"] is None else list(root["vector"]),
        "model_best_score": None if root is None else root["score"],
        "diagnostics": diagnostics,
        "proof_scope": proof_scope,
    }
