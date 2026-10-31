import { describe, expect, it } from 'vitest'
import { hasContinuousMowerWorkaholicPolicy, hasMeasuredPermanentPrimaryDuty } from './permanentDutyEvidence'
import {createDefaultWorkspace} from '../workbench/defaults'
import {compileRosterSchedule} from '../scheduler/compileRosterSchedule'

describe('measured permanent duty evidence', () => {
  it('requires the measured own-primary counter to cover every positive physical duty hour', () => {
    expect(hasMeasuredPermanentPrimaryDuty({ workHours: 12, exhaustedHours: 46, permanentPrimaryOccupancyHours: 58 })).toBe(true)
    expect(hasMeasuredPermanentPrimaryDuty({ workHours: 0, exhaustedHours: 72, permanentPrimaryOccupancyHours: 72 })).toBe(true)
    // A further substitute/nonpermanent hour is physical work that this counter does not prove.
    expect(hasMeasuredPermanentPrimaryDuty({ workHours: 13, exhaustedHours: 46, permanentPrimaryOccupancyHours: 58 })).toBe(false)
    expect(hasMeasuredPermanentPrimaryDuty({ workHours: 12, exhaustedHours: 46 })).toBe(false)
  })

  it('uses the existing 1e-5-hour comparison tolerance on measured coverage', () => {
    expect(hasMeasuredPermanentPrimaryDuty({ workHours: 12, exhaustedHours: 46, permanentPrimaryOccupancyHours: 58 + 5e-6 })).toBe(true)
    expect(hasMeasuredPermanentPrimaryDuty({ workHours: 12, exhaustedHours: 46, permanentPrimaryOccupancyHours: 58 - 2e-5 })).toBe(false)
  })

  it.each([
    { workHours: 0, exhaustedHours: 0, permanentPrimaryOccupancyHours: 0 },
    { workHours: -1, exhaustedHours: 47, permanentPrimaryOccupancyHours: 46 },
    { workHours: 47, exhaustedHours: -1, permanentPrimaryOccupancyHours: 46 },
    { workHours: NaN, exhaustedHours: 46, permanentPrimaryOccupancyHours: 58 },
    { workHours: 12, exhaustedHours: Infinity, permanentPrimaryOccupancyHours: 58 },
    { workHours: 12, exhaustedHours: 46, permanentPrimaryOccupancyHours: NaN },
    { workHours: 12, exhaustedHours: 46, permanentPrimaryOccupancyHours: Infinity },
    { workHours: 12, exhaustedHours: 46, permanentPrimaryOccupancyHours: -58 },
    { workHours: Number.MAX_VALUE, exhaustedHours: Number.MAX_VALUE, permanentPrimaryOccupancyHours: Number.MAX_VALUE },
  ])('rejects absent, nonpositive or invalid physical coverage %#', value => {
    expect(hasMeasuredPermanentPrimaryDuty(value)).toBe(false)
  })
})

const lancet='char_285_medic2'
function policySchedule(){
 const workspace=createDefaultWorkspace();workspace.mainPlan.conf.workaholic=[lancet]
 workspace.compatibility.backupPlans=[{name:'primary change',trigger:'True',plan:{room_2_3:{plans:[{agent:'埃癸斯',replacement:[]}]}},conf:{workaholic:'',removed_operators:{}}}]
 return compileRosterSchedule(workspace)
}

describe('continuous Mower workaholic evidence',()=>{
 it('proves a base name across empty and primary-changing layers without changing any report input',()=>{
  const schedule=policySchedule(),before=structuredClone(schedule)
  schedule.sourceWorkspace.compatibility.backupPlans.push({name:'no conf',trigger:'True',plan:{}})
  before.sourceWorkspace.compatibility.backupPlans.push({name:'no conf',trigger:'True',plan:{}})
  expect(hasContinuousMowerWorkaholicPolicy(schedule,lancet)).toBe(true)
  expect(schedule).toEqual(before)
 })
 it('uses the Native alias/comma parsing for original policy and permits unrelated removals',()=>{
  const schedule=policySchedule()
  Reflect.set(schedule.sourceWorkspace.mainPlan.conf,'workaholic','Lancet-2，Lancet-2')
  Reflect.set(schedule.rawConf,'workaholic','Lancet-2')
  schedule.sourceWorkspace.compatibility.backupPlans=[{name:'unrelated removal',conf:{workaholic:['Lancet-2'],removed_operators:{workaholic:'阿米娅'}}}]
  expect(hasContinuousMowerWorkaholicPolicy(schedule,'Lancet-2')).toBe(true)
 })
 it.each(['Lancet-2',lancet,['阿米娅',lancet]])('rejects any possible removal, including removal winning over an addition: %s',removed=>{
  const schedule=policySchedule()
  schedule.sourceWorkspace.compatibility.backupPlans.push({name:'conditional removal',trigger:'True',conf:{workaholic:'Lancet-2',removed_operators:{workaholic:removed}}})
  expect(hasContinuousMowerWorkaholicPolicy(schedule,lancet)).toBe(false)
 })
 it('does not infer base permission from a backup-only addition or compiled-only policy',()=>{
  const schedule=policySchedule();schedule.sourceWorkspace.mainPlan.conf.workaholic=[]
  schedule.sourceWorkspace.compatibility.backupPlans=[{name:'addition only',conf:{workaholic:'Lancet-2'}}]
  expect(hasContinuousMowerWorkaholicPolicy(schedule,lancet)).toBe(false)
 })
 it.each(['compiled','native-raw','original'] as const)('requires agreement with the %s base policy',which=>{
  const schedule=policySchedule()
  if(which==='compiled')schedule.policies.workaholic=[]
  if(which==='native-raw')schedule.rawConf.workaholic=[]
  if(which==='original')schedule.sourceWorkspace.mainPlan.conf.workaholic=[]
  expect(hasContinuousMowerWorkaholicPolicy(schedule,lancet)).toBe(false)
 })
 it.each(['source','backups','compatibility-fields','version','raw-conf'] as const)('rejects missing/unknown original structure: %s',which=>{
  const schedule=policySchedule()
  if(which==='source')Reflect.deleteProperty(schedule,'sourceWorkspace')
  if(which==='backups')Reflect.deleteProperty(schedule.sourceWorkspace.compatibility,'backupPlans')
  if(which==='compatibility-fields')Reflect.deleteProperty(schedule.sourceWorkspace.compatibility,'unrecognizedFields')
  if(which==='version')Reflect.set(schedule.sourceWorkspace,'schemaVersion',999)
  if(which==='raw-conf')Reflect.deleteProperty(schedule,'rawConf')
  expect(hasContinuousMowerWorkaholicPolicy(schedule,lancet)).toBe(false)
 })
 it.each([null,{conf:null},{conf:{workaholic:42}},{conf:{workaholic:'unknown-person'}},{conf:{removed_operators:{workaholic:'unknown-person'}}},{conf:{removed_operators:[]}},{conf:{removed_operators:{unknown_policy:'Lancet-2'}}},{plan:[]}])('does not certify malformed backup policy %#',raw=>{
  const schedule=policySchedule();schedule.sourceWorkspace.compatibility.backupPlans=[raw]
  expect(hasContinuousMowerWorkaholicPolicy(schedule,lancet)).toBe(false)
 })
 it('does not certify an unknown operator identity',()=>{
  expect(hasContinuousMowerWorkaholicPolicy(policySchedule(),'unknown-person')).toBe(false)
 })
})
