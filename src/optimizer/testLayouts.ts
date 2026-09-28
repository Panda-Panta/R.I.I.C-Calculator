import { OPERATORS } from '../domain/operators'
import { type OwnedOperatorInput } from '../domain/operatorInventory'
import { createDefaultWorkspace } from '../workbench/defaults'
import { restoreOperatorMowerName } from '../workbench/compat/mowerJson'
import { runSmartRoster } from './smartRoster'
import { validatePhysicalRoster } from './rosterDraft'
import { validateRosterWorkspace } from '../workbench/validate'
import type { RosterWorkspace } from '../workbench/model'

const allOwned: OwnedOperatorInput[] = OPERATORS.map((o) => ({
  operator: o.name,
  elitePhase: o.rarity < 3 ? 0 : o.rarity === 3 ? 1 : 2,
  level: o.rarity < 3 ? 30 : o.rarity === 3 ? 55 : o.rarity === 4 ? 70 : o.rarity === 5 ? 80 : 90,
}))

function printRosterDetails(label: string, ws: RosterWorkspace, score: number | null) {
  console.log(`\n=======================================================`)
  console.log(`【${label}】自动排班测试报告 (综合 82 评分: ${score?.toFixed(1) ?? 'N/A'} 分/日)`)
  console.log(`=======================================================`)

  console.log(`\n--- 产出设施主班与替班分布 ---`)
  for (const room of Object.values(ws.mainPlan.facilities)) {
    if (['manufacture', 'trading', 'power', 'central', 'contact'].includes(room.type)) {
      const occupants = room.slots
        .filter((s) => s.occupant.kind === 'operator')
        .map((s) => {
          const name = restoreOperatorMowerName(s.occupant.kind === 'operator' ? s.occupant.operatorId : '')
          const backups = s.replacements.map(restoreOperatorMowerName).join('/')
          const grp = s.groupId ? ` [组: ${s.groupId}]` : ''
          return `${name}${backups ? ` (替: ${backups})` : ''}${grp}`
        })
      const prod = room.product ? ` [配方: ${room.product}]` : ''
      console.log(`  ${room.roomId} (${room.type} Lv.${room.level}${prod}): ${occupants.join(', ') || '(空)'}`)
    }
  }

  console.log(`\n--- 宿舍人员分布 ---`)
  for (const room of Object.values(ws.mainPlan.facilities)) {
    if (room.type === 'dormitory') {
      const dormResidents = room.slots
        .map((s) => (s.occupant.kind === 'operator' ? restoreOperatorMowerName(s.occupant.operatorId) : s.occupant.kind === 'free' ? '[空床位Free]' : '(空)'))
      console.log(`  ${room.roomId} (Lv.${room.level}): ${dormResidents.join(', ')}`)
    }
  }

  console.log(`\n--- Mower Conf 策略生成 ---`)
  const conf = ws.mainPlan.conf
  console.log(`  exhaust_require (耗尽替换): ${conf.exhaust_require.map(restoreOperatorMowerName).join(', ') || '无'}`)
  console.log(`  rest_in_full (满心情上班): ${conf.rest_in_full.map(restoreOperatorMowerName).join(', ') || '无'}`)
  console.log(`  workaholic (0心情工作/禁宿舍): ${conf.workaholic.map(restoreOperatorMowerName).join(', ') || '无'}`)
  console.log(`  resting_priority (宿舍低优): ${conf.resting_priority.map(restoreOperatorMowerName).join(', ') || '无'}`)
  console.log(`  ope_resting_priority (宿舍高优): ${conf.ope_resting_priority.map(restoreOperatorMowerName).join(', ') || '无'}`)

  console.log(`\n--- 规则与约束合规性检查 ---`)
  const allMains = Object.values(ws.mainPlan.facilities).flatMap((r) =>
    r.slots.flatMap((s) => (s.occupant.kind === 'operator' ? [restoreOperatorMowerName(s.occupant.operatorId)] : [])),
  )
  const allMainsSet = new Set(allMains)

  const tradingRooms = Object.values(ws.mainPlan.facilities).filter((r) => r.type === 'trading')
  const tradeOps = tradingRooms.flatMap((r) =>
    r.slots.map((s) => (s.occupant.kind === 'operator' ? restoreOperatorMowerName(s.occupant.operatorId) : '')),
  )

  // 1. 跑单干员检查
  const shiftRunForbidden = ['但书', '龙舌兰', '空']
  const forbiddenFound = shiftRunForbidden.filter((op) => tradeOps.includes(op))
  console.log(`  [自动排班规范] 贸易站主班排除但书/龙舌兰/空: ${forbiddenFound.length === 0 ? '✅ 通过' : `❌ 发现违规: ${forbiddenFound.join(', ')}`}`)

  // 2. 鸿雪4杜林检查
  if (allMainsSet.has('鸿雪')) {
    const durins = ['杜林', '桃金娘', '褐果', '至简']
    const presentDurins = durins.filter((d) => allMainsSet.has(d))
    console.log(`  [鸿雪组规范] 4杜林在基建: ${presentDurins.length === 4 ? `✅ 通过 (${presentDurins.join(', ')})` : `❌ 缺失: 仅有 ${presentDurins.join(', ')}`}`)
  }

  // 3. 深海猎人检查
  if (allMainsSet.has('歌蕾蒂娅')) {
    const abyssal = ['歌蕾蒂娅', '斯卡蒂', '乌尔比安', '安哲拉', '幽灵鲨']
    const presentAbyssal = abyssal.filter((a) => allMainsSet.has(a))
    console.log(`  [深海猎人规范] 5人全核心在岗: ${presentAbyssal.length === 5 ? `✅ 通过 (${presentAbyssal.join(', ')})` : `❌ 缺失: 仅有 ${presentAbyssal.join(', ')}`}`)
    const lowPriorityCheck = ['乌尔比安', '斯卡蒂', '幽灵鲨', '安哲拉'].every((op) =>
      conf.resting_priority.map(restoreOperatorMowerName).includes(op),
    )
    console.log(`  [深海宿舍策略] 4制造干员宿舍低优先: ${lowPriorityCheck ? '✅ 通过' : '❌ 失败'}`)
  }

  // 4. 红云酒神猫猫检查
  if (allMainsSet.has('红云') && allMainsSet.has('酒神')) {
    const vdm = ['红云', '酒神', 'Miss.Christine']
    const expRooms = Object.values(ws.mainPlan.facilities).filter((r) => r.type === 'manufacture' && r.product === 'exp')
    const boundRoom = expRooms.find((r) =>
      vdm.every((m) => r.slots.some((s) => s.occupant.kind === 'operator' && restoreOperatorMowerName(s.occupant.operatorId) === m)),
    )
    console.log(`  [红云酒神猫猫] 3人强行同站绑定: ${boundRoom ? `✅ 通过 (进驻于 ${boundRoom.roomId})` : '❌ 失败'}`)
  }

  // 5. 自动化检查
  if (allMainsSet.has('温蒂')) {
    const powerCount = Object.values(ws.mainPlan.facilities).filter((r) => r.type === 'power').length
    if (powerCount === 2) {
      const lancetInWorkaholic = conf.workaholic.map(restoreOperatorMowerName).includes('Lancet-2')
      const eunectesInCentral = ws.mainPlan.facilities.central.slots.some(
        (s) => s.occupant.kind === 'operator' && restoreOperatorMowerName(s.occupant.operatorId) === '森蚺',
      )
      console.log(`  [2电自动化] Lancet-2进workaholic禁宿舍: ${lancetInWorkaholic ? '✅ 通过' : '❌ 失败'}`)
      console.log(`  [2电自动化] 森蚺进驻控制中枢: ${eunectesInCentral ? '✅ 通过' : '❌ 失败'}`)
    }
  }

  // 6. 完整排班校验与诊断 (validateRosterWorkspace)
  const validation = validateRosterWorkspace(ws)
  console.log(`  [排班校验诊断] 严重错误: ${validation.criticalErrors.length === 0 ? '✅ 0' : `❌ ${validation.criticalErrors.map((e) => e.message).join('；')}`}`)
  console.log(`  [排班校验诊断] 警告数量: ${validation.warnings.length === 0 ? '✅ 0 (完美无警告)' : `❌ ${validation.warnings.length} 个警告: ${validation.warnings.map((w) => w.message).join('；')}`}`)

  // 7. 菲亚梅塔替补（3名高产出干员）检查
  const fiamSlot = Object.values(ws.mainPlan.facilities)
    .filter((r) => r.type === 'dormitory')
    .flatMap((r) => r.slots)
    .find((s) => s.occupant.kind === 'operator' && restoreOperatorMowerName(s.occupant.operatorId) === '菲亚梅塔')
  if (fiamSlot) {
    const fiamReps = fiamSlot.replacements.map(restoreOperatorMowerName)
    console.log(`  [菲亚梅塔机制] 配置替补人数: ${fiamReps.length === 3 ? `✅ 3人 (${fiamReps.join(', ')})` : `❌ 异常: ${fiamReps.length}人`}`)
  }

  // 8. 宿舍 Free 床位 > 最大组合人数检查
  const groupCounts = new Map<string, number>()
  for (const r of Object.values(ws.mainPlan.facilities)) {
    if (r.type === 'dormitory') continue
    for (const s of r.slots) {
      if (s.occupant.kind === 'operator' && s.groupId) {
        groupCounts.set(s.groupId, (groupCounts.get(s.groupId) ?? 0) + 1)
      }
    }
  }
  const maxGroupSize = Math.max(0, ...groupCounts.values(), 1)
  const freeBeds = Object.values(ws.mainPlan.facilities)
    .filter((r) => r.type === 'dormitory')
    .reduce((sum, r) => sum + r.slots.filter((s) => s.occupant.kind === 'free').length, 0)
  console.log(`  [宿舍Free床位规范] Free床位数(${freeBeds}) > 最大组合人数(${maxGroupSize}): ${freeBeds > maxGroupSize ? `✅ 通过 (余量: +${freeBeds - maxGroupSize})` : `❌ 不合规`}`)

  // 9. 温蒂与清流同组绑定检查
  if (allMainsSet.has('温蒂')) {
    const goldRooms = Object.values(ws.mainPlan.facilities).filter((r) => r.type === 'manufacture' && r.product === 'gold')
    const wendyRoom = goldRooms.find((r) => r.slots.some((s) => s.occupant.kind === 'operator' && restoreOperatorMowerName(s.occupant.operatorId) === '温蒂'))
    const purestreamInWendyRoom = wendyRoom?.slots.some((s) => s.occupant.kind === 'operator' && restoreOperatorMowerName(s.occupant.operatorId) === '清流')
    console.log(`  [自动化温蒂清流同组] 温蒂与清流同站进驻: ${purestreamInWendyRoom ? `✅ 通过 (${wendyRoom?.roomId})` : '❌ 失败'}`)
  }

  // 10. 物理完整性检查
  const physErrors = validatePhysicalRoster(ws)
  console.log(`  [基建物理排班验证] 错误数: ${physErrors.length === 0 ? '✅ 0 (排班完全合法)' : `❌ ${physErrors.map((e) => e.message).join('；')}`}`)
}

async function runTests() {
  // ----------------------------------------------------
  // Test 1: Standard 243 Layout (2 Trading, 4 Manufacture [2 gold, 2 exp], 3 Power)
  // ----------------------------------------------------
  console.log('\n>>> 正在启动 243 布局自动排班计算与 24h+72h 仿真 (Trials=3, SimTopK=2)...')
  const base243 = createDefaultWorkspace()
  // 2 gold, 2 exp manufacture
  base243.mainPlan.facilities.room_1_1.product = 'gold'
  base243.mainPlan.facilities.room_1_2.product = 'gold'
  base243.mainPlan.facilities.room_2_1.product = 'exp'
  base243.mainPlan.facilities.room_2_2.product = 'exp'

  const result243 = runSmartRoster(base243, allOwned, {
    trials: 3,
    simulationTopK: 2,
    simulationWarmupHours: 24,
    simulationSampleHours: 72,
    enableDeepSearch: false,
    seed: 42,
  })

  if (result243.workspace) {
    printRosterDetails('标准 243 布局 (2贸4造3电)', result243.workspace, result243.score)
  } else {
    console.error('243 排班生成失败：', result243.diagnostics)
  }

  // ----------------------------------------------------
  // Test 2: Standard 252 Layout (2 Trading [1 Lv.3, 1 Lv.2], 5 Manufacture [3 gold, 2 exp], 2 Power)
  // ----------------------------------------------------
  console.log('\n>>> 正在启动 252 布局自动排班计算与 24h+72h 仿真 (Trials=3, SimTopK=2)...')
  const base252 = createDefaultWorkspace()
  // room_3_3 is converted to manufacture
  base252.mainPlan.facilities.room_3_3 = {
    roomId: 'room_3_3',
    type: 'manufacture',
    level: 3,
    product: 'exp',
    slots: Array.from({ length: 3 }, () => ({ occupant: { kind: 'empty' }, groupId: null, replacements: [] })),
  }
  // 5 manufacture: 3 gold, 2 exp
  base252.mainPlan.facilities.room_1_1.product = 'gold'
  base252.mainPlan.facilities.room_1_2.product = 'gold'
  base252.mainPlan.facilities.room_2_1.product = 'gold'
  base252.mainPlan.facilities.room_2_2.product = 'exp'
  base252.mainPlan.facilities.room_3_3.product = 'exp'

  // room_3_1 trading level 2 (2 seats), room_3_2 trading level 3 (3 seats)
  base252.mainPlan.facilities.room_3_1.level = 2

  // Balance power in 252: dormitories & functional rooms level 1
  for (const room of Object.values(base252.mainPlan.facilities)) {
    if (room.type === 'dormitory' || room.type === 'contact' || room.type === 'factory' || room.type === 'train') {
      room.level = 1
    }
  }

  const result252 = runSmartRoster(base252, allOwned, {
    trials: 3,
    simulationTopK: 2,
    simulationWarmupHours: 24,
    simulationSampleHours: 72,
    enableDeepSearch: false,
    seed: 777,
  })

  if (result252.workspace) {
    printRosterDetails('标准 252 布局 (2贸5造2电)', result252.workspace, result252.score)
  } else {
    console.error('252 排班生成失败：', result252.diagnostics)
  }
}

runTests().catch(console.error)
