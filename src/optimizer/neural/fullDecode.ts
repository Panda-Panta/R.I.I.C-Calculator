import { initialFullState, legalFullActions, nextDecision, type FullScenario, type FullState, type FullDecision, type FullAction, type FullConstructionOrder } from './fullActionSpace';
import { applyFullAction, finalizeFullState, type FullFinalResult } from './fullTransitions';
export interface FullScorerContext {
    scenario: FullScenario;
    state: FullState;
    decision: FullDecision;
    actions: FullAction[];
}
export type FullScorer = (context: FullScorerContext) => readonly number[];
export interface FullTraceStep {
    decision: FullDecision;
    actions: FullAction[];
    chosenIndex: number;
    action: FullAction;
}
export interface FullDecodeResult extends FullFinalResult {
    trace: FullTraceStep[];
    /** Backward-compatible total completed scorer-driven actions, including forced actions. */
    modelActions: number;
    constructionOrder: FullConstructionOrder;
    forcedActions: number;
    modelChoiceActions: number;
    frozenSlots: number;
}
export function decodeFullRoster(s: FullScenario, scorer: FullScorer): FullDecodeResult {
    let state = initialFullState(s);
    const trace: FullTraceStep[] = [];
    while (s.valid && !state.done && !state.diagnostics.length) {
        const decision = nextDecision(s, state)!, actions = legalFullActions(s, state);
        if (!actions.length) {
            state.diagnostics.push({
                code: 'DECODE_DEAD_END', message: JSON.stringify(decision)
            });
            break;
        }
        let logits: readonly number[];
        try {
            logits = scorer({
                scenario: s, state: structuredClone(state), decision: { ...decision }, actions: structuredClone(actions)
            });
        }
        catch (e) {
            state.diagnostics.push({
                code: 'SCORER_ERROR', message: String(e)
            });
            break;
        }
        if (logits.length !== actions.length || !logits.every(Number.isFinite)) {
            state.diagnostics.push({
                code: 'INVALID_LOGITS', message: 'Expected one finite logit per legal action'
            });
            break;
        }
        let chosenIndex = 0;
        for (let i = 1; i < logits.length; i++) {
            if (logits[i]! > logits[chosenIndex]!) {
                chosenIndex = i;
            }
        }
        const action = actions[chosenIndex]!;
        trace.push({
            decision: { ...decision }, actions, chosenIndex, action
        });
        state = applyFullAction(s, state, action);
    }
    const forcedActions = trace.filter(step => step.actions.length === 1).length;
    return {
        ...finalizeFullState(s, state), trace, modelActions: trace.length, constructionOrder: s.constructionOrder,
        forcedActions, modelChoiceActions: trace.length - forcedActions, frozenSlots: s.lockedSlots.length
    };
}
