"""A CPU factor-graph policy trained with terminal-F REINFORCE.

This is a static, sequential vector constructor, not an event-driven RIIC
environment and not a reproduction of Learning to Dispatch's PPO algorithm.
Only public problem features and explicitly charged full evaluations are used.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any, Sequence

import torch
from torch import Tensor, nn


FEATURE_DIM = 16
ACTION_FEATURE_DIM = 9


def _bounded(value: float) -> float:
    value = float(value)
    return value / (1.0 + abs(value))


def _summary(values: Sequence[float]) -> list[float]:
    vals = [float(v) for v in values]
    if not vals:
        return [0.0] * 4
    mean = sum(vals) / len(vals)
    variance = sum((v - mean) ** 2 for v in vals) / len(vals)
    scale = max(1.0, max(abs(v) for v in vals))
    return [v / scale for v in (min(vals), max(vals), mean, math.sqrt(variance))]


def _signature(problem: Any) -> str:
    """Detect identical declared inputs even if an experiment renames its ID."""
    public = {k: v for k, v in problem.spec.items() if k != "id"}
    encoded = json.dumps(public, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _parameter_vector(network: nn.Module) -> Tensor:
    return torch.cat([p.detach().reshape(-1) for p in network.parameters()])


def parameter_digest(network: nn.Module) -> str:
    digest = hashlib.sha256()
    for name, parameter in network.state_dict().items():
        digest.update(name.encode("utf-8"))
        digest.update(bytes(parameter.detach().cpu().contiguous().flatten().view(torch.uint8).tolist()))
    return digest.hexdigest()


@dataclass
class GraphState:
    features: Tensor
    edge_index: Tensor
    variable_count: int


def build_graph(problem: Any, partial: Sequence[int | None]) -> GraphState:
    """Build variable <-> score/forbidden/resource nodes from the public spec."""
    spec = problem.spec
    count = len(problem.domains)
    if len(partial) != count:
        raise ValueError("partial vector length differs from the declared domains")
    rows: list[list[float]] = []
    edges: list[tuple[int, int]] = []
    unary = spec.get("unary", [[] for _ in range(count)])
    for i, domain in enumerate(problem.domains):
        assigned = partial[i] is not None
        row = [0.0] * FEATURE_DIM
        row[0] = 1.0
        row[4] = float(assigned)
        row[5] = (float(partial[i]) / max(1, len(domain) - 1)) if assigned else 0.0
        row[6] = _bounded(len(domain))
        row[7] = i / max(1, count - 1)
        row[8:12] = _summary(unary[i])
        row[12] = _bounded(unary[i][partial[i]]) if assigned and unary[i] else 0.0
        rows.append(row)

    def add_node(kind: int, variables: Sequence[int], values: Sequence[float], current: float = 0.0) -> None:
        row = [0.0] * FEATURE_DIM
        row[kind] = 1.0
        row[4] = sum(partial[i] is not None for i in variables) / max(1, len(variables))
        row[6] = _bounded(len(variables))
        row[8:12] = _summary(values)
        row[12] = _bounded(current)
        node = len(rows)
        rows.append(row)
        for i in variables:
            edges.extend(((i, node), (node, i)))

    for factor in spec.get("factors", []):
        variables = factor["vars"]
        table = factor.get("table", {})
        key = ",".join(str(partial[i]) for i in variables)
        current = float(table.get(key, 0.0)) if all(partial[i] is not None for i in variables) else 0.0
        add_node(1, variables, list(table.values()), current)
    for constraint in spec.get("forbidden", []):
        matched = sum(partial[i] == v for i, v in zip(constraint["vars"], constraint["values"]))
        add_node(2, constraint["vars"], constraint["values"], matched)
    for resource in spec.get("resources", []):
        usage = resource["usage"]
        variables = [i for i in range(count) if any(float(v) != 0.0 for v in usage[i])]
        used = sum(float(usage[i][partial[i]]) for i in variables if partial[i] is not None)
        add_node(3, variables, [resource["capacity"]], used)
        rows[-1][13] = _bounded(float(resource["capacity"]) - used)
    features = torch.tensor(rows, dtype=torch.float32)
    edge_index = torch.tensor(edges, dtype=torch.long).T.contiguous() if edges else torch.empty((2, 0), dtype=torch.long)
    return GraphState(features, edge_index, count)


class GraphPolicy(nn.Module):
    """Shared node encoder, two actual sum-message rounds, shared action head."""

    def __init__(self, hidden: int = 32, rounds: int = 2) -> None:
        super().__init__()
        self.input_layer = nn.Linear(FEATURE_DIM, hidden)
        self.message_layers = nn.ModuleList(
            nn.Sequential(nn.Linear(hidden, hidden), nn.Tanh(), nn.Linear(hidden, hidden), nn.Tanh())
            for _ in range(rounds)
        )
        self.epsilon = nn.Parameter(torch.zeros(rounds))
        self.action_head = nn.Sequential(
            nn.Linear(2 * hidden + ACTION_FEATURE_DIM, hidden), nn.Tanh(), nn.Linear(hidden, 1)
        )
        # Learned from F returns, initialized without a preference for proxy G.
        self.proxy_weight = nn.Parameter(torch.tensor(0.0))

    def encode(self, graph: GraphState) -> Tensor:
        hidden = torch.tanh(self.input_layer(graph.features))
        source, target = graph.edge_index
        for index, layer in enumerate(self.message_layers):
            message = torch.zeros_like(hidden)
            if source.numel():
                message.index_add_(0, target, hidden[source])
            hidden = layer((1.0 + self.epsilon[index]) * hidden + message)
        return hidden

    def forward(self, graph: GraphState, variable: int, action_features: Tensor) -> Tensor:
        hidden = self.encode(graph)
        local = hidden[variable].expand(action_features.shape[0], -1)
        pooled = hidden.mean(dim=0).expand(action_features.shape[0], -1)
        logits = self.action_head(torch.cat((local, pooled, action_features), dim=1)).squeeze(-1)
        return logits + self.proxy_weight * action_features[:, 6]


def legal_action_mask(problem: Any, partial: Sequence[int | None], variable: int) -> Tensor:
    """Mask decidable prefix violations; full actions also check both public validators.

    This does not enumerate extensions or claim that every prefix has a feasible
    completion. Non-extendable prefixes can terminate a rollout without an F call.
    Resource pruning uses the minimum remaining usage, so signed usages are safe.
    """
    mask = []
    for value in problem.domains[variable]:
        candidate = list(partial)
        candidate[variable] = int(value)
        valid = True
        for forbidden in problem.spec.get("forbidden", []):
            if all(candidate[i] is not None and candidate[i] == v for i, v in zip(forbidden["vars"], forbidden["values"])):
                valid = False
                break
        if valid:
            for resource in problem.spec.get("resources", []):
                lower = sum(
                    float(resource["usage"][i][v]) if v is not None
                    else min(float(resource["usage"][i][k]) for k in problem.domains[i])
                    for i, v in enumerate(candidate)
                )
                if lower > float(resource["capacity"]) + 1e-10:
                    valid = False
                    break
        if valid and all(v is not None for v in candidate):
            vector = tuple(int(v) for v in candidate)
            valid = bool(problem.feasible(vector)) and bool(problem.schedule_feasible(vector))
        mask.append(valid)
    return torch.tensor(mask, dtype=torch.bool)


def _factor_expectation(problem: Any, factor: dict, partial: Sequence[int | None]) -> float:
    """Uniform conditional mean of a public G table, including implicit zeros."""
    variables = factor["vars"]
    denominator = math.prod(len(problem.domains[i]) for i in variables if partial[i] is None)
    total = 0.0
    for key, score in factor.get("table", {}).items():
        values = tuple(int(value) for value in key.split(","))
        if all(partial[i] is None or partial[i] == value for i, value in zip(variables, values)):
            total += float(score)
    return total / max(1, denominator)


def _action_features(problem: Any, variable: int, partial: Sequence[int | None] | None = None) -> Tensor:
    unary = problem.spec.get("unary", [[] for _ in problem.domains])[variable]
    partial = list(partial) if partial is not None else [None] * len(problem.domains)
    values = list(problem.domains[variable])
    unary_values = [float(unary[value]) if unary else 0.0 for value in values]
    factor_values = []
    for value in values:
        candidate = list(partial)
        candidate[variable] = int(value)
        factor_values.append(sum(
            _factor_expectation(problem, factor, candidate)
            for factor in problem.spec.get("factors", []) if variable in factor["vars"]
        ))
    combined = [a + b for a, b in zip(unary_values, factor_values)]

    def centered(scores: list[float]) -> list[float]:
        mean = sum(scores) / len(scores)
        scale = max(1.0, max(scores) - min(scores))
        return [(score - mean) / scale for score in scores]

    relative_unary, relative_factor, relative_G = map(centered, (unary_values, factor_values, combined))
    rows = []
    for index, value in enumerate(values):
        ratios = [
            float(resource["usage"][variable][value]) / max(1.0, abs(float(resource["capacity"])))
            for resource in problem.spec.get("resources", [])
        ]
        rows.append([
            relative_unary[index],
            value / max(1, len(problem.domains[variable]) - 1),
            _bounded(sum(ratios)),
            _bounded(max(ratios, default=0.0)),
            1.0,
            relative_factor[index],
            relative_G[index],
            float(value == problem.initial[variable]),
            variable / max(1, len(problem.domains) - 1),
        ])
    return torch.tensor(rows, dtype=torch.float32)


def _rollout(network: GraphPolicy, problem: Any, generator: torch.Generator, *, greedy: bool = False, exploration: float = 0.15) -> dict:
    partial: list[int | None] = [None] * len(problem.domains)
    log_probabilities: list[Tensor] = []
    entropies: list[Tensor] = []
    masked_actions = 0
    for variable, domain in enumerate(problem.domains):
        mask = legal_action_mask(problem, partial, variable)
        masked_actions += int((~mask).sum())
        if not bool(mask.any()):
            return {"vector": None, "dead_end_at": variable, "masked_actions": masked_actions}
        logits = network(build_graph(problem, partial), variable, _action_features(problem, variable, partial))
        logits = logits.masked_fill(~mask, -torch.inf)
        probabilities = torch.softmax(logits, dim=0)
        if not greedy:
            probabilities = (1.0 - exploration) * probabilities + exploration * mask.to(torch.float32) / mask.sum()
        log_probs = torch.log(probabilities.clamp_min(torch.finfo(torch.float32).tiny))
        action = int(torch.argmax(logits)) if greedy else int(torch.multinomial(probabilities.detach(), 1, generator=generator))
        partial[variable] = int(domain[action])
        log_probabilities.append(log_probs[action])
        entropies.append(-(probabilities[mask] * log_probs[mask]).sum())
    zero = next(network.parameters()).sum() * 0.0
    return {
        "vector": tuple(int(v) for v in partial),
        "log_probability": torch.stack(log_probabilities).sum() if log_probabilities else zero,
        "entropy": torch.stack(entropies).mean() if entropies else zero,
        "masked_actions": masked_actions,
    }


def _valid_full(result: dict) -> bool:
    score = result.get("score")
    return bool(result.get("valid")) and result.get("fidelity", "full") == "full" and score is not None and math.isfinite(float(score))


@dataclass
class FrozenPolicy:
    network: GraphPolicy
    training_scene_ids: tuple[str, ...]
    training_signatures: tuple[str, ...]
    training_query_count: int
    digest: str


def train_policy(training_problems: Sequence[Any], *, seed: int = 42, budget: int = 16) -> tuple[FrozenPolicy, dict]:
    """Train on this explicit collection only; budget is total charged full calls.

    Invalid/unsupported F responses consume a call but supply no reward or update.
    The per-scene baseline depends only on earlier training returns. No held-out
    object, hidden score, or best-vector replay enters the optimizer.
    """
    torch.set_num_threads(1)
    problems = list(training_problems)
    with torch.random.fork_rng(devices=[]):
        torch.manual_seed(int(seed))
        network = GraphPolicy().cpu()
    generator = torch.Generator(device="cpu").manual_seed(int(seed))
    optimizer = torch.optim.Adam(network.parameters(), lr=0.01)
    initial = _parameter_vector(network).clone()
    encoder_parameters = list(network.input_layer.parameters()) + list(network.message_layers.parameters()) + [network.epsilon]
    encoder_initial = torch.cat([p.detach().flatten() for p in encoder_parameters]).clone()
    queries = updates = dead_ends = masked_actions = 0
    states: dict[int, dict] = {}
    initial_incumbents: list[dict] = []
    records: list[dict] = []
    max_gradient = max_encoder_gradient = 0.0
    query_limit = max(0, int(budget))
    attempts = 0
    while queries < query_limit and problems and attempts < max(8, query_limit * 8):
        available = [p for p in problems if int(p.remaining) > 0]
        if not available:
            break
        problem = available[attempts % len(available)]
        attempts += 1
        state = states.setdefault(id(problem), {"bootstrapped": False, "baseline": 0.0, "mean": 0.0, "m2": 0.0, "count": 0, "best": None})
        bootstrap = not state["bootstrapped"] and problem.feasible(problem.initial) and problem.schedule_feasible(problem.initial)
        state["bootstrapped"] = True
        exploration = 0.25 - 0.15 * min(1.0, queries / max(1, query_limit))
        if bootstrap:
            rollout = {"vector": tuple(problem.initial), "masked_actions": 0}
        else:
            rollout = _rollout(network, problem, generator, exploration=exploration)
        masked_actions += rollout["masked_actions"]
        if rollout["vector"] is None:
            dead_ends += 1
            continue
        queries += 1
        try:
            # Common random numbers reduce action-comparison noise. Every repeat
            # still consumes a query; unseen seeds remain exclusively validation.
            result = problem.evaluate(rollout["vector"], fidelity="full", seed=int(seed))
        except Exception as error:
            records.append({"scene_id": str(problem.scene_id), "accepted_reward": False, "error": type(error).__name__})
            continue
        if not _valid_full(result):
            records.append({"scene_id": str(problem.scene_id), "accepted_reward": False, "status": "invalid_or_incomplete_F"})
            continue
        terminal_reward = float(result["score"])
        if bootstrap:
            state.update(baseline=terminal_reward, mean=terminal_reward, count=1, best=terminal_reward)
            incumbent = {"scene_id": str(problem.scene_id), "vector": list(rollout["vector"]), "score": terminal_reward, "seed": result.get("seed")}
            initial_incumbents.append(incumbent)
            records.append({"scene_id": str(problem.scene_id), "accepted_reward": True, "role": "initial_baseline", "vector": list(rollout["vector"]), "terminal_F_reward": terminal_reward, "gradient_l2": 0.0, "encoder_gradient_l2": 0.0, "checkpoint_digest_after": parameter_digest(network)})
            continue
        baseline = state["baseline"]
        deviation = math.sqrt(state["m2"] / max(1, state["count"] - 1))
        reward_scale = max(1.0, deviation, 0.01 * abs(state["mean"]))
        advantage = max(-5.0, min(5.0, (terminal_reward - baseline) / reward_scale))
        loss = -advantage * rollout["log_probability"] - 0.005 * rollout["entropy"]
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        gradient = math.sqrt(sum(float(p.grad.detach().square().sum()) for p in network.parameters() if p.grad is not None))
        encoder_gradient = math.sqrt(sum(float(p.grad.detach().square().sum()) for p in encoder_parameters if p.grad is not None))
        max_gradient = max(max_gradient, gradient)
        max_encoder_gradient = max(max_encoder_gradient, encoder_gradient)
        torch.nn.utils.clip_grad_norm_(network.parameters(), 5.0)
        optimizer.step()
        updates += 1
        records.append({
            "scene_id": str(problem.scene_id), "accepted_reward": True,
            "role": "sampled_policy", "exploration_probability": exploration,
            "vector": list(rollout["vector"]), "terminal_F_reward": terminal_reward,
            "baseline_before": baseline, "scaled_advantage": advantage,
            "loss": float(loss.detach()), "gradient_l2": gradient,
            "encoder_gradient_l2": encoder_gradient,
            "checkpoint_digest_after": parameter_digest(network),
        })
        state["baseline"] = 0.85 * baseline + 0.15 * terminal_reward
        state["count"] += 1
        delta = terminal_reward - state["mean"]
        state["mean"] += delta / state["count"]
        state["m2"] += delta * (terminal_reward - state["mean"])
        state["best"] = max(terminal_reward, state["best"]) if state["best"] is not None else terminal_reward
    parameter_delta = float(torch.linalg.vector_norm(_parameter_vector(network) - initial))
    encoder_final = torch.cat([p.detach().flatten() for p in encoder_parameters])
    frozen_network = copy.deepcopy(network).eval()
    for parameter in frozen_network.parameters():
        parameter.requires_grad_(False)
        parameter.grad = None
    digest = parameter_digest(frozen_network)
    frozen = FrozenPolicy(
        frozen_network, tuple(str(p.scene_id) for p in problems),
        tuple(_signature(p) for p in problems), queries, digest,
    )
    diagnostics = {
        "query_count": queries, "query_budget": query_limit, "optimizer_updates": updates,
        "attempts": attempts, "dead_ends": dead_ends, "masked_actions": masked_actions,
        "max_gradient_l2": max_gradient, "max_encoder_gradient_l2": max_encoder_gradient,
        "parameter_delta_l2": parameter_delta,
        "encoder_parameter_delta_l2": float(torch.linalg.vector_norm(encoder_final - encoder_initial)),
        "records": records, "training_scene_ids": list(frozen.training_scene_ids),
        "checkpoint_digest": digest, "reward": "valid complete-vector full-F terminal score",
        "algorithm": "REINFORCE with per-scene initial-F/EMA baseline, variance-scaled advantage, and on-policy uniform exploration mixture",
        "initial_incumbents": initial_incumbents,
        "training_best_by_scene": [{"scene_id": str(p.scene_id), "score": states.get(id(p), {}).get("best")} for p in problems],
        "configuration": {"learning_rate": 0.01, "baseline_ema": 0.15, "entropy_coefficient": 0.005, "exploration_start": 0.25, "exploration_end": 0.10, "action_features": ACTION_FEATURE_DIM},
        "algorithm_revision": "r01-centered-public-factor-policy",
        "training_seed_strategy": "fixed common-random-number seed; repeated/cached queries remain charged",
        "device": "cpu", "torch_threads": torch.get_num_threads(),
    }
    return frozen, diagnostics


def evaluate_frozen_policy(policy: FrozenPolicy, problem: Any, *, seed: int = 42, budget: int = 1) -> dict:
    """Evaluate with no optimizer, no gradient, and no training-best selection."""
    before = parameter_digest(policy.network)
    if before != policy.digest or any(p.requires_grad for p in policy.network.parameters()):
        raise ValueError("policy is not the unchanged frozen training checkpoint")
    generator = torch.Generator(device="cpu").manual_seed(int(seed))
    limit = max(0, min(int(budget), int(problem.remaining)))
    records: list[dict] = []
    best = None
    attempts = queries = dead_ends = 0
    policy.network.eval()
    with torch.no_grad():
        while queries < limit and attempts < max(8, limit * 8):
            rollout = _rollout(policy.network, problem, generator, greedy=attempts == 0)
            attempts += 1
            if rollout["vector"] is None:
                dead_ends += 1
                continue
            queries += 1
            try:
                result = problem.evaluate(rollout["vector"], fidelity="full", seed=int(seed) + queries - 1)
            except Exception as error:
                records.append({"valid": False, "score": None, "error": type(error).__name__})
                continue
            records.append(result)
            if _valid_full(result) and (best is None or float(result["score"]) > float(best["score"])):
                best = result
    after = parameter_digest(policy.network)
    if before != after:
        raise RuntimeError("frozen evaluation modified policy parameters")
    repeated = str(problem.scene_id) in policy.training_scene_ids or _signature(problem) in policy.training_signatures
    return {
        "best_vector": list(best["vector"]) if best is not None else None,
        "best_score": float(best["score"]) if best is not None else None,
        "diagnostics": {
            "query_count": queries, "query_budget": limit, "records": records,
            "attempts": attempts, "dead_ends": dead_ends,
            "checkpoint_digest_before": before, "checkpoint_digest_after": after,
            "parameters_unchanged": before == after, "optimizer_updates": 0,
            "training_input_reused": repeated,
            "evaluation_scope": "same_scene_frozen_validation" if repeated else "declared_input_holdout",
            "split_caveat": "Different public inputs do not establish inventory-group independence or statistical generalization.",
            "selection_source": "valid full-F calls made in this frozen evaluation only",
        },
        "proof_scope": "Static construction and charged complete-F evaluation; no event-dynamic RL or generalization claim.",
    }


def public_G_maximizers(problem: Any, *, max_candidates: int = 4, enumeration_limit: int = 100_000) -> tuple[list[tuple[int, ...]], dict]:
    """An explicitly separate, bounded exact PUBLIC-G candidate generator.

    It never queries F. These candidates are a deployment safeguard, not policy
    outputs or RL training rewards. Large declared domains omit this safeguard.
    """
    cardinality = math.prod(len(domain) for domain in problem.domains)
    if cardinality > enumeration_limit:
        return [], {"status": "omitted_domain_above_limit", "declared_cardinality": cardinality, "enumeration_limit": enumeration_limit}
    candidates: list[tuple[int, ...]] = []
    best_G = None
    visited = ties = 0
    for raw in problem.vectors(feasible_only=True):
        vector = tuple(int(v) for v in raw)
        visited += 1
        if not problem.schedule_feasible(vector):
            continue
        score = float(problem.cheap(vector))
        if not math.isfinite(score):
            continue
        tied = best_G is not None and math.isclose(score, best_G, rel_tol=1e-10, abs_tol=1e-8)
        if best_G is None or score > best_G and not tied:
            best_G, candidates, ties = score, [vector], 1
        elif tied:
            ties += 1
            if len(candidates) < max_candidates:
                candidates.append(vector)
    return candidates[:max_candidates], {
        "status": "public_G_maximum_in_declared_finite_domain" if best_G is not None else "no_feasible_public_G_candidate",
        "declared_cardinality": cardinality, "structurally_feasible_vectors_visited": visited,
        "maximum_G": best_G, "maximum_G_tie_count": ties,
        "retained_candidates": len(candidates[:max_candidates]), "F_queries": 0,
        "claim": "Public G only; not a maximum-F proof or a learned-policy result.",
    }


def solve(problem: Any, *, seed: int = 42, budget: int = 16) -> dict:
    """Explicit hybrid deployment; learned policy and public-G pool stay separate."""
    limit = max(0, min(int(budget), int(problem.remaining)))
    G_pool, G_model = public_G_maximizers(problem)
    initial_legal = problem.feasible(problem.initial) and problem.schedule_feasible(problem.initial)
    if initial_legal and limit > 0:
        if limit <= 2:
            # A legal, known baseline gets the first F call even when there is
            # no budget for a sampled training episode plus frozen validation.
            training_budget, frozen_budget = 1, 0
            G_pool = G_pool[:limit - 1]
        else:
            # Preserve bootstrap + at least one sampled update before spending
            # queries on either a frozen policy or the separate public-G pool.
            G_pool = G_pool[:max(0, limit - 3)]
            training_budget, frozen_budget = limit - 1 - len(G_pool), 1
    else:
        G_pool = G_pool[:max(0, limit - 1)]
        training_budget = max(0, limit - min(1, limit) - len(G_pool))
        frozen_budget = min(1, limit)
    policy, training = train_policy([problem], seed=seed, budget=training_budget)
    trained = training["optimizer_updates"] > 0
    evaluation = evaluate_frozen_policy(policy, problem, seed=seed, budget=frozen_budget if trained else 0)
    if not trained:
        evaluation["diagnostics"]["evaluation_status"] = "skipped_policy_untrained"
    initial = next((r for r in training["initial_incumbents"] if r["scene_id"] == str(problem.scene_id)), None)
    selected_vector, selected_score = evaluation["best_vector"], evaluation["best_score"]
    selection_source = "frozen_policy"
    if initial is not None and (selected_score is None or initial["score"] > selected_score + 1e-7):
        selected_vector, selected_score = initial["vector"], initial["score"]
        selection_source = "verified_initial_incumbent"
    G_records = []
    for vector in G_pool:
        if problem.remaining <= 0:
            break
        result = problem.evaluate(vector, fidelity="full", seed=seed)
        G_records.append(result)
        if _valid_full(result) and (selected_score is None or float(result["score"]) > selected_score + 1e-7):
            selected_vector, selected_score = list(vector), float(result["score"])
            selection_source = "verified_public_G_pool"
    return {
        "best_vector": selected_vector, "best_score": selected_score,
        "frozen_policy_vector": evaluation["best_vector"], "frozen_policy_score": evaluation["best_score"],
        "diagnostics": {
            "algorithm": "factor_graph_gnn_reinforce_with_explicit_public_G_deployment_pool", "training": training,
            "frozen_validation": evaluation["diagnostics"],
            "public_G_pool": {"model": G_model, "records": G_records, "query_count": len(G_records), "query_budget": len(G_pool)},
            "query_count": training["query_count"] + evaluation["diagnostics"]["query_count"] + len(G_records),
            "query_budget": limit, "training_scope": "same_scene_online_adaptation",
            "generalization_evidence": False,
            "selection_source": selection_source,
            "initial_incumbent": initial,
            "training_best_used_for_selection": False,
            "selection_seed_strategy": "All budgeted training and deployment comparisons use the search seed; unused seeds are external validation only.",
            "deployment_gain_is_RL_only": False,
            "rl_training_status": "trained" if trained else "not_trained_insufficient_budget" if training_budget <= 1 else "not_trained_no_valid_training_reward",
        },
        "proof_scope": "Learned factor-graph policy is reported separately from verified initial/public-G deployment candidates. Public-G enumeration proves only G maximality in its bounded declared domain, never F optimality. Static experiment; no cross-scene or event-dynamic RL claim.",
    }
