import { OPERATOR_MAP } from './operators'

const tradeRunners = new Set(['但书', '龙舌兰', '佩佩', '可露希尔'])

/** Mower treats these replacement candidates as a trade order swap. */
export function isTradeRunOrderOperator(idOrName: string): boolean {
  return tradeRunners.has(OPERATOR_MAP.get(idOrName)?.name ?? idOrName)
}
