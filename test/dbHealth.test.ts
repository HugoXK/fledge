import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'
import { queryHealthSummary, readDatabaseHealth, recordQuery, resetQueryHealth, statementName } from '../src/lib/dbHealth.js'
import { resetMetrics } from '../src/lib/metrics.js'

test('statementName keeps the verb and table, never the SQL or its parameters', () => {
  assert.equal(statementName('SELECT * FROM jobs WHERE id = ?'), 'select:jobs')
  assert.equal(statementName('INSERT INTO "quota_ledger" (x) VALUES (?)'), 'insert:quota_ledger')
  assert.equal(statementName('UPDATE jobs SET status = ? WHERE id = ?'), 'update:jobs')
  assert.equal(statementName('PRAGMA user_version'), 'pragma:user_version')
  assert.equal(statementName('BEGIN IMMEDIATE'), 'transaction:begin')
  assert.equal(statementName('CREATE TABLE IF NOT EXISTS "jobs" (id TEXT)'), 'create:jobs')
  assert.equal(statementName('SELECT 1 AS n'), 'select:unknown')
  assert.doesNotMatch(statementName("SELECT * FROM jobs WHERE goal = 'SECRET'"), /SECRET/)
})

test('the histogram records every query and the ring records only slow ones', () => {
  resetMetrics()
  resetQueryHealth()
  recordQuery('select:jobs', 5, 1, 200)
  recordQuery('select:jobs', 250, 1, 200)

  const summary = queryHealthSummary()
  assert.equal(summary.totalQueries, 2)
  assert.deepEqual(summary.slow.map((row) => row.statement), ['select:jobs'])
  assert.equal(summary.slow[0]?.ms, 250)
  assert.equal(summary.slowest[0]?.statement, 'select:jobs')
  assert.equal(summary.slowest[0]?.count, 2)
  assert.equal(summary.slowest[0]?.maxMs, 250)

  const text = JSON.stringify(summary)
  assert.doesNotMatch(text, /SECRET|SELECT \*/)
})

test('the slow ring is bounded to 20 entries', () => {
  resetQueryHealth()
  for (let index = 0; index < 25; index += 1) recordQuery('select:jobs', 300, 1, 200)
  assert.equal(queryHealthSummary().slow.length, 20)
})

test('a threshold of zero records every statement; a high threshold records none', () => {
  resetMetrics()
  resetQueryHealth()
  const quick = new Store(':memory:', { slowQueryMs: 0 })
  try {
    quick.get('SELECT 1 AS n')
    assert.equal(queryHealthSummary().slow.length >= 1, true)
    assert.match(queryHealthSummary().slow[0]?.statement ?? '', /^select:/)
  } finally {
    quick.close()
  }

  resetMetrics()
  resetQueryHealth()
  const patient = new Store(':memory:', { slowQueryMs: 10_000 })
  try {
    patient.get('SELECT 1 AS n')
    assert.equal(queryHealthSummary().slow.length, 0)
  } finally {
    patient.close()
  }
})

test('databaseHealth reports the file and the table counts', () => {
  const store = new Store(':memory:')
  try {
    const before = readDatabaseHealth(store.db)
    assert.ok(before.pageSize > 0)
    assert.ok(before.pageCount > 0)
    assert.equal(before.bytes, before.pageSize * before.pageCount)
    assert.ok(before.tables.some((table) => table.name === 'users'))
    assert.ok(before.tables.every((table) => !table.name.startsWith('sqlite_')))

    makeUser(store, { login: 'db-health', status: 'approved' })
    const after = readDatabaseHealth(store.db)
    const users = after.tables.find((table) => table.name === 'users')
    assert.ok(users !== undefined && users.rows >= 1)
  } finally {
    store.close()
  }
})
