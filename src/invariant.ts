/**
 * Legacy invariant companion entry retained for existing Cordis configurations.
 *
 * @deprecated DSH 0.2.1 retired the invariant service. This entry is a no-op and
 * may be removed from configuration; rollback does not require a companion.
 * @module @domitor-syh/dsh-rollback/invariant
 */

import type { Context } from '@deepseek-ai/cordis'

/** Historical Cordis plugin name, retained for configuration compatibility. */
export const name = 'rollback-invariant'
/** The legacy entry can activate even when the retired service is absent. */
export const inject: string[] = []

/** Accept existing plugin configurations without installing resources. */
export const apply = (_ctx: Context): void => {}
