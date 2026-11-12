// #251: a `changes_requested` review carries the maintainer's words in
// `review.body`. The follow-up job has no column for them, so they live in the
// goal the agent is given, and the console reads that same line back. This
// module owns the line's shape in both directions, so the writer and the reader
// cannot drift into "the instruction is stored but never shown".
const MARKER = 'Reviewer asked: '

/**
 * The instruction's own bound, deliberately smaller than the goal's. `enqueue`
 * caps a goal at 4000 characters and appends the carry-over block (up to 3200)
 * after it, so a review body allowed the goal's own bound would push the
 * follow-up's directives — "do not open a second PR" and the closing line — off
 * the end of it. This leaves room for both.
 */
export const REVIEW_INSTRUCTION_MAX = 1000

/**
 * Trim, collapse to one line and bound. `review.body` is Markdown with newlines
 * and is written by whoever reviews the PR; a single line keeps the goal a
 * fixed number of lines and keeps the marker unambiguous to read back. A clipped
 * body ends in an ellipsis so the agent and the console both see the cut.
 */
export function normalizeReviewInstruction(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= REVIEW_INSTRUCTION_MAX ? normalized : `${normalized.slice(0, REVIEW_INSTRUCTION_MAX - 1)}…`
}

/** The goal line a follow-up stores, or '' when there is nothing to carry. */
export function reviewInstructionLine(instruction: string | undefined): string {
  const normalized = normalizeReviewInstruction(instruction ?? '')
  return normalized === '' ? '' : `${MARKER}${normalized}`
}

/** The instruction a stored goal carries, or '' when it carries none. */
export function reviewInstructionFromGoal(goal: string | null | undefined): string {
  for (const line of String(goal ?? '').split('\n')) {
    if (line.startsWith(MARKER)) return line.slice(MARKER.length).trim()
  }
  return ''
}

/** The label both the goal block and the job page use. */
export const REVIEW_INSTRUCTION_LABEL = 'Reviewer asked'
