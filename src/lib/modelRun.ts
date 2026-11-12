// The model a job actually ran, and the models it fell through to get there.
//
// The gateway writes this JSON on the job when it answers a chat call, because
// that is the only place that knows which provider model replied: a repository's
// primary can be rate-limited and the job still finishes on its second model, and
// the console and the pull-request comment must say so instead of naming the
// primary the instance was configured with. Nothing here throws: a job row from
// an older release carries no value, and a malformed one must not break a page.

export interface ModelAttempt {
  modelId: string
  label: string
  status: number
  retryable: boolean
}

export interface ModelRun {
  model: { id: string; label: string } | null
  attempts: ModelAttempt[]
}

function attempt(value: unknown): ModelAttempt | null {
  if (value === null || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const modelId = typeof row.modelId === 'string' ? row.modelId : ''
  if (modelId === '') return null
  const status = typeof row.status === 'number' && Number.isFinite(row.status) ? row.status : 0
  return {
    modelId,
    label: typeof row.label === 'string' && row.label !== '' ? row.label : modelId,
    status,
    retryable: row.retryable === true,
  }
}

export function parseModelRun(value: string | null): ModelRun | null {
  if (value === null || value === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const row = parsed as Record<string, unknown>
  const modelRow = row.model === null || typeof row.model !== 'object' ? null : (row.model as Record<string, unknown>)
  const id = typeof modelRow?.id === 'string' ? modelRow.id : ''
  const model = id === '' ? null : { id, label: typeof modelRow?.label === 'string' && modelRow.label !== '' ? modelRow.label : id }
  const attempts = Array.isArray(row.attempts) ? row.attempts.map(attempt).filter((entry): entry is ModelAttempt => entry !== null) : []
  if (model === null && attempts.length === 0) return null
  return { model, attempts }
}
