import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { SCHEMA_VERSION, Store } from '../src/db.js'
import { SqliteDialect } from '../src/db/sqlite.js'

// #1229: one set of cases for the dialect seam. The port case runs against the
// SQLite adapter directly; the Store case runs through the public Store methods,
// which must delegate to the same port rather than keep a raw handle.

interface CrudSurface {
  exec(sql: string): void
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } | void
  get<T = unknown>(sql: string, ...params: unknown[]): T | undefined
  all<T = unknown>(sql: string, ...params: unknown[]): T[]
}

function crudCase(db: CrudSurface): void {
  db.exec('CREATE TABLE contract (id TEXT PRIMARY KEY, n INTEGER NOT NULL UNIQUE)')
  db.run('INSERT INTO contract (id, n) VALUES (?, ?)', 'a', 1)
  assert.equal(db.get<{ n: number }>('SELECT n FROM contract WHERE id = ?', 'a')?.n, 1)
  assert.equal(db.all('SELECT id FROM contract').length, 1)
  db.run('UPDATE contract SET n = ? WHERE id = ?', 2, 'a')
  assert.equal(db.get<{ n: number }>('SELECT n FROM contract WHERE id = ?', 'a')?.n, 2)
  db.run('DELETE FROM contract WHERE id = ?', 'a')
  assert.equal(db.all('SELECT id FROM contract').length, 0)
}

function storeSurface(store: Store): CrudSurface {
  return {
    exec: (sql) => {
      store.run(sql)
    },
    run: (sql, ...params) => {
      store.run(sql, ...params)
    },
    get: (sql, ...params) => store.get(sql, ...params),
    all: (sql, ...params) => store.all(sql, ...params),
  }
}

test('the CRUD contract case passes through the port and through Store', () => {
  const dialect = new SqliteDialect(':memory:')
  try {
    crudCase(dialect)
  } finally {
    dialect.close()
  }
  const store = new Store(':memory:')
  try {
    crudCase(storeSurface(store))
  } finally {
    store.close()
  }
})

test('the prepared statement result contract is {changes, lastInsertRowid} through the port', () => {
  const dialect = new SqliteDialect(':memory:')
  try {
    dialect.exec('CREATE TABLE r (id INTEGER PRIMARY KEY, v TEXT)')
    const first = dialect.run('INSERT INTO r (v) VALUES (?)', 'one')
    assert.equal(first.changes, 1)
    assert.equal(first.lastInsertRowid, 1)
    const same = dialect.prepare('UPDATE r SET v = ? WHERE id = ?').run('two', 1)
    assert.equal(same.changes, 1)
    assert.equal(typeof same.lastInsertRowid, 'number', 'the result keeps the second contract field')
    const inserted = dialect.prepare('INSERT INTO r (v) VALUES (?)').run('three')
    assert.equal(inserted.changes, 1)
    assert.equal(typeof inserted.lastInsertRowid, 'number', 'prepare().run() normalizes the driver bigint too')
    assert.equal(dialect.get<{ v: string }>('SELECT v FROM r WHERE id = 1')?.v, 'two')
  } finally {
    dialect.close()
  }
})

test('a constraint violation is refused through the port and through Store', () => {
  const dialect = new SqliteDialect(':memory:')
  try {
    dialect.exec('CREATE TABLE uniq (id INTEGER PRIMARY KEY, v TEXT UNIQUE)')
    dialect.run('INSERT INTO uniq (v) VALUES (?)', 'x')
    assert.throws(() => dialect.run('INSERT INTO uniq (v) VALUES (?)', 'x'), /UNIQUE|constraint/i)
  } finally {
    dialect.close()
  }
  const store = new Store(':memory:')
  try {
    store.run('CREATE TABLE uniq (id INTEGER PRIMARY KEY, v TEXT UNIQUE)')
    store.run('INSERT INTO uniq (v) VALUES (?)', 'x')
    assert.throws(() => store.run('INSERT INTO uniq (v) VALUES (?)', 'x'), /UNIQUE|constraint/i)
  } finally {
    store.close()
  }
})

test('a foreign-key violation is refused through the port and through Store', () => {
  // PRAGMA foreign_keys defaults to OFF in SQLite, so this is the one dialect
  // setting a second backend can silently differ on; the port case turns it on
  // and proves the refusal, and Store turns it on in its constructor.
  const dialect = new SqliteDialect(':memory:')
  try {
    dialect.exec('PRAGMA foreign_keys = ON')
    assert.equal(dialect.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys, 1)
    dialect.exec('CREATE TABLE fk_parent (id TEXT PRIMARY KEY)')
    dialect.exec('CREATE TABLE fk_child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES fk_parent(id))')
    assert.throws(() => dialect.run('INSERT INTO fk_child (id, parent_id) VALUES (?, ?)', 'c1', 'missing'), /FOREIGN KEY|constraint/i)
    dialect.run('INSERT INTO fk_parent (id) VALUES (?)', 'p1')
    dialect.run('INSERT INTO fk_child (id, parent_id) VALUES (?, ?)', 'c1', 'p1')
    assert.equal(dialect.all('SELECT id FROM fk_child').length, 1)
  } finally {
    dialect.close()
  }
  const store = new Store(':memory:')
  try {
    store.exec('CREATE TABLE fk_parent (id TEXT PRIMARY KEY)')
    store.exec('CREATE TABLE fk_child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES fk_parent(id))')
    assert.throws(() => store.run('INSERT INTO fk_child (id, parent_id) VALUES (?, ?)', 'c1', 'missing'), /FOREIGN KEY|constraint/i)
    store.run('INSERT INTO fk_parent (id) VALUES (?)', 'p1')
    store.run('INSERT INTO fk_child (id, parent_id) VALUES (?, ?)', 'c1', 'p1')
    assert.equal(store.all('SELECT id FROM fk_child').length, 1)
  } finally {
    store.close()
  }
})

test('a transaction commits and a throw rolls back through the port and through Store', () => {
  const dialect = new SqliteDialect(':memory:')
  try {
    dialect.exec('CREATE TABLE tx (id INTEGER PRIMARY KEY, v TEXT)')
    dialect.transaction(() => {
      dialect.run('INSERT INTO tx (v) VALUES (?)', 'kept')
    })
    assert.equal(dialect.all('SELECT id FROM tx').length, 1)
    assert.throws(() =>
      dialect.transaction(() => {
        dialect.run('INSERT INTO tx (v) VALUES (?)', 'rolled back')
        throw new Error('rollback')
      }),
    )
    assert.equal(dialect.all('SELECT id FROM tx').length, 1)
  } finally {
    dialect.close()
  }
  const store = new Store(':memory:')
  try {
    store.run('CREATE TABLE tx (id INTEGER PRIMARY KEY, v TEXT)')
    store.transaction(() => {
      store.run('INSERT INTO tx (v) VALUES (?)', 'kept')
    })
    assert.equal(store.all('SELECT id FROM tx').length, 1)
    assert.throws(() =>
      store.transaction(() => {
        store.run('INSERT INTO tx (v) VALUES (?)', 'rolled back')
        throw new Error('rollback')
      }),
    )
    assert.equal(store.all('SELECT id FROM tx').length, 1)
  } finally {
    store.close()
  }
})

test('transaction() opens with BEGIN IMMEDIATE, so a second writer is refused at once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-contract-'))
  const first = new SqliteDialect(join(dir, 'locks.db'))
  const second = new SqliteDialect(join(dir, 'locks.db'))
  try {
    first.exec('CREATE TABLE lockcase (id INTEGER PRIMARY KEY)')
    first.transaction(() => {
      // BEGIN IMMEDIATE takes the write lock; a deferred BEGIN would not.
      assert.throws(() => {
        second.exec('BEGIN IMMEDIATE')
      }, /busy|locked/i)
    })
  } finally {
    try {
      second.exec('ROLLBACK')
    } catch {
      // The second writer never opened a transaction; nothing to roll back.
    }
    second.close()
    first.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the Store constructor runs the journal_mode, user_version and ALTER TABLE migration steps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-migrate-'))
  const store = new Store(join(dir, 'migrate.db'))
  try {
    assert.equal(store.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'wal')
    assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, SCHEMA_VERSION)
    const scheduleColumns = store.all<{ name: string }>('PRAGMA table_info(schedules)').map((column) => column.name)
    assert.ok(scheduleColumns.includes('grace_ms'), 'migrateScheduleMisfireColumns added grace_ms')
    assert.ok(scheduleColumns.includes('daily_runs'), 'migrateScheduleBudgetColumns added daily_runs')
    const testRunColumns = store.all<{ name: string }>('PRAGMA table_info(test_runs)').map((column) => column.name)
    assert.ok(testRunColumns.includes('head_sha'), 'migrateTestRunsShape replaced the old key with head_sha')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('only the SQLite adapter imports node:sqlite under src/', () => {
  const root = process.cwd()
  // The two exceptions are named here on purpose: adding a third means editing
  // this set and the architecture paragraph together, so the surface cannot
  // drift one file at a time.
  const allowed = new Set(['src/db/sqlite.ts', 'src/lib/prevRelease.ts', 'src/lib/evolution/export.ts'])
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile() && entry.name.endsWith('.ts') && readFileSync(absolute, 'utf8').split('\n').some((line) => line.includes("node:sqlite") && /import|require|createRequire/.test(line))) {
        found.push(relative(root, absolute).replaceAll('\\', '/'))
      }
    }
  }
  walk(join(root, 'src'))
  assert.deepEqual(found.sort(), [...allowed].sort(), 'only the adapter and the two named exceptions touch node:sqlite')
})
