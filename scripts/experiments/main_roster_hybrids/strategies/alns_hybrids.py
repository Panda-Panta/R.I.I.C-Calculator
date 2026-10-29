"""G-pool + actual ALNS/SA/CE operations + fixed-neighborhood exact repair.

One caller-owned Problem and one query ledger cover every fidelity and cache hit.
Legacy solves are never stacked. All repair/G work is proposal-only, not native F.
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.util
import math
import os
from pathlib import Path
import random
import sys


_LEGACY = {}
_REPAIR_POOL_CAP = 4
_CP_SEARCH_SECONDS = 8.0


def _legacy(name):
    """Load original read-only method operations without generating bytecode."""
    sys.dont_write_bytecode = True
    configured = os.environ.get("RIIC_ROSTER_METHODS_ROOT")
    if configured:
        root = Path(configured).resolve()
    else:
        roots = [parent / "scripts/experiments/roster_methods" for parent in Path(__file__).resolve().parents]
        root = next((candidate for candidate in roots if (candidate / "common.py").is_file()
                     and (candidate / "methods/m02_alns.py").is_file()), None)
        if root is None:
            raise ImportError("Set RIIC_ROSTER_METHODS_ROOT to the original read-only roster_methods directory")
    path = root / ("common.py" if name == "common" else f"methods/{name}.py")
    key = str(path.resolve())
    if key in _LEGACY:
        return _LEGACY[key]
    raw = path.read_bytes()
    spec = importlib.util.spec_from_file_location("_riic_main_hybrid_legacy_" + hashlib.sha256(key.encode()).hexdigest()[:16], path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    exec(compile(raw, str(path), "exec"), module.__dict__)
    module._hybrid_source = {"path": key, "sha256": hashlib.sha256(raw).hexdigest()}
    _LEGACY[key] = module
    return module


def _exact_module():
    if __package__:
        return importlib.import_module(__package__ + ".exact_repairs")
    # The registry loads this module by absolute path with no package/sys.path
    # side effects. Resolve the owned sibling by the same absolute-source rule.
    path = Path(__file__).resolve().with_name("exact_repairs.py")
    name = "_riic_main_hybrid_exact_" + hashlib.sha256(str(path).encode()).hexdigest()[:16]
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        exec(compile(path.read_bytes(), str(path), "exec"), module.__dict__)
    return sys.modules[name]


def _full_score(record, vector):
    value = record.get("score")
    if not record.get("valid") or record.get("fidelity") != "full" or tuple(record.get("vector", ())) != tuple(vector):
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        return None
    return float(value)


class _QueryLedger:
    """Each evaluate invocation costs one, including short/invalid/duplicates."""
    def __init__(self, problem, *, budget, seed):
        self.problem, self.seed = problem, seed
        self.limit = min(budget, max(0, int(problem.remaining)))
        self.calls = 0
        self.records = []
        self.full_seen = set()
        self.valid_full = []
        self.best_vector = None
        self.best_score = None

    def available(self):
        return self.calls < self.limit and self.problem.remaining > 0

    def evaluate(self, vector, *, stage, fidelity="full"):
        if not self.available():
            raise RuntimeError("hybrid shared query budget exhausted")
        vector = tuple(vector)
        self.calls += 1
        record = self.problem.evaluate(vector, fidelity=fidelity, seed=self.seed)
        score = _full_score(record, vector)
        if fidelity == "full":
            self.full_seen.add(vector)
        if score is not None:
            self.valid_full.append((score, vector))
            if self.best_score is None or score > self.best_score:
                self.best_score, self.best_vector = score, vector
        self.records.append({"query": self.calls, "stage": stage, "vector": list(vector), "fidelity": fidelity,
                             "seed": self.seed, "valid_full": score is not None, "full_score": score,
                             "best_full_so_far": self.best_score, "shared_cache_hit": record.get("shared_cache_hit"),
                             "reason": record.get("reason")})
        return score


def _solve(problem, *, seed, budget, method):
    if type(budget) is not int or budget < 0:
        raise ValueError("budget must be a nonnegative integer")
    pool_module = _legacy("m01_pool")
    alns = _legacy("m02_alns")
    annealing = _legacy("m12_annealing")
    ce = _legacy("m11_cross_entropy")
    ledger = _QueryLedger(problem, budget=budget, seed=seed)
    domains = [tuple(domain) for domain in problem.domains]
    rng = random.Random(seed)
    probabilities = [[1.0 / len(domain)] * len(domain) for domain in domains]
    weights = alns._AdaptiveWeights(["related", "random", "ce_diff", "restart"])
    calls = {"pool": 0, "related_destroy": 0, "random_destroy": 0, "exact_repair": 0,
             "metropolis": 0, "ce_sample": 0, "ce_update": 0}
    operations, updates, ce_updates = [], [], []
    pool = None
    status = "no_query_budget" if not ledger.available() else "budget_exhausted"
    current, current_score = tuple(problem.initial), None
    cp_search_seconds, cp_setup_seconds, cp_wall_seconds, cp_solver_seconds = 0.0, 0.0, 0.0, 0.0
    unsupported = False

    def fit_ce():
        nonlocal probabilities
        if not ledger.valid_full:
            return
        elite_count = max(1, math.ceil(len(ledger.valid_full) * ce._ELITE_FRACTION))
        elites = [vector for _value, vector in sorted(ledger.valid_full, key=lambda entry: (-entry[0], entry[1]))[:elite_count]]
        before = probabilities
        probabilities, frequencies = ce._update_probabilities(domains, probabilities, elites,
                                                               smoothing=ce._SMOOTHING, exploration=ce._EXPLORATION)
        calls["ce_update"] += 1
        ce_updates.append({"after_query": ledger.calls, "before": before, "after": probabilities,
                           "empirical": frequencies, "full_elites": [list(vector) for vector in elites]})

    if ledger.available() and math.prod(map(len, domains)) > 128:
        status = "unsupported_domain_over_128_vectors"
        unsupported = True
    elif ledger.available():
        if alns._legal(problem, current):
            current_score = ledger.evaluate(current, stage="initial")
            fit_ce()
        calls["pool"] += 1
        pool = pool_module.build_pools(problem, min(8, max(1, ledger.limit)), candidate_limit=128)
    anchors = [tuple(vector) for vector in (pool["diverse"] if pool else [])]
    if pool and pool["top_k"]:
        anchors = list(dict.fromkeys([tuple(pool["top_k"][0])] + anchors))
    scale = abs(current_score) if current_score is not None else 1.0
    initial_temperature = max(1.0, scale) * 0.1
    repair = None
    if not unsupported and ledger.available() and anchors:
        try:
            repair = getattr(_exact_module(), "repair_cp" if method == "cp" else "repair_factor_dp")
        except (ImportError, AttributeError) as error:
            status, unsupported = "unsupported_exact_repair", True
            operations.append({"component_error": str(error)})
    elif ledger.available() and not unsupported:
        status, unsupported = "unsupported_no_finite_G_pool", True

    for attempt in range(max(16, ledger.limit * 8)):
        if unsupported or not ledger.available() or repair is None:
            break
        if pool["model_complete"] and len(ledger.full_seen) == pool["unique_model_candidates"]:
            status = "encoded_domain_queried"
            break
        destroy_name = weights.choose(rng)
        anchor = anchors[0] if attempt == 0 else anchors[(attempt // 4) % len(anchors)] if destroy_name == "restart" else current
        count = rng.randint(1, max(1, math.ceil(len(anchor) * 0.6)))
        ce_target = None
        if destroy_name == "random":
            calls["random_destroy"] += 1
            released = alns._destroy_random(problem, anchor, rng, count)
        elif destroy_name == "restart":
            released = list(range(len(anchor)))
        else:
            calls["related_destroy"] += 1
            released = alns._destroy_related(problem, anchor, rng, count)
            if destroy_name == "ce_diff":
                calls["ce_sample"] += 1
                ce_target = ce._sample_novel_vector(domains, probabilities, ledger.full_seen, rng)
                if ce_target is not None:
                    released = sorted(set(released) | {index for index, (a, b) in enumerate(zip(anchor, ce_target)) if a != b})
        if not alns._legal(problem, anchor):
            released = list(range(len(anchor)))
        repair_records, generated, blocked = [], [], set(ledger.full_seen)
        # Build a real exact-repair pool. Exclusion changes only the current
        # fixed neighborhood; no G proof is promoted to F or to a larger domain.
        for _ in range(_REPAIR_POOL_CAP):
            if method == "cp" and cp_search_seconds >= _CP_SEARCH_SECONDS:
                status = "cp_model_time_budget_exhausted"
                break
            before_queries = len(problem.history)
            kwargs = {"excluded": tuple(sorted(blocked)), "seed": seed}
            if method == "cp":
                kwargs["time_limit_s"] = min(1.0, _CP_SEARCH_SECONDS - cp_search_seconds)
            record = repair(problem, anchor, released, **kwargs)
            calls["exact_repair"] += 1
            if len(problem.history) != before_queries:
                raise RuntimeError("exact repair invoked evaluate outside the shared query ledger")
            repair_records.append(record)
            if method == "cp":
                costs = record.get("diagnostics", {})
                wall, setup = float(costs.get("total_wall_seconds", 0.0)), float(costs.get("setup_wall_seconds", 0.0))
                cp_wall_seconds += wall
                cp_setup_seconds += setup
                cp_search_seconds += max(0.0, wall - setup)
                cp_solver_seconds += sum(float(row.get("wall_time_seconds", 0.0)) for row in costs.get("solves", []))
            vector = record.get("vector")
            if vector is None:
                if record.get("status") in {"UNSUPPORTED", "MODEL_INVALID"}:
                    status, unsupported = "unsupported_exact_repair_" + record["status"].lower(), True
                break
            vector = tuple(vector)
            if vector in blocked or not alns._legal(problem, vector) or any(vector[index] != anchor[index] for index in range(len(anchor)) if index not in released):
                raise RuntimeError("exact repair violated fixed-neighborhood/exclusion/legality contract")
            value = float(problem.cheap(vector))
            if not math.isfinite(value):
                status, unsupported = "unsupported_nonfinite_repair_G", True
                break
            generated.append((value, vector))
            blocked.add(vector)
        candidate, tie_pool_size = None, 0
        if generated and not unsupported:
            highest_G = max(value for value, _vector in generated)
            tier = [vector for value, vector in generated if math.isclose(value, highest_G, rel_tol=0.0, abs_tol=1e-9)]
            tie_pool_size = len(tier)
            def diversity_key(vector):
                distance = min((sum(a != b for a, b in zip(vector, seen)) for seen in ledger.full_seen), default=len(vector))
                probability = math.prod(probabilities[index][domains[index].index(value)] for index, value in enumerate(vector))
                return -distance, -probability, vector
            candidate = min(tier, key=diversity_key)
        reward, accepted, probability, draw = 0.0, False, None, None
        score = None
        temperature = initial_temperature * 0.05 ** (ledger.calls / max(1, ledger.limit))
        previous_score, old_best = current_score, ledger.best_score
        if candidate is not None:
            score = ledger.evaluate(candidate, stage="alns_" + method + "_repair")
            if score is not None:
                improved_best = old_best is None or score > old_best
                if current_score is None:
                    accepted, probability = True, 1.0
                else:
                    calls["metropolis"] += 1
                    accepted, probability, draw = annealing._metropolis(score - current_score, max(1e-12, temperature), rng)
                reward = 8.0 if improved_best else 4.0 if accepted and (current_score is None or score > current_score) else 1.0 if accepted else 0.0
                if accepted:
                    current, current_score = candidate, score
                fit_ce()
        weights.reward(destroy_name, reward)
        operations.append({"attempt": attempt + 1, "destroy": destroy_name, "anchor": list(anchor), "released": released,
                           "ce_target": list(ce_target) if ce_target is not None else None,
                           "repair_calls": repair_records, "generated_G_pool": [{"G": value, "vector": list(vector)} for value, vector in generated],
                           "tie_pool_size": tie_pool_size, "candidate": list(candidate) if candidate is not None else None,
                           "full_score": score, "previous_score": previous_score, "accepted": accepted,
                           "temperature": temperature, "acceptance_probability": probability, "acceptance_draw": draw, "reward": reward})
        if (attempt + 1) % 4 == 0:
            updates.append(weights.update())
        if status == "cp_model_time_budget_exhausted":
            break
    else:
        status = "proposal_attempt_limit"
    if any(weights.uses.values()):
        updates.append(weights.update())
    model_complete = bool(pool and pool["model_complete"])
    domain_queried = bool(model_complete and len(ledger.full_seen) == pool["unique_model_candidates"])
    if domain_queried and not unsupported:
        status = "encoded_domain_queried"
    sources = {name: dict(module._hybrid_source)
               for name, module in (("pool", pool_module), ("alns", alns), ("annealing", annealing), ("ce", ce))}
    return {"best_vector": list(ledger.best_vector) if ledger.best_vector is not None else None, "best_score": ledger.best_score,
            "diagnostics": {"method": "alns_cp" if method == "cp" else "alns_factor_dp", "status": status,
                            "seed": seed, "requested_budget": budget, "effective_budget": ledger.limit, "queries": ledger.calls,
                            "query_ledger": ledger.records, "component_calls": calls, "component_sources": sources,
                            "pool_model_complete": model_complete, "pool_unique_model_candidates": pool["unique_model_candidates"] if pool else None,
                            "operations": operations, "destroy_weights": dict(weights.weights), "weight_updates": updates,
                            "ce_updates": ce_updates, "categorical_probabilities": probabilities,
                            "exact_pool_cap_per_attempt": _REPAIR_POOL_CAP, "total_cp_solver_seconds": cp_solver_seconds,
                            "total_cp_search_seconds": cp_search_seconds, "total_cp_setup_seconds": cp_setup_seconds,
                            "total_cp_wall_seconds": cp_wall_seconds, "cp_search_budget_seconds": _CP_SEARCH_SECONDS,
                            "cp_time_scope": "One-second per-repair post-setup search allowance, eight seconds accumulated search. Cold import/model setup and total wall are reported separately; not a one/eight-second total-wall guarantee.",
                            "tie_handling": "Highest observed public-G repair tier only; max-min Hamming to queried vectors, CE probability, then canonical order. No unqueried F secondary score.",
                            "encoded_domain_queried": domain_queried,
                            "all_queried_full_valid": bool(ledger.full_seen) and len(ledger.valid_full) == ledger.calls},
            "proof_scope": "Actual public G pool, legacy ALNS related/random destroy and adaptive F rewards, legacy simulated-annealing acceptance and F-elite CE categorical exploration, plus real fixed-neighborhood CP-SAT or factor-DP repair. One caller-owned Problem and charged query ledger; short/unknown never full winners. Exact certificates concern only their excluded/fixed public G neighborhood, including any dense high-order factor; no general sparsity, joint-F, expectation or real-game optimum claim."}


def solve_cp(problem, *, seed=42, budget=16):
    return _solve(problem, seed=seed, budget=budget, method="cp")


def solve_factor_dp(problem, *, seed=42, budget=16):
    return _solve(problem, seed=seed, budget=budget, method="factor_dp")


def solve(problem, *, seed=42, budget=16):
    return solve_cp(problem, seed=seed, budget=budget)
