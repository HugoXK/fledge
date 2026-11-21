import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/db.js'
import { readRestoreDrill, type RestoreDrillStatus } from '../src/lib/backupStatus.js'
import { decryptSecret, encryptSecret, registerSecretKeyring } from '../src/lib/secrets.js'
import { adminPage } from '../src/views/pages.js'
import { makeTerminalJob, makeUser, testConfig } from './helpers.js'

const drillScript = fileURLToPath(new URL('../scripts/restore-drill.mjs', import.meta.url))
// Loaded per test so the suite reports this module's behaviour separately from a
// missing file: the drill rows must fail on their own at the base.
async function payloadModule(): Promise<typeof import('../scripts/lib/secret-payload.mjs')> {
  return import('../scripts/lib/secret-payload.mjs')
}
const deployDoc = fileURLToPath(new URL('../docs/deploy.md', import.meta.url))

// The column payloads this drill reads are written by `encryptSecret`, so the
// fixture is the real writer over a synthetic key: no production key and no copy
// of a real database is involved.
const KEY_A = randomBytes(32).toString('base64')
const KEY_B = randomBytes(32).toString('base64')
const KEY_RING = randomBytes(32).toString('base64')

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [drillScript, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string }
    return { code: failure.status ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

// A user, a repository, a user model and a job whose secrets were all sealed with
// `key`: the four tables the drill checks, so a decision about one table cannot
// stand in for the others.
function seedKeyed(dbPath: string, key: string, keyId?: string): void {
  const store = new Store(dbPath)
  try {
    const user = makeUser(store, { login: 'drill-keyed', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_drill',
      userId: user.id,
      owner: 'o',
      name: 'drill',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('repo-token', key, keyId),
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    store.setUserGithubToken(user.id, encryptSecret('user-token', key, keyId))
    store.createUserModel({
      id: 'um_drill',
      userId: user.id,
      label: 'model',
      baseUrl: 'https://models.example.invalid',
      keyEnc: encryptSecret('model-key', key, keyId),
      model: 'm',
      allowPrivate: false,
    })
    makeTerminalJob(store, { id: 'job_drill', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h1', platformTokenHash: '' })
  } finally {
    store.close()
  }
}

function statusOf(path: string): { ok: boolean; columnCheck?: string; columnErrors?: string[]; detail: string } {
  return JSON.parse(readFileSync(path, 'utf8')) as { ok: boolean; columnCheck?: string; columnErrors?: string[]; detail: string }
}

function fixture(options: { key?: string; keyId?: string; keyFile?: 'single' | 'ring' } = {}): {
  root: string
  dbPath: string
  backupDir: string
  workDir: string
  statusFile: string
  keyFile: string | null
} {
  const root = mkdtempSync(join(tmpdir(), 'fledge-drill-columns-'))
  const dbPath = join(root, 'live', 'fledge.db')
  const backupDir = join(root, 'backups')
  const workDir = join(root, 'work')
  const statusFile = join(root, 'backup-drill.json')
  seedKeyed(dbPath, options.key ?? KEY_A, options.keyId)
  let keyFile: string | null = null
  if (options.keyFile === 'ring') {
    keyFile = join(root, 'column-keyring.json')
    writeFileSync(keyFile, `${JSON.stringify({ [options.keyId ?? 'k2']: options.key ?? KEY_A })}\n`, { mode: 0o600 })
  } else if (options.keyFile === 'single') {
    keyFile = join(root, 'column.key')
    writeFileSync(keyFile, `${options.key ?? KEY_A}\n`, { mode: 0o600 })
  }
  return { root, dbPath, backupDir, workDir, statusFile, keyFile }
}

function drillArgs(input: ReturnType<typeof fixture>, keyFile: string | null): string[] {
  const args = ['--db', input.dbPath, '--backup-dir', input.backupDir, '--work-dir', input.workDir, '--status-file', input.statusFile]
  return keyFile === null ? args : [...args, '--secret-key-file', keyFile]
}

test('a copy restored under another column key fails the drill and names the columns', () => {
  const input = fixture({ key: KEY_A, keyFile: 'single' })
  try {
    const wrong = join(input.root, 'wrong.key')
    writeFileSync(wrong, `${KEY_B}\n`, { mode: 0o600 })
    const result = run(drillArgs(input, wrong))
    assert.notEqual(result.code, 0, 'a copy whose encrypted columns do not decrypt must not report a successful drill')
    assert.doesNotMatch(result.stdout, /^restore-drill: OK$/m)
    assert.match(result.stderr, /users\.github_token_enc|repos\.token_enc|user_models\.key_enc/, `stderr must name the columns, got: ${result.stderr}`)
    const record = statusOf(input.statusFile)
    assert.equal(record.ok, false)
    assert.equal(record.columnCheck, 'fail')
    const errors = record.columnErrors ?? []
    assert.ok(errors.some((entry) => entry.includes('users.github_token_enc')), `columnErrors must name users.github_token_enc, got: ${JSON.stringify(errors)}`)
    assert.ok(errors.some((entry) => entry.includes('user_models.key_enc')), `columnErrors must name user_models.key_enc, got: ${JSON.stringify(errors)}`)
    assert.doesNotMatch(readFileSync(input.statusFile, 'utf8'), /user-token|model-key|repo-token/, 'the status file must never carry a plaintext secret')
  } finally {
    rmSync(input.root, { recursive: true, force: true })
  }
})

test('the same copy with the key it was written under passes the column check', () => {
  const input = fixture({ key: KEY_A, keyFile: 'single' })
  try {
    const result = run(drillArgs(input, input.keyFile))
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^restore-drill: OK$/m)
    const record = statusOf(input.statusFile)
    assert.equal(record.ok, true)
    assert.equal(record.columnCheck, 'pass')
    assert.deepEqual(record.columnErrors ?? [], [])
  } finally {
    rmSync(input.root, { recursive: true, force: true })
  }
})

test('without the flag the status file says skipped and the run output is unchanged', () => {
  const keyed = fixture({ key: KEY_A, keyFile: 'single' })
  const plain = fixture({ key: KEY_A })
  try {
    const keyedRun = run(drillArgs(keyed, keyed.keyFile))
    assert.equal(keyedRun.code, 0, keyedRun.stderr)
    const skippedRun = run(drillArgs(plain, null))
    assert.equal(skippedRun.code, 0, skippedRun.stderr)
    assert.equal(statusOf(plain.statusFile).columnCheck, 'skipped')
    assert.equal(statusOf(plain.statusFile).ok, true)
    // The check is recorded, never printed: the console of a keyed and an unkeyed
    // run stays the same, so an operator's log comparison keeps working.
    const shape = (stdout: string): string => stdout.split('\n')
      .filter((line) => /^(manifest=|table=|schema_version |source_table=|schema_drift=|source_drift=|encryption=|backup=|restored=|RTO=|RPO=|restore-drill: )/.test(line))
      .map((line) => line.replace(/^(backup|restored|manifest)=.*$/, '$1=<path>').replace(/^(RTO|RPO)=.*$/, '$1=<time>'))
      .join('\n')
    assert.equal(shape(skippedRun.stdout), shape(keyedRun.stdout))
  } finally {
    rmSync(keyed.root, { recursive: true, force: true })
    rmSync(plain.root, { recursive: true, force: true })
  }
})

test('a keyed run that dies before the check records not-reached, never skipped', () => {
  // A copy that is not a database: the drill refuses it before it reaches the
  // column check. The record must then say the check never got its turn, because
  // `skipped` means "no key given" and the operator did pass one — sending them
  // to look for a flag they already have.
  const corrupt = (input: ReturnType<typeof fixture>): void => {
    mkdirSync(input.backupDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(input.backupDir, 'fledge-2026-11-20T00-00-00-000Z.db'), 'not a database\n', { mode: 0o600 })
  }
  const keyed = fixture({ key: KEY_A, keyFile: 'single' })
  const plain = fixture({ key: KEY_A })
  try {
    corrupt(keyed)
    const keyedRun = run(drillArgs(keyed, keyed.keyFile))
    assert.notEqual(keyedRun.code, 0, 'a copy that is not a database must not pass the drill')
    const keyedRecord = statusOf(keyed.statusFile)
    assert.equal(keyedRecord.ok, false)
    assert.equal(keyedRecord.columnCheck, 'not-reached', `a keyed run that failed before the check must not record "no key given", got: ${JSON.stringify(keyedRecord)}`)

    // The same failure without the flag stays `skipped`: the two states are told
    // apart by the flag that was given, not by the fact that the run failed.
    corrupt(plain)
    const plainRun = run(drillArgs(plain, null))
    assert.notEqual(plainRun.code, 0, 'the copy is corrupt with or without a key file')
    assert.equal(statusOf(plain.statusFile).columnCheck, 'skipped')
  } finally {
    rmSync(keyed.root, { recursive: true, force: true })
    rmSync(plain.root, { recursive: true, force: true })
  }
})

test('readRestoreDrill reads the column check the drill wrote and null for a file that predates it', () => {
  const input = fixture({ key: KEY_A, keyFile: 'single' })
  try {
    const result = run(drillArgs(input, null))
    assert.equal(result.code, 0, result.stderr)
    const status = readRestoreDrill(input.statusFile)
    assert.ok(status !== null)
    // `'skipped'` arrives as the union value: no parenthetical, no normalisation.
    assert.equal(status.columnCheck, 'skipped')
    assert.deepEqual(status.columnErrors, [])

    // A record from a keyed run that failed early carries its own union value;
    // reading it as `null` would read as "not recorded" and hide the reason.
    const unreached = join(input.root, 'unreached-drill.json')
    writeFileSync(unreached, `${JSON.stringify({ at: '2026-11-20T00:00:00.000Z', ok: false, detail: 'cannot open restored copy', columnCheck: 'not-reached', columnErrors: [] })}\n`)
    assert.equal(readRestoreDrill(unreached)?.columnCheck, 'not-reached')

    const legacy = join(input.root, 'legacy-drill.json')
    writeFileSync(legacy, `${JSON.stringify({ at: '2026-01-01T00:00:00.000Z', ok: true, detail: 'old' })}\n`)
    const old = readRestoreDrill(legacy)
    assert.ok(old !== null)
    assert.equal(old.columnCheck, null, 'a file that never carried the field is not recorded, not skipped')
    assert.deepEqual(old.columnErrors, [])
  } finally {
    rmSync(input.root, { recursive: true, force: true })
  }
})

function renderAdmin(locale: 'en' | 'zh', drill: RestoreDrillStatus | null): string {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: `drill-${locale}`, status: 'approved', superadmin: true })
    return adminPage({
      config: testConfig(),
      locale,
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      users: [],
      jobs: [],
      jobsPage: 1,
      jobsTotal: 0,
      audit: [],
      auditPage: 1,
      auditTotal: 0,
      perPage: 10,
      backup: { dir: '/nonexistent', present: false, copies: [], newest: null, stale: false, expectedHours: 26, matching: 0, differing: 0, encrypted: 0 },
      drill,
    })
  } finally {
    store.close()
  }
}

// The drill row and the column-check row beside it: the two are one reading, so a
// test that looked at only the first would miss the state word this card adds.
function drillRow(html: string): string {
  const match = /<div class="list-row"><div class="list-main"><strong>(?:Restore drill|恢复演练)<\/strong>[\s\S]*?<\/div><\/div>(?:\s*<div class="list-row"><div class="list-main"><strong>(?:Column check|列检查)<\/strong>[\s\S]*?<\/div><\/div>)?/.exec(html)
  assert.ok(match !== null, 'the admin page has no restore drill row')
  return match[0]
}

test('the admin row renders pass, skipped and fail as three different readings', () => {
  const base: RestoreDrillStatus = { at: '2026-11-20T10:00:00.000Z', ok: true, detail: 'RTO=0.100s RPO=0.002s', columnCheck: 'pass', columnErrors: [] }
  const passed = drillRow(renderAdmin('en', base))
  assert.match(passed, /column check: passed/)
  assert.match(passed, /· ok$|· ok ·/, `a proven drill reads as ok, got: ${passed}`)

  const skipped = drillRow(renderAdmin('en', { ...base, columnCheck: 'skipped' }))
  assert.match(skipped, /column check: not run \(no key given\)/)
  assert.doesNotMatch(skipped, /· ok(?: ·|$)/, `a skipped check must not read as a bare success, got: ${skipped}`)

  const failed = drillRow(renderAdmin('en', { ...base, columnCheck: 'fail', columnErrors: ['users.github_token_enc: Unsupported state or unable to authenticate data'] }))
  assert.match(failed, /column check: failed \(users\.github_token_enc/)
  assert.doesNotMatch(failed, /· ok(?: ·|$)/, `a failed check must not read as ok even when ok is true, got: ${failed}`)

  const notRecorded = drillRow(renderAdmin('en', { ...base, columnCheck: null }))
  assert.match(notRecorded, /column check: not recorded/)

  // A keyed run that died before the check has its own reading, and it is never
  // the "no key given" one: that is the sentence this state exists to stop.
  const notReached = drillRow(renderAdmin('en', { ...base, ok: false, columnCheck: 'not-reached', detail: 'cannot open restored copy' }))
  assert.match(notReached, /column check: not reached \(the run failed before it\)/)
  assert.doesNotMatch(notReached, /no key given/, `an operator who passed the flag must not be told they passed none, got: ${notReached}`)
  assert.doesNotMatch(notReached, /· ok(?: ·|$)/, `an unreached check must not read as a bare success, got: ${notReached}`)
  // Only `pass` earns an unqualified `ok`, even beside a contradictory record.
  const notReachedOk = drillRow(renderAdmin('en', { ...base, ok: true, columnCheck: 'not-reached' }))
  assert.match(notReachedOk, /failed \(column check not reached\)/)

  const zh = drillRow(renderAdmin('zh', { ...base, columnCheck: 'skipped' }))
  assert.match(zh, /列检查：未运行（未提供密钥）/)
  const zhNotReached = drillRow(renderAdmin('zh', { ...base, ok: false, columnCheck: 'not-reached' }))
  assert.match(zhNotReached, /列检查：未到达（本次运行在检查前失败）/)
  assert.doesNotMatch(zhNotReached, /未提供密钥/)
})

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const keyedFences = (text: string): string[] => [...text.matchAll(/```sh\n([\s\S]*?)```/g)]
  .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
  .filter((block) => block.includes('--secret-key-file'))

// #1192: the old guard asked only whether `rm -f <path>` appeared anywhere in the
// block, and a removal on the success path answered that. The block that leaves
// the key on disk when the drill refuses passed. This ratchet reads the two
// documented fences as text and accepts two shapes only: the removal sits in the
// `else` branch that stops the block, or a trap removes the file *and* the block
// propagates the subshell's status before it copies anything in. A subshell trap
// alone is rejected: its `exit 1` ends the subshell, so the parent would go on to
// copy an unverified database over the live one.
function keyCleanupProblem(block: string, path: string): string | null {
  const rm = new RegExp(`rm\\s+-f\\s+${escapeRegExp(path)}`)
  const failureBranches = [...block.matchAll(/\belse\b([\s\S]*?)\bfi\b/g)].map((match) => match[1] ?? '')
  if (failureBranches.some((branch) => rm.test(branch))) return null
  const trapRemoves = new RegExp(`trap\\s+['"][^'"]*rm\\s+-f\\s+${escapeRegExp(path)}['"]`).test(block)
  // A block that puts anything on the live instance after the drill must also stop
  // when the drill refuses; a block that only reports a drill result copies nothing.
  const rollsForward = /\bsudo cp\b|\bsystemctl start\b/.test(block)
  const propagates = /\$\?\s*-ne\s+0/.test(block)
  if (trapRemoves) {
    if (!rollsForward || propagates) return null
    return 'a trap inside a subshell removes the key, but the block never propagates the subshell status, so a refused drill would still copy the database'
  }
  if (!/\bexit\s+1\b/.test(block)) return 'the block neither removes the key on a refusal nor stops when the drill refuses'
  return 'the key is removed only outside the failure branch, so a refused drill leaves it on disk'
}

// The restore-for-real fence exactly as it stood before this fix (main
// `044c7515`, the same text as `#1187`'s tip `2d88f5a7`): the `rm` sits after
// `fi`, so `exit 1` leaves the key in `/var/tmp/fledge-restore`.
const REFUSAL_LEAK_BLOCK = `sudo systemctl stop fledge
sudo install -d -m 700 /var/tmp/fledge-restore
sudo sh -c 'umask 077; sed -n "s/^TOKEN_ENCRYPTION_KEY=//p" /etc/fledge/fledge.env > /var/tmp/fledge-restore/column.key'
if BACKUP_ENCRYPTION_KEY_FILE=/etc/fledge/backup.key npm run db:restore-drill -- --db "$DB_PATH" --backup-dir "$BACKUP_DIR" --work-dir /var/tmp/fledge-restore --secret-key-file /var/tmp/fledge-restore/column.key; then
  echo "restore-drill: OK"
else
  echo "drill failed; do not restore from this copy" >&2
  exit 1
fi
# the column key was only needed for the check above
sudo rm -f /var/tmp/fledge-restore/column.key
# a failed drill renames the copy to restored.db.failed, so only a fresh, verified
# restored.db can be copied in the next step
sudo rm -f "$DB_PATH-wal" "$DB_PATH-shm"
sudo cp /var/tmp/fledge-restore/restored.db "$DB_PATH"
sudo systemctl start fledge
curl -fsS http://127.0.0.1:8080/healthz`

test('every runbook block that hands the drill a column key removes it on the refusal path', () => {
  const keyed = keyedFences(readFileSync(deployDoc, 'utf8'))
  assert.equal(keyed.length, 2, `expected the drill and the restore-for-real blocks, found ${keyed.length}`)
  for (const block of keyed) {
    for (const match of block.matchAll(/--secret-key-file\s+([^\s`;]+)/g)) {
      const path = match[1]
      assert.ok(path !== undefined, 'the flag must name a path in the runbook')
      // The file holds the key the copy's credentials open with: a block that
      // writes it and leaves it behind when it refuses the copy is a key left on
      // disk, whatever the comment beside it says.
      const problem = keyCleanupProblem(block, path)
      assert.equal(problem, null, `the block that passes ${path} must remove it on every exit, got: ${problem}\n${block}`)
    }
  }
})

test('the key-cleanup ratchet rejects the refusal leak and a trap without status propagation', () => {
  const path = '/var/tmp/fledge-restore/column.key'
  assert.match(
    keyCleanupProblem(REFUSAL_LEAK_BLOCK, path) ?? '',
    /removed only outside the failure branch/,
    'the pinned block that leaked on a refusal must fail the ratchet',
  )
  const subshellTrap = [
    'sudo systemctl stop fledge',
    `( trap 'sudo rm -f ${path}' EXIT`,
    `  npm run db:restore-drill -- --db "$DB_PATH" --secret-key-file ${path} || exit 1 )`,
    'sudo cp /var/tmp/fledge-restore/restored.db "$DB_PATH"',
  ].join('\n')
  assert.match(
    keyCleanupProblem(subshellTrap, path) ?? '',
    /never propagates the subshell status/,
    'a trap inside a subshell must not pass unless the block stops on the subshell status',
  )
  const propagatedTrap = [
    'sudo systemctl stop fledge',
    `( trap 'sudo rm -f ${path}' EXIT`,
    `  npm run db:restore-drill -- --db "$DB_PATH" --secret-key-file ${path} )`,
    'if [ $? -ne 0 ]; then',
    '  echo "drill failed" >&2',
    '  exit 1',
    'fi',
    'sudo cp /var/tmp/fledge-restore/restored.db "$DB_PATH"',
  ].join('\n')
  assert.equal(keyCleanupProblem(propagatedTrap, path), null, 'a trap plus an explicit status stop is one of the two accepted shapes')
})

test('both documented restore invocations pass a column key', () => {
  const lines = readFileSync(deployDoc, 'utf8').split('\n')
  const covered = lines.filter((line) => line.includes('npm run db:restore-drill --'))
  // The predicate matches a command anywhere in the line, because the
  // restore-for-real line begins with an environment assignment.
  assert.equal(covered.length, 2, `expected exactly two documented invocations, found:\n${covered.join('\n')}`)
  for (const line of covered) assert.ok(line.includes('--secret-key-file'), `every documented invocation must pass --secret-key-file, got: ${line}`)
})

test('the drill reads no column key from its own environment and loads no env file', () => {
  const source = readFileSync(drillScript, 'utf8')
  assert.doesNotMatch(source, /TOKEN_ENCRYPTION/)
  assert.doesNotMatch(source, /dotenv/)
  assert.doesNotMatch(source, /['"]\.env['"]/)
})

test('the script-side decrypt and decryptSecret agree on every payload shape', async () => {
  const { decryptColumnPayload } = await payloadModule()
  const v1 = encryptSecret('plain-default', KEY_A)
  assert.equal(decryptColumnPayload(v1, { key: KEY_A, keyring: {} }), 'plain-default')
  assert.equal(decryptSecret(v1, KEY_A), 'plain-default')
  assert.throws(() => decryptColumnPayload(v1, { key: KEY_B, keyring: {} }))
  assert.throws(() => decryptSecret(v1, KEY_B))
  assert.throws(() => decryptColumnPayload(v1, { key: null, keyring: {} }), 'a v1 payload needs the default key')
  // Neither reader may return a partial value for a payload it cannot open.
  assert.throws(() => decryptColumnPayload(v1.slice(0, -4), { key: KEY_A, keyring: {} }))

  registerSecretKeyring({ k2: KEY_RING })
  const v2 = encryptSecret('plain-keyed', KEY_RING, 'k2')
  assert.equal(decryptColumnPayload(v2, { key: null, keyring: { k2: KEY_RING } }), 'plain-keyed')
  assert.equal(decryptSecret(v2, KEY_RING), 'plain-keyed')
  // A v2 payload is decided by the id it names, not by the default key beside
  // it: both readers ignore the second argument here and use the keyring.
  assert.equal(decryptSecret(v2, KEY_A), 'plain-keyed')
  assert.throws(() => decryptColumnPayload(v2, { key: KEY_RING, keyring: {} }), /unknown key id k2/)
  assert.throws(() => decryptColumnPayload('v3:whatever', { key: KEY_A, keyring: {} }), /Unsupported secret format/)
})

test('a keyring host passes with its keyring and fails naming the id when given only the default key', () => {
  const keyring = fixture({ key: KEY_RING, keyId: 'k2', keyFile: 'ring' })
  try {
    const passed = run(drillArgs(keyring, keyring.keyFile))
    assert.equal(passed.code, 0, passed.stderr)
    assert.equal(statusOf(keyring.statusFile).columnCheck, 'pass')
  } finally {
    rmSync(keyring.root, { recursive: true, force: true })
  }

  const narrow = fixture({ key: KEY_RING, keyId: 'k2', keyFile: 'single' })
  try {
    const result = run(drillArgs(narrow, narrow.keyFile))
    assert.notEqual(result.code, 0, 'a single-key reader must not pass a keyring copy')
    const errors = statusOf(narrow.statusFile).columnErrors ?? []
    assert.ok(errors.some((entry) => entry.includes('unknown key id k2')), `the reason must name the key id, got: ${JSON.stringify(errors)}`)
  } finally {
    rmSync(narrow.root, { recursive: true, force: true })
  }
})

test('the key file parser accepts one base64 key or a keyring and refuses a short key', async () => {
  const { readSecretKeyFile } = await payloadModule()
  const single = fixture({ key: KEY_A })
  try {
    const path = join(single.root, 'one.key')
    writeFileSync(path, `${KEY_A}\n`, { mode: 0o600 })
    assert.deepEqual(readSecretKeyFile(path), { key: KEY_A, keyring: {} })
    const ringPath = join(single.root, 'ring.json')
    writeFileSync(ringPath, `${JSON.stringify({ k2: KEY_RING })}\n`, { mode: 0o600 })
    assert.deepEqual(readSecretKeyFile(ringPath), { key: null, keyring: { k2: KEY_RING } })
    const short = join(single.root, 'short.key')
    writeFileSync(short, 'c2hvcnQ=\n', { mode: 0o600 })
    assert.throws(() => readSecretKeyFile(short), /32 bytes/)
  } finally {
    rmSync(single.root, { recursive: true, force: true })
  }
})
