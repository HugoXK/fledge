// Types for the CodeQL alert reader, so the TypeScript suite can feed it SARIF
// fixtures written into a temporary directory.
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low'

export interface CodeqlAlert {
  ruleId: string
  path: string
  line: number
  severity: AlertSeverity
}

export declare const HIGH_THRESHOLD: number

export declare const CRITICAL_THRESHOLD: number

export declare function severityOf(result: unknown, rule: unknown): AlertSeverity

export declare function parseSarif(document: unknown): CodeqlAlert[]

export declare function highAlerts(alerts: CodeqlAlert[]): CodeqlAlert[]

export declare function alertKey(alert: CodeqlAlert): string

export declare function addedAlerts(baselineKeys: string[], alerts: CodeqlAlert[]): CodeqlAlert[]

export interface ReviewThread {
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  originalLine: number | null
}

// #307: the accepted-severity results, and the thread that keeps the merge open.
export declare function acceptedAlerts(alerts: CodeqlAlert[]): CodeqlAlert[]

export declare function threadAt(alert: CodeqlAlert, threads: ReviewThread[]): ReviewThread | null
