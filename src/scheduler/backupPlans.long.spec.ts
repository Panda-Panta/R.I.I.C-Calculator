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

it.each([24,168])('executes real backups and production continuously for %i hours', hours => {
  const workspace=importMowerJson(readFileSync(new URL('roster.json',directory),'utf8'))
  const result=runScheduleSimulationBridge(workspace,{sampleHours:hours,warmupHours:0,recordSegments:true,production:{outputMode:'potential',runOrderMode:'ideal',droneTarget:'none',seed:42}})
  writeFileSync(new URL(`production-${hours}h.json`,directory),JSON.stringify(result,null,2))
  expect(result.error).toBeUndefined()
  expect(result.report?.success,JSON.stringify(result.report?.diagnostics)).toBe(true)
  expect(result.report?.production?.success,JSON.stringify(result.report?.diagnostics)).toBe(true)
  expect(result.report!.elapsedHours).toBeCloseTo(hours,7)
  const activated=new Set(result.report!.events.filter(e=>e.type==='backup-plan'&&e.active).map(e=>e.backupIndex))
  if(hours===168)expect([...activated].sort()).toEqual([0,1,2,3,4,5,6,7,8])
  else expect(activated.size).toBeGreaterThanOrEqual(5)
  for(const s of result.report!.segments){
    const ids=[...Object.values(s.occupants),...Object.values(s.bedOccupants)]
    expect(new Set(ids).size).toBe(ids.length)
    expect(Object.values(s.morale).every(m=>Number.isFinite(m)&&m>=0&&m<=24)).toBe(true)
  }
},120000)
