/**
 * Sliding-window checkpoint store. The tutorial's "仅最近 10 轮" limit is a
 * rolling window: older checkpoints are dropped to bound memory.
 *
 * Pure, dependency-free, and independent of any per-session keying — the host
 * plugin owns one instance per live session.
 *
 * @module @domitor-syh/dsh-rollback/core/sliding-window
 */

export class SlidingWindow<T> {
  private items: T[] = []

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('SlidingWindow capacity must be a positive safe integer')
    }
  }

  /** Append one item, evicting the oldest when over capacity. */
  push(item: T): void {
    this.items.push(item)
    if (this.items.length > this.capacity) this.items.shift()
  }

  /** A fresh copy of the retained items, oldest first. */
  snapshot(): readonly T[] {
    return [...this.items]
  }

  /** Number of retained items. */
  size(): number {
    return this.items.length
  }

  /** Drop everything (HMR / session disposal safety). */
  clear(): void {
    this.items = []
  }
}