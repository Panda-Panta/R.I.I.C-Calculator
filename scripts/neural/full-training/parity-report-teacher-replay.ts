/** Native fixed-target replay only: no model, gradients, autonomous decode, simulator, or roster repair. */
import { compileOperatorInventory } from '../../../src/domain/operatorInventory';
import { normalizeProductionWeights } from '../../../src/domain/productionWeights';
import { createFullScenario } from '../../../src/optimizer/neural/fullActionSpace';
import { replayFullTeacher, fullSemanticWorkspace } from '../../../src/optimizer/neural/fullTeacherTraces';
export function replayPolicyForkTeacher(record: any, outcome: any) {
    if (record.policyMode !== 'latest-native-group-occupants-v4' || record.constructionOrder !== 'staffing-first-v1' || record.input?.split !== 'train') throw Error('Only explicit V4 fixed TRAIN teacher accounting supported');
    const input = record.input, workspace = structuredClone(input.workspace);
    workspace.productionWeights = normalizeProductionWeights(input.options.productionWeights ?? workspace.productionWeights);
    const scenario = createFullScenario(workspace, compileOperatorInventory(input.entries), { constructionOrder: 'staffing-first-v1', policyMode: 'latest-native-group-occupants-v4', simulationConditioning: { schedulerAssumptions: { restingThreshold: .65, operationDurationHours: 0 }, droneTarget: input.options.droneTarget, droneRoomId: input.options.droneRoomId, warmupHours: input.options.simulationWarmupHours, sampleHours: input.options.simulationSampleHours, maxStepHours: input.simulationDefaults?.maxStepHours ?? .25, seed: input.options.seed } });
    const target = outcome?.result?.result?.workspace;
    if (!scenario.valid || !target) throw Error('Invalid fixed teacher replay input/target');
    const replay = replayFullTeacher(scenario, target);
    if (!replay.complete || !replay.exactReplay) throw Error('Fixed teacher does not exactly replay under native V4 policy');
    return { familyId: record.familyId, actionIds: replay.trace.map(t => t.action.id), semanticWorkspace: fullSemanticWorkspace(scenario, replay.workspace), total: replay.modelActions, forced: replay.forcedActions, modelChoice: replay.modelChoiceActions };
}
