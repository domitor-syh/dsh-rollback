/**
 * Type-check the DSH-facing host files.
 *
 * The project's own `tsc --noEmit` deliberately covers only `src/core` and
 * `tests`, because `src/service.ts` and `src/index.ts` import types from
 * `@deepseek-ai/*` packages that are NOT installed in this repository — the DSH
 * host resolves them at runtime, and the bundle keeps them external. Those files
 * were therefore never type-checked, and a bundler does not care about a missing
 * identifier: a dropped import shipped as a runtime `ReferenceError`
 * (`shadowedSurfaceFrom is not defined`) from a green `pnpm build && pnpm test`.
 *
 * This script closes that gap. It runs the compiler over exactly those files and
 * ignores the diagnostics the absent packages inevitably cause, so anything else
 * fails the run:
 *
 *   TS2307  Cannot find module '@deepseek-ai/…' — the package is not installed.
 *   TS7006  a callback parameter only those packages' types would have typed.
 *
 * Everything else is a real defect, including TS2304/TS2552 (an undefined name).
 * It uses the compiler API rather than spawning `tsc`, so it needs no child
 * process and cannot be blocked by a sandbox that forbids piped stdio.
 *
 * @module dsh-rollback/scripts/typecheck-host
 */

import ts from 'typescript'

/** The plugin's own files that consume DSH and browser APIs the repo can't type. */
const FILES = ['src/service.ts', 'src/index.ts', 'src/client/index.ts']

/**
 * Diagnostics caused by packages this repo does not install types for: the
 * `@deepseek-ai/*` DSH packages (resolved by the host at runtime) and `react`
 * (a peer dependency with no bundled declarations). Everything outside this set
 * is treated as a real error.
 */
const UNRESOLVED_PACKAGE_FALLOUT = new Set([
  2307, // Cannot find module '@deepseek-ai/…' or its corresponding type declarations.
  7006, // Parameter implicitly has an 'any' type (the missing types would have typed it).
  7016, // Could not find a declaration file for module 'react' — it implicitly has an 'any' type.
])

const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  verbatimModuleSyntax: true,
  types: ['node'],
}

const program = ts.createProgram(FILES, options)
const diagnostics = [
  ...program.getSyntacticDiagnostics(),
  ...program.getSemanticDiagnostics(),
]

const real = diagnostics.filter(diagnostic => !UNRESOLVED_PACKAGE_FALLOUT.has(diagnostic.code))
const ignored = diagnostics.length - real.length

if (real.length === 0) {
  console.log(`typecheck:host OK — ${FILES.join(', ')} (${ignored} unresolved-package diagnostic(s) ignored)`)
  process.exit(0)
}

const formatHost = {
  getCanonicalFileName: fileName => fileName,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => '\n',
}
for (const diagnostic of real) {
  console.error(ts.formatDiagnostic(diagnostic, formatHost).trim())
}
console.error(`typecheck:host FAILED — ${real.length} real error(s) in ${FILES.join(', ')}`)
process.exit(1)