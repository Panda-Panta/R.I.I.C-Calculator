import {MOWER_INVENTORY_ITEMS} from '../domain/simulationInventory'
import type {RuntimeState} from './rosterRuntime'
import {toMowerMicros} from './mowerTaskQueue'

const inventoryNames=new Set<string>(MOWER_INVENTORY_ITEMS.map(item=>item.name))
const products=new Set(['gold','exp3','orirock','orirock_device','lmd','orundum'])
const roomName=/^(?:room_[1-3]_[1-3]|dormitory_[1-4]|gaming_[1-3]|central|meeting|factory|contact|train|recycle)$/
const fail=(message:string):never=>{throw new Error(`副表：${message}`)}

/** Native 94a observations: a planned facility is not proof that its type was read. */
export function compileMowerBackupQuery(member:string,name?:string):(state:RuntimeState)=>string|number|boolean|null {
  if(member==='facility_product_type_count')return state=>{
    if(!state.mowerFacilityProducts)return fail('缺少设施产物状态')
    return new Set(Object.values(state.mowerFacilityProducts).filter(product=>product!==null&&products.has(product))).size
  }
  if(member==='inventory_count'){
    if(!inventoryNames.has(name!))return fail(`不支持的副表仓库资源：${name}`)
    return state=>{
      const inventory=state.mowerInventoryCounts
      if(!inventory)return fail('缺少库存状态；请预设初始物品数量')
      const count=Object.prototype.hasOwnProperty.call(inventory,name!)?inventory[name!]!:0
      if(!Number.isFinite(count)||count<0)return fail(`库存数量必须为非负有限数：${name}`)
      return count
    }
  }
  if(member==='facility_product_count'){
    if(!products.has(name!))return fail(`不支持的产物或订单类型：${name}`)
    return state=>{
      if(!state.mowerFacilityProducts)return fail('缺少设施产物状态')
      return Object.values(state.mowerFacilityProducts).filter(product=>product===name).length
    }
  }
  if(['facility_product','facility_type','facility_operator_count'].includes(member)){
    if(!roomName.test(name!))return fail(`不支持的设施位置：${name}`)
    return state=>{
      if(member==='facility_type')return state.mowerFacilityTypes&&Object.prototype.hasOwnProperty.call(state.mowerFacilityTypes,name!)?state.mowerFacilityTypes[name!]??null:null
      if(member==='facility_operator_count'){
        const observed=state.mowerSource?.data.operators
        if(observed)return Object.values(observed).filter(operator=>operator.currentRoom===name).length
        const keys=[...state.config.positions,...state.config.beds].filter(position=>position.roomId===name).map(position=>position.id)
        return new Set(keys.flatMap(key=>[state.occupants[key],state.bedOccupants[key]]).filter(Boolean)).size
      }
      const observed=state.mowerFacilityProducts
      if(!observed)return fail('缺少设施产物状态')
      return Object.prototype.hasOwnProperty.call(observed,name!)?observed[name!]??null:null
    }
  }
  if(member==='facility_has_mastery_plan'||member==='facility_is_training'){
    if(name!=='train')return fail(`不支持的训练室位置：${name}`)
    return ()=>false // User contract: no unfinished local plan and no active training.
  }
  return state=>{
    const data=state.mowerSource?.data
    if(!data)return fail('缺少绑组心情观测状态')
    const members=name?data.group(name):[]
    if(!members.length)return fail(`不存在的绑组：${name}`)
    const anchors=members.map(member=>data.operators[member]!).filter(operator=>data.isGroupShiftAnchor(operator))
    if(!anchors.length)return fail(`绑组内没有可统计心情的干员：${name}`)
    const moods=anchors.map(operator=>operator.currentMood(toMowerMicros(state.time)))
    return member==='group_max_mood'?Math.max(...moods):Math.min(...moods)
  }
}
