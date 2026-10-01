/**
 * Type-check the DSH-facing host files.
 *
 * The project's own `tsc --noEmit` deliberately covers only `src/core` and `tests`:
 * `src/service.ts`, `src/index.ts` and the client half import types from
 * `@deepseek-ai/*` packages that were NOT installed in this repository, so those
 * files were never type-checked. A bundler does not care about a missing identifier,
 * and the gap has already cost this project once: a dropped import shipped as a
 * runtime `ReferenceError` (`shadowedSurfaceFrom is not defined`) from a green
 * `pnpm build && pnpm test`.
 *
 * This script closed that gap by running the compiler over those files and ignoring
 * the diagnostics the ABSENT packages inevitably caused — 18 of them, which is a lot
 * of cover for a real defect to hide behind. That ignoring is now gone, because the
 * absence is gone:
 *
 *   - the DSH packages this plugin touches are installed as devDependencies,
 *     pinned to `0.2.0-rc.2` — the build this plugin is adapted to. Note these
 *     publish under two dist-tags and `latest` is a stale, broken `0.0.1-rc.1`
 *     line; the real line is `next`. An unpinned install gets the broken one.
 *   - `src/dsh-types.ts` loads those packages' `Context` augmentations. Installing
 *     them is not enough on its own: an augmentation only applies when its module is
 *     loaded by the program, which is why the service names resolved to nothing.
 *   - `@types/react` / `@types/react-dom` are installed, so the client half is
 *     checked too — and doing that immediately caught a real misuse: the official
 *     `Tooltip` requires `children` as a prop, which `createElement`'s varargs no
 *     longer satisfy.
 *
 * So nothing is silenced any more, and the check now fails on exactly what it should:
 * a missing module, a wrong identifier, a signature mismatch. Both halves run it:
 * `pnpm typecheck` (which also runs `tsc --noEmit`) and `pnpm typecheck:host`.
 *
 * It uses the compiler API rather than spawning `tsc`, so it needs no child process
 * and cannot be blocked by a sandbox that forbids piped stdio.
 *
 * @module dsh-rollback/scripts/typecheck-host
 */

import ts from 'typescript'

/** The plugin's own files that consume DSH and browser APIs. */
const FILES = [
  'src/dsh-types.ts',
  'src/service.ts',
  'src/index.ts',
  'src/invariant.ts',
  'src/client/index.ts',
]

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

if (diagnostics.length === 0) {
  console.log(`typecheck:host OK — ${FILES.join(', ')} (nothing silenced)`)
  process.exit(0)
}

const formatHost = {
  getCanonicalFileName: fileName => fileName,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => '\n',
}
for (const diagnostic of diagnostics) {
  console.error(ts.formatDiagnostic(diagnostic, formatHost).trim())
}
console.error(`typecheck:host FAILED — ${diagnostics.length} error(s) in ${FILES.join(', ')}`)
process.exit(1)