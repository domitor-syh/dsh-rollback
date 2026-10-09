import type { TruncationMarkerPlan } from './truncation-plan.ts'

/** The fixed-heuristic face of the optional tokenMeter measurement, not route prices. */
export interface HeuristicNode { readonly seq: number; readonly heuristicTokens: number }

/** Price precisely the positional range the next marker will replace.
 * Never sort seqs: a surface after earlier replacements need not be numeric order.
 * Unknown, duplicated, misaligned or invalid measurements safely decline pricing.
 */
export function priceRollbackPrune(marker: TruncationMarkerPlan, nodes: readonly HeuristicNode[]) {
  if (marker.range === null || marker.shadowed.length === 0) return null
  const start = nodes.findIndex(node => node.seq === marker.range!.start)
  if (start < 0) return null
  const selected = nodes.slice(start, start + marker.shadowed.length)
  if (selected.length !== marker.shadowed.length || selected.at(-1)?.seq !== marker.range.end) return null
  let total = 0
  const seen = new Set<number>()
  for (let index = 0; index < selected.length; index++) {
    const node = selected[index]!
    if (node.seq !== marker.shadowed[index] || seen.has(node.seq)
      || !Number.isSafeInteger(node.heuristicTokens) || node.heuristicTokens < 0) return null
    seen.add(node.seq)
    total += node.heuristicTokens
    if (!Number.isSafeInteger(total)) return null
  }
  return {
    shadowedRange: { start: marker.range.start, end: marker.range.end },
    shadowedSeqs: [...marker.shadowed], shadowedTokenCount: total,
  }
}
