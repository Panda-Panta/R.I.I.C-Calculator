/** @vitest-environment jsdom */
import {beforeEach,describe,expect,it} from 'vitest'
import {mount} from '@vue/test-utils'
import {createPinia,setActivePinia} from 'pinia'
import {NSelect,NTabs} from 'naive-ui'
import BackupPlanEditor from './BackupPlanEditor.vue'
import {useRosterWorkbenchStore} from '../../workbench/store'
import {createDefaultBackupPlan} from '../../workbench/backupPlanHelpers'
import {validateRosterWorkspace} from '../../workbench/validate'

beforeEach(()=>setActivePinia(createPinia()))
describe('new backup tasks respect established facility slots',()=>{
  it.each([
    ['room_1_1',1,1],['room_1_1',2,2],['train',3,2],['recycle',1,1],['recycle',3,2],
  ] as const)('creates %s level%i with %i task slots',(room,level,count)=>{
    const store=useRosterWorkbenchStore()
    store.workspace.mainPlan.facilities[room].level=level
    store.workspace.mainPlan.facilities[room].slots=Array.from({length:count},()=>({occupant:{kind:'empty' as const},groupId:null,replacements:[]}))
    store.workspace.compatibility.backupPlans=[createDefaultBackupPlan()]
    expect(validateRosterWorkspace(store.workspace).isValid).toBe(true)
    const wrapper=mount(BackupPlanEditor)
    wrapper.findComponent(NTabs).vm.$emit('update:value','task')
    return wrapper.vm.$nextTick().then(async()=>{
      wrapper.findAllComponents(NSelect).find(select=>select.attributes('data-test')==='add-task-facility-select')!.vm.$emit('update:value',room)
      await wrapper.vm.$nextTick()
      await wrapper.find('[data-test="add-task-facility-btn"]').trigger('click')
      const plan=store.workspace.compatibility.backupPlans[0] as {task:Record<string,string[]>}
      expect(plan.task[room]).toEqual(Array(count).fill('Current'))
      expect(wrapper.findAll(`[data-test^="task-slot-${room}-"]`)).toHaveLength(count)
      expect(validateRosterWorkspace(store.workspace).isValid).toBe(true)
      wrapper.unmount()
    })
  })
  it('keeps an imported two-slot task visible even if the current facility is smaller',async()=>{
    const store=useRosterWorkbenchStore()
    store.workspace.mainPlan.facilities.recycle.level=1
    store.workspace.mainPlan.facilities.recycle.slots=[{occupant:{kind:'empty'},groupId:null,replacements:[]}]
    store.workspace.compatibility.backupPlans=[{...createDefaultBackupPlan(),task:{recycle:['芬','香草']}}]
    const wrapper=mount(BackupPlanEditor)
    wrapper.findComponent(NTabs).vm.$emit('update:value','task')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="task-slot-recycle-1"]').exists()).toBe(true)
    expect(validateRosterWorkspace(store.workspace).isValid).toBe(false)
    wrapper.unmount()
  })
  it('creates two training task positions established by a valid backup-only overlay',async()=>{
    const store=useRosterWorkbenchStore()
    store.workspace.mainPlan.facilities.train.level=0
    store.workspace.mainPlan.facilities.train.slots=[]
    delete (store.workspace.compatibility.unrecognizedFields.facility_levels as Record<string,unknown>|undefined)?.train
    store.workspace.compatibility.backupPlans=[{...createDefaultBackupPlan(),plan:{train:{plans:[{agent:'芬'},{agent:'香草'}]}}}]
    expect(validateRosterWorkspace(store.workspace).isValid).toBe(true)
    const wrapper=mount(BackupPlanEditor)
    wrapper.findComponent(NTabs).vm.$emit('update:value','task')
    await wrapper.vm.$nextTick()
    const select=wrapper.findAllComponents(NSelect).find(item=>item.attributes('data-test')==='add-task-facility-select')!
    expect(select.props('options')).toContainEqual(expect.objectContaining({value:'train'}))
    select.vm.$emit('update:value','train')
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-test="add-task-facility-btn"]').trigger('click')
    expect((store.workspace.compatibility.backupPlans[0] as {task:Record<string,string[]>}).task.train).toEqual(['Current','Current'])
    expect(validateRosterWorkspace(store.workspace).isValid).toBe(true)
    expect(store.workspace.mainPlan.facilities.train).toMatchObject({level:0,slots:[]})
    wrapper.unmount()
  })
})
