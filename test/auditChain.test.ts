import test from 'node:test'
import assert from 'node:assert/strict'
import { Store, type AuditRow } from '../src/db.js'
import { verifyAuditChain } from '../src/lib/auditChain.js'

function rowsOf(store: Store): AuditRow[] {
  return store.all<AuditRow>('SELECT * FROM audit_log ORDER BY id ASC')
}

test('audit rows link forward and verify from the chain start', () => {
  const store = new Store(':memory:')
  try {
    store.audit(null, 'one', 'first')
    store.audit(null, 'two', 'second')
    store.audit(null, 'three', null)
    const rows = rowsOf(store)
    assert.equal(rows.length, 3)
    assert.ok(rows[0]?.hash !== null)
    assert.equal(rows[0]?.prev_hash, null)
    assert.equal(rows[1]?.prev_hash, rows[0]?.hash)
    assert.equal(rows[2]?.prev_hash, rows[1]?.hash)
    assert.equal(store.getSetting('audit_chain_start_id'), String(rows[0]?.id))
    const result = verifyAuditChain(rows, Number(store.getSetting('audit_chain_start_id')))
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(result.checked, 3)
    assert.equal(result.unverifiedBeforeStart, 0)
    assert.equal(result.startId, rows[0]?.id)
  } finally {
    store.close()
  }
})

test('editing a stored field fails at that row', () => {
  const store = new Store(':memory:')
  try {
    store.audit(null, 'one', 'first')
    store.audit(null, 'two', 'second')
    store.audit(null, 'three', 'third')
    const rows = rowsOf(store)
    store.run('UPDATE audit_log SET detail = ? WHERE id = ?', 'tampered', rows[1]?.id)
    const result = verifyAuditChain(rowsOf(store), Number(store.getSetting('audit_chain_start_id')))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.id === rows[1]?.id && /hash/.test(error.reason)))
  } finally {
    store.close()
  }
})

test('deleting a row breaks the next link', () => {
  const store = new Store(':memory:')
  try {
    store.audit(null, 'one', 'first')
    store.audit(null, 'two', 'second')
    store.audit(null, 'three', 'third')
    const rows = rowsOf(store)
    store.run('DELETE FROM audit_log WHERE id = ?', rows[1]?.id)
    const result = verifyAuditChain(rowsOf(store), Number(store.getSetting('audit_chain_start_id')))
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => error.id === rows[2]?.id && /prev_hash/.test(error.reason)))
  } finally {
    store.close()
  }
})

test('rows written before the chain are unverified, and a null hash after the start fails', () => {
  const store = new Store(':memory:')
  try {
    store.run('INSERT INTO audit_log (at, user_id, action, detail) VALUES (?, ?, ?, ?)', '2026-01-01T00:00:00.000Z', null, 'legacy', 'before')
    store.audit(null, 'after', 'new')
    const rows = rowsOf(store)
    const start = Number(store.getSetting('audit_chain_start_id'))
    assert.equal(start, rows[1]?.id)
    const verified = verifyAuditChain(rows, start)
    assert.equal(verified.ok, true, JSON.stringify(verified.errors))
    assert.equal(verified.unverifiedBeforeStart, 1)

    store.run('INSERT INTO audit_log (at, user_id, action, detail) VALUES (?, ?, ?, ?)', '2026-01-01T00:00:01.000Z', null, 'manual', 'no hash')
    const broken = verifyAuditChain(rowsOf(store), start)
    assert.equal(broken.ok, false)
    assert.ok(broken.errors.some((error) => /unhashed row/.test(error.reason)))
  } finally {
    store.close()
  }
})
