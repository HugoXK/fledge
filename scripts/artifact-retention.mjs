#!/usr/bin/env node
// Reclaim the workspace snapshots agent runs leave behind under the instance
// root. The dry run is the default: nothing is removed without --apply, and the
// only things it will ever remove are `r<number>` snapshots that no state file
// references and that sit outside both keep windows. Everything else is
// reported and left alone.
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

const USAGE = 'usage: node scripts/artifact-retention.mjs [--root <dir>] [--keep <n>] [--max-age-days <n>] [--apply] [--dry-run]'

const DAY_MS = 86_400_000
const RUN_NAME = /^r(\d+)$/
const STATE_FILES = ['state.json', 'inflight.json']

class RetentionError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function fail(code, message) {
  throw new RetentionError(code, message)
}

function parseCount(text, name, min) {
  // `Number('')` and `Number('   ')` are 0, so an empty value must not reach the
  // conversion: for the two retention knobs zero means "keep nothing".
  const raw = text === undefined ? '' : String(text)
  if (raw.trim() === '') fail(2, `${name} must be an integer >= ${String(min)}, got ${String(text)}`)
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) fail(2, `${name} must be an integer >= ${String(min)}, got ${String(text)}`)
  return value
}

// A setting shipped empty in `.env.example` is unset, exactly like the root:
// the default applies rather than the most destructive possible value.
function countFromEnv(env, name, fallback) {
  const raw = env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  return parseCount(raw, name, 0)
}

function parseArgs(argv) {
  const parsed = { apply: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--apply') parsed.apply = true
    else if (arg === '--dry-run') parsed.apply = false
    else if (arg === '--root') {
      index += 1
      const value = argv[index]
      // A missing value used to fall through to the environment root, which made
      // `--root` silently mean "whatever this timer's env says".
      if (value === undefined || value === '' || value.startsWith('--')) fail(2, `--root requires a value\n${USAGE}`)
      parsed.root = value
    }
    else if (arg === '--keep') { index += 1; parsed.keep = parseCount(argv[index], '--keep', 0) }
    else if (arg === '--max-age-days') { index += 1; parsed.maxAgeDays = parseCount(argv[index], '--max-age-days', 0) }
    else fail(2, `unknown argument ${arg}\n${USAGE}`)
  }
  return parsed
}

// Every string anywhere in a state file is a possible workspace reference, and
// those files belong to the runtime rather than to this repository, so the walk
// is deliberately shape-agnostic: an unrecognised name protects more than it
// removes, which is the safe direction for this tool to be wrong in.
function collectStrings(value, sink) {
  if (typeof value === 'string') { sink.add(value); return }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, sink); return }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, sink)
  }
}

function referencedWorkspaces(botDir) {
  const names = new Set()
  const paths = new Set()
  let unreadable
  for (const file of STATE_FILES) {
    const path = join(botDir, file)
    if (!existsSync(path)) continue
    let parsed
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // A state file that cannot be parsed protects every workspace in the
      // repository: the tool must not delete on a guess.
      names.add('*')
      unreadable = file
      continue
    }
    const strings = new Set()
    collectStrings(parsed, strings)
    for (const item of strings) {
      names.add(item)
      names.add(basename(item))
      if (item.includes('/') || item.includes(sep)) {
        // A reference is a path inside this repository's runtime tree, so a
        // relative one resolves against the bot directory the state file lives
        // in, never against whatever directory the timer happens to run from.
        // Any r<number> segment on that path protects that snapshot too: a
        // reference to `r11/checkout` must not leave `r11` removable.
        const resolved = resolve(botDir, item)
        paths.add(resolved)
        for (const segment of resolved.split(sep)) {
          if (RUN_NAME.test(segment)) names.add(segment)
        }
      }
    }
  }
  return { names, paths, unreadable }
}

// A snapshot is a tree of ordinary files; a symlink inside one is never
// followed, so the byte count cannot leave the tree and cannot double-count.
function directoryBytes(path) {
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += directoryBytes(child)
    else if (entry.isFile()) total += lstatSync(child).size
  }
  return total
}

function listDirectories(path) {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(path, entry.name))
    .sort()
}

function repoDirectories(root) {
  const repos = []
  for (const userDir of listDirectories(join(root, 'users'))) {
    for (const repoDir of listDirectories(join(userDir, 'repos'))) repos.push(repoDir)
  }
  return repos
}

function snapshot(workspaceRoot, name, now) {
  const path = join(workspaceRoot, name)
  const match = RUN_NAME.exec(name)
  if (match === null) return { path, name, action: 'skip', reason: 'not-a-run' }
  const stats = lstatSync(path)
  if (stats.isSymbolicLink()) return { path, name, action: 'skip', reason: 'symlink' }
  if (!stats.isDirectory()) return { path, name, action: 'skip', reason: 'not-a-directory' }
  return {
    path,
    name,
    run: Number(match[1]),
    ageDays: (now - stats.mtimeMs) / DAY_MS,
    bytes: directoryBytes(path),
    workspaceRoot,
  }
}

function decide(entry, keep, maxAgeDays, referenced) {
  if (entry.action === 'skip') return entry
  const isReferenced = referenced.names.has('*')
    || referenced.names.has(entry.name)
    || referenced.paths.has(resolve(entry.path))
  if (isReferenced) return { ...entry, action: 'keep', reason: 'referenced' }
  if (entry.keepByCount === true) return { ...entry, action: 'keep', reason: 'newest' }
  if (entry.ageDays <= maxAgeDays) return { ...entry, action: 'keep', reason: 'within-window' }
  return { ...entry, action: 'remove', reason: 'outside-window' }
}

function line(entry) {
  if (entry.action === 'skip') return `workspace=${entry.path} action=skip reason=${entry.reason}`
  return `workspace=${entry.path} run=${entry.name} age_days=${entry.ageDays.toFixed(2)} bytes=${String(entry.bytes)} action=${entry.action} reason=${entry.reason}`
}

function removeCandidate(entry) {
  // A candidate is a directory under a workspace root this run enumerated; a
  // path that escaped that root, or a symlink standing in for one, is a bug and
  // never a delete.
  const resolved = resolve(entry.path)
  if (!resolved.startsWith(resolve(entry.workspaceRoot) + sep)) return 'outside-workspace-root'
  const stats = lstatSync(resolved)
  if (stats.isSymbolicLink() || !stats.isDirectory()) return 'not-a-directory'
  rmSync(resolved, { recursive: true, force: true })
  return undefined
}

function collect(entries, candidates) {
  return {
    keep: entries.filter((entry) => entry.action === 'keep').length,
    candidates: candidates.length,
    bytes: candidates.reduce((sum, entry) => sum + entry.bytes, 0),
  }
}

function run(argv, env) {
  const parsed = parseArgs(argv)
  if (parsed.help) { console.log(USAGE); return 0 }

  // `??` is the wrong operator for an environment: `.env.example` ships
  // ARTIFACT_RETENTION_ROOT= with no value, and an empty string would stop the
  // chain at the cwd (the documented timer runs from /opt/fledge), walking the
  // wrong tree and reporting a clean run.
  const configuredRoot = [parsed.root, env.ARTIFACT_RETENTION_ROOT, env.FLYBOT_INSTANCE_ROOT, join(env.DATA_DIR ?? join('.', 'data'), 'flybot-users')]
    .find((value) => value !== undefined && value !== '')
  const root = resolve(configuredRoot)
  if (root === resolve(sep)) fail(1, `refusing to treat the filesystem root as an instance root: ${root}`)
  if (!existsSync(root)) fail(1, `instance root not found: ${root}`)

  const keep = parsed.keep ?? countFromEnv(env, 'ARTIFACT_RETENTION_KEEP', 3)
  const maxAgeDays = parsed.maxAgeDays ?? countFromEnv(env, 'ARTIFACT_RETENTION_MAX_AGE_DAYS', 14)
  const now = Date.now()

  const entries = []
  const traversed = []
  for (const repoDir of repoDirectories(root)) {
    const botDir = join(repoDir, 'data', 'bot')
    const workspaceRoot = join(botDir, 'workspace')
    if (!existsSync(workspaceRoot)) continue
    traversed.push(workspaceRoot)
    const referenced = referencedWorkspaces(botDir)
    const found = readdirSync(workspaceRoot).map((name) => snapshot(workspaceRoot, name, now))
    const ordered = found
      .filter((entry) => entry.action !== 'skip')
      .sort((left, right) => right.run - left.run)
    ordered.forEach((entry, index) => { entry.keepByCount = index < keep })
    if (referenced.unreadable !== undefined) {
      console.log(`workspace=${workspaceRoot} state-file=${referenced.unreadable} action=keep-all reason=state-file-unreadable`)
    }
    for (const entry of found) entries.push(decide(entry, keep, maxAgeDays, referenced))
  }

  const candidates = entries.filter((entry) => entry.action === 'remove')
  const totals = collect(entries, candidates)
  console.log(`instance-root=${root} workspaces=${String(traversed.length)} keep-window=${String(keep)} max-age-days=${String(maxAgeDays)}`)

  if (!parsed.apply) {
    for (const entry of entries) console.log(line(entry))
    console.log(`keep=${String(totals.keep)} candidates=${String(totals.candidates)} bytes=${String(totals.bytes)} freed=0`)
    console.log('artifact-retention: DRY-RUN nothing was removed; re-run with --apply')
    return 0
  }

  let removed = 0
  let failed = 0
  let freed = 0
  for (const entry of candidates) {
    const refusal = removeCandidate(entry)
    if (refusal === undefined) {
      removed += 1
      freed += entry.bytes
      console.log(`removed=${entry.path} bytes=${String(entry.bytes)}`)
    } else {
      failed += 1
      console.log(`failed=${entry.path} reason=${refusal}`)
    }
  }
  for (const entry of entries) if (entry.action === 'skip') console.log(line(entry))
  const actor = env.USER ?? env.LOGNAME ?? 'unknown'
  console.log(`keep=${String(totals.keep)} candidates=${String(totals.candidates)} bytes=${String(totals.bytes)} removed=${String(removed)} failed=${String(failed)} freed=${String(freed)}`)
  // The audit line is the record: stdout is what an operator's timer and
  // journald keep, and it names what was removed and how much it freed.
  console.log(`audit action=artifact-retention actor=${actor} root=${root} keep=${String(keep)} max-age-days=${String(maxAgeDays)} removed=${String(removed)} failed=${String(failed)} freed=${String(freed)}`)
  if (failed > 0) {
    console.log('artifact-retention: FAILED')
    return 1
  }
  console.log('artifact-retention: OK')
  return 0
}

try {
  process.exitCode = run(process.argv.slice(2), process.env)
} catch (error) {
  const failure = error instanceof RetentionError
    ? error
    : new RetentionError(1, error instanceof Error ? error.message : String(error))
  console.error(`artifact-retention: ${failure.message}`)
  process.exitCode = failure.code
}
