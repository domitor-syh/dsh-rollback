/**
 * Package-owned invariant companion for `@domitor-syh/dsh-rollback`.
 * @module @domitor-syh/dsh-rollback/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@domitor-syh/dsh-rollback'

/** Cordis companion plugin name. */
export const name = 'rollback-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No relational invariant of its own: the `rollback/truncate` event is a
 * log-only plugin event (core invariant falls through to the merge-extensible
 * default), and the observable capture state is keyed weakly by session so its
 * lifetime is the session's, not a cross-plugin relation.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))