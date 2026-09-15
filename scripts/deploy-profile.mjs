/**
 * Deploy the built plugin into a DSH profile.
 *
 * `pnpm build` only updates THIS repository's `lib/`, and DSH does not load the
 * plugin from here: the profile declares a `file:` dependency on the packed
 * tarball and loads the copy extracted into its own `node_modules`. So editing
 * the source and rebuilding changes nothing at runtime until the plugin is
 * re-packed AND re-installed — and because the version does not change during a
 * dev loop, a package manager may skip the reinstall entirely. That silence is
 * the trap this script removes.
 *
 * It packs the current build, refreshes both places the profile can read from
 * (the referenced tarball and the extracted copy), backs up the previous
 * extracted build once, and then states the one step it cannot do: restarting
 * DSH (the host half loads at startup) and refreshing the page (the client half).
 *
 * Usage:
 *   pnpm build && node scripts/deploy-profile.mjs
 *
 * Environment:
 *   DSH_HOME     harness home (default: `~/.dsh`)
 *   DSH_PROFILE  profile to deploy into (default: `web`)
 *
 * @module dsh-rollback/scripts/deploy-profile
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const PACKAGE = '@domitor-syh/dsh-rollback'
const repo = resolve(import.meta.dirname, '..')

/**
 * Copy one file over `dest`, breaking any existing link first.
 *
 * A package manager may HARDLINK files from its store into `node_modules`
 * (pnpm does on this machine), and Node's copy helpers fail to replace a
 * hardlink on Windows. Removing the entry first makes the copy create a fresh
 * file, which also leaves the shared store copy untouched.
 * @param src - file to copy from.
 * @param dest - destination file to replace.
 */
function replaceFile(src, dest) {
  rmSync(dest, { force: true })
  copyFileSync(src, dest)
}

/**
 * Copy a directory tree, replacing `dest`.
 *
 * Deliberately NOT `cpSync(src, dest, { recursive: true })`: on Windows that
 * call SILENTLY does nothing when the source and destination are on different
 * volumes — no error, no files — which deleted an installed plugin's `lib/`
 * once already. It also cannot replace hardlinked destinations. Walking the
 * tree with `copyFileSync` avoids both.
 * @param src - directory to copy from.
 * @param dest - directory to replace.
 */
function replaceTree(src, dest) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) replaceTree(from, to)
    else replaceFile(from, to)
  }
}

/** The harness home, honoring `DSH_HOME`. */
const dshHome = process.env.DSH_HOME?.trim() !== undefined && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(homedir(), '.dsh')
const profileName = process.env.DSH_PROFILE?.trim() || 'web'
const profile = join(dshHome, 'profiles', profileName)
const profileManifest = join(profile, 'package.json')

if (!existsSync(profileManifest)) {
  console.error(`deploy-profile: no profile manifest at ${profileManifest}`)
  process.exit(1)
}

// Read the specifier the profile actually installs, so the tarball we refresh is
// the one that will be read — never a guessed path.
const manifest = JSON.parse(readFileSync(profileManifest, 'utf8'))
const specifier = manifest.dependencies?.[PACKAGE]
if (typeof specifier !== 'string' || !specifier.startsWith('file:')) {
  console.error(`deploy-profile: ${profileManifest} does not depend on ${PACKAGE} via file: (got ${JSON.stringify(specifier)})`)
  process.exit(1)
}
const referencedTarball = resolve(specifier.slice('file:'.length))
const installed = join(profile, 'node_modules', ...PACKAGE.split('/'))

const builtEntry = join(repo, 'lib', 'index.js')
if (!existsSync(builtEntry)) {
  console.error(`deploy-profile: ${builtEntry} is missing — run \`pnpm build\` first`)
  process.exit(1)
}

// 1) Pack the current build. `stdio: 'inherit'` keeps this free of any piped
// stdio, so it also works under a sandbox that forbids named pipes.
const pack = spawnSync('pnpm', ['pack'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' })
if (pack.status !== 0) {
  console.error('deploy-profile: `pnpm pack` failed')
  process.exit(pack.status ?? 1)
}
const packed = readdirSync(repo)
  .filter(name => name.endsWith('.tgz'))
  .map(name => join(repo, name))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
if (packed === undefined) {
  console.error('deploy-profile: `pnpm pack` produced no tarball')
  process.exit(1)
}

// 2) Refresh the tarball the profile references (backing up the previous one).
mkdirSync(dirname(referencedTarball), { recursive: true })
if (existsSync(referencedTarball)) {
  const backup = `${referencedTarball}.bak`
  if (!existsSync(backup)) copyFileSync(referencedTarball, backup)
}
copyFileSync(packed, referencedTarball)

// 3) Refresh the extracted copy, so a plain restart is enough — no reinstall.
// The first backup is kept, so the pre-deploy build stays recoverable.
if (existsSync(installed)) {
  const libBackup = join(installed, 'lib.bak')
  if (!existsSync(libBackup)) replaceTree(join(installed, 'lib'), libBackup)
  replaceTree(join(repo, 'lib'), join(installed, 'lib'))
  for (const file of ['package.json', 'cordis.patch.yml', 'README.md', 'README.en.md']) {
    if (existsSync(join(repo, file))) replaceFile(join(repo, file), join(installed, file))
  }
} else {
  console.error(`deploy-profile: ${installed} is missing — run \`pnpm install\` in ${profile} first`)
  process.exit(1)
}

// 4) Verify what was actually deployed, and say so — the point of this script.
const deployedEntry = join(installed, 'lib', 'index.js')
if (!existsSync(deployedEntry)) {
  console.error(`deploy-profile: ${deployedEntry} is missing after the copy — the install is now incomplete`)
  process.exit(1)
}
const deployed = readFileSync(deployedEntry, 'utf8')
const built = readFileSync(builtEntry, 'utf8')
if (deployed !== built) {
  console.error('deploy-profile: the deployed index.js does not match the build')
  process.exit(1)
}

console.log(`deploy-profile: deployed ${PACKAGE} to profile "${profileName}"`)
console.log(`  tarball:   ${referencedTarball}`)
console.log(`  installed: ${installed} (${deployed.length} bytes verified)`)
console.log('  Next: RESTART DSH (the host half loads at startup), then refresh the page.')
console.log('  Not done here: the running process keeps the code it booted with.')