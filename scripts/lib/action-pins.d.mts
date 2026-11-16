// Types for the action-pin checker, so the TypeScript suite can call the real
// implementation and build its fixtures in a temporary directory instead of
// restating the rules.
export type ActionPinProblem = 'not-pinned' | 'missing-tag-comment' | 'not-allowed'

export interface ActionPinFinding {
  file: string
  line: number
  value: string
  problem: ActionPinProblem
}

export interface ActionPinReport {
  findings: ActionPinFinding[]
  checked: number
  files: string[]
}

// `allowlist` is the reviewed owner/repo list; omitting it skips the allowlist
// half of the gate, which the CLI never does.
export declare function checkWorkflow(text: string, file: string, allowlist?: string[]): ActionPinFinding[]

export declare function scanWorkflows(dir: string, allowlist?: string[]): ActionPinReport

/** Where the reviewed list lives, relative to the repository root. */
export declare const ALLOWLIST_FILE: string

/** Resolves the list next to this module, so a base-branch copy reads its own. */
export declare function defaultAllowlistPath(): string

/** Throws on a malformed file: an unreadable list must not allow everything. */
export declare function readAllowlist(path?: string): string[]

/** `github/codeql-action/init@sha` -> `github/codeql-action`. */
export declare function repositoryOf(value: string): string

// One per reason the gate refuses: an ungated privileged job, an event it cannot
// classify, a privileged job whose triggers it could not read, and every shape it
// will not guess at (an `on:` value, a `jobs:` block, a header or a permission).
export type ActorGateProblem =
  | 'missing-association-gate'
  | 'unknown-event'
  | 'no-readable-trigger'
  | 'missing-trigger-block'
  | 'unparsed-on-entries'
  | 'unparsed-event-header'
  | `unparsed-on "${string}"`
  | 'missing-jobs-block'
  | 'unparsed-jobs-block'
  | 'unparsed-jobs-value'
  | 'unparsed-job-header'
  | `unparsed permissions value "${string}"`

export interface ActorGateFinding {
  file: string
  line: number
  job: string
  event: string
  problem: ActorGateProblem
}

export interface ActorGateReport {
  findings: ActorGateFinding[]
  checked: number
  files: string[]
}

/** Maps a stranger-reachable event to where its `author_association` lives. */
export declare const STRANGER_EVENT_ASSOCIATION: Record<string, string>

export declare function checkActorGates(text: string, file: string): ActorGateFinding[]

export declare function scanActorGates(dir: string): ActorGateReport
