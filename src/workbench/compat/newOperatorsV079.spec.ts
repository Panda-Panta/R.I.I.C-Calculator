import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fullCatalogIdleInventory } from '../../domain/operatorInventory'
import { resolveOperatorCharId } from '../../domain/operatorIdentifiers'
import { runScheduleSimulationBridge } from '../scheduleSimulationBridge'
import { validateRosterWorkspace } from '../validate'
import { exportMowerJson, importMowerJson } from './mowerJson'
import { decodeRosterFrom16QrChunks, encodeRosterTo16QrChunks } from './mowerQrCodec'

const names = ['塔露拉', '冻河', '国度', '奥尔佳', '行铃', '镜匠']

describe('v079 operators through Mower entry points', () => {
  it('recognizes all six names after native JSON and QR payload roundtrips', () => {
    const document = JSON.parse(readFileSync(new URL('./fixtures/mower-252-3gold.json', import.meta.url), 'utf8'))
    document.plan1.central.plans = names.slice(0, 5).map(agent => ({ agent, group: '', replacement: [] }))
    document.plan1.meeting.plans[0].agent = '镜匠'
    const exported = exportMowerJson(importMowerJson(JSON.stringify(document)))
    const decoded = decodeRosterFrom16QrChunks(encodeRosterTo16QrChunks(exported, 14))
    const workspace = importMowerJson(decoded)
    const exportedAgain = JSON.parse(exportMowerJson(workspace))
    expect(validateRosterWorkspace(workspace).criticalErrors).toEqual([])
    expect(exportedAgain.plan1.central.plans.map((slot: { agent: string }) => slot.agent)).toEqual(names.slice(0, 5))
    expect(exportedAgain.plan1.meeting.plans[0].agent).toBe('镜匠')
    for (const name of names) expect(resolveOperatorCharId(name)).toMatch(/^char_/)
  })

  it.each([0, 2])('runs a normal imported schedule with Frozen River at elite %s', elitePhase => {
    const document = JSON.parse(readFileSync(new URL('./fixtures/mower-252-3gold.json', import.meta.url), 'utf8'))
    document.plan1.room_1_2.plans[0].agent = '冻河'
    const workspace = importMowerJson(JSON.stringify(document))
    const before = structuredClone(workspace)
    const operatorInventory = fullCatalogIdleInventory().map(entry => entry.operator === resolveOperatorCharId('冻河')
      ? { ...entry, elitePhase, level: 1 }
      : entry)
    const result = runScheduleSimulationBridge(workspace, {
      operatorInventory, warmupHours: 0, sampleHours: 1,
      production: { outputMode: 'potential', runOrderMode: 'ideal', droneTarget: 'none', seed: 42 },
    })
    expect(result.error).toBeUndefined()
    expect(result.report?.success).toBe(true)
    expect(result.report?.production?.success).toBe(true)
    expect(result.report?.assumptions.schedulingModel).toBe('mower-alpha')
    expect(result.report?.operators.find(operator => operator.operatorName === '冻河')?.mainWorkHours).toBeGreaterThan(0)
    expect(workspace).toEqual(before)
  })
})
