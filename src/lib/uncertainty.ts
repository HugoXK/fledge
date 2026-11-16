// #381 slice 1: a job that cannot decide may stop and ask instead of turning the
// uncertainty into a confident guess. The callback carries at most one decision,
// bounded so the inbox card stays readable and the reason cannot become a second
// summary; the answer is stored on the same job row and the retry carries it.
//
// This module is pure: the service owns the state transitions, the store owns the
// row, and the view owns the card. Keeping the bounds here means the callback and
// the answer route cannot disagree about what a decision is.

export const DECISION_LIMITS = {
  question: 300,
  why: 500,
  options: 4,
  option: 80,
} as const

/** The question a paused job is waiting on. */
export interface JobDecision {
  question: string
  why: string
  options: string[]
}

/** The first answer, written once; a second POST replays it and enqueues nothing. */
export interface JobDecisionAnswer {
  text: string
  by: string
  at: string
}

/** The row's `decision_json`: the question plus the answer once one exists. */
export interface StoredDecision extends JobDecision {
  answer: JobDecisionAnswer | null
}

export type DecisionParse =
  | { ok: true; decision: JobDecision }
  | { ok: false; code: 'decision_invalid' | 'one_decision_per_job'; message: string }

// One trimmed, bounded string or null. A caller that sends a number, an empty
// string or an oversized question is refused rather than coerced: the card is a
// question a person reads, and half of one is worse than none.
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) return null
  return trimmed
}

// `value` is the callback's `decision` field, already known to be present. An
// array is the "two decisions" shape the contract refuses; anything else that is
// not an object, or that names no question or no reason, is malformed.
export function parseJobDecision(value: unknown): DecisionParse {
  if (Array.isArray(value)) return { ok: false, code: 'one_decision_per_job', message: 'one decision per job' }
  if (value === null || typeof value !== 'object') {
    return { ok: false, code: 'decision_invalid', message: 'a decision must be an object' }
  }
  const body = value as Record<string, unknown>
  const question = boundedText(body.question, DECISION_LIMITS.question)
  if (question === null) {
    return { ok: false, code: 'decision_invalid', message: `the question must be 1-${DECISION_LIMITS.question} characters` }
  }
  const why = boundedText(body.why, DECISION_LIMITS.why)
  if (why === null) {
    return { ok: false, code: 'decision_invalid', message: `why must be 1-${DECISION_LIMITS.why} characters` }
  }
  const options: string[] = []
  const rawOptions = body.options
  if (rawOptions !== undefined && rawOptions !== null) {
    if (!Array.isArray(rawOptions)) return { ok: false, code: 'decision_invalid', message: 'options must be an array' }
    if (rawOptions.length > DECISION_LIMITS.options) {
      return { ok: false, code: 'decision_invalid', message: `at most ${DECISION_LIMITS.options} options` }
    }
    for (const entry of rawOptions) {
      const option = boundedText(entry, DECISION_LIMITS.option)
      if (option === null) {
        return { ok: false, code: 'decision_invalid', message: `each option must be 1-${DECISION_LIMITS.option} characters` }
      }
      options.push(option)
    }
  }
  return { ok: true, decision: { question, why, options } }
}

// A stored decision is read back by the inbox and the answer route. A row that
// cannot be parsed is treated as no decision: the job stays paused and the card
// is not invented from a malformed string.
export function storedDecision(json: string | null): StoredDecision | null {
  if (json === null || json === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const question = typeof record.question === 'string' ? record.question : null
  const why = typeof record.why === 'string' ? record.why : null
  if (question === null || why === null) return null
  const options = Array.isArray(record.options) ? record.options.filter((entry): entry is string => typeof entry === 'string') : []
  let answer: JobDecisionAnswer | null = null
  const rawAnswer = record.answer
  if (rawAnswer !== null && typeof rawAnswer === 'object' && !Array.isArray(rawAnswer)) {
    const entry = rawAnswer as Record<string, unknown>
    if (typeof entry.text === 'string' && typeof entry.by === 'string' && typeof entry.at === 'string') {
      answer = { text: entry.text, by: entry.by, at: entry.at }
    }
  }
  return { question, why, options, answer }
}

export function decisionWithAnswer(decision: JobDecision, answer: JobDecisionAnswer): string {
  return JSON.stringify({ ...decision, answer })
}

// The retry starts from the paused job's goal and carries the question and the
// answer, so the resumed run knows what was asked and what a person decided.
export function decisionAnswerGoal(base: string, question: string, answer: string): string {
  return `${base}\n\n## Decision from the repository owner\nQuestion: ${question}\nAnswer: ${answer}`
}

// The inbox card is addressed by the job, not by a live session: the answer route
// branches on this prefix and never reaches the bridge's answerQuestion.
export const JOB_QUESTION_PREFIX = 'job:'

export function jobQuestionId(jobId: string): string {
  return `${JOB_QUESTION_PREFIX}${jobId}`
}

export function jobIdFromQuestionId(questionId: string): string | null {
  if (!questionId.startsWith(JOB_QUESTION_PREFIX)) return null
  const jobId = questionId.slice(JOB_QUESTION_PREFIX.length)
  return jobId === '' ? null : jobId
}
