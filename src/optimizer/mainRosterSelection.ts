import type { OperatorInventory } from '../domain/operatorInventory'
import type { RosterWorkspace } from '../domain/roster'
import { resolveOperatorCharId } from '../domain/operatorIdentifiers'
import { productionWorkspaceHourlyScore } from './productionSingletons'

/** Rank prepared, complete primary rosters; G proposes candidates, never bounds F.
 * The caller retains admission, warmup/recovery preparation and exact-input F.
 */
export function selectHighOutputMainCandidates<T extends { id: string; workspace: RosterWorkspace }>(
  candidates: readonly T[], inventory: OperatorInventory,
  options: { anchorId?: string; maxCandidates?: number } = {},
): { candidates: T[]; scores: { id: string; primaryHourlyScore: number | null }[]; diagnostics: { code: string; message: string }[] } {
  const diagnostics: { code: string; message: string }[] = []
  const requested = options.maxCandidates ?? 2
  if (!Number.isInteger(requested) || requested < 0) return { candidates: [], scores: [], diagnostics: [{ code: 'MAIN_SELECTION_INVALID_LIMIT', message: '主班候选上限须为非负有限整数。' }] }
  const limit = Math.min(2, requested)
  if (requested > 2) diagnostics.push({ code: 'MAIN_SELECTION_LIMIT_CLAMPED', message: '主班候选固定最多两份。' })
  if (!limit || !candidates.length) return { candidates: [], scores: [], diagnostics }
  let anchorIndex = options.anchorId === undefined ? 0 : candidates.findIndex(candidate => candidate.id === options.anchorId)
  if (anchorIndex < 0) {
    diagnostics.push({ code: 'MAIN_SELECTION_ANCHOR_NOT_FOUND', message: '指定的安全主班候选不存在，保留第一份候选作为回退。' })
    anchorIndex = 0
  }
  const anchor = candidates[anchorIndex]!
  if (!inventory.valid) return { candidates: [anchor], scores: candidates.map(candidate => ({ id: candidate.id, primaryHourlyScore: null })),
    diagnostics: [...diagnostics, { code: 'MAIN_SELECTION_INVALID_INVENTORY', message: '实际干员库无效，保留安全候选，不使用目录练度量化主班。' }] }
  const owned = new Set(inventory.operators.map(operator => operator.charId))
  const scores = candidates.map(candidate => {
    const unowned = Object.values(candidate.workspace.mainPlan.facilities).filter(room => room.level > 0)
      .flatMap(room => room.slots.flatMap(slot => slot.occupant.kind === 'operator' ? [slot.occupant.operatorId] : []))
      .find(operator => !owned.has(resolveOperatorCharId(operator)))
    if (unowned !== undefined) {
      diagnostics.push({ code: 'MAIN_SCORE_UNOWNED_OCCUPANT', message: `${candidate.id}：实际在岗者 ${unowned} 未在持有库中，主班评分保持未知。` })
      return { id: candidate.id, primaryHourlyScore: null }
    }
    let primaryHourlyScore: number | null = null, detail = '完整主班产出未能量化'
    try {
      const score = productionWorkspaceHourlyScore(candidate.workspace, inventory)
      if (score !== undefined && Number.isFinite(score)) primaryHourlyScore = score
    } catch (error) { detail = error instanceof Error ? error.message : String(error) }
    if (primaryHourlyScore === null) diagnostics.push({ code: 'MAIN_SCORE_UNAVAILABLE', message: `${candidate.id}：${detail}，保留未知状态。` })
    return { id: candidate.id, primaryHourlyScore }
  })
  const ranked = candidates.flatMap((candidate, index) => {
    const score = scores[index]!.primaryHourlyScore
    return score !== null ? [{ candidate, score, index }] : []
  }).sort((a, b) => Math.abs(a.score - b.score) > 1e-7 ? b.score - a.score
    : Number(b.index === anchorIndex) - Number(a.index === anchorIndex) || a.index - b.index)
  const best = ranked[0]?.candidate ?? anchor
  if (!ranked.length) diagnostics.push({ code: 'MAIN_SELECTION_NO_QUANTIFIED_MAIN', message: '没有已量化的主班排序，保留安全候选交由完整仿真验证。' })
  const second = !ranked.length ? undefined : best !== anchor ? anchor
    : ranked.find(row => row.candidate !== best)?.candidate ?? candidates.find(candidate => candidate !== best)
  return { candidates: [best, ...(second ? [second] : [])].slice(0, limit), scores, diagnostics }
}
