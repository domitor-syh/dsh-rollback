/**
 * Where this plugin's diagnostics go.
 *
 * A plugin's `console.warn` reaches only the terminal that started DSH — not the
 * app's own log, and not whatever surface the host shows the user. `ctx.logger` is
 * the channel the host actually routes. That difference is measurable: this plugin's
 * contained observer failures were invisible in the app, so a host-side probe had to
 * hijack the global `console` just to read them back.
 *
 * So every diagnostic goes through here, through the framework's logger when the
 * build provides one — and through the console when it does not, because a dropped
 * diagnostic is worse than one in the wrong place. A failing logger must never
 * become a second failure either, hence the try/catch: reporting is not worth
 * throwing over.
 *
 * @module @domitor-syh/dsh-rollback/log
 */

/** The subset of a Cordis logger this module uses. */
export interface DiagnosticLogger {
  readonly info?: (message: string) => void
  readonly warn?: (message: string) => void
  readonly error?: (message: string) => void
}

/** Anything that may carry a logger: a context, a scope, or nothing. */
type LoggerCarrier = { readonly logger?: DiagnosticLogger } | undefined | null

/** Severity of one diagnostic. */
export type DiagnosticLevel = 'info' | 'warn' | 'error'

/**
 * Render the values after the message into the single string a logger takes.
 *
 * Errors keep their stack when there is one: the observer-failure reports exist to
 * explain WHY something was contained, and the stack is most of that answer.
 * @param rest - the values to append.
 * @returns a leading-space-joined suffix, or the empty string.
 */
function describe(rest: readonly unknown[]): string {
  if (rest.length === 0) return ''
  return ' ' + rest
    .map(value => {
      if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
      if (typeof value === 'string') return value
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    })
    .join(' ')
}

/**
 * Report one diagnostic through the framework's logger, or the console.
 *
 * The message is a single string on purpose: a logger's parameter list is not
 * promised to look like `console`'s, and formatting here keeps the two call sites
 * (and any future one) identical.
 * @param carrier - whatever holds the logger: usually the plugin's context.
 * @param level - severity to report at.
 * @param message - the message, already prefixed with the plugin's name.
 * @param rest - extra values, appended as one string.
 */
export function diagnose(carrier: LoggerCarrier, level: DiagnosticLevel, message: string, ...rest: unknown[]): void {
  const line = message + describe(rest)
  const logger = carrier?.logger
  const write = logger?.[level]
  if (typeof write === 'function') {
    try {
      write.call(logger, line)
      return
    } catch {
      // Fall through: a logger that throws must not swallow the report.
    }
  }
  const fallback = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  fallback(line)
}