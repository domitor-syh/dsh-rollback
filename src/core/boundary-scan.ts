/** Pure boundary decisions: unknown probes never become filesystem mutations. */
export interface TrackedFile {
  /** null is unknown content unless missing=true confirms absence. */
  readonly lastKnown: string | null
  readonly size: number | null
  readonly mtimeMs: number | null
  readonly missing: boolean
  readonly lastSeenTurn?: number | null
}

export interface ObservedFile {
  readonly content: string
  readonly size: number
  readonly mtimeMs: number
}

export type FileProbe<T> =
  | { readonly kind: 'observed'; readonly value: T }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unknown'; readonly reason: string }

export type BoundaryAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'adopt'; readonly observed: ObservedFile }
  | { readonly kind: 'created'; readonly observed: ObservedFile }
  | { readonly kind: 'missing'; readonly before: string }
  | { readonly kind: 'changed'; readonly before: string; readonly after: string; readonly observed: ObservedFile }
  | { readonly kind: 'unrestorable' }

export function unchangedByStat(tracked: TrackedFile, size: number, mtimeMs: number): boolean {
  return !tracked.missing && tracked.lastKnown !== null && tracked.size === size && tracked.mtimeMs === mtimeMs
}

/** Findings belong to the boundary scanned, never a stale earlier confirmation. */
export function findingTurn(lastSeenTurn: number | null | undefined, scannedTurn: number): number {
  void lastSeenTurn
  return scannedTurn
}

/**
 * Accept a typed probe; plain observed/null is retained for existing callers where
 * null has the strict meaning confirmed ENOENT (not any caught filesystem error).
 */
export function planBoundaryAction(tracked: TrackedFile, probe: FileProbe<ObservedFile> | ObservedFile | null): BoundaryAction {
  let observed: ObservedFile | null
  if (probe !== null && 'kind' in probe) {
    if (probe.kind === 'unknown') return { kind: 'unknown', reason: probe.reason }
    observed = probe.kind === 'missing' ? null : probe.value
  } else observed = probe
  if (observed === null) {
    if (tracked.missing) return { kind: 'none' }
    if (tracked.lastKnown === null) return { kind: 'unrestorable' }
    return { kind: 'missing', before: tracked.lastKnown }
  }
  if (tracked.missing) return { kind: 'created', observed }
  if (tracked.lastKnown === null) return { kind: 'adopt', observed }
  if (observed.content === tracked.lastKnown) return { kind: 'none' }
  return { kind: 'changed', before: tracked.lastKnown, after: observed.content, observed }
}
