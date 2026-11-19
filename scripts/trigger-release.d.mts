export interface DispatchReleaseInput {
  repo: string
  token: string
  ref?: string
  workflow?: string
  /** Injected for a deterministic proof in tests; defaults to the wall clock. */
  clock?: () => string
  fetchImpl?: (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
}

export interface DispatchReleaseResult {
  ok: true
  at: string
  repo: string
  workflow: string
  ref: string
}

/** One run as the check reads it: the event is what tells the slot from the
 * scheduled fallback. */
export interface ReleaseRun {
  id: number
  event: string
  createdAt: string
  conclusion: string | null
}

export interface DispatchRunProof extends ReleaseRun {}

export interface DispatchWithProofResult extends DispatchReleaseResult {
  run: DispatchRunProof | null
}

export interface ReleaseSlotVerdict {
  state: 'slot-dispatched' | 'slot-pending' | 'slot-late' | 'slot-missed'
  event: string | null
  boundary: string
  deadline: string
  run: ReleaseRun | null
}

export function dispatchRelease(input: DispatchReleaseInput): Promise<DispatchReleaseResult>
export function readReleaseRuns(input: DispatchReleaseInput & { sinceIso?: string }): Promise<ReleaseRun[]>
export function dispatchWithProof(input: DispatchReleaseInput): Promise<DispatchWithProofResult>
export function slotWindow(now: string): { boundary: string; deadline: string }
export function releaseSlotVerdict(input: { runs: ReleaseRun[]; now: string; deadlineMinutes?: number }): ReleaseSlotVerdict
