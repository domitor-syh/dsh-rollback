import { defineConfig } from 'tsdown'

/**
 * Self-contained build for the standalone repository, mirroring
 * dsh-ui-skin-switcher. No references outside this package, so a `pnpm
 * install` of a git checkout can run it through its own `prepare` script.
 *
 * Outputs (matching the runtime contract DSH expects):
 * - lib/index.js, lib/invariant.js  ESM node halves; `@deepseek-ai/*` stays
 *   external (the DSH installation resolves it at runtime).
 * - lib/client.js                   browser half wrapped in the
 *   `window.__ModuleLoader__.load({ id, factory })` registration shell;
 *   `@deepseek-ai/*` and react stay external.
 */

const PKG_ID = '@domitor-syh/dsh-rollback'

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/invariant.ts'],
    outDir: 'lib',
    format: 'esm',
    platform: 'neutral',
    dts: false,
    sourcemap: false,
    external: [/^@deepseek-ai\//, 'node:fs', 'node:fs/promises', 'node:os', 'node:path'],
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: false,
    external: [/^@deepseek-ai\//, 'react', 'react-dom'],
    outputOptions: {
      entryFileNames: '[name].js',
      banner:
        'window.__ModuleLoader__.load({\n' +
        `\tid: ${JSON.stringify(PKG_ID)},\n` +
        '\tfactory: (require) => {\n' +
        '\t\tvar module = { exports: {} };\n' +
        '\t\tvar exports = module.exports;\n' +
        '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
      footer:
        '\t\treturn module.exports;\n' +
        '\t}\n' +
        '});',
    },
  },
])