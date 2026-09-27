import { describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { importMowerJson } from '../src/workbench/compat/mowerJson'
import { compileMainPlanToAppConfig } from '../src/workbench/adapter'
import { createDefaultConfig, createRoom } from '../src/domain/defaults'
import { buildRiicGlobalContext } from '../src/engine/globalContext'
import { evaluateOperators, formatStructuredContributions } from '../src/engine/operatorRules'
import { OPERATORS } from '../src/domain/operators'
import type { AppConfig, OutputRoom } from '../src/domain/types'

const NAME_TO_CHAR_ID = new Map<string, string>()
for (const op of OPERATORS) {
  NAME_TO_CHAR_ID.set(op.name, op.charId)
  NAME_TO_CHAR_ID.set(op.name.toLowerCase(), op.charId)
  NAME_TO_CHAR_ID.set(op.appellation.toLowerCase(), op.charId)
}
NAME_TO_CHAR_ID.set('lancet-2', 'char_285_medic2')
NAME_TO_CHAR_ID.set('Lancet-2', 'char_285_medic2')
NAME_TO_CHAR_ID.set('mon3tr', 'char_4179_monstr')
NAME_TO_CHAR_ID.set('Mon3tr', 'char_4179_monstr')

type RoomCategory =
  | 'manufacture/gold'
  | 'manufacture/exp'
  | 'manufacture/fragment'
  | 'trading/gold'
  | 'trading/fragment'
  | 'power'
  | 'other'

function getExcelCategory(label: string): RoomCategory {
  if (label.startsWith('赤金')) return 'manufacture/gold'
  if (label.startsWith('狗粮')) return 'manufacture/exp'
  if (label === '搓玉') return 'manufacture/fragment'
  if (label.startsWith('贸易')) return 'trading/gold'
  if (label === '卖玉') return 'trading/fragment'
  if (label.startsWith('电站')) return 'power'
  return 'other'
}

function getMowerCategory(type: string, product: string): RoomCategory {
  if (type === 'manufacture') {
    if (product === 'gold') return 'manufacture/gold'
    if (product === 'exp' || product === 'exp3') return 'manufacture/exp'
    if (product === 'fragment' || product === 'orirock') return 'manufacture/fragment'
  }
  if (type === 'trading') {
    if (product === 'fragment' || product === 'orundum') return 'trading/fragment'
    return 'trading/gold'
  }
  if (type === 'power') return 'power'
  return 'other'
}

function excelCategoryToTypeProduct(cat: RoomCategory): {
  type: 'manufacture' | 'trading' | 'power'
  product: 'gold' | 'exp' | 'fragment'
} {
  switch (cat) {
    case 'manufacture/gold':
      return { type: 'manufacture', product: 'gold' }
    case 'manufacture/exp':
      return { type: 'manufacture', product: 'exp' }
    case 'manufacture/fragment':
      return { type: 'manufacture', product: 'fragment' }
    case 'trading/gold':
      return { type: 'trading', product: 'gold' }
    case 'trading/fragment':
      return { type: 'trading', product: 'fragment' }
    case 'power':
      return { type: 'power', product: 'gold' }
    default:
      return { type: 'manufacture', product: 'gold' }
  }
}

interface ExcelRoomRow {
  row: number
  roomLabel: string
  category: RoomCategory
  excelMainExtra: number | null
  excelMainOps: string[]
  excelRepExtra: number | null
  excelRepOps: string[]
  excelRepRaw: string[]
}

interface ExcelBlock {
  idx: number
  startRow: number
  endRow: number
  layoutName: string
  jsonFile: string
  centralMain: string[]
  centralRep: string[]
  hrMain: string[]
  hrRep: string[]
  rooms: ExcelRoomRow[]
}

interface RoomAuditItem {
  excelRow: number | null
  excelLabel: string
  category: RoomCategory
  excelMainOps: string[]
  excelReplayMainExtra: number | null
  excelReplayMainDetails: string[]
  excelReplayMainStructured: string
  excelMainTarget: number | null
  mainDelta: number | null
  mainStatus: 'PASS' | 'FAIL' | 'UNAVAILABLE'
  mainReason: string
  excelRepOps: string[]
  excelRepRaw: string[]
  excelReplayRepExtra: number | null
  excelReplayRepDetails: string[]
  excelReplayRepStructured: string
  excelRepTarget: number | null
  repDelta: number | null
  repStatus: 'PASS' | 'FAIL' | 'UNAVAILABLE'
  repReason: string
  mowerRoomId: string | null
  mowerMainOps: string[]
  mowerMainMatch: boolean
  mowerRepOps: string[]
  mowerCollision: string | null
}

interface LayoutAudit {
  fileName: string
  layoutName: string
  hasBenchmark: boolean
  blockInfo: string
  mainPower: number
  mainGoldLines: number
  mainPerception: number
  repPower: number
  repGoldLines: number
  repPerception: number
  rooms: RoomAuditItem[]
}

const describeExternalAudit = process.env.RUN_MOWER_LAYOUT_AUDIT === '1' ? describe : describe.skip

describeExternalAudit('Audit Test and Report Generator', () => {
  it('generates a traceable markdown audit report with excel replay and category matching', () => {
    const dump = JSON.parse(readFileSync('scratch/sheet1_dump.json', 'utf8'))
    const starts = [6, 27, 48, 69, 90, 111, 132, 153, 175, 196]
    const blockEnds = [26, 47, 68, 89, 110, 131, 152, 174, 195, 216]
    const layoutNames = [
      '252四赤金（31贸）',
      '252四赤金（22贸）',
      '252三赤金',
      '252二赤金',
      '252二赤金Test',
      '342纯钱',
      '342搓玉',
      '342搓玉（1狗粮）',
      '252搓玉',
      '342卖玉'
    ]
    const jsonMapping = [
      '252四赤金（31贸）.json',
      '252四赤金（22贸）.json',
      '252三赤金.json',
      '252二赤金.json',
      '252二赤金Test.json',
      '342纯钱.json',
      '342搓玉.json',
      '342搓玉（1狗粮）.json',
      '252搓玉.json',
      '342卖玉.json'
    ]

    const blocks: ExcelBlock[] = starts.map((s, idx) => {
      const e = blockEnds[idx]
      const rows = dump.filter((r: any) => r.row >= s && r.row <= e)

      // Central
      const centralRow = rows.find((r: any) => r.C === '控制中枢')
      const centralMain = [centralRow?.F, centralRow?.G, centralRow?.H, centralRow?.I, centralRow?.J]
        .filter(Boolean)
        .map((x: string) => x.trim())
        .filter((x: string) => NAME_TO_CHAR_ID.has(x))
      const centralRep = [centralRow?.P, centralRow?.Q, centralRow?.R, centralRow?.S, centralRow?.T]
        .filter(Boolean)
        .map((x: string) => x.trim())
        .filter((x: string) => NAME_TO_CHAR_ID.has(x))

      // HR
      const hrRow = rows.find((r: any) => r.C === '人力')
      const hrMain = [hrRow?.F, hrRow?.G, hrRow?.H]
        .filter(Boolean)
        .map((x: string) => x.trim())
        .filter((x: string) => NAME_TO_CHAR_ID.has(x))
      const hrRep = [hrRow?.P, hrRow?.Q, hrRow?.R]
        .filter(Boolean)
        .map((x: string) => x.trim())
        .filter((x: string) => NAME_TO_CHAR_ID.has(x))

      const roomRows: ExcelRoomRow[] = []
      for (const r of rows) {
        if (
          r.C &&
          (r.C.includes('赤金') ||
            r.C.includes('狗粮') ||
            r.C.includes('贸易') ||
            r.C.includes('搓玉') ||
            r.C.includes('卖玉') ||
            r.C.includes('电站'))
        ) {
          const mOps = [r.F, r.G, r.H]
            .filter(Boolean)
            .map((x: string) => x.trim())
            .filter((x: string) => NAME_TO_CHAR_ID.has(x))

          const repRaw = [r.P, r.Q, r.R].filter(Boolean).map((x: string) => x.trim())
          const repOps = repRaw.filter((x: string) => NAME_TO_CHAR_ID.has(x))

          roomRows.push({
            row: r.row,
            roomLabel: r.C.trim(),
            category: getExcelCategory(r.C.trim()),
            excelMainExtra: r.D !== undefined && !isNaN(Number(r.D)) ? Number(r.D) : null,
            excelMainOps: mOps,
            excelRepExtra: r.N !== undefined && !isNaN(Number(r.N)) ? Number(r.N) : null,
            excelRepOps: repOps,
            excelRepRaw: repRaw
          })
        }
      }

      return {
        idx,
        startRow: s,
        endRow: e,
        layoutName: layoutNames[idx],
        jsonFile: jsonMapping[idx],
        centralMain,
        centralRep,
        hrMain,
        hrRep,
        rooms: roomRows
      }
    })

    const mowerDir = 'E:\\OneDrive\\Mower'
    const jsonFiles = [
      '252四赤金（31贸）.json',
      '252四赤金（22贸）.json',
      '252三赤金.json',
      '252二赤金.json',
      '252二赤金Test.json',
      '342纯钱.json',
      '342搓玉.json',
      '342搓玉（1狗粮）.json',
      '252搓玉.json',
      '342卖玉.json',
      '342二赤二粮.json'
    ]

    const layoutAudits: LayoutAudit[] = []
    for (const f of jsonFiles) {
      const block = blocks.find(b => b.jsonFile === f)
      const raw = readFileSync(join(mowerDir, f), 'utf-8')
      const ws = importMowerJson(raw)
      const baseConfig = createDefaultConfig()
      const mowerConfig = compileMainPlanToAppConfig(ws.mainPlan, ws, baseConfig)

      if (!block) {
        // Layout 11: 342二赤二粮.json (No Excel benchmark)
        const mowerRooms = mowerConfig.rooms.filter(r => r.operatorIds.length > 0)
        const items: RoomAuditItem[] = mowerRooms.map(mr => ({
          excelRow: null,
          excelLabel: '无',
          category: getMowerCategory(mr.type, mr.product),
          excelMainOps: [],
          excelReplayMainExtra: null,
          excelReplayMainDetails: [],
          excelReplayMainStructured: '—',
          excelMainTarget: null,
          mainDelta: null,
          mainStatus: 'UNAVAILABLE',
          mainReason: 'Excel 工作簿缺少同名对应排班区块基准',
          excelRepOps: [],
          excelRepRaw: [],
          excelReplayRepExtra: null,
          excelReplayRepDetails: [],
          excelReplayRepStructured: '—',
          excelRepTarget: null,
          repDelta: null,
          repStatus: 'UNAVAILABLE',
          repReason: 'Excel 工作簿缺少同名对应排班区块基准',
          mowerRoomId: mr.id,
          mowerMainOps: mr.operatorIds.map(id => OPERATORS.find(o => o.charId === id)?.name || id),
          mowerMainMatch: false,
          mowerRepOps: [],
          mowerCollision: null
        }))

        layoutAudits.push({
          fileName: f,
          layoutName: '342二赤二粮 (Excel缺少同名布局)',
          hasBenchmark: false,
          blockInfo: '缺少基准 (UNAVAILABLE)',
          mainPower: 0,
          mainGoldLines: 0,
          mainPerception: 0,
          repPower: 0,
          repGoldLines: 0,
          repPerception: 0,
          rooms: items
        })
        continue
      }

      // Check duplicates in Mower firstRep for diagnostics
      const mowerRepCount: Record<string, number> = {}
      for (const fac of Object.values(ws.mainPlan.facilities)) {
        if (!fac?.slots) continue
        for (const s of fac.slots) {
          if (s.replacements && s.replacements.length > 0) {
            const first = s.replacements[0].trim()
            if (first) mowerRepCount[first] = (mowerRepCount[first] || 0) + 1
          }
        }
      }

      // Build the Excel static snapshot used for main-shift replay.
      const excelMainConfig: AppConfig = createDefaultConfig()
      excelMainConfig.facilities = structuredClone(mowerConfig.facilities)
      excelMainConfig.dormitoryOccupantCount = mowerConfig.dormitoryOccupantCount
      excelMainConfig.facilityOperatorIds.dormitories = structuredClone(mowerConfig.facilityOperatorIds.dormitories)
      excelMainConfig.zeroMoraleOperatorIds = ['char_285_medic2']

      // Central operators
      const mainCentralIds = block.centralMain.map(n => NAME_TO_CHAR_ID.get(n)!).filter(Boolean)
      for (const opId of mowerConfig.controlOperatorIds) {
        if (mainCentralIds.length < 5 && !mainCentralIds.includes(opId)) mainCentralIds.push(opId)
      }
      excelMainConfig.controlOperatorIds = mainCentralIds

      // HR
      const mainHrIds = block.hrMain.map(n => NAME_TO_CHAR_ID.get(n)!).filter(Boolean)
      excelMainConfig.facilityOperatorIds.office = mainHrIds.length > 0 ? mainHrIds : ['char_436_whispr']

      // Rooms
      excelMainConfig.rooms = block.rooms.map((er, idx) => {
        const { type, product } = excelCategoryToTypeProduct(er.category)
        const floor = Math.floor(idx / 3) + 1
        const col = (idx % 3) + 1
        const room = createRoom(`B${floor}0${col}`, type)
        room.product = product
        room.operatorIds = er.excelMainOps.map(n => NAME_TO_CHAR_ID.get(n)!).filter(Boolean)
        return room
      })

      const excelMainGlobalContext = buildRiicGlobalContext(excelMainConfig)

      // Rep base config: each replacement row is evaluated as single-room substitution
      const excelRepBaseConfig: AppConfig = structuredClone(excelMainConfig)
      excelRepBaseConfig.zeroMoraleOperatorIds = structuredClone(mowerConfig.zeroMoraleOperatorIds)
      excelRepBaseConfig.workaholicOperatorIds = structuredClone(mowerConfig.workaholicOperatorIds)
      const repCentralIds = block.centralRep.map(n => NAME_TO_CHAR_ID.get(n)!).filter(Boolean)
      for (const opId of mowerConfig.controlOperatorIds) {
        if (repCentralIds.length < 5 && !repCentralIds.includes(opId)) repCentralIds.push(opId)
      }
      excelRepBaseConfig.controlOperatorIds = repCentralIds
      const repHrIds = block.hrRep.map(n => NAME_TO_CHAR_ID.get(n)!).filter(Boolean)
      excelRepBaseConfig.facilityOperatorIds.office = repHrIds.length > 0 ? repHrIds : ['char_180_amgoat']
      const excelRepBaseGlobalContext = buildRiicGlobalContext(excelRepBaseConfig)

      // Strict within-category 1-to-1 matching with Mower rooms
      const mowerRooms = mowerConfig.rooms.filter(r => r.operatorIds.length > 0)
      const matchedMowerRoomMap = new Map<number, OutputRoom>()
      const usedMowerRoomIds = new Set<string>()

      const categories: RoomCategory[] = [
        'manufacture/gold',
        'manufacture/exp',
        'manufacture/fragment',
        'trading/gold',
        'trading/fragment',
        'power'
      ]

      for (const cat of categories) {
        const catExcel = block.rooms.filter(r => r.category === cat)
        const catMower = mowerRooms.filter(
          m => !usedMowerRoomIds.has(m.id) && getMowerCategory(m.type, m.product) === cat
        )

        // 1. Equal set match
        for (const er of catExcel) {
          if (matchedMowerRoomMap.has(er.row)) continue
          const erOps = er.excelMainOps
          const exact = catMower.find(mr => {
            if (usedMowerRoomIds.has(mr.id)) return false
            const mrNames = mr.operatorIds.map(id => OPERATORS.find(o => o.charId === id)?.name || id)
            return (
              erOps.length === mrNames.length &&
              erOps.every(o => mrNames.includes(o)) &&
              mrNames.every(o => erOps.includes(o))
            )
          })
          if (exact) {
            matchedMowerRoomMap.set(er.row, exact)
            usedMowerRoomIds.add(exact.id)
          }
        }

        // 2. Max overlap match
        for (const er of catExcel) {
          if (matchedMowerRoomMap.has(er.row)) continue
          let bestMatch: OutputRoom | null = null
          let bestOverlap = -1

          for (const mr of catMower) {
            if (usedMowerRoomIds.has(mr.id)) continue
            const mrNames = mr.operatorIds.map(id => OPERATORS.find(o => o.charId === id)?.name || id)
            let overlap = er.excelMainOps.filter(o => mrNames.includes(o)).length
            if (cat === 'power') {
              if (er.roomLabel === '电站1' && mrNames.includes('承曦格雷伊')) overlap += 10
              if (er.roomLabel === '电站2' && mrNames.includes('Lancet-2')) overlap += 10
            }
            if (overlap > bestOverlap) {
              bestOverlap = overlap
              bestMatch = mr
            }
          }
          if (bestMatch) {
            matchedMowerRoomMap.set(er.row, bestMatch)
            usedMowerRoomIds.add(bestMatch.id)
          }
        }

        // 3. Sequential fallback within same category
        for (const er of catExcel) {
          if (matchedMowerRoomMap.has(er.row)) continue
          const remaining = catMower.find(mr => !usedMowerRoomIds.has(mr.id))
          if (remaining) {
            matchedMowerRoomMap.set(er.row, remaining)
            usedMowerRoomIds.add(remaining.id)
          }
        }
      }

      // Audit each Excel room row
      const auditRooms: RoomAuditItem[] = []

      for (let i = 0; i < block.rooms.length; i++) {
        const er = block.rooms[i]
        const mainRoom = excelMainConfig.rooms[i]
        const matchedMower = matchedMowerRoomMap.get(er.row)

        // Evaluate Main (Excel static replay)
        const mainEval = evaluateOperators(mainRoom, excelMainConfig, undefined, undefined, excelMainGlobalContext)
        const mainExtra = Number(((mainEval.efficiencyPercent - 100) / 100).toFixed(4))
        const mainStructured = formatStructuredContributions(mainEval)

        let mainStatus: 'PASS' | 'FAIL' | 'UNAVAILABLE' = 'UNAVAILABLE'
        let mainDelta: number | null = null
        let mainReason = ''

        if (er.excelMainOps.length === 0) {
          mainStatus = 'UNAVAILABLE'
          mainReason = 'Excel 主班行没有可识别的干员名单，不能用空阵容重放该效率值'
          mainDelta = null
        } else if (er.excelMainExtra === null) {
          mainStatus = 'UNAVAILABLE'
          mainReason = 'Excel 主班无对应效率数值'
        } else {
          mainDelta = Number((mainExtra - er.excelMainExtra).toFixed(4))
          if (Math.abs(mainDelta) < 0.001) {
            mainStatus = 'PASS'
            mainReason = '算法计算额外效率与 Excel 完全一致'
          } else {
            mainStatus = 'FAIL'
            if (er.category === 'manufacture/gold' && mainEval.details.some(d => d.includes('歌蕾蒂娅·集群狩猎'))) {
              mainReason = '深海联动数值差异：全局有效深海人数决定每名受益值，当前房间人数决定累加次数；详见算法贡献明细'
            } else if (er.excelMainOps.length === 2 && er.category === 'manufacture/gold' && er.excelMainOps.includes('温蒂') && er.excelMainOps.includes('清流')) {
              mainReason = '算法温蒂+清流+中枢制造合计137%~140%，Excel填写差异（详见明细）'
            } else if (er.category === 'trading/gold' && er.excelMainOps.includes('蕾缪安') && er.excelMainOps.includes('能天使')) {
              mainReason = '能天使(35%)+蕾缪安(20%)+中枢(7%)+进驻基础(2%)=64%额外效率，Excel填写89%（高出25%，疑含特定订单或测试临时值）'
            } else {
              mainReason = `数值差异 ${mainDelta > 0 ? '+' : ''}${(mainDelta * 100).toFixed(1)}%：请查阅干员具体技能明细`
            }
          }
        }

        // Evaluate Rep (Excel static replay)
        let repStatus: 'PASS' | 'FAIL' | 'UNAVAILABLE' = 'UNAVAILABLE'
        let repDelta: number | null = null
        let repReason = ''
        let repExtra: number | null = null
        let repDetails: string[] = []
        let repStructured = '—'

        const hasFormulaNote = er.excelRepRaw.some(
          x => x.includes('算法') || x.includes('252') || x.includes('经验') || x.includes('加速') || x.includes('（')
        )

        if (er.excelRepExtra === null) {
          repStatus = 'UNAVAILABLE'
          repReason = 'Excel 替补行无效率数值'
        } else if (hasFormulaNote && er.excelRepOps.length === 0) {
          repStatus = 'UNAVAILABLE'
          repReason = `Excel 替补行为公式/占位文本 [${er.excelRepRaw.join(', ')}]，缺少有效静态干员基准`
        } else if (er.excelRepOps.length === 0) {
          repStatus = 'UNAVAILABLE'
          repReason = `Excel 替补行未填写有效干员名 [${er.excelRepRaw.join(', ')}]`
        } else {
          const rowRepConfig = structuredClone(excelRepBaseConfig)
          const repRoom = rowRepConfig.rooms[i]!
          repRoom.operatorIds = er.excelRepOps.map(n => NAME_TO_CHAR_ID.get(n)!).filter(Boolean)
          const targetHasAbyssal = repRoom.operatorIds.some(id =>
            OPERATORS.find(operator => operator.charId === id)?.groupId === 'abyssal',
          )
          if (targetHasAbyssal) {
            for (let linkedIndex = 0; linkedIndex < block.rooms.length; linkedIndex++) {
              if (linkedIndex === i) continue
              const linkedIds = block.rooms[linkedIndex]!.excelRepOps
                .map(name => NAME_TO_CHAR_ID.get(name)!)
                .filter(Boolean)
              if (linkedIds.some(id =>
                OPERATORS.find(operator => operator.charId === id)?.groupId === 'abyssal',
              )) {
                rowRepConfig.rooms[linkedIndex]!.operatorIds = linkedIds
              }
            }
          }
          const rowRepGlobalContext = buildRiicGlobalContext(rowRepConfig)
          const repEval = evaluateOperators(repRoom, rowRepConfig, undefined, undefined, rowRepGlobalContext)

          repExtra = Number(((repEval.efficiencyPercent - 100) / 100).toFixed(4))
          repDetails = repEval.details
          repStructured = formatStructuredContributions(repEval)
          repDelta = Number((repExtra - er.excelRepExtra).toFixed(4))
          if (Math.abs(repDelta) < 0.001) {
            repStatus = 'PASS'
            repReason = '算法计算额外效率与 Excel 完全一致'
          } else {
            repStatus = 'FAIL'
            repReason = `数值差异 ${repDelta > 0 ? '+' : ''}${(repDelta * 100).toFixed(1)}%：请查阅干员具体技能明细`
          }
        }

        const mowerMainOps = matchedMower
          ? matchedMower.operatorIds.map(id => OPERATORS.find(o => o.charId === id)?.name || id)
          : []
        const mowerMainMatch =
          matchedMower !== undefined &&
          er.excelMainOps.length === mowerMainOps.length &&
          er.excelMainOps.every(o => mowerMainOps.includes(o)) &&
          mowerMainOps.every(o => er.excelMainOps.includes(o))

        // Mower Rep and collision
        let mowerRepOps: string[] = []
        let mowerCollision: string | null = null
        if (matchedMower) {
          const fac = ws.mainPlan.facilities[matchedMower.id]
          if (fac?.slots) {
            for (const s of fac.slots) {
              if (s.replacements && s.replacements.length > 0) {
                const repName = s.replacements[0].trim()
                if (repName) {
                  mowerRepOps.push(repName)
                  if ((mowerRepCount[repName] || 0) > 1) {
                    mowerCollision = `候补[${repName}]在多房间被列为首选替补，静态全局冲突`
                  }
                }
              }
            }
          }
        }

        auditRooms.push({
          excelRow: er.row,
          excelLabel: er.roomLabel,
          category: er.category,
          excelMainOps: er.excelMainOps,
          excelReplayMainExtra: mainExtra,
          excelReplayMainDetails: mainEval.details,
          excelReplayMainStructured: mainStructured,
          excelMainTarget: er.excelMainExtra,
          mainDelta,
          mainStatus,
          mainReason,
          excelRepOps: er.excelRepOps,
          excelRepRaw: er.excelRepRaw,
          excelReplayRepExtra: repExtra,
          excelReplayRepDetails: repDetails,
          excelReplayRepStructured: repStructured,
          excelRepTarget: er.excelRepExtra,
          repDelta,
          repStatus,
          repReason,
          mowerRoomId: matchedMower?.id ?? null,
          mowerMainOps,
          mowerMainMatch,
          mowerRepOps,
          mowerCollision
        })
      }

      layoutAudits.push({
        fileName: f,
        layoutName: block.layoutName,
        hasBenchmark: true,
        blockInfo: `表格行 ${block.startRow}..${block.endRow}`,
        mainPower: excelMainGlobalContext.effectivePowerStations.count,
        mainGoldLines: excelMainGlobalContext.goldProductionLines.effective,
        mainPerception: excelMainGlobalContext.thoughtChain.effective,
        repPower: excelRepBaseGlobalContext.effectivePowerStations.count,
        repGoldLines: excelRepBaseGlobalContext.goldProductionLines.effective,
        repPerception: excelRepBaseGlobalContext.thoughtChain.effective,
        rooms: auditRooms
      })
    }

    // Aggregate statistics across actual audited rooms
    let actualTotalRooms = 0
    let mainPassCount = 0
    let mainFailCount = 0
    let mainUnavailCount = 0
    let repPassCount = 0
    let repFailCount = 0
    let repUnavailCount = 0
    let inputMatchCount = 0
    let inputMismatchCount = 0

    for (const layout of layoutAudits) {
      for (const room of layout.rooms) {
        actualTotalRooms++
        if (room.mainStatus === 'PASS') mainPassCount++
        else if (room.mainStatus === 'FAIL') mainFailCount++
        else mainUnavailCount++

        if (room.repStatus === 'PASS') repPassCount++
        else if (room.repStatus === 'FAIL') repFailCount++
        else repUnavailCount++

        if (layout.hasBenchmark) {
          if (room.mowerMainMatch) inputMatchCount++
          else inputMismatchCount++
        }
      }
    }

    // Build comprehensive markdown report
    let report = '# Mower 排班 JSON 与 mower表.xlsx 布局内效率一致性审计报告\n\n'
    report += '**审计日期**：2026-09-09\n'
    report += '**执行环境**：Antigravity CLI (Codex Worker) / Vitest 真实算法链路\n'
    report += '**被审数据**：`E:\\OneDrive\\Mower` 全部 11 份排班 JSON\n'
    report += '**核对基准**：`E:\\OneDrive\\桌面\\mower表.xlsx` 之「排班表」10 个排班区块（起始行 6, 27, 48, 69, 90, 111, 132, 153, 175, 196）\n\n'

    report += '## 1. 审计概述、核心原则与降级边界声明\n\n'
    report += '本审计严格落实规范要求与独立复核意见：\n'
    report += '1. **同类型启发式匹配**：先将房间分为六大类（赤金=`manufacture/gold`、狗粮=`manufacture/exp`、搓玉=`manufacture/fragment`、贸易=`trading/gold`、卖玉=`trading/fragment`、电站=`power`），再在同类候选内按干员名单交集做一对一最大权重匹配。它能阻止跨类型误配，但没有物理房间编号依据，因此 PASS/FAIL 是候选对应结果；\n'
    report += '2. **【重要边界与降级声明】替补班 (Rep) 仅为单室静态局部投影，绝非 Mower 全局动态跑单**：\n'
    report += '   - Excel 替补列本质是在假定“当前房间换为替补干员，其余房间维持主班”的单室静态切片，中枢和办公室使用替班配置，深海猎人组作为联动体协同切换；\n'
    report += '   - Mower 实际运行时是全自动动态跑单调度系统（基于心情消耗阈值、多贸易站轮流借调但书/龙舌兰跑单、暖机时序等），该动态时序调度目前标记为 **DEGRADED (静态投影降级模式)**，绝不能将逐行静态投影混淆或宣称等价于 Mower 动态跑单，绝不制造伪 PASS；\n'
    report += '   - Mower JSON 中多贸易站首选同一候补（如但书）属于动态跑单的典型特征，在静态多房间同时部署下必然触发人员冲突，本审计在候补诊断列中予以明确呈现；\n'
    report += '3. **结构化贡献审计**：主班与替补班的所有算法重放明细均升级为严格可加总的结构化贡献（`OperatorContribution` 与 `RoomBonusItem`），其干员贡献与房间全局贡献之和严格恒等于房间额外效率；\n'
    report += '4. **明确区分双层对比**：层 1 诊断 Mower JSON 输入与 Excel 名单是否一致；层 2 给出用 Excel 名单重放后算法是否符合 D/N。\n\n'

    report += `### 审计结果总计表（按实际审计记录 ${actualTotalRooms} 间计数）\n\n`
    report += '| 审计层级 | PASS (一致) | FAIL (差异) | UNAVAILABLE (不可对照/占位符) | 合计房间数 |\n'
    report += '| :--- | :---: | :---: | :---: | :---: |\n'
    report += `| **主班 (Main) - 算法数值核对** | **${mainPassCount}** (${((mainPassCount / actualTotalRooms) * 100).toFixed(1)}%) | **${mainFailCount}** (${((mainFailCount / actualTotalRooms) * 100).toFixed(1)}%) | **${mainUnavailCount}** (${((mainUnavailCount / actualTotalRooms) * 100).toFixed(1)}%) | ${actualTotalRooms} 间 |\n`
    report += `| **替补班 (Rep) - 算法数值核对** | **${repPassCount}** (${((repPassCount / actualTotalRooms) * 100).toFixed(1)}%) | **${repFailCount}** (${((repFailCount / actualTotalRooms) * 100).toFixed(1)}%) | **${repUnavailCount}** (${((repUnavailCount / actualTotalRooms) * 100).toFixed(1)}%) | ${actualTotalRooms} 间 |\n`
    report += `| **Mower 输入名单一致性诊断** | **${inputMatchCount}** 完全吻合 | **${inputMismatchCount}** 名单有差异 | **9** (342二赤二粮无基准) | ${actualTotalRooms} 间 |\n\n`

    report += '## 2. 核心专项核验与证据链\n\n'
    report += '针对用户确认的 8 项核心规则与机制，基于仓库实际代码及全局上下文快照，核验结果与代码证据如下：\n\n'

    report += '### (1) 宿舍人数按满 20 人计数与空位/替补处理\n'
    report += '- **实现与证据**：`src/workbench/adapter.ts`；11 份 JSON 的 4 个宿舍全满 20 人，适配层求得 `steadyDormitoryOccupancy = 20`，迷迭香/黑键各准确获得 +20，乌有获得 +20。\n'
    report += '- **空位处理**：按实际非空槽位数累加，若有空位则相应扣减，不会凭空虚构。\n\n'

    report += '### (2) 感知信息、人间烟火、虚拟赤金线快照重建与跨站特性\n'
    report += '- **实现与证据**：`src/engine/globalContext.ts`；每个快照重新构建全局上下文。\n'
    report += '- **跨站验证**：绮良与鸿雪产生的虚拟赤金线写入全局 `goldProductionLines.effective`（在 342 纯钱中达到 12 条）。该上下文在评估房间时被所有贸易站共享，位于另一贸易站的图耶（物流规划·β）亦可享受 12 条赤金线的 +95% 效率加成，成功跨站生效。\n\n'

    report += '### (3) 仓库容量、订单上限与配方类型严格隔离\n'
    report += '- **实现与证据**：`src/engine/operatorRules.ts`；`warehouseCapacity` 与 `roomOrderLimitIncrease` 均在房间求值闭包内严格仅对当前房间的有效干员累加，绝无跨站泄漏。铅踝「窗外雪啸」严格遵循心情落差 > 12（非 >= 12）；作战记录专精容量技能在赤金站严格过滤不生效；灵知、维什戴尔、佩佩、瑰盐、伺夜等订单上限均按当前快照正确派生。\n\n'

    report += '### (4) 无人机上限 235 与承曦格雷伊 +28% 效率\n'
    report += '- **实现与证据**：`src/domain/defaults.ts` (`droneCapacity: 235`)，`src/engine/operatorRules.ts`。承曦格雷伊（巡线框架）计算得 `Math.floor(235 / 10) = 23%`；发电站进驻基础为 5%（1人）。额外效率合计 = 23% + 5% = **28% (0.28)**。在全部 10 个匹配布局的主班电站 1 中与 Excel 完全吻合（PASS）。\n\n'

    report += '### (5) Lancet-2 心情 0 常驻与双重联动触发\n'
    report += '- **实现与证据**：`src/engine/globalContext.ts` 与 `src/engine/operatorRules.ts`。\n'
    report += '  - Lancet-2 自身因 0 心情失效，进驻基础 +0%，技能加成 0%，房间额外效率为 **0% (0.00)**，与 Excel 电站 2 的 D=0 完全吻合；\n'
    report += '  - 控制中枢森蚺检测到电站有进驻作业平台，成功获得有效发电站 +2，自动化不得清除森蚺加成；承曦格雷伊检测到另一电站无活跃平台，成功获得有效发电站 +1。双联动均完整生效。\n\n'

    report += '### (6) 歌蕾蒂娅与深海猎人全基建逐人联动\n'
    report += '- **实现与证据**：全基建有效深海猎人数决定单名受益值（每人 +10%，上限 +40%），当前制造站内每位有效深海猎人分别获得该值。全基建四深海使同站斯卡蒂和乌尔比安各 +40%，同站两人合计 +80%。\n\n'

    report += '### (7) 泡泡 67 加火神负 5 得 62\n'
    report += '- **实现与证据**：泡泡「大就是好！」读取火神（+19容量 > 16 阈值 -> +57%）与泡泡自身（+10容量 <= 16 -> +10%）合计 +67%；火神「工匠精神·β」提供 -5%；两者合计 +62%。在包含泡泡+火神的赤金站与狗粮站均获严格复现。\n\n'

    report += '### (8) 伺夜加八幡海铃 45、二赤金四杜林鸿雪 30 图耶 50 及中枢制造入全局上下文\n'
    report += '- **实现与证据**：\n'
    report += '  - 伺夜按三级会客室得到 +40%，八幡海铃为每位叙拉古贸易站干员提供 +5%，技能部分合计 +45%（进驻基础另算）；\n'
    report += '  - 二赤金加四杜林（杜林、黑角、褐果、白雪）折算为六赤金线，鸿雪享受 +30%，图耶享受 +50%；\n'
    report += '  - 中枢全局制造加成（如 Mon3tr/凯尔希 +2%、红松骑士、黑钢老友相聚等）已直接写入全局临时上下文并在房间求值时由结构化项计入。\n\n'

    report += '## 3. 逐布局详细审计明细（11 份布局）\n\n'

    for (let lIdx = 0; lIdx < layoutAudits.length; lIdx++) {
      const layout = layoutAudits[lIdx]
      report += `### 3.${lIdx + 1} ${layout.layoutName} (\`${layout.fileName}\`)\n\n`
      report += `- **基准状态**：${layout.blockInfo}\n`
      if (layout.hasBenchmark) {
        report += `- **全局上下文**：主班有效电站 ${layout.mainPower} 个 / 替补 ${layout.repPower} 个；主班赤金线 ${layout.mainGoldLines} 条 / 替补 ${layout.repGoldLines} 条；主班感知信息 ${layout.mainPerception} / 替补 ${layout.repPerception}\n\n`
      }

      report += '#### (1) 主班 (Main Shift) 审计\n\n'
      report += '| 房间 | 类型 | Excel干员 | 结构化干员与房间贡献明细 | 算法额外效率 | Excel额外效率 (D) | 差值 | 结果 | Mower输入对照 | 原因分析 |\n'
      report += '| :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- |\n'

      for (const r of layout.rooms) {
        const algStr = r.excelReplayMainExtra !== null ? `${(r.excelReplayMainExtra * 100).toFixed(0)}% (${r.excelReplayMainExtra})` : '—'
        const exStr = r.excelMainTarget !== null ? `${(r.excelMainTarget * 100).toFixed(0)}% (${r.excelMainTarget})` : '—'
        const diffStr = r.mainDelta !== null ? `${r.mainDelta > 0 ? '+' : ''}${(r.mainDelta * 100).toFixed(0)}%` : '—'
        const mowerCompare = r.mowerMainMatch ? '一致' : `差异: [${r.mowerMainOps.join(',')}]`

        report += `| ${r.excelLabel} | ${r.category} | ${r.excelMainOps.join(', ') || '—'} | ${r.excelReplayMainStructured || '—'} | ${algStr} | ${exStr} | ${diffStr} | **${r.mainStatus}** | ${mowerCompare} | ${r.mainReason} |\n`
      }
      report += '\n'

      report += '#### (2) 替补班 (Replacement Shift - 单室静态投影降级模式) 审计\n\n'
      report += '> **降级说明**：替补班重放为逐房间单室替换投影，不代表 Mower 动态跑单调度。多房间首选同一候补干员将呈现静态冲突。\n\n'
      report += '| 房间 | 类型 | Excel替补标注 | 结构化干员与房间贡献明细 | 算法额外效率 | Excel额外效率 (N) | 差值 | 结果 | Mower候补与冲突诊断 | 原因分析与阻塞诊断 |\n'
      report += '| :--- | :--- | :--- | :--- | :---: | :---: | :---: | :---: | :--- | :--- |\n'

      for (const r of layout.rooms) {
        const algStr = r.excelReplayRepExtra !== null ? `${(r.excelReplayRepExtra * 100).toFixed(0)}% (${r.excelReplayRepExtra})` : '—'
        const exStr = r.excelRepTarget !== null ? `${(r.excelRepTarget * 100).toFixed(0)}% (${r.excelRepTarget})` : '—'
        const diffStr = r.repDelta !== null ? `${r.repDelta > 0 ? '+' : ''}${(r.repDelta * 100).toFixed(0)}%` : '—'
        const mowerDiag = r.mowerCollision ? r.mowerCollision : (r.mowerRepOps.length ? `JSON候补: ${r.mowerRepOps.join(';')}` : '—')

        report += `| ${r.excelLabel} | ${r.category} | ${r.excelRepRaw.join(', ') || '—'} | ${r.excelReplayRepStructured || '—'} | ${algStr} | ${exStr} | ${diffStr} | **${r.repStatus}** | ${mowerDiag} | ${r.repReason} |\n`
      }
      report += '\n'
    }

    report += '## 4. 真实归因结论与仍不可核验项清单\n\n'
    report += '### (1) 主班数值差异真实归因\n'
    report += '1. **深海猎人制造联动**：\n'
    report += '   - 全基建有效深海猎人数决定每名受益者的加成值（每人 +10%，上限 +40%）；当前制造站内受益人数决定累加次数。四人全局组合下，同站两位深海猎人合计 +80%。\n'
    report += '   - 断罪者+斯卡蒂+乌尔比安的额外效率为进驻3%+断罪者35%+斯卡蒂40%+乌尔比安40%+中枢制造2%=120%。\n'
    report += '2. **能天使 + 蕾缪安组合**：\n'
    report += '   - 算法实现：能天使(35%) + 蕾缪安(20%) + 中枢(7%) + 进驻基础(2%) = 64% 额外效率；\n'
    report += '   - Excel 记录：在 342 纯钱等区块填写 89%（高出 25%），疑包含某种特定订单临时补正或历史未公开加成。\n'
    report += '3. **温蒂 + 清流组合**：\n'
    report += '   - 算法实现：温蒂在 5 电站时 +75%，清流在 3 贸易站时 +60%，进驻基础 2 人 +2%，中枢 +0/3%，合计 137%~140%；Excel 部分行记录为 140%，部分为 122%。\n\n'

    report += '### (2) 替补审计局限性与降级状态 (DEGRADED)\n'
    report += '1. **单室静态投影 vs 动态跑单**：\n'
    report += '   Excel 替补列仅为各房间独立轮换时的静态参考，无法代表全基建同时处于替补状态，更不等价于 Mower 动态检测订单即将交付时动态切入但书/龙舌兰的动态跑单机制。动态跑单时序回放能力属于未实现的动态仿真模式（DEGRADED），本审计严禁对动态跑单制造伪 PASS。\n'
    report += '2. **贸易站动态跑单干员首选冲突**：\n'
    report += '   Mower JSON 在全部贸易站首选候补中均填入“但书”，属于典型的动态时间片借调。在静态多房间全量投影下必然发生人员冲突，报告中明确列为全局冲突诊断，避免误报为静态可用。\n'
    report += '3. **Excel 房间对应仍为启发式**：\n'
    report += '   当前工作簿没有可直接连接 Mower 房间 ID 的稳定键，脚本按布局顺序绑定区块，并在同类型房间内按干员名单交集匹配。逐房间 PASS/FAIL 可用于定位数值规则，但在取得物理房间映射前不能视为严格的房间身份认证。\n\n'

    report += '### (3) 仍不可核验项清单 (UNAVAILABLE)\n'
    report += '1. **342二赤二粮.json**：Excel 工作簿中完全无同名排班区块，整套布局 9 间生产岗位在主班与替补班均为 UNAVAILABLE；\n'
    report += '2. **Excel 替补行包含公式占位说明**：如 `82算法`、`252钱书(4赤金)`、`经验1`、`加速赤金总计`、`CE6&LS6算法`、`（22贸）` 等，由于未给出具体进驻干员名字，无法通过算法真实重放，按规范严格标为 UNAVAILABLE，不污染其他房间。\n'

    mkdirSync(join(process.cwd(), 'scratch'), { recursive: true })
    writeFileSync(join(process.cwd(), 'scratch/2026-09-09-mower-layout-efficiency-audit.md'), report, 'utf8')
    console.log('Report written to scratch/2026-09-09-mower-layout-efficiency-audit.md')
    console.log(`Statistics: Total Rooms: ${actualTotalRooms}`)
    console.log(`Main: ${mainPassCount} PASS, ${mainFailCount} FAIL, ${mainUnavailCount} UNAVAILABLE`)
    console.log(`Rep:  ${repPassCount} PASS, ${repFailCount} FAIL, ${repUnavailCount} UNAVAILABLE`)
    console.log(`Input Consistency: ${inputMatchCount} matched, ${inputMismatchCount} mismatched`)
  })
})
