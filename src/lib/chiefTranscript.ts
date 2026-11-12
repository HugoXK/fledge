export interface ChiefMessage {
  role: 'user' | 'chief'
  text: string
  at: number
}

const OWNER_PREFIX = '[Fledge owner message]\n'

const INTERNAL_PREFIXES = [
  'A Fledge job is ready.',
  'Fledge provisioning request.',
  'You are the Fledge repository worker.',
]

export function redactChiefText(value: string): string {
  return value
    .replace(/\bflg_[A-Za-z0-9_-]{8,}/g, '[redacted-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted-github-token]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-github-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted-key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, '$1[redacted]')
    .replace(/\/api\/jobs\/[A-Za-z0-9_-]+\/(callback|credential)/g, '/api/jobs/[job]/$1')
    .replace(/(callbackSecret|credentialSecret)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{8,}/gi, '$1: [redacted]')
    .slice(0, 4000)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      const type = (block as Record<string, unknown>).type
      const text = (block as Record<string, unknown>).text
      return type === 'text' && typeof text === 'string' ? text : ''
    })
    .filter((text) => text !== '')
    .join('\n')
}

function isInternal(text: string): boolean {
  const trimmed = text.trim()
  return INTERNAL_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}

export function parseChiefTranscript(jsonl: string, limit = 20): ChiefMessage[] {
  const pairs: Array<{ user: string; at: number; replies: string[] }> = []
  let current: { user: string; at: number; replies: string[] } | null = null
  const finalize = (): void => {
    if (current !== null) pairs.push(current)
    current = null
  }
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = event.type
    const data = (event.data ?? {}) as Record<string, unknown>
    if (type === 'user/message') {
      const source = (data.source ?? {}) as Record<string, unknown>
      const text = textOf(data.content).trim()
      if (typeof source.kind !== 'string' || text === '') continue
      if (source.kind === 'user') {
        finalize()
        const owner = text.startsWith(OWNER_PREFIX) ? text.slice(OWNER_PREFIX.length).trim() : text
        if (text.startsWith(OWNER_PREFIX) || !isInternal(text)) current = { user: owner, at: Number(event.time ?? 0), replies: [] }
      } else if (source.kind === 'bot') {
        finalize()
      }
      continue
    }
    if (type !== 'assistant/message' || current === null) continue
    const message = (data.message ?? {}) as Record<string, unknown>
    const text = textOf(message.content).trim()
    if (text !== '') current.replies.push(text)
  }
  finalize()
  const picked = pairs.filter((pair) => pair.user !== '').slice(-Math.max(1, limit))
  return picked.flatMap((pair) => [
    { role: 'user' as const, text: redactChiefText(pair.user), at: pair.at },
    ...(pair.replies.length === 0 ? [] : [{ role: 'chief' as const, text: redactChiefText(pair.replies.join('\n\n')), at: pair.at }]),
  ])
}
