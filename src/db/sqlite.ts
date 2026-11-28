import { DatabaseSync } from 'node:sqlite'
import type { SqlDialect, SqlRunResult, SqlStatement } from './dialect.js'

type SqlValue = string | number | bigint | null | Uint8Array

// #1229: the only production file that imports `node:sqlite`. Everything that
// tells SQLite its dialect (`PRAGMA`, `user_version`, `ALTER TABLE`, `BEGIN
// IMMEDIATE`) arrives through this adapter, so a second backend is a sibling
// class, not a rewrite of `src/db.ts`.
export class SqliteDialect implements SqlDialect {
  private readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
  }

  run(sql: string, ...params: unknown[]): SqlRunResult {
    const result = this.db.prepare(sql).run(...(params as SqlValue[]))
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
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
    return this.db.prepare(sql) as unknown as SqlStatement
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
