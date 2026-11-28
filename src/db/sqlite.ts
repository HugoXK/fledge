import { DatabaseSync } from 'node:sqlite'
import type { SqlDialect, SqlRunResult, SqlStatement } from './dialect.js'

type SqlValue = string | number | bigint | null | Uint8Array

function resultOf(value: { changes: number | bigint; lastInsertRowid: number | bigint }): SqlRunResult {
  return { changes: Number(value.changes), lastInsertRowid: Number(value.lastInsertRowid) }
}

// #1229: the only production file that imports the SQLite driver. It owns the
// transaction statements (`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`) and normalizes
// the driver's `number | bigint` result fields; the `PRAGMA`/`ALTER TABLE`/
// `user_version` text still lives in `src/db.ts`, because this slice removes the
// direct driver dependency (scope (a) in the card) and does not yet move the
// dialect SQL.
export class SqliteDialect implements SqlDialect {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
  }

  run(sql: string, ...params: unknown[]): SqlRunResult {
    return resultOf(this.db.prepare(sql).run(...(params as SqlValue[])))
  }

  get<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...(params as SqlValue[])) as T | undefined
  }

  all<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as SqlValue[])) as T[]
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare(sql: string): SqlStatement {
    const statement = this.db.prepare(sql)
    return {
      run: (...params: unknown[]) => resultOf(statement.run(...(params as SqlValue[]))),
      get: <T = unknown>(...params: unknown[]) => statement.get(...(params as SqlValue[])) as T | undefined,
      all: <T = unknown>(...params: unknown[]) => statement.all(...(params as SqlValue[])) as T[],
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  ping(): void {
    this.db.prepare('SELECT 1').get()
  }

  close(): void {
    this.db.close()
  }
}
