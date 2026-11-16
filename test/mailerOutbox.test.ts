import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ConsoleMailer } from '../src/email/mailer.js'

// #694: an outbox file used to be named `<stamp>-<address>.eml`, so "keep the
// newest file" kept one identifier alive forever and no retention window could
// delete everything. The name is opaque now, which is what makes a window safe.
// The address still lives inside the file (that is what a dev reads); only the
// name and the sink are clean.
const DAY_MS = 86_400_000

function outboxDir(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'fledge-outbox-'))
  return { root, dir: join(root, 'mail-outbox') }
}

function names(dir: string): string[] {
  return readdirSync(dir).sort()
}

test('the console mailer names the file without the recipient and keeps the address in the body', async () => {
  const { root, dir } = outboxDir()
  try {
    await new ConsoleMailer(dir).send({
      to: 'alice@example.com',
      subject: 'Approve repo',
      text: 'Open https://fledge.test/approve/tok_ABC123 to approve.',
    })
    const written = names(dir)
    assert.equal(written.length, 1)
    const [name] = written
    assert.ok(name !== undefined)
    assert.match(name, /^\d{4}-.*\.eml$/)
    assert.ok(!name.includes('@'), `name carries the address: ${name}`)
    const body = readFileSync(join(dir, name), 'utf8')
    assert.match(body, /^To: alice@example\.com$/m)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('mail:outbox removes an .eml past the window, keeps a recent one and prints the newest', () => {
  const { root, dir } = outboxDir()
  mkdirSync(dir, { recursive: true })
  try {
    const old = join(dir, '2026-01-01T00-00-00-000Z-aaaaaa.eml')
    const recent = join(dir, '2026-11-16T00-00-00-000Z-bbbbbb.eml')
    writeFileSync(old, 'Subject: Old\r\n\r\nold\r\n')
    writeFileSync(recent, 'Subject: New\r\n\r\nhttps://fledge.test/approve/tok_ABC123\r\n')
    const past = new Date(Date.now() - 30 * DAY_MS)
    utimesSync(old, past, past)

    const run = spawnSync(process.execPath, ['scripts/outbox.mjs'], {
      env: { ...process.env, DATA_DIR: root, MAIL_OUTBOX_RETENTION_DAYS: '7' },
      encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    const remaining = names(dir)
    assert.deepEqual(remaining, ['2026-11-16T00-00-00-000Z-bbbbbb.eml'])
    assert.ok(!remaining.some((name) => name.includes('@')), remaining.join(','))
    assert.match(run.stdout, /2026-11-16T00-00-00-000Z-bbbbbb\.eml/)
    assert.match(run.stdout, /https:\/\/fledge\.test\/approve\/tok_ABC123/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
