import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The inventory is only worth having if it is complete enough to rotate from and
// cannot itself become the leak. These tests pin both: every secret the example
// configuration asks for has a row with all nine fields, and no row contains a
// value-shaped string.

const root = fileURLToPath(new URL('..', import.meta.url))
const inventory = readFileSync(`${root}docs/secrets.md`, 'utf8')
const envExample = readFileSync(`${root}.env.example`, 'utf8')
const packageJson = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  scripts?: Record<string, string>
}

const FIELDS = [
  'Secret',
  'Purpose',
  'Storage',
  'Minimum scope',
  'Owner',
  'Last rotated',
  'Rotation command',
  'Verification command',
  'Fingerprint',
]

function tableRows(): string[][] {
  return inventory
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim()),
    )
}

const rows = tableRows()
const header = rows[0] ?? []
const body = rows.slice(1)

test('the inventory has the nine fields the runbook needs', () => {
  assert.deepEqual(header, FIELDS)
})

test('every row fills every field, and the fingerprint is not a value', () => {
  assert.ok(body.length > 0, 'the inventory must list at least one secret')
  for (const row of body) {
    assert.equal(row.length, FIELDS.length, `row has ${String(row.length)} cells: ${row.join(' | ')}`)
    for (const [index, cell] of row.entries()) {
      assert.ok((cell ?? '') !== '', `${row[0] ?? 'a row'} leaves "${FIELDS[index] ?? String(index)}" empty`)
    }
    const fingerprint = row[8] ?? ''
    assert.match(fingerprint, /^([0-9a-f]{12}|unknown)$/, `${row[0] ?? 'a row'} has a fingerprint that is neither 12 hex nor "unknown"`)
  }
})

test('the inventory itself carries no value-shaped string', () => {
  const shapes = [
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /flg_[A-Za-z0-9_-]{8,}/,
    /sk-[A-Za-z0-9_-]{16,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ]
  for (const shape of shapes) assert.doesNotMatch(inventory, shape)
})

// Booleans whose name happens to contain TOKEN; they are switches, not values.
const NOT_SECRETS = new Set(['ALLOW_TOKEN_LOGIN_ONLY', 'GITHUB_APP_USER_TOKEN', 'PLATFORM_LLM_PRICE_PER_TOKEN'])

test('every secret the example configuration asks for has a row', () => {
  const names = envExample
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
    .filter((name) => /(SECRET|KEY|TOKEN|PASS)/.test(name))
    .filter((name) => !NOT_SECRETS.has(name))
  assert.ok(names.length >= 10, `expected the example to ask for the known secrets, found ${String(names.length)}`)
  for (const name of names) {
    assert.ok(inventory.includes(name), `${name} is requested by .env.example but missing from docs/secrets.md`)
  }
})

test('.env.example keeps no GitHub token placeholder', () => {
  // A GITHUB_TOKEN entry in the example invites a real one into a .env that is
  // then copied around; the platform never needs one.
  assert.doesNotMatch(envExample, /^GITHUB_TOKEN=/m)
  assert.doesNotMatch(envExample, /^GH_TOKEN=/m)
})

test('the inventory is reachable from a command, not only from prose', () => {
  assert.equal(packageJson.scripts?.['secret:scan'], 'node scripts/secret-scan.mjs')
})
