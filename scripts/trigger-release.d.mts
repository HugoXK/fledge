export interface DispatchReleaseInput {
  repo: string
  token: string
  ref?: string
  workflow?: string
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

export function dispatchRelease(input: DispatchReleaseInput): Promise<DispatchReleaseResult>
