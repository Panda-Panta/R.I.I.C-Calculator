import { expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import jpeg from 'jpeg-js'
import { decode16QrFromRgba } from '../workbench/compat/mowerQrCodec'
import { importMowerJson } from '../workbench/compat/mowerJson'
import { runScheduleSimulationBridge } from '../workbench/scheduleSimulationBridge'

const directory = new URL('../../validation/mower-backup-2026-09-22/', import.meta.url)
it('decodes the supplied image byte-for-data without losing any backup settings', () => {
  const image = jpeg.decode(readFileSync(new URL('source-roster.jpeg', directory)))
  const data = decode16QrFromRgba(image.data,image.width,image.height)
  expect(JSON.parse(data)).toEqual(JSON.parse(readFileSync(new URL('roster.json',directory),'utf8')))
})

it.each([24,168])('recovers the original alpha roster and completes a %i hour request', async hours => {
  // Flush Vitest's task update before the synchronous multi-day simulation.
  await new Promise(resolve => setTimeout(resolve, 150))
  const workspace=importMowerJson(readFileSync(new URL('roster.json',directory),'utf8'))
  const result=runScheduleSimulationBridge(workspace,{sampleHours:hours,warmupHours:0,recordSegments:true,production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'none',seed:42}})
  writeFileSync(new URL(`production-${hours}h.json`,directory),JSON.stringify(result,null,2))
  expect(result.error).toBeUndefined()
  expect(result.report?.success,JSON.stringify(result.report?.diagnostics)).toBe(true)
  expect(result.report?.production?.success).toBe(true)
  expect(result.report?.diagnostics).toContainEqual(expect.objectContaining({code:'mower-task-exception',message:expect.stringContaining('循环')}))
  expect(result.report?.diagnostics.some(d=>d.code==='BACKUP_EXECUTION_FAILED')).toBe(false)
  expect(result.report!.elapsedHours).toBeCloseTo(hours,7)
},1200000)

it.each([24,168])('completes the explicit control with backup 0 disabled for %i hours', async hours => {
  await new Promise(resolve => setTimeout(resolve, 150))
  const workspace=importMowerJson(readFileSync(new URL('roster.json',directory),'utf8'))
  // Independent control only: the original image and imported roster stay intact.
  Reflect.set(workspace.compatibility.backupPlans[0]!,'trigger','False')
  const result=runScheduleSimulationBridge(workspace,{sampleHours:hours,warmupHours:0,recordSegments:true,production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'none',seed:42}})
  expect(result.report?.success,JSON.stringify(result.report?.diagnostics)).toBe(true)
  expect(result.report?.production?.success).toBe(true)
  expect(result.report!.elapsedHours).toBeCloseTo(hours,7)
  const activated=new Set(result.report!.events.filter(e=>e.type==='backup-plan'&&e.active).map(e=>e.backupIndex))
  expect(activated.has(0)).toBe(false)
  expect(activated.size).toBeGreaterThanOrEqual(5)
  for(const s of result.report!.segments){
    const ids=[...Object.values(s.occupants),...Object.values(s.bedOccupants)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(Object.values(s.morale).every(m=>Number.isFinite(m)&&m>=0&&m<=24)).toBe(true)
  }
},300000)
