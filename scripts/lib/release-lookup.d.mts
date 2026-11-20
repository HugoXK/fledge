export type ReleaseLookupState = 'present' | 'absent' | 'unreadable'

export const RELEASE_LOOKUP_PRESENT: 'present'
export const RELEASE_LOOKUP_ABSENT: 'absent'
export const RELEASE_LOOKUP_UNREADABLE: 'unreadable'

export interface ReleaseLookupObservation {
  status?: number
  stdout?: string
  stderr?: string
}

export interface ReleaseLookupResult {
  state: ReleaseLookupState
  httpStatus: number | null
  reason: string
}

export function classifyReleaseLookup(observation?: ReleaseLookupObservation): ReleaseLookupResult

export function releaseLookupPath(repository: string, tag: string): string
