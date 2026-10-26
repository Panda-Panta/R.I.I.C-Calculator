/** Separate physical choices from singleton-mask mechanics; no placement is added here. */
import { physicalBackupOperatorIds } from '../../../src/optimizer/combinationModel';
export function fullPlacementMetrics(scenario: any, result: any) {
    let totalMain = 0, totalRelief = 0, frozenPhysicalPlacements = 0, forcedMain = 0, forcedRelief = 0;
    for (const room of Object.values(result.workspace.mainPlan.facilities) as any[])
        for (const [index, slot] of room.slots.entries()) {
            const main = Number(slot.occupant.kind === 'operator'), relief = [slot, ...slot.groupBindings ?? []].reduce((n, b) => n + physicalBackupOperatorIds(room, b).length, 0);
            if (scenario.lockedSlots.includes(`${room.roomId}:${index}`))
                frozenPhysicalPlacements += main + relief;
            else {
                totalMain += main;
                totalRelief += relief;
            }
        }
    for (const step of result.trace) {
        if (step.actions.length !== 1 || step.action.kind !== 'operator')
            continue;
        if (step.decision.kind === 'occupant')
            forcedMain++;
        else if (['replacement', 'binding-replacement'].includes(step.decision.kind)) {
            const room = result.workspace.mainPlan.facilities[step.decision.roomId];
            forcedRelief += physicalBackupOperatorIds(room, { replacements: [step.action.value] }).length;
        }
    }
    return { modelMainPlacements: totalMain - forcedMain, modelReliefPlacements: totalRelief - forcedRelief, modelPhysicalPlacements: totalMain + totalRelief - forcedMain - forcedRelief, forcedPhysicalPlacements: forcedMain + forcedRelief, mechanicalPlacements: forcedMain + forcedRelief, totalGeneratedPhysicalPlacements: totalMain + totalRelief, frozenPhysicalPlacements, fallbackPhysicalPlacements: 0, placementAccounting: 'Model placements exclude singleton-mask forced physical actions; mechanical placements are forced actions, never repair/fallback' };
}
