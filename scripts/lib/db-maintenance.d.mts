// Types for `scripts/lib/db-maintenance.mjs`, so the TypeScript suite can drive
// the plan and the report shape without the CLI — the same pattern as
// `scripts/lib/retention.d.mts`.
export interface TableCount {
  name: string
  rows: number
}

export interface Counters {
  pageCount: number
  freelistCount: number
  stat1Rows: number
  tables: TableCount[]
}

export interface PlanStep {
  name: 'wal-checkpoint' | 'analyze' | 'vacuum'
  sql: string
  executes: boolean
}

export interface Plan {
  steps: PlanStep[]
}

export type RefusalCode = 'no-backup' | 'backup-too-old' | 'db-busy'

export interface Refusal {
  code: RefusalCode
  sentence: string
}

export interface BackupFacts {
  file: string
  ageHours: number | null
  manifest: string
  windowHours: number
}

export interface MaintenanceReport {
  at: string
  mode: 'dry-run' | 'real'
  db: string
  busyTimeoutMs: number
  before: Counters
  after: Counters | null
  plan: Plan
  backup: BackupFacts | null
  refusal: Refusal | null
  report: string
  exit: number
}

/** The slice of `node:sqlite`'s `DatabaseSync` these helpers use. */
export interface Queryable {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

export declare const BUSY_TIMEOUT_MS: number
export declare function readCounters(db: Queryable): Counters
export declare function planSteps(): Plan
export declare function refusalSentence(code: RefusalCode, detail?: Record<string, unknown>): string
export declare function buildReport(input: {
  at: string
  mode: 'dry-run' | 'real'
  dbPath: string
  before: Counters
  after?: Counters | null
  plan: Plan
  backup?: BackupFacts | null
  refusal?: Refusal | null
  reportPath: string
  exit: number
}): MaintenanceReport
