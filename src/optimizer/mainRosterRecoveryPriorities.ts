export interface RecoverySupportProposal<T> {
  candidate: T
  supportScore: number | null
  primaryScore: number | null
}

const SUPPORT_EPS = 1e-7
const known = (value: number | null): value is number => typeof value === 'number' && Number.isFinite(value)

/** A proposal order only: these static snapshots neither predict F nor justify
 * pruning a row. Preserve both a no-primary-loss choice and a recovery extreme.
 */
export function rankRecoverySupportProposals<T>(
  rows: readonly RecoverySupportProposal<T>[], baselinePrimaryScore: number | null,
): RecoverySupportProposal<T>[] {
  const bySupport = rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const first = a.row.supportScore, second = b.row.supportScore
    return known(first) && known(second) ? second - first || a.index - b.index
      : Number(known(second)) - Number(known(first)) || a.index - b.index
  })
  const ordered: typeof bySupport = []
  // Form tolerance bands against each band's highest recovery snapshot before
  // using G as a tie-breaker. A fixed anchor avoids a non-transitive comparator.
  for (let start = 0; start < bySupport.length;) {
    const anchor = bySupport[start]!.row.supportScore
    if (!known(anchor)) { ordered.push(...bySupport.slice(start)); break }
    let end = start + 1
    while (end < bySupport.length) {
      const score = bySupport[end]!.row.supportScore
      if (!known(score) || anchor - score > SUPPORT_EPS) break
      end++
    }
    ordered.push(...bySupport.slice(start, end).sort((a, b) => {
      const first = a.row.primaryScore, second = b.row.primaryScore
      return known(first) && known(second) ? second - first || a.index - b.index
        : Number(known(second)) - Number(known(first)) || a.index - b.index
    }))
    start = end
  }
  const selected: typeof bySupport = [], indices = new Set<number>()
  const safe = known(baselinePrimaryScore) ? ordered.find(({ row }) => {
    if (!known(row.supportScore) || !known(row.primaryScore)) return false
    const tolerance = Math.max(1e-7, 1e-9 * Math.max(1, Math.abs(row.primaryScore), Math.abs(baselinePrimaryScore)))
    return row.primaryScore >= baselinePrimaryScore - tolerance
  }) : undefined
  if (safe) { selected.push(safe); indices.add(safe.index) }
  const exploration = ordered.find(({ row, index }) => known(row.supportScore) && !indices.has(index))
  if (exploration) { selected.push(exploration); indices.add(exploration.index) }
  return [...selected, ...ordered.filter(entry => !indices.has(entry.index))].map(entry => entry.row)
}
