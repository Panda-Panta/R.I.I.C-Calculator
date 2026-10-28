"""UCT over static assignment prefixes, with complete feasible rollout queries.

There is no event-state/advance-action API in the experiment contract.  This
module consequently does not implement the event-level policy in REPORT §14.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import math
import random
from typing import Any


@dataclass
class _Node:
    prefix: tuple[int, ...]
    untried: list[int] = field(default_factory=list)
    children: dict[int, "_Node"] = field(default_factory=dict)
    visits: int = 0
    reward_samples: int = 0
    reward_sum: float = 0.0
    closed: bool = False

    @property
    def mean_score(self) -> float | None:
        return self.reward_sum / self.reward_samples if self.reward_samples else None


def _uct(parent: _Node, child: _Node, reward_scale: float,
         exploration: float = math.sqrt(2.0)) -> float:
    """Unobserved returns have no fabricated score and receive exploration first."""
    if not child.visits or not child.reward_samples:
        return math.inf
    return (child.mean_score / reward_scale
            + exploration * math.sqrt(math.log(max(1, parent.visits)) / child.visits))


def _select_child(parent: _Node, rng: random.Random, reward_scale: float,
                  exploration: float = math.sqrt(2.0)) -> _Node:
    candidates = [child for child in parent.children.values() if not child.closed]
    values = [_uct(parent, child, reward_scale, exploration) for child in candidates]
    highest = max(values)
    return rng.choice([child for child, value in zip(candidates, values)
                       if value == highest])


def _partial_feasible(prefix: tuple[int, ...], spec: dict, domains: list[list[int]]) -> bool:
    """Sound inexpensive pruning for the declared forbidden/resource constraints.

    Resource lower bounds include minimum remaining usage, including negative
    usage.  All other structural and scheduling checks are left to the public
    complete-vector predicates, never to an unqueried objective.
    """
    assigned = len(prefix)
    for forbidden in spec.get("forbidden", []):
        indices = forbidden["vars"]
        if all(index < assigned for index in indices):
            if all(prefix[index] == value
                   for index, value in zip(indices, forbidden["values"])):
                return False
    for resource in spec.get("resources", []):
        usage = resource["usage"]
        lower_bound = sum(usage[index][prefix[index]] for index in range(assigned))
        lower_bound += sum(min(usage[index][value] for value in domains[index])
                           for index in range(assigned, len(domains)))
        if lower_bound > resource["capacity"] + 1e-12:
            return False
    return True


class _RolloutLimit(Exception):
    pass


def _complete_rollout(problem: Any, prefix: tuple[int, ...], domains: list[list[int]],
                      spec: dict, rng: random.Random, excluded: set[tuple[int, ...]],
                      node_limit: int, greedy_probability: float = 0.0
                      ) -> tuple[tuple[int, ...] | None, bool, int, str | None]:
    """Randomized depth-first completion; only full legal leaves may reach F.

    A failed bounded search is distinguished from an exhausted subtree.  Its
    failure is not a reward and cannot prove infeasibility.
    """
    examined = 0
    schedule_unknown = None

    def search(partial: tuple[int, ...]) -> tuple[int, ...] | None:
        nonlocal examined, schedule_unknown
        if examined >= node_limit:
            raise _RolloutLimit
        examined += 1
        if not _partial_feasible(partial, spec, domains):
            return None
        if len(partial) == len(domains):
            if partial not in excluded and problem.feasible(partial):
                try:
                    if problem.schedule_feasible(partial):
                        return partial
                except RuntimeError as error:
                    # common's finite scheduler raises on UNKNOWN.  It cannot
                    # justify pruning the leaf or labelling its F score zero.
                    schedule_unknown = str(error)
            return None
        actions = domains[len(partial)].copy()
        rng.shuffle(actions)
        if greedy_probability > 0 and rng.random() < greedy_probability:
            # A rollout heuristic, not a terminal reward: complete with the
            # public initial values solely to rank this one-step choice by G.
            # Randomized ties and subsequent DFS retain every legal action.
            def public_priority(action):
                candidate = partial + (action,) + tuple(problem.initial[len(partial) + 1:])
                return problem.cheap(candidate)

            actions.sort(key=public_priority, reverse=True)
        for action in actions:
            completed = search(partial + (action,))
            if completed is not None:
                return completed
        return None

    try:
        vector = search(prefix)
        return vector, vector is None and schedule_unknown is None, examined, schedule_unknown
    except _RolloutLimit:
        return None, False, examined, None


def solve(problem: Any, *, seed: int = 42, budget: int = 16) -> dict:
    """Run four-phase MCTS within a strict count of public evaluate calls.

    A node is a static prefix in fixed variable order.  The rollout terminal is
    a complete, structurally and declaratively schedule-feasible assignment.
    A publicly legal initial vector is the first counted full-F observation.
    Same-seed duplicate leaves are skipped by default, and remain available as
    an explicit replication experiment. Invalid or unsupported observations are
    missing rewards, not zero-score simulations.
    """
    rng = random.Random(seed)
    domains = [list(domain) for domain in problem.domains]
    spec = problem.spec
    metadata = getattr(problem, "metadata", {}) or {}
    requested_budget = max(0, int(budget))
    options = metadata.get("mcts", {})
    rollout_limit = max(1, int(options.get("rollout_node_limit", 5000)))
    iteration_limit = max(1, int(options.get("iteration_limit", max(64, requested_budget * 32))))
    repeat_leaves = bool(options.get("repeat_evaluated_leaves", False))
    greedy_probability = float(options.get("rollout_greedy_probability", 1.0))
    root_rollout_first = bool(options.get("root_rollout_first", True))
    exploration = float(options.get("exploration", math.sqrt(2.0)))
    scale_fraction = float(options.get("reward_scale_fraction", 1.0))
    if not 0 <= greedy_probability <= 1 or not math.isfinite(exploration) or exploration <= 0:
        raise ValueError("MCTS rollout probability must be in [0,1] and exploration positive")
    if not math.isfinite(scale_fraction) or scale_fraction <= 0:
        raise ValueError("mcts.reward_scale_fraction must be finite and positive")
    initial_score = float(problem.cheap(problem.initial))
    public_scale = abs(initial_score) if math.isfinite(initial_score) else 1.0
    reward_scale = float(options.get("reward_scale", max(1.0, public_scale * scale_fraction)))
    if not math.isfinite(reward_scale) or reward_scale <= 0:
        raise ValueError("mcts.reward_scale must be finite and positive")

    nodes: list[_Node] = []

    def make_node(prefix: tuple[int, ...]) -> _Node:
        node = _Node(prefix)
        if len(prefix) < len(domains):
            node.untried = [action for action in domains[len(prefix)]
                            if _partial_feasible(prefix + (action,), spec, domains)]
            rng.shuffle(node.untried)
            node.closed = not node.untried
        nodes.append(node)
        return node

    root = make_node(())
    excluded: set[tuple[int, ...]] = set()
    queried_leaves: set[tuple[int, ...]] = set()
    trace = []
    best_vector = None
    best_score = None
    queries = iterations = selections = expansions = rollout_nodes = backprops = 0
    invalid_evaluations = generation_failures = truncated_rollouts = 0
    unknown_schedule_rollouts = 0
    stop_reason = "query_budget"
    baseline = {"vector": list(problem.initial), "status": "not_checked_no_budget", "score": None}
    baseline_pending = False
    if requested_budget and problem.remaining > 0:
        if not problem.feasible(problem.initial):
            baseline["status"] = "public_structure_infeasible"
        else:
            try:
                baseline_pending = bool(problem.schedule_feasible(problem.initial))
                baseline["status"] = "pending" if baseline_pending else "declared_schedule_infeasible"
            except RuntimeError as error:
                baseline.update(status="schedule_check_unknown", reason=str(error))
    root_rollout_done = not root_rollout_first

    while queries < requested_budget:
        if problem.remaining <= 0:
            stop_reason = "problem_budget"
            break
        if root.closed:
            stop_reason = "all_available_legal_leaves_queried" if not repeat_leaves else "no_remaining_legal_supported_leaf"
            break
        if iterations >= iteration_limit:
            stop_reason = "tree_iteration_limit"
            break
        iterations += 1
        node = root
        path = [root]
        selected_prefixes = []
        expanded_prefix = None
        # Preserve the legal initial incumbent as the first counted query.
        # Neither this baseline nor the following root rollout has traversed a
        # child action, so their observations update the root alone.
        baseline_step = baseline_pending
        warm_start = baseline_step or not root_rollout_done
        while not warm_start and len(node.prefix) < len(domains):
            if node.untried:
                action = node.untried.pop()
                child = make_node(node.prefix + (action,))
                node.children[action] = child
                node = child
                path.append(child)
                expanded_prefix = list(child.prefix)
                expansions += 1
                break
            available = [child for child in node.children.values() if not child.closed]
            if not available:
                node.closed = True
                break
            node = _select_child(node, rng, reward_scale, exploration)
            path.append(node)
            selected_prefixes.append(list(node.prefix))
            selections += 1

        if baseline_step:
            baseline_pending = False
            vector, exhausted, examined, schedule_unknown = tuple(problem.initial), False, 0, None
        else:
            if warm_start:
                root_rollout_done = True
            vector, exhausted, examined, schedule_unknown = _complete_rollout(
                problem, node.prefix, domains, spec, rng, excluded, rollout_limit,
                greedy_probability)
        rollout_nodes += examined
        score = None
        result = None
        reason = None
        if vector is None:
            generation_failures += 1
            if exhausted:
                node.closed = True
                reason = "no_legal_leaf_remaining_in_subtree"
            elif schedule_unknown is not None:
                unknown_schedule_rollouts += 1
                reason = "schedule_check_unknown: " + schedule_unknown
            else:
                truncated_rollouts += 1
                reason = "rollout_node_limit"
        else:
            queries += 1
            result = problem.evaluate(vector, fidelity="full", seed=seed)
            queried_leaves.add(vector)
            if not repeat_leaves:
                excluded.add(vector)
                if len(node.prefix) == len(domains):
                    node.closed = True
            candidate_score = result.get("score")
            valid = (result.get("valid") is True
                     and result.get("fidelity", "full") == "full"
                     and isinstance(candidate_score, (int, float))
                     and not isinstance(candidate_score, bool)
                     and math.isfinite(candidate_score))
            if valid:
                score = float(candidate_score)
                if best_score is None or score > best_score:
                    best_score, best_vector = score, list(vector)
            else:
                invalid_evaluations += 1
                excluded.add(vector)
                reason = result.get("reason") or result.get("status") or "invalid_or_non_full_result"
                if len(node.prefix) == len(domains):
                    node.closed = True
            if baseline_step:
                baseline.update(status="valid" if valid else "invalid_or_unsupported",
                                score=score, query=queries)

        # Traversal counts include rejected/truncated attempts; only valid F
        # observations change reward estimates.  This separation is inspectable.
        for visited in path:
            visited.visits += 1
            if score is not None:
                visited.reward_samples += 1
                visited.reward_sum += score
            backprops += 1
        for ancestor in reversed(path):
            if (len(ancestor.prefix) < len(domains) and not ancestor.untried
                    and all(child.closed for child in ancestor.children.values())):
                ancestor.closed = True
        trace.append({
            "iteration": iterations,
            "phase": "baseline" if baseline_step else "root_rollout" if warm_start else "tree",
            "selected_prefixes": selected_prefixes,
            "expanded_prefix": expanded_prefix,
            "terminal_leaf": list(vector) if vector is not None else None,
            "queried": vector is not None,
            "valid_reward": score is not None,
            "score": score,
            "reason": reason,
            "backprop_prefixes": [list(visited.prefix) for visited in path],
        })

    node_statistics = []
    for node in nodes:
        node_statistics.append({
            "prefix": list(node.prefix), "visits": node.visits,
            "reward_samples": node.reward_samples, "reward_sum": node.reward_sum,
            "mean_score": node.mean_score, "closed": node.closed,
            "children": sorted(node.children), "untried": sorted(node.untried),
        })
    return {
        "best_vector": best_vector,
        "best_score": best_score,
        "diagnostics": {
            "algorithm": "static-prefix MCTS/UCT",
            "seed": seed, "budget_requested": requested_budget,
            "queries": queries, "valid_rollouts": root.reward_samples,
            "baseline": baseline,
            "invalid_evaluations": invalid_evaluations,
            "iterations": iterations, "selection_steps": selections,
            "expansion_steps": expansions, "rollout_nodes_examined": rollout_nodes,
            "backprop_steps": backprops, "generation_failures": generation_failures,
            "truncated_rollouts": truncated_rollouts,
            "unknown_schedule_rollouts": unknown_schedule_rollouts,
            "rollout_node_limit": rollout_limit, "iteration_limit": iteration_limit,
            "reward_scale": reward_scale,
            "reward_scale_fraction": scale_fraction, "exploration": exploration,
            "rollout_greedy_probability": greedy_probability,
            "root_rollout_first": root_rollout_first,
            "repeat_evaluated_leaves": repeat_leaves,
            "unique_queried_leaves": len(queried_leaves),
            "duplicate_queries": queries - len(queried_leaves),
            "uct_formula": "mean_valid_score / fixed_public_scale + exploration*sqrt(ln(parent_visits)/child_visits)",
            "node_count": len(nodes), "tree_max_depth": max(map(lambda item: len(item.prefix), nodes)),
            "stop_reason": stop_reason,
            "tree": node_statistics,
        },
        "trace": trace,
        "proof_scope": {
            "search_domain": "finite static prefix-assignment construction tree",
            "terminal_queries": "complete feasible vectors passing public structural and declared scheduling checks",
            "reward": "public full-fidelity evaluate observations only; unsupported is missing, never zero",
            "dynamic_event_policy_verified": False,
            "event_api_missing": "no copy/advance/event-action enumeration API in CONTRACT.md",
            "optimality_proven": False,
            "uct_theorem_claimed": False,
            "limitation": "fixed cheap-derived score scale is a heuristic; bounded-reward MDP assumptions are not established",
        },
    }
