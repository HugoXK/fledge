// #1229: the seam a second SQLite backend can be proven against. `Store` talks
// only to this port; `src/db/sqlite.ts` is the one production adapter over the
// SQLite driver. The contract suite (test/dbContract.test.ts) runs one set of
// CRUD/transaction/constraint/migration cases through `Store` and through the
// port, so a later backend is held to the same cases and not to a promise.
export interface SqlRunResult {
  changes: number
  lastInsertRowid: number
}

export interface SqlStatement {
  run(...params: unknown[]): SqlRunResult
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

export interface SqlDialect {
  run(sql: string, ...params: unknown[]): SqlRunResult
  get<T = unknown>(sql: string, ...params: unknown[]): T | undefined
  all<T = unknown>(sql: string, ...params: unknown[]): T[]
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  transaction<T>(fn: () => T): T
  ping(): void
  close(): void
}
