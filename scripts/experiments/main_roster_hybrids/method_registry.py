"""Read-only adapters for the fifteen actual legacy solvers and two new hybrids.

No native engine or private cache is imported here. Configure the old source with
--legacy-root in the harness, or RIIC_ROSTER_METHODS_ROOT; run Python with -B.
Every arm receives one fresh common.Problem. Native solves own the first,
charged incumbent query; this module never pre-evaluates or supplies F labels.
"""
from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
import copy
import hashlib
import importlib.util
import itertools
import json
import math
import os
from pathlib import Path
import sys
import time
from typing import Any, Callable


REGISTRY_SCHEMA_VERSION = 1
LEGACY_ENV = "RIIC_ROSTER_METHODS_ROOT"
MAX_DECLARED_VECTORS = 128
sys.dont_write_bytecode = True
_MODULES: dict[tuple[str, str], Any] = {}


@dataclass(frozen=True)
class MethodDefinition:
    identifier: str
    legacy_module: str | None = None
    hybrid_entry: str | None = None
    dependencies: tuple[str, ...] = ()


_OLD_MODULES = (
    "m01_pool", "m02_alns", "m03_cpsat", "m04_colgen", "m05_benders",
    "m06_factor_dp", "m07_bayes", "m08_multifidelity", "m09_ranking",
    "m10_renewal", "m11_cross_entropy", "m12_annealing", "m13_pareto",
    "m14_mcts", "m15_gnn_rl",
)
_DEPENDENCIES = {"m03_cpsat": ("ortools",), "m04_colgen": ("numpy", "scipy"),
                 "m07_bayes": ("numpy", "scipy"), "m15_gnn_rl": ("torch",)}
METHOD_REGISTRY = {name: MethodDefinition(name, legacy_module=name,
                                        dependencies=_DEPENDENCIES.get(name, ()))
                   for name in _OLD_MODULES}
METHOD_REGISTRY.update({
    "g_baseline": MethodDefinition("g_baseline"),
    "alns_cp": MethodDefinition("alns_cp", hybrid_entry="solve_cp", dependencies=("ortools",)),
    "alns_factor_dp": MethodDefinition("alns_factor_dp", hybrid_entry="solve_factor_dp"),
})
_ALIASES = {f"{i:02}": name for i, name in enumerate(_OLD_MODULES, 1)}
_ALIASES.update({"alns_dp": "alns_factor_dp", "simple_g": "g_baseline"})


def canonical_method_id(name: str) -> str:
    identifier = _ALIASES.get(name, name)
    if identifier not in METHOD_REGISTRY:
        raise ValueError(f"Unknown method {name!r}; choose one of {', '.join(METHOD_REGISTRY)}")
    return identifier


def resolve_legacy_root(legacy_root: str | Path | None = None) -> Path:
    value = legacy_root if legacy_root is not None else os.environ.get(LEGACY_ENV)
    if not value:
        raise ValueError(f"Pass --legacy-root or set {LEGACY_ENV}; no implicit source checkout is used")
    root = Path(value).expanduser().resolve()
    if not (root / "common.py").is_file() or not (root / "methods").is_dir():
        raise ValueError(f"Not a legacy roster_methods source root: {root}")
    return root


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_file(path: Path):
    path = path.resolve()
    digest = _sha(path)
    key = (str(path), digest)
    if key not in _MODULES:
        # Register before exec: dataclasses resolves its defining module here.
        name = "_riic_hybrid_source_" + hashlib.sha256(str(path).encode()).hexdigest()[:16] + "_" + digest[:12]
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise ImportError(f"Cannot import {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        try:
            sys.dont_write_bytecode = True
            spec.loader.exec_module(module)
        except BaseException:
            sys.modules.pop(name, None)
            raise
        _MODULES[key] = module
    return _MODULES[key]


def load_legacy_common(legacy_root: str | Path | None = None):
    """Load the actual old common.py, with no copy or legacy pycache writes."""
    return _load_file(resolve_legacy_root(legacy_root) / "common.py")


@contextmanager
def _legacy_environment(root: Path):
    previous = os.environ.get(LEGACY_ENV)
    os.environ[LEGACY_ENV] = str(root)
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop(LEGACY_ENV, None)
        else:
            os.environ[LEGACY_ENV] = previous


def _g_baseline(problem, *, seed=42, budget=2):
    """Explicit simple-G baseline, never advertised as one of the 15 solvers."""
    queried = set()
    if budget and problem.remaining and problem.schedule_feasible(problem.initial):
        problem.evaluate(problem.initial, fidelity="full", seed=seed)
        queried.add(tuple(problem.initial))
    ordered = sorted((tuple(v) for v in problem.vectors() if problem.schedule_feasible(v)),
                     key=lambda vector: (-problem.cheap(vector), vector))
    for vector in ordered:
        if len(problem.history) >= budget or problem.remaining <= 0:
            break
        if vector not in queried:
            problem.evaluate(vector, fidelity="full", seed=seed)
            queried.add(vector)
    best = problem.best()
    return {"best_vector": best["vector"] if best else None,
            "best_score": best["score"] if best else None,
            "diagnostics": {"algorithm": "explicit_public_G_baseline", "public_candidates": len(ordered)},
            "proof_scope": "Sorts only the declared public G; chooses only queried valid full F. No F optimality proof."}


def _load_implementation(definition: MethodDefinition, root: Path) -> tuple[Callable, dict]:
    if definition.identifier == "g_baseline":
        return _g_baseline, {"path": str(Path(__file__).resolve()), "sha256": _sha(Path(__file__)), "entry_point": "_g_baseline"}
    for dependency in definition.dependencies:
        if importlib.util.find_spec(dependency) is None:
            raise ImportError(f"Required dependency unavailable in {sys.executable}: {dependency}")
    if definition.legacy_module:
        path = root / "methods" / (definition.legacy_module + ".py")
        entry = "solve"
    else:
        path = Path(__file__).resolve().parent / "strategies" / "alns_hybrids.py"
        entry = definition.hybrid_entry
    module = _load_file(path)
    solve = getattr(module, entry)
    return solve, {"path": str(path), "sha256": _sha(path), "entry_point": entry}


def _finite(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _public_model_error(problem) -> str | None:
    """Check G representation only, never request materializations or native F."""
    spec = problem.spec
    sizes = spec.get("domains", [])
    if not sizes or any(type(size) is not int or size <= 0 for size in sizes):
        return "invalid_domains"
    if math.prod(sizes) > MAX_DECLARED_VECTORS:
        return "declared_domain_above_128_vector_contract"
    initial = spec.get("initial", [])
    if len(initial) != len(sizes) or any(type(v) is not int or v < 0 or v >= sizes[i] for i, v in enumerate(initial)):
        return "invalid_initial"
    if tuple(initial) != tuple(problem.initial):
        return "problem_initial_differs_from_public_spec"
    unary = spec.get("unary", [[0] * size for size in sizes])
    if len(unary) != len(sizes) or any(len(row) != sizes[i] or not all(_finite(value) for value in row) for i, row in enumerate(unary)):
        return "unknown_or_invalid_unary_G"
    for factor in spec.get("factors", []):
        scope, table = factor.get("vars"), factor.get("table")
        if not isinstance(scope, list) or len(set(scope)) != len(scope) or any(type(i) is not int or i < 0 or i >= len(sizes) for i in scope):
            return "invalid_factor_scope"
        if not isinstance(table, dict) or any(not _finite(value) for value in table.values()):
            return "unknown_or_nonfinite_factor_G"
        for key in table:
            try:
                values = [] if key == "" else [int(v) for v in key.split(",")]
            except (AttributeError, ValueError):
                return "invalid_factor_key"
            if key != ",".join(map(str, values)) or len(values) != len(scope) or any(v < 0 or v >= sizes[i] for i, v in zip(scope, values)):
                return "invalid_factor_key"
    dense = problem.metadata.get("modelKind") == "fully-measured-high-order-table"
    if dense and (len(spec.get("factors", [])) != 1 or spec["factors"][0]["vars"] != list(range(len(sizes)))):
        return "declared_complete_G_requires_one_full_scope_factor"
    for vector in itertools.product(*(range(size) for size in sizes)):
        if problem.feasible(vector):
            if dense and ",".join(map(str, vector)) not in spec["factors"][0]["table"]:
                return "missing_measured_G_for_public_feasible_vector"
            if not _finite(problem.cheap(vector)):
                return "feasible_vector_has_unknown_G"
    return None


def _preflight(definition, problem, budget, seed):
    if type(budget) is not int or budget < 0 or type(seed) is not int:
        return "invalid_budget_or_seed"
    if problem.history:
        return "nonempty_arm_history_cannot_be_imported_as_free_training_data"
    if problem.metadata.get("initialStatus", "ready") != "ready":
        return "incumbent_initial_G_is_rejected_or_unknown"
    error = _public_model_error(problem)
    if error:
        return error
    protocol = problem.metadata.get("evaluation_protocol", {})
    if protocol.get("kind") == "native" and (seed != 42 or protocol.get("fixed_seed", 42) != 42):
        return "search_seed_conflicts_with_fixed_native_protocol"
    if definition.identifier == "m09_ranking" and protocol.get("kind") == "native":
        return "ocba_replication_seeds_conflict_with_fixed_native_seed_42"
    if definition.identifier == "m10_renewal" and not problem.metadata.get("renewal"):
        return "missing_real_renewal_cycle_metadata"
    if definition.identifier == "m13_pareto" and protocol.get("kind") == "native":
        measured = set(protocol.get("metrics", []))
        if len(measured & {"exp", "order_lmd", "gold", "change_cost"}) < 2:
            return "pareto_requires_two_declared_measured_metrics"
    if not problem.feasible(problem.initial) or not problem.schedule_feasible(problem.initial):
        return "initial_incumbent_not_admissible_in_public_model"
    return None


def _capability(identifier: str, raw: dict, problem) -> dict:
    diagnostics = raw.get("diagnostics", {})
    diagnostics = diagnostics if isinstance(diagnostics, dict) else {}
    limits = []
    if identifier == "m05_benders" and not problem.spec.get("scheduling"):
        limits.append("missing_scheduling_metadata")
    if identifier == "m07_bayes" and not diagnostics.get("model_updates"):
        limits.append("GP_acquisition_not_exercised_at_this_budget")
    if identifier == "m08_multifidelity" and not any(row.get("fidelity") == "short" for row in problem.history):
        limits.append("full_only_no_successive_halving_round")
    if identifier == "m09_ranking" and diagnostics.get("comparison_status") == "insufficient_budget_for_replicated_comparison":
        limits.append("OCBA_replicated_comparison_not_exercised")
    if identifier == "m15_gnn_rl":
        if not diagnostics.get("training", {}).get("optimizer_updates", 0):
            limits.append("GNN_policy_not_trained_at_this_budget")
        limits.append("same_scene_online_training_no_holdout_or_generalization_evidence")
    if identifier == "m13_pareto" and not diagnostics.get("generations", 0):
        limits.append("NSGA_parent_child_generation_not_exercised")
    if identifier == "m14_mcts" and not diagnostics.get("expansion_steps", 0):
        limits.append("MCTS_tree_expansion_not_exercised")
    if identifier == "m02_alns" and not diagnostics.get("weight_updates"):
        limits.append("ALNS_adaptive_weight_update_not_exercised")
    mechanism_limits = [entry for entry in limits if entry != "same_scene_online_training_no_holdout_or_generalization_evidence"]
    return {"level": "supported_reduced" if mechanism_limits else "supported_full", "limitations": limits}


def _unsupported(identifier, reason):
    return {"method_id": identifier, "status": "unsupported", "best_vector": None, "best_score": None,
            "diagnostics": [reason], "proof_scope": "Unsupported for these declared inputs; no method/F execution was claimed.",
            "registry": {"schema_version": REGISTRY_SCHEMA_VERSION,
                         "capability": {"level": "unsupported", "limitations": [reason]},
                         "budget": {"logical_queries": 0, "full": 0, "short": 0, "cheap": 0}}}


def run_method(name: str, problem, *, seed=42, budget=2, legacy_root=None, options=None) -> dict:
    """Run one actual solve with one shared Problem/history and a hard query cap.

    ``options`` is reserved for explicit registry settings; method tuning belongs
    in public spec.metadata and is therefore included in the input digest.
    """
    identifier = canonical_method_id(name)
    if options:
        return _unsupported(identifier, "unknown_registry_options_put_method_configuration_in_public_metadata")
    definition = METHOD_REGISTRY[identifier]
    try:
        root = resolve_legacy_root(legacy_root)
        error = _preflight(definition, problem, budget, seed)
        if error:
            return _unsupported(identifier, error)
        with _legacy_environment(root):
            solve, implementation = _load_implementation(definition, root)
    except (ImportError, OSError, AttributeError, ValueError, TypeError, RuntimeError) as error:
        return _unsupported(identifier, f"{type(error).__name__}: {error}")

    # Keep the actual common.Problem identity; no proxy, copied history, hidden
    # incumbent label, evaluator introspection or private-cache access is used.
    original_budget, original_evaluate = problem.budget, problem.evaluate
    had_evaluate = "evaluate" in vars(problem)
    saved_evaluate = vars(problem).get("evaluate")
    problem.budget = min(original_budget, budget)
    protocol = problem.metadata.get("evaluation_protocol", {})
    violations: list[str] = []
    invocations = 0

    def guarded_evaluate(vector, fidelity="full", seed=None):
        nonlocal invocations
        invocations += 1
        if len(problem.history) >= budget or problem.remaining <= 0:
            violations.append("evaluate_after_logical_budget_exhausted")
            return {"vector": list(vector), "valid": False, "score": None, "metrics": {}, "fidelity": fidelity,
                    "seed": seed, "counted": False, "reason": "budget-exhausted"}
        actual_seed = problem.default_seed if seed is None else seed
        reason = None
        if protocol.get("kind") == "native" and not problem.history and (tuple(vector) != tuple(problem.initial) or fidelity != "full"):
            reason = "first_query_must_be_the_full_incumbent"
        if protocol.get("kind") == "native" and actual_seed != 42:
            reason = "unsupported-seed"
        if fidelity == "short" and protocol.get("short_supported") is False:
            reason = "unsupported-short-fidelity"
        if reason:
            violations.append(reason)
            row = {"vector": list(vector), "valid": False, "score": None, "metrics": {}, "fidelity": fidelity,
                   "seed": actual_seed, "counted": True, "query_index": len(problem.history), "elapsed_ms": 0,
                   "reason": reason, "physical_evaluation_requested": False}
            problem.history.append(row)
            return copy.deepcopy(row)
        return original_evaluate(vector, fidelity=fidelity, seed=actual_seed)

    problem.evaluate = guarded_evaluate
    started = time.perf_counter()
    try:
        with _legacy_environment(root):
            raw = solve(problem, seed=seed, budget=budget)
        if not isinstance(raw, dict):
            raise TypeError("solve must return a dict")
    except Exception as error:
        raw = {"best_vector": None, "diagnostics": [f"{type(error).__name__}: {error}"],
               "proof_scope": "Solver failed; preserve charged query evidence without inventing an incumbent."}
        violations.append("solver_execution_failed")
    finally:
        problem.budget = original_budget
        if had_evaluate:
            problem.evaluate = saved_evaluate
        else:
            del problem.evaluate
    elapsed_ms = (time.perf_counter() - started) * 1000

    rows = problem.history
    candidate = raw.get("best_vector")
    selected = [row for row in rows if row.get("valid") and row.get("fidelity") == "full" and
                _finite(row.get("score")) and row.get("vector") == candidate]
    best_record = max(selected, key=lambda row: row["score"], default=None)
    if candidate is not None and best_record is None:
        violations.append("reported_winner_has_no_queried_valid_full_record")
    capability = _capability(identifier, raw, problem)
    if budget > 0 and not rows:
        # A legacy solve can explicitly decline an unsupported model. Merely
        # importing it is not evidence that its optimization/F mechanism ran.
        capability = {"level": "unsupported", "limitations": ["solver_made_no_charged_query"]}
    counts = Counter(row.get("fidelity") for row in rows)
    identities = [(tuple(row["vector"]), row.get("fidelity"), row.get("seed")) for row in rows]
    budget_evidence = {"requested": budget, "logical_queries": len(rows), "evaluate_invocations": invocations,
                      "full": counts["full"], "short": counts["short"], "cheap": counts["cheap"],
                      "initial_queries": sum(tuple(row["vector"]) == tuple(problem.initial) for row in rows),
                      "duplicates": len(identities) - len(set(identities)),
                      "cache_hits": sum(bool(row.get("shared_cache_hit") or row.get("cache_hit")) for row in rows),
                      "violations": violations,
                      "unit": "each evaluate invocation, including initial/cached/duplicate/short; direct public G is separate"}
    public_hash = hashlib.sha256(json.dumps(problem.spec, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    result = {**raw, "method_id": identifier, "status": "protocol_error" if violations else capability["level"],
              "best_vector": list(best_record["vector"]) if best_record else None,
              "best_score": best_record["score"] if best_record else None,
              "best_full_record": copy.deepcopy(best_record),
              "registry": {"schema_version": REGISTRY_SCHEMA_VERSION, "implementation": implementation,
                           "legacy_common": {"path": str(root / "common.py"), "sha256": _sha(root / "common.py")},
                           "capability": capability, "budget": budget_evidence, "solve_elapsed_ms": elapsed_ms,
                           "public_spec_sha256": public_hash}}
    if identifier == "m15_gnn_rl":
        diagnostics = raw.get("diagnostics", {})
        diagnostics = diagnostics if isinstance(diagnostics, dict) else {}
        training = diagnostics.get("training", {})
        frozen = diagnostics.get("frozen_validation", {})
        deployment = diagnostics.get("public_G_pool", {})
        result["registry"]["training_input"] = {
            "domain_schema_version": protocol.get("domain_schema_version", 1), "public_spec_sha256": public_hash,
            "scene_id": problem.scene_id, "legacy_implementation_sha256": implementation.get("sha256"),
            "algorithm_revision": training.get("algorithm_revision"),
            "checkpoint_digest": training.get("checkpoint_digest"),
            "training_scene_ids": training.get("training_scene_ids", []),
            "scope": "same public scene and charged current-arm queries only; no holdout or hidden labels",
        }
        result["registry"]["training_cost"] = {
            "charged_full_training_queries": training.get("query_count", 0),
            "optimizer_updates": training.get("optimizer_updates", 0),
            "frozen_validation_queries": frozen.get("query_count", 0),
            "public_G_deployment_queries": deployment.get("query_count", 0),
            "separate_training_wall_ms": None,
            "time_scope": "solve_elapsed_ms includes graph construction/training/deployment; no separate phase clock was measured",
        }
    return result


def get_method(name: str, *, legacy_root=None, options=None) -> Callable:
    """Return the uniform solve(problem, *, seed, budget) dispatch function."""
    identifier = canonical_method_id(name)
    def solve(problem, *, seed=42, budget=2):
        return run_method(identifier, problem, seed=seed, budget=budget, legacy_root=legacy_root, options=options)
    solve.__name__ = identifier
    return solve
