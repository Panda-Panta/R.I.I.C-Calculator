import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { importMowerJson, resolveOperatorCharId as id } from '../workbench/compat/mowerJson'
import { compileRosterSchedule } from './compileRosterSchedule'
import { compiledScheduleToRuntimeConfig, createRosterRuntime } from './rosterRuntime'
import { createBackupPlanController, evaluateBackupExpression } from './backupPlans'
import { simulateSchedule } from '../simulator/scheduleSimulation'

const source = readFileSync(new URL('../../validation/mower-backup-2026-09-22/roster.json', import.meta.url), 'utf8')
function setup() {
  const schedule = compileRosterSchedule(importMowerJson(source))
  const state = createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
  const controller = createBackupPlanController(schedule, state)
  return { schedule, state, controller }
}
describe('Mower backup source contract', () => {
  it.each([undefined,0,1000])('preserves dorm atmosphere provenance across backup activation and exit: %s', (dormAtmosphere) => {
    const workspace=importMowerJson(source)
    workspace.compatibility.backupPlans=[{trigger:"op_data.operators['阿罗玛'].current_mood() < 10",conf:{exhaust_require:['焰尾']}}]
    const options=dormAtmosphere===undefined?{}:{dormAtmosphere}
    const schedule=compileRosterSchedule(workspace,options),state=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
    const controller=createBackupPlanController(schedule,state)
    const baseDefaults=[...schedule.assumptions.defaultsApplied]
    state.morale[id('阿罗玛')]=1
    controller.evaluate('END')
    expect(controller.active).toEqual([true])
    expect(controller.schedule.assumptions.defaultsApplied).toEqual(baseDefaults)
    expect(controller.schedule.assumptions.dormAtmosphere).toBe(schedule.assumptions.dormAtmosphere)
    expect(controller.schedule.assumptions.defaultsApplied.includes('dormAtmosphere')).toBe(dormAtmosphere===undefined)
    state.morale[id('阿罗玛')]=24
    controller.evaluate('END')
    expect(controller.active).toEqual([false])
    expect(controller.schedule.assumptions.defaultsApplied).toEqual(baseDefaults)
    state.morale[id('阿罗玛')]=1
    controller.evaluate('END')
    expect(controller.active).toEqual([true])
    expect(controller.schedule.assumptions.defaultsApplied).toEqual(baseDefaults)
  })

  it('allows a backup to introduce Fiammetta when the main plan had none', () => {
    const workspace=importMowerJson(source)
    const dorm=Object.values(workspace.mainPlan.facilities).find(room=>room.slots.some(slot=>slot.occupant.kind==='operator'&&id(slot.occupant.operatorId)===id('菲亚梅塔')))!
    const index=dorm.slots.findIndex(slot=>slot.occupant.kind==='operator'&&id(slot.occupant.operatorId)===id('菲亚梅塔'))
    dorm.slots[index]={occupant:{kind:'free'},groupId:null,replacements:[]}
    workspace.compatibility.backupPlans=[{trigger:'True',plan:{[dorm.roomId]:{plans:Array.from({length:index+1},(_,i)=>({agent:i===index?'菲亚梅塔':'Current',replacement:i===index?['阿罗玛']:[],group:''}))}}}]
    const schedule=compileRosterSchedule(workspace),state=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
    expect(state.config.fiammetta).toBeUndefined()
    createBackupPlanController(schedule,state).evaluate('END')
    expect(state.config.fiammetta?.operatorId).toBe(id('菲亚梅塔'))
  })
  it('merges overlapping slots in source order and restores earlier layers on exit', () => {
    const workspace=importMowerJson(source)
    const condition=(name:string)=>({left:`op_data.operators['${name}'].current_mood()`,operator:'<',right:'10'})
    const plan=(agent:string)=>({dormitory_1:{plans:[{agent,replacement:[],group:''}]}})
    workspace.compatibility.backupPlans=[{trigger:condition('阿罗玛'),plan:plan('芬')},{trigger:condition('远牙'),plan:plan('香草')},{trigger:'True',plan:plan('Current')}]
    const schedule=compileRosterSchedule(workspace),state=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule)),controller=createBackupPlanController(schedule,state)
    state.morale[id('阿罗玛')]=1;state.morale[id('远牙')]=1
    controller.evaluate('END')
    expect(state.config.positions.find(p=>p.id==='dormitory_1_0')?.primary).toBe(id('香草'))
    state.morale[id('远牙')]=24;controller.evaluate('END')
    expect(state.config.positions.find(p=>p.id==='dormitory_1_0')?.primary).toBe(id('芬'))
    state.morale[id('阿罗玛')]=24;controller.evaluate('END')
    expect(state.config.positions.find(p=>p.id==='dormitory_1_0')?.primary).toBe(schedule.rooms.find(r=>r.roomId==='dormitory_1')!.slots[0]!.primaryOperatorId)
  })
  it('rejects non-finite arithmetic without committing a changed activation', () => {
    const workspace=importMowerJson(source)
    workspace.compatibility.backupPlans=[{trigger:{left:'1',operator:'/',right:'0'}}]
    const schedule=compileRosterSchedule(workspace),state=createRosterRuntime(compiledScheduleToRuntimeConfig(schedule)),controller=createBackupPlanController(schedule,state)
    const before=structuredClone(state)
    expect(()=>controller.evaluate('END')).toThrow('有限数')
    expect(state).toEqual(before)
    expect(controller.active).toEqual([false])
  })
  it('does not mutate a compiled schedule across repeated simulations', () => {
    const schedule=compileRosterSchedule(importMowerJson(source)),before=structuredClone(schedule)
    const options={sampleHours:8,recordSegments:true}
    const first=simulateSchedule(schedule,options)
    expect(schedule).toEqual(before)
    expect(simulateSchedule(schedule,options)).toEqual(first)
  })
  it.each(Array.from({ length: 9 }, (_, i) => i))('executes real backup %i only when its condition becomes true', index => {
    const workspace = importMowerJson(source)
    const raw = JSON.parse(source).backup_plans[index]
    workspace.compatibility.backupPlans = [raw]
    const schedule = compileRosterSchedule(workspace)
    const state = createRosterRuntime(compiledScheduleToRuntimeConfig(schedule))
    const controller = createBackupPlanController(schedule, state)
    controller.evaluate('END')
    expect(controller.active).toEqual([false])
    const move = (name: string, slot: string, dorm: boolean) => {
      for (const [key,value] of Object.entries(state.occupants)) if(value===id(name)) delete state.occupants[key]
      for (const [key,value] of Object.entries(state.bedOccupants)) if(value===id(name)) delete state.bedOccupants[key]
      if(dorm)state.bedOccupants[slot]=id(name);else state.occupants[slot]=id(name)
    }
    if(index===0||index===3)move('薇薇安娜','dormitory_1_4',true)
    if(index===1)move('森蚺','dormitory_1_4',true)
    if(index===2)move('令','dormitory_1_4',true)
    if(index===4){move('阿罗玛','dormitory_1_4',true);state.morale[id('歌蕾蒂娅')]=1;state.morale[id('菲亚梅塔')]=0}
    if(index===5)state.morale[id('薇薇安娜')]=1
    if(index===6||index===7)move('娜斯提','factory_0',false)
    if(index===8)move('歌蕾蒂娅','dormitory_1_4',true)
    const morale={...state.morale},occupants={...state.occupants},beds={...state.bedOccupants}
    controller.evaluate('END')
    expect(controller.active).toEqual([true])
    expect(state.morale).toEqual(morale)
    // Native backup_plan_solver generates tasks; agent_arrange executes them in a later run.
    expect(state.occupants).toEqual(occupants);expect(state.bedOccupants).toEqual(beds)
    const generated=state.mowerBackupGenerated??[]
    if(Object.keys(raw.task).length)expect(generated.map(t=>t.plan)).toContainEqual(Object.fromEntries((Object.entries(raw.task) as [string,string[]][]).map(([room,names])=>[room,names.map(name=>name==='Current'||name==='Free'?name:id(name))])))
    const conf=controller.schedule.policies
    for(const key of ['exhaust_require','resting_priority','workaholic','free_blacklist']){
      for(const name of (raw.conf[key] as string).split(',').filter(Boolean))expect(conf[key]).toContain(id(name))
    }
    const ids=[...Object.values(state.occupants),...Object.values(state.bedOccupants)]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('does not rewrite a generated forced task when only a policy-only plan changes', () => {
    const { state, controller }=setup()
    const p=state.config.positions.find(p=>p.primary===id('薇薇安娜'))!
    delete state.occupants[p.id];state.bedOccupants.dormitory_1_4=p.primary
    controller.evaluate('END')
    const forced=(state.mowerBackupGenerated??[]).find(t=>Object.values(t.plan).flat().includes(id('多萝西')))!
    expect(forced).toBeDefined();const plan=structuredClone(forced.plan)
    state.morale[id('远牙')]=1
    controller.evaluate('END')
    expect(forced.plan).toEqual(plan)
  })
  it('reads actual position and mood, rejects executable text', () => {
    const { state } = setup()
    expect(evaluateBackupExpression("op_data.operators['阿罗玛'].is_working()", state)).toBe(true)
    expect(() => evaluateBackupExpression('globalThis.process.exit()', state)).toThrow()
  })
  it('activates policy-only plan at END, unions policies, and restores on exit', () => {
    const { state, controller } = setup()
    state.morale[id('远牙')] = 23
    state.morale[id('薇薇安娜')] = 20
    controller.evaluate('BEFORE_PLANNING')
    expect(controller.active[5]).toBe(false)
    controller.evaluate('END')
    expect(controller.active[5]).toBe(true)
    expect(state.config.positions.find(p => p.primary === id('远牙'))?.restingPriority).toBe('low')
    expect(state.config.positions.find(p => p.primary === id('阿罗玛'))?.exhaustRequired).toBe(true)
    state.morale[id('远牙')] = 1
    controller.evaluate('END')
    expect(controller.active[5]).toBe(false)
    expect(state.config.positions.find(p => p.primary === id('远牙'))?.restingPriority).toBe('high')
  })
  it('executes forced dorm task once per activation without resetting morale', () => {
    const { state, controller } = setup()
    const p = state.config.positions.find(p => p.primary === id('森蚺'))!
    delete state.occupants[p.id]
    state.bedOccupants.dormitory_2_2 = p.primary
    state.morale[id('苍苔')] = 7
    controller.evaluate('BEFORE_PLANNING')
    expect(controller.active[1]).toBe(true)
    expect(state.mowerBackupGenerated?.[0]?.plan.dormitory_3).toEqual(['Current','Current','Current',id('苍苔'),id('引星棘刺')])
    expect(state.morale[id('苍苔')]).toBe(7)
    const count = state.events.length
    controller.evaluate('BEFORE_PLANNING')
    expect(state.events).toHaveLength(count)
    const ids = [...Object.values(state.occupants), ...Object.values(state.bedOccupants)]
    expect(new Set(ids).size).toBe(ids.length)
  })
})
