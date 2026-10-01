/**
 * Bilingual README parity check.
 *
 * The two READMEs are maintained by hand in two languages, so they drift. They have
 * — twice in one session: a compatibility claim that had gone stale in both, and a
 * regression-test inventory that had drifted apart. Reviewing prose cannot catch
 * that reliably, because the prose is supposed to differ. STRUCTURE is not supposed
 * to differ, and neither are the facts that are language-neutral.
 *
 * So this checks exactly those two things and nothing else:
 *
 *   1. structure — heading depths, table count, rows per table, column counts, code
 *      fences. A reader of either language must land on the same document.
 *   2. language-neutral facts — every version string, every `backticked.identifier`
 *      and every path must appear in both. A number that is true in one file and
 *      absent in the other is the drift that matters.
 *
 * It deliberately does NOT compare prose, headings' text, or ordering of sentences:
 * those are allowed to differ, and flagging them would train the reader to ignore
 * the check.
 *
 * Usage: node scripts/check-readmes.mjs   (exit 1 on drift)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['README.md', 'README.en.md'];

/** Facts that must match across languages: stated as a number, an identifier or a path. */
const FACT_PATTERNS = [
  { label: 'version strings', re: /\b\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?\b/g },
  { label: 'dotted identifiers', re: /`([a-zA-Z][\w.]*\.[\w.]+)`/g },
  { label: 'file paths', re: /`((?:src|scripts|tests|lib|docs)\/[\w./-]+)`/g },
];

const read = (file) => readFileSync(join(root, file), 'utf8');

/** Structural fingerprint of one document. */
function structure(text) {
  const lines = text.split(/\r?\n/);
  const headings = [];
  const tables = [];
  let current = null;
  let fences = 0;

  for (const line of lines) {
    const heading = /^(#{1,6})\s+\S/.exec(line);
    if (heading) {
      headings.push(heading[1].length);
      current = null;
      continue;
    }
    if (/^\s*```/.test(line)) {
      fences += 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const columns = line.split('|').length - 2;
      if (current === null) {
        current = { rows: 0, columns };
        tables.push(current);
      }
      current.rows += 1;
      if (columns !== current.columns) current.columns = Math.max(current.columns, columns);
      continue;
    }
    if (line.trim() !== '') current = null;
  }

  return {
    headings: headings.join(','),
    headingCount: headings.length,
    tables: tables.map((t) => `${t.rows}r x ${t.columns}c`).join(' '),
    tableCount: tables.length,
    tableRows: tables.map((t) => t.rows),
    fences,
  };
}

/** Every distinct language-neutral fact in one document, per category. */
function facts(text) {
  const found = {};
  for (const { label, re } of FACT_PATTERNS) {
    const set = new Set();
    for (const match of text.matchAll(re)) set.add(match[1] ?? match[0]);
    found[label] = set;
  }
  return found;
}

const failures = [];
const notes = [];

const docs = {};
for (const file of FILES) {
  try {
    docs[file] = read(file);
  } catch (error) {
    failures.push(`${file}: cannot read (${error.code ?? error.message})`);
  }
}

if (failures.length === 0) {
  const [a, b] = FILES;
  const sa = structure(docs[a]);
  const sb = structure(docs[b]);

  // 1. Structure.
  for (const key of ['headingCount', 'tableCount', 'fences']) {
    if (sa[key] !== sb[key]) failures.push(`structure: ${key} — ${a}=${sa[key]} vs ${b}=${sb[key]}`);
  }
  if (sa.headings !== sb.headings) {
    failures.push(`structure: heading depths differ\n        ${a}: ${sa.headings}\n        ${b}: ${sb.headings}`);
  }
  if (sa.tables !== sb.tables) {
    failures.push(`structure: table shapes differ (rows x columns)\n        ${a}: ${sa.tables}\n        ${b}: ${sb.tables}`);
  } else {
    notes.push(`structure identical: ${sa.headingCount} headings, ${sa.tableCount} tables (${sa.tables}), ${sa.fences} fences`);
  }

  // 2. Language-neutral facts, both directions — a number present in only one file
  //    is the drift that hides, whichever file it is missing from.
  const fa = facts(docs[a]);
  const fb = facts(docs[b]);
  for (const { label } of FACT_PATTERNS) {
    const onlyA = [...fa[label]].filter((v) => !fb[label].has(v)).sort();
    const onlyB = [...fb[label]].filter((v) => !fa[label].has(v)).sort();
    if (onlyA.length > 0) failures.push(`${label} only in ${a}: ${onlyA.join(', ')}`);
    if (onlyB.length > 0) failures.push(`${label} only in ${b}: ${onlyB.join(', ')}`);
    if (onlyA.length === 0 && onlyB.length === 0) notes.push(`${label}: ${fa[label].size} shared`);
  }
}

for (const note of notes) console.log(`  ok    ${note}`);
for (const failure of failures) console.log(`  DRIFT ${failure}`);

if (failures.length > 0) {
  console.log(`\n${failures.length} bilingual drift(s) found — the two READMEs describe the same plugin, so they must agree on structure and facts.`);
  process.exit(1);
}
console.log('\nREADME.md and README.en.md agree on structure and on every language-neutral fact.');