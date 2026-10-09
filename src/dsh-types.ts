/**
 * Pull the host packages' `Context` augmentations into the type-check program.
 *
 * DSH's packages declare their services and events by AUGMENTING `@deepseek-ai/cordis`
 * (`declare module '@deepseek-ai/cordis' { interface Context { fs: … } }`), and an
 * augmentation only applies when its module is loaded BY THE PROGRAM. Installing the
 * package is not enough — which is why the host half used to be checked with 18
 * diagnostics silenced: `ctx.fs`, `ctx.commands`, `ctx.sandboxPolicy`,
 * `ctx.systemPrompt` and the `tools/*` events all resolved to nothing, and the
 * silenced list hid real defects along with them.
 *
 * Every import here is TYPE-ONLY, so `verbatimModuleSyntax` erases all of them at
 * emit: the shipped plugin keeps its property of importing no core package at
 * runtime. The packages sit in `devDependencies` — needed to type-check, never to run.
 *
 * Most of these do not expose a `/types` subpath, so the package root is imported.
 * That is the whole trick: a type-only import of the entry pulls its `.d.ts`, and the
 * augmentation inside it takes effect for the rest of the program.
 *
 * @module @domitor-syh/dsh-rollback/dsh-types
 */

// ctx.fs — resolve, processPath, stat, readText, writeText, editText.
import type {} from '@deepseek-ai/dsh-fs'
// ctx.commands.register, and the CommandDefinition / invocation shapes it takes.
import type {} from '@deepseek-ai/dsh-commands'
// ctx.sandboxPolicy.resolve — the policy that bounds every path this plugin touches.
import type {} from '@deepseek-ai/dsh-sandbox-policy'
// ctx.systemPrompt.context — the turn-scoped note this plugin contributes.
import type {} from '@deepseek-ai/dsh-system-prompt'
// The tools/pre-execute, tools/execute and tools/result events this plugin observes.
import type {} from '@deepseek-ai/dsh-tools'
// Optional context-pressure pricing; type-only, no runtime dependency or injection.
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-token-meter'
// ctx.invariants.register — the seat self-check.
import type {} from '@deepseek-ai/dsh-invariants'
// Session and its branded ids/seqs, plus the event payload shapes.
import type {} from '@deepseek-ai/dsh-session/types'
