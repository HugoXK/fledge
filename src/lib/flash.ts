// #472 slice 2: a redirect message is a one-shot flash, not a query string.
//
// Every route that reports an outcome already puts a notice or error parameter
// in the Location. `readRedirectMessage()` is the seam that turns that promise
// into a cookie: the message moves into `fledge_flash`, the address bar keeps
// only the page and any other parameter, and the next HTML page consumes and
// clears the cookie. A hand-typed query parameter therefore has no renderer
// left to reach.
//
// The cookie is base64url JSON, not a plain sentence: the key travels with the
// text, so the seam decides "one message per event" before the page renders it
// (a refusal keeps its code as the event id). Text is server-authored and is
// escaped again by the banner builder; decoding re-checks the shape and caps
// every field, so a cookie a client edits cannot grow the page or smuggle a
// field into it.

export const FLASH_COOKIE = 'fledge_flash'

const LOCAL_ORIGIN = 'http://fledge.invalid'
const MAX_TEXT = 500
const MAX_KEY = 80
const MAX_RAW = 4096

export interface FlashMessage {
  text: string
  /** One event renders once; a refusal uses its code plus the text. */
  key: string
}

export interface FlashState {
  notice?: FlashMessage
  error?: FlashMessage
}

export interface RedirectFlash {
  location: string
  state: FlashState
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.slice(0, max)
}

function readMessage(value: unknown): FlashMessage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  const body = bounded(entry.t, MAX_TEXT)
  if (body === undefined) return undefined
  return { text: body, key: bounded(entry.k, MAX_KEY) ?? body }
}

export function encodeFlash(state: FlashState): string {
  const payload: Record<string, { t: string; k: string }> = {}
  if (state.notice !== undefined) payload.n = { t: state.notice.text.slice(0, MAX_TEXT), k: state.notice.key.slice(0, MAX_KEY) }
  if (state.error !== undefined) payload.e = { t: state.error.text.slice(0, MAX_TEXT), k: state.error.key.slice(0, MAX_KEY) }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeFlash(raw: string | undefined): FlashState | undefined {
  if (raw === undefined || raw === '' || raw.length > MAX_RAW) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const notice = readMessage(record.n)
  const error = readMessage(record.e)
  if (notice === undefined && error === undefined) return undefined
  return {
    ...(notice === undefined ? {} : { notice }),
    ...(error === undefined ? {} : { error }),
  }
}

// The redirect contract is local-only: a Location that leaves this origin is
// never rewritten, so an external URL keeps whatever its own query says. Only
// a path can carry a platform message.
export function readRedirectMessage(location: string): RedirectFlash | undefined {
  if (!location.startsWith('/') || location.startsWith('//')) return undefined
  let url: URL
  try {
    url = new URL(location, LOCAL_ORIGIN)
  } catch {
    return undefined
  }
  if (url.origin !== LOCAL_ORIGIN) return undefined
  const notice = bounded(url.searchParams.get('notice'), MAX_TEXT)
  const error = bounded(url.searchParams.get('error'), MAX_TEXT)
  if (notice === undefined && error === undefined) return undefined
  // `code` is the refusal's event id and is not read by any renderer; it is
  // removed together with the message it belongs to.
  const code = error === undefined ? undefined : bounded(url.searchParams.get('code'), MAX_KEY)
  url.searchParams.delete('notice')
  url.searchParams.delete('error')
  if (error !== undefined) url.searchParams.delete('code')
  const state: FlashState = {}
  if (error !== undefined) state.error = { text: error, key: code === undefined ? error : `${code}:${error}` }
  if (notice !== undefined) state.notice = { text: notice, key: notice }
  return { location: `${url.pathname}${url.search}${url.hash}`, state }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The one-shot message this request may render, read before any handler runs. */
    flash?: FlashState
  }
}
