// The reviewer's verdict has to reach the merge path, not only the work-item
// board. A low score and a `changes_requested` item are the two signals the
// product reviewer already writes; auto-merge uses them as a final gate.
//
// A manual maintainer merge is allowed to override this gate; the service
// records that override in the audit log. This helper is pure so the boundary
// can be tested without GitHub.

export type ReviewMergeBlock =
  | { kind: 'changes_requested' }
  | { kind: 'score'; score: number; minScore: number }

export interface ReviewMergeInput {
  state: string | null | undefined
  score: number | null | undefined
  minScore: number
}

export function reviewMergeBlock(input: ReviewMergeInput): ReviewMergeBlock | null {
  if (input.state === 'changes_requested') return { kind: 'changes_requested' }
  if (typeof input.score === 'number' && Number.isFinite(input.score) && input.score < input.minScore) {
    return { kind: 'score', score: input.score, minScore: input.minScore }
  }
  return null
}
