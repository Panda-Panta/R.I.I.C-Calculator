"""Real OR-Tools CP-SAT over the declared finite structural proxy model.

The solver never enumerates ``problem.vectors`` or reads an unevaluated F score.
Missing sparse factor entries have value zero, as in the public contract.
"""

from __future__ import annotations

import math
from fractions import Fraction


OBJECTIVE_SCALE = 1_000_000
MODEL_TIME_LIMIT_SECONDS = 8.0
SAFE_INTEGER = (1 << 53) - 1
TIE_BUFFER_LIMIT = 10_000
PROOF_SCOPE = (
    "Declared finite unary+factor proxy with forbidden tuples and resource "
    "capacities only; CP-SAT optimality concerns the scaled proxy, never native "
    "F, long-term game income, or an unencoded scheduling model."
)


def _upper_float(value):
    """Round a rational bound upward, including accumulated conversion error."""
    converted = float(value)
    return math.nextafter(converted, math.inf) if Fraction.from_float(converted) < value else converted


def _number(value, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number")
    if not math.isfinite(value):
        raise ValueError(f"{label} must be finite")
    return value


def _scope(value, domains, label):
    if not isinstance(value, (list, tuple)):
        raise ValueError(f"{label} must be a variable-index list")
    result = list(value)
    if any(type(index) is not int or not 0 <= index < len(domains) for index in result):
        raise ValueError(f"{label} contains an undeclared variable")
    return result


def _values(value, scope, domains, label):
    if not isinstance(value, (list, tuple)) or len(value) != len(scope):
        raise ValueError(f"{label} has the wrong arity")
    result = list(value)
    if any(type(v) is not int or not 0 <= v < domains[i] for i, v in zip(scope, result)):
        raise ValueError(f"{label} contains an out-of-domain value")
    return result


def _build_model(spec, cp_model):
    domains = spec.get("domains")
    if not isinstance(domains, (list, tuple)) or any(type(d) is not int or d < 1 for d in domains):
        raise ValueError("domains must contain positive integer sizes")
    domains = list(domains)
    unary = spec.get("unary")
    if not isinstance(unary, (list, tuple)) or len(unary) != len(domains):
        raise ValueError("unary must have one row per variable")

    model = cp_model.CpModel()
    variables, choices, objective_terms = [], [], []
    coefficient_abs_sum = 0
    rounding_error = Fraction(0)
    for i, (size, values) in enumerate(zip(domains, unary)):
        if not isinstance(values, (list, tuple)) or len(values) != size:
            raise ValueError(f"unary[{i}] does not match the domain")
        variable = model.new_int_var(0, size - 1, f"x_{i}")
        literals = [model.new_bool_var(f"x_{i}_is_{v}") for v in range(size)]
        model.add_exactly_one(literals)
        model.add(variable == sum(v * literal for v, literal in enumerate(literals)))
        errors = []
        for v, raw in enumerate(values):
            raw = _number(raw, f"unary[{i}][{v}]")
            coefficient = round(raw * OBJECTIVE_SCALE)
            objective_terms.append(coefficient * literals[v])
            coefficient_abs_sum += abs(coefficient)
            errors.append(abs(Fraction(str(raw)) - Fraction(coefficient, OBJECTIVE_SCALE)))
        rounding_error += max(errors, default=Fraction(0))
        variables.append(variable)
        choices.append(literals)

    factor_count = 0
    factor_rows = 0
    for f, factor in enumerate(spec.get("factors", [])):
        scope = _scope(factor.get("vars"), domains, f"factor[{f}].vars")
        table = factor.get("table")
        if not isinstance(table, dict):
            raise ValueError(f"factor[{f}].table must be a sparse mapping")
        errors = [Fraction(0)]
        seen_assignments = set()
        for key, raw in table.items():
            if not isinstance(key, str):
                raise ValueError(f"factor[{f}] keys must be comma-separated strings")
            try:
                values = [int(part) for part in key.split(",")] if key else []
            except ValueError as error:
                raise ValueError(f"factor[{f}] has a malformed table key") from error
            values = _values(values, scope, domains, f"factor[{f}].values")
            assignment = tuple(values)
            if assignment in seen_assignments:
                raise ValueError(f"factor[{f}] has duplicate canonical table assignments")
            seen_assignments.add(assignment)
            raw = _number(raw, f"factor[{f}][{key}]")
            coefficient = round(raw * OBJECTIVE_SCALE)
            errors.append(abs(Fraction(str(raw)) - Fraction(coefficient, OBJECTIVE_SCALE)))
            # A repeated variable with conflicting values can never match cheap().
            if any(values[a] != values[b] for a in range(len(scope)) for b in range(a) if scope[a] == scope[b]):
                continue
            factor_rows += 1
            if not scope:
                objective_terms.append(coefficient)
            elif coefficient:
                row_match = model.new_bool_var(f"factor_{f}_row_{factor_rows}")
                required = [choices[i][v] for i, v in zip(scope, values)]
                for literal in required:
                    model.add_implication(row_match, literal)
                model.add_bool_or([row_match] + [literal.Not() for literal in required])
                objective_terms.append(coefficient * row_match)
            coefficient_abs_sum += abs(coefficient)
        rounding_error += max(errors)
        factor_count += 1

    for f, forbidden in enumerate(spec.get("forbidden", [])):
        scope = _scope(forbidden.get("vars"), domains, f"forbidden[{f}].vars")
        values = _values(forbidden.get("values"), scope, domains, f"forbidden[{f}].values")
        model.add_bool_or([choices[i][v].Not() for i, v in zip(scope, values)])

    resource_scales = []
    for r, resource in enumerate(spec.get("resources", [])):
        capacity = Fraction(str(_number(resource.get("capacity"), f"resource[{r}].capacity")))
        usage = resource.get("usage")
        if not isinstance(usage, (list, tuple)) or len(usage) != len(domains):
            raise ValueError(f"resource[{r}].usage has the wrong variable count")
        rows, scale = [], capacity.denominator
        for i, (size, values) in enumerate(zip(domains, usage)):
            if not isinstance(values, (list, tuple)) or len(values) != size:
                raise ValueError(f"resource[{r}].usage[{i}] has the wrong domain size")
            row = [Fraction(str(_number(v, f"resource[{r}].usage[{i}]"))) for v in values]
            for value in row:
                scale = math.lcm(scale, value.denominator)
            rows.append(row)
        rhs = int(capacity * scale)
        coefficients = [[int(value * scale) for value in row] for row in rows]
        if abs(rhs) + sum(abs(v) for row in coefficients for v in row) > SAFE_INTEGER:
            raise ValueError(f"resource[{r}] exact integer scaling exceeds the supported safe range")
        terms = [value * choices[i][v] for i, row in enumerate(coefficients) for v, value in enumerate(row)]
        model.add(sum(terms) <= rhs)
        resource_scales.append({"name": resource.get("name", str(r)), "scale": scale, "rounding": "none; exact decimal coefficients"})

    if coefficient_abs_sum > SAFE_INTEGER:
        raise ValueError("scaled objective exceeds the supported safe integer range")
    objective_expression = sum(objective_terms)
    model.maximize(objective_expression)
    initial = spec.get("initial", [])
    if isinstance(initial, (list, tuple)) and len(initial) == len(domains) and all(type(v) is int and 0 <= v < domains[i] for i, v in enumerate(initial)):
        for variable, value in zip(variables, initial):
            model.add_hint(variable, value)
    # The error is computed from decimal input values; one unary and at most one
    # sparse table entry contribute per variable/factor in any complete vector.
    error_bound = _upper_float(rounding_error)
    return model, variables, choices, {
        "objective_scale": OBJECTIVE_SCALE,
        "objective_abs_error_bound": error_bound,
        "optimal_scaled_solution_proxy_regret_bound": _upper_float(2 * rounding_error),
        "objective_error_reference": "exact sum of input decimal coefficients",
        "resource_scaling": resource_scales,
        "variables": len(variables),
        "one_hot_literals": sum(domains),
        "factor_count": factor_count,
        "factor_table_rows": factor_rows,
        "missing_factor_entries": "zero",
    }, objective_expression


def _scaled_proxy(spec, vector):
    """The same integer coefficients as CP, using public G inputs only."""
    total = sum(round(spec["unary"][i][v] * OBJECTIVE_SCALE) for i, v in enumerate(vector))
    for factor in spec.get("factors", []):
        key = ",".join(str(vector[i]) for i in factor["vars"])
        total += round(factor["table"].get(key, 0) * OBJECTIVE_SCALE)
    return total


def _has_equal_neighbor(problem, vector, generated, objective):
    """Avoid a satisfaction solve for a G tier with no observed local tie.

    This checks only single-coordinate public-G neighbors, not a full product
    or any F labels. CP-SAT still constructs and certifies the actual pool.
    """
    for i, domain in enumerate(problem.domains):
        for value in domain:
            if value == vector[i]:
                continue
            neighbor = vector[:i] + (value,) + vector[i + 1:]
            if neighbor not in generated and problem.feasible(neighbor) and _scaled_proxy(problem.spec, neighbor) == objective:
                return True
    return False


def solve(problem, *, seed=42, budget=16):
    diagnostics = []
    result = {
        "best_vector": None,
        "diagnostics": diagnostics,
        "proof_scope": PROOF_SCOPE,
        "algorithm": "OR-Tools CP-SAT",
        "model_solutions": [],
        "model_best_vector": None,
        "model_optimality_proven": False,
        "evaluations": 0,
        "query_curve": [],
        "optimization_solves": 0,
        "tie_enumeration_solves": 0,
        "tie_batches": [],
        "pool_policy": "descending scaled G; max-min Hamming ordering within CP-certified exact-G ties",
    }
    if type(budget) is not int or budget < 0:
        diagnostics.append("invalid_budget: budget must be a nonnegative integer")
        return result
    try:
        import ortools
        from ortools.sat.python import cp_model
    except ImportError as error:
        diagnostics.append(f"dependency_unavailable: real OR-Tools CP-SAT is required: {error}")
        return result
    result["solver_version"] = ortools.__version__
    try:
        model, variables, choices, metadata, objective_expression = _build_model(problem.spec, cp_model)
    except (ValueError, TypeError, KeyError, OverflowError) as error:
        diagnostics.append(f"invalid_model_input: {error}")
        return result
    result.update(metadata)
    max_evaluations = min(budget, max(0, int(problem.remaining)))
    if not max_evaluations:
        diagnostics.append("query_budget_exhausted: no new F evaluation requested")
        previous = problem.best()
        result["best_vector"] = list(previous["vector"]) if previous else None
        return result

    # Keep the real starting solution available to F. It supplies no model bound.
    queried = {}
    generated = set()
    enumeration_complete = False
    contract_mismatch = False

    def evaluate(vector):
        evaluation = problem.evaluate(vector, fidelity="full", seed=seed)
        queried[vector] = evaluation
        result["evaluations"] += 1
        best = problem.best()
        result["query_curve"].append({
            "query": result["evaluations"], "vector": list(vector),
            "proxy_objective": float(problem.cheap(vector)),
            "valid": bool(evaluation.get("valid")), "F": evaluation.get("score"),
            "best_F_so_far": best["score"] if best else None,
        })
        return evaluation

    initial = tuple(problem.initial)
    if problem.feasible(initial):
        evaluate(initial)

    class TieCollector(cp_model.CpSolverSolutionCallback):
        def __init__(self, quota):
            super().__init__()
            self.quota = quota
            self.vectors = set()
            self.new_queries = 0
            self.limit_hit = None

        def on_solution_callback(self):
            vector = tuple(self.value(variable) for variable in variables)
            if vector not in self.vectors:
                self.vectors.add(vector)
                self.new_queries += vector not in queried
            if self.new_queries >= self.quota:
                self.limit_hit = "query_quota"
                self.stop_search()
            elif len(self.vectors) >= TIE_BUFFER_LIMIT:
                self.limit_hit = "tie_buffer_limit"
                self.stop_search()

    solver_seconds = 0.0
    first_solve = True
    # An initial evaluation may consume the budget, but the first actual solve
    # still records the proxy optimum/bound. It never consumes an extra F query.
    while first_solve or (result["evaluations"] < max_evaluations and problem.remaining > 0):
        remaining_time = MODEL_TIME_LIMIT_SECONDS - solver_seconds
        if remaining_time <= 0:
            diagnostics.append("model_time_limit: retained all checked model/F results")
            break
        solver = cp_model.CpSolver()
        solver.parameters.num_search_workers = 1
        solver.parameters.random_seed = int(seed) & 0x7FFFFFFF
        solver.parameters.max_time_in_seconds = remaining_time
        status = solver.solve(model)
        result["optimization_solves"] += 1
        solver_seconds += solver.wall_time
        status_name = solver.status_name(status)
        record = {
            "status": status_name,
            "wall_time_seconds": solver.wall_time,
            "branches": solver.num_branches,
            "conflicts": solver.num_conflicts,
        }
        if first_solve:
            result["model_status"] = status_name
            result["model_optimality_proven"] = status == cp_model.OPTIMAL
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            result["terminal_model_status"] = status_name
            enumeration_complete = status == cp_model.INFEASIBLE
            if first_solve:
                result["first_solve_statistics"] = record
            if status in (cp_model.UNKNOWN, cp_model.MODEL_INVALID):
                diagnostics.append(f"solver_{status_name.lower()}: no infeasibility or optimality inferred")
            break

        vector = tuple(solver.value(variable) for variable in variables)
        generated.add(vector)
        record.update({
            "vector": list(vector),
            "scaled_objective": int(round(solver.objective_value)),
            "scaled_best_bound": solver.best_objective_bound,
            "proxy_objective": float(problem.cheap(vector)),
        })
        if first_solve:
            result["model_best_vector"] = list(vector)
            result["model_proxy_objective"] = record["proxy_objective"]
            result["model_scaled_objective"] = record["scaled_objective"]
            result["model_scaled_best_bound"] = record["scaled_best_bound"]
            result["model_scaled_absolute_gap"] = max(0, solver.best_objective_bound - record["scaled_objective"])
            result["model_proxy_upper_bound"] = _upper_float(Fraction(str(solver.best_objective_bound)) / OBJECTIVE_SCALE + Fraction.from_float(metadata["objective_abs_error_bound"]))
        first_solve = False
        if not problem.feasible(vector):
            diagnostics.append("model_contract_mismatch: CP vector rejected by public structural constraints")
            result["model_optimality_proven"] = False
            contract_mismatch = True
            result["model_solutions"].append(record)
            break
        record["structural_feasible"] = True
        result["model_solutions"].append(record)
        if vector not in queried and result["evaluations"] < max_evaluations and problem.remaining > 0:
            evaluation = evaluate(vector)
            record["evaluation_valid"] = bool(evaluation.get("valid"))
            record["evaluation_score"] = evaluation.get("score")
        # Exact vector no-good obtains a new model solution. This is model pool
        # enumeration by CP-SAT, not exhaustive F enumeration or a Benders cut.
        model.add_bool_or([choices[i][value].Not() for i, value in enumerate(vector)])

        # Exact G ties contain useful structural alternatives (for example a
        # recovery choice may not change a static projection). Enumerating a
        # witnessed tier once avoids re-optimizing G for every tied assignment.
        # A public-G single-coordinate check avoids this extra solve on unique
        # tiers. No F value, scene id, or operator identity enters the decision.
        quota = min(max_evaluations - result["evaluations"], int(problem.remaining))
        if status == cp_model.OPTIMAL and quota > 0 and _has_equal_neighbor(problem, vector, generated, record["scaled_objective"]):
            remaining_time = MODEL_TIME_LIMIT_SECONDS - solver_seconds
            if remaining_time <= 0:
                continue
            tier = model.clone()
            tier.clear_objective()
            tier.add(objective_expression == record["scaled_objective"])
            collector = TieCollector(quota)
            tier_solver = cp_model.CpSolver()
            tier_solver.parameters.num_search_workers = 1
            tier_solver.parameters.random_seed = int(seed) & 0x7FFFFFFF
            tier_solver.parameters.max_time_in_seconds = remaining_time
            tier_solver.parameters.enumerate_all_solutions = True
            tier_status = tier_solver.solve(tier, collector)
            solver_seconds += tier_solver.wall_time
            result["tie_enumeration_solves"] += 1
            batch = {
                "scaled_G": record["scaled_objective"], "status": tier_solver.status_name(tier_status),
                "solver_mode": "satisfaction enumeration at a previously proved optimal G tier",
                "vectors": len(collector.vectors), "limit_hit": collector.limit_hit,
                "wall_time_seconds": tier_solver.wall_time,
                "branches": tier_solver.num_branches, "conflicts": tier_solver.num_conflicts,
            }
            result["tie_batches"].append(batch)
            pending = set(collector.vectors)
            while pending:
                anchors = list(queried) or [initial]
                tied = min(pending, key=lambda candidate: (
                    -min(sum(a != b for a, b in zip(candidate, anchor)) for anchor in anchors), candidate))
                pending.remove(tied)
                if tied in generated:
                    continue
                if not problem.feasible(tied):
                    diagnostics.append("model_contract_mismatch: CP tie witness rejected by public constraints")
                    contract_mismatch = True
                    result["model_optimality_proven"] = False
                    break
                generated.add(tied)
                tied_record = {
                    "status": tier_solver.status_name(tier_status),
                    "solver_mode": "fixed-G satisfaction witness",
                    "tie_batch": len(result["tie_batches"]), "vector": list(tied),
                    "scaled_objective": record["scaled_objective"],
                    "proxy_objective": float(problem.cheap(tied)), "structural_feasible": True,
                }
                result["model_solutions"].append(tied_record)
                if tied not in queried and result["evaluations"] < max_evaluations and problem.remaining > 0:
                    evaluation = evaluate(tied)
                    tied_record["evaluation_valid"] = bool(evaluation.get("valid"))
                    tied_record["evaluation_score"] = evaluation.get("score")
                model.add_bool_or([choices[i][value].Not() for i, value in enumerate(tied)])
            if contract_mismatch:
                break

    best = problem.best()
    result["best_vector"] = list(best["vector"]) if best else None
    if best:
        result["best_score"] = best["score"]
    result["query_count"] = result["evaluations"]
    result["total_solver_wall_time_seconds"] = solver_seconds
    result["total_solver_calls"] = result["optimization_solves"] + result["tie_enumeration_solves"]
    full_valid = {
        vector for vector, row in queried.items()
        if row.get("valid") and row.get("fidelity", "full") == "full"
        and isinstance(row.get("score"), (int, float)) and math.isfinite(row["score"])
    }
    all_evaluated = enumeration_complete and generated <= set(queried)
    result["finite_F_certificate"] = {
        "model_enumeration_complete": enumeration_complete,
        "structural_model_size": len(generated) if enumeration_complete else None,
        "distinct_generated_vectors": len(generated), "distinct_full_queries": len(queried),
        "all_model_vectors_full_evaluated": all_evaluated,
        "all_model_vectors_valid_full": enumeration_complete and generated <= full_valid,
        "best_fixed_seed_F_over_declared_domain_proven": bool(
            enumeration_complete and generated and generated <= full_valid and not contract_mismatch),
        "seed": seed,
        "scope": "Separate exhaustive CP-generated-domain/full-oracle coverage certificate at this seed and declared simulation window; never an unrestricted roster, expected-income, or game/device optimum.",
    }
    return result
