/**
 * Derivative work based on arknights-mower (Plan.vue / SlickOperatorSelect.vue)
 * Original work Copyright (c) 2021 Nano
 * Licensed under the MIT License
 */

export type PolicyOperatorListKey =
  | 'rest_in_full'
  | 'exhaust_require'
  | 'workaholic'
  | 'resting_priority'
  | 'resting_priority_replacement'
  | 'free_room_exclusions'
  | 'resting_standby'
  | 'free_blacklist'
  | 'refresh_trading'
  | 'refresh_drained'
  | 'ope_resting_priority'

export interface PolicyListFieldMeta {
  key: PolicyOperatorListKey
  label: string
  help: string
  placeholder: string
}

export const POLICY_LIST_FIELDS: readonly PolicyListFieldMeta[] = [
  {key:'rest_in_full',label:'需要回满心情的干员',help:'回满目标为当前心情上限。',placeholder:''},
  {key:'exhaust_require',label:'需要用尽心情的干员',help:'用尽按当前心情下限计算，优先取得替班；被占用时先换替班，否则叫回占用组。',placeholder:''},
  {key:'ope_resting_priority',label:'宿舍高优先级干员',help:'高优干员 → 普通主班 → 低优主班 → 高优替班 → 候补 → 普通替班 → 空闲。同级距心情上限更远者优先。只影响分床和单回，不改变下班顺序。动态干员达到个人上限后按空闲级分床和保床，固定宿舍岗位与宿舍保留干员除外。',placeholder:''},
  {key:'resting_priority',label:'宿舍低优先级干员',help:'低于普通主班，高于高优替班；同级距心情上限更远者优先。需有床才能下班，不改变下班顺序。',placeholder:''},
  {key:'resting_priority_replacement',label:'宿舍高优先级替班',help:'仅替班生效，低于低优主班、高于候补；同级距心情上限更远者优先，可接管候补床位。',placeholder:''},
  {key:'resting_standby',label:'宿舍休息候补干员',help:'任意干员均可配置，恢复优先级低于高优替班、高于普通替班，不随心情临时提优。符合待命条件的工作主班有床休息，无床时待命；需有正常优先级主班在休息，绑组随组回班，未绑组随下一批回班。待命不恢复心情；固定宿舍、用尽、回满和零心情工作规则独立生效。',placeholder:''},
  {key:'workaholic',label:'0心情工作的干员',help:'心情涣散状态仍能触发技能的干员。',placeholder:''},
  {key:'free_blacklist',label:'宿舍黑名单',help:'不参与动态分床和补床，固定宿舍岗位不受影响。',placeholder:''},
  {key:'free_room_exclusions',label:'宿舍保留干员',help:'名单内干员保留 Free 宿舍床位，不因满心情而离宿或降低恢复优先级，仍按正常回班及个人心情上限规则离宿。',placeholder:''},
  {key:'refresh_trading',label:'跑单时间刷新干员',help:'贸易站外影响贸易效率、且与贸易站内干员不在同组的干员。上下班后重读订单时间。',placeholder:'可保留 干员(房间) 限定'},
  {key:'refresh_drained',label:'用尽刷新',help:'影响用尽干员心情消耗速率的干员。上下班后重新读取用尽干员的下班时间。',placeholder:''},
] as const
