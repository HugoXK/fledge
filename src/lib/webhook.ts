import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Config } from '../config.js'
import { isBlockedIpAddress } from './ipAddress.js'
import { nowIso } from './time.js'

export interface WebhookAddress {
  address: string
  family: number
}

export type WebhookResolver = (host: string) => Promise<WebhookAddress[]>

export interface WebhookSafetyOptions {
  allowedHosts?: string[]
  resolve?: WebhookResolver
  fetch?: typeof fetch
}

/** A destination refusal (`blocked`) is terminal; a resolution failure is transient. */
export class WebhookAddressError extends Error {
  constructor(message: string, readonly kind: 'blocked' | 'retry') {
    super(message)
    this.name = 'WebhookAddressError'
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function parseWebhookUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebhookAddressError('Refusing notification webhook: not an absolute URL', 'blocked')
  }
  if (url.username !== '' || url.password !== '') {
    throw new WebhookAddressError(`Refusing notification webhook: host "${normalizeHost(url.hostname)}" must not include credentials`, 'blocked')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebhookAddressError(`Refusing notification webhook: host "${normalizeHost(url.hostname)}" must use http:// or https://`, 'blocked')
  }
  if (url.hostname === '') {
    throw new WebhookAddressError('Refusing notification webhook: missing host', 'blocked')
  }
  return url
}

async function resolveWebhookHost(host: string, resolve: WebhookResolver): Promise<WebhookAddress[]> {
  try {
    return await resolve(host)
  } catch {
    throw new WebhookAddressError(`Refusing notification webhook: cannot resolve host "${host}"`, 'retry')
  }
}

export async function assertSafeWebhookUrl(raw: string, options: WebhookSafetyOptions = {}): Promise<URL> {
  const url = parseWebhookUrl(raw)
  const host = normalizeHost(url.hostname)
  const allowedHosts = (options.allowedHosts ?? []).map(normalizeHost)
  const allowlisted = allowedHosts.includes(host)

  if (allowedHosts.length > 0 && !allowlisted) {
    throw new WebhookAddressError(`Refusing notification webhook: host "${host}" is not in NOTIFY_WEBHOOK_ALLOWED_HOSTS`, 'blocked')
  }
  if (allowlisted) return url

  if (url.protocol !== 'https:') {
    throw new WebhookAddressError(`Refusing notification webhook: host "${host}" must use https://`, 'blocked')
  }
  if (isIP(host) !== 0) {
    if (isBlockedIpAddress(host)) {
      throw new WebhookAddressError(`Refusing notification webhook: host "${host}" is a private or reserved address`, 'blocked')
    }
    return url
  }

  const resolve = options.resolve ?? ((name: string) => lookup(name, { all: true }))
  const addresses = await resolveWebhookHost(host, resolve)
  if (addresses.length === 0) {
    throw new WebhookAddressError(`Refusing notification webhook: cannot resolve host "${host}"`, 'retry')
  }
  for (const entry of addresses) {
    if (isBlockedIpAddress(entry.address)) {
      throw new WebhookAddressError(`Refusing notification webhook: host "${host}" resolves to a private or reserved address`, 'blocked')
    }
  }
  return url
}

export async function assertSafeNotificationWebhook(
  config: Pick<Config, 'env' | 'notifyWebhookUrl' | 'notifyWebhookAllowedHosts'>,
  options: Pick<WebhookSafetyOptions, 'resolve'> = {},
): Promise<void> {
  if (config.env !== 'production' || config.notifyWebhookUrl === '') return
  await assertSafeWebhookUrl(config.notifyWebhookUrl, {
    allowedHosts: config.notifyWebhookAllowedHosts,
    resolve: options.resolve,
  })
}

async function postWebhook(
  url: URL,
  body: string,
  headers: Record<string, string>,
  options: WebhookSafetyOptions,
): Promise<Response> {
  const fetchImpl = options.fetch ?? fetch
  let current = url
  let method = 'POST'
  let payload: string | undefined = body

  for (let redirects = 0; ; redirects += 1) {
    let safeUrl: URL
    try {
      safeUrl = await assertSafeWebhookUrl(current.toString(), options)
    } catch (error) {
      // A policy refusal is terminal; a resolver failure is transient. The
      // address layer says which one this is, so a DNS blip is retried instead
      // of losing the notification as `blocked`.
      throw new NotificationWebhookError(String(error), error instanceof WebhookAddressError ? error.kind : 'blocked')
    }
    let response: Response
    try {
      response = await fetchImpl(safeUrl.toString(), {
        method,
        headers,
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
      })
    } catch (error) {
      // A timeout or reset may have happened after the body left the process, so
      // it is unknown; a connect/DNS failure never reached the destination.
      throw new NotificationWebhookError(
        `Notification webhook request to host "${normalizeHost(current.hostname)}" failed`,
        isAmbiguousWebhookFailure(error) ? 'unknown' : 'retry',
      )
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response
    if (redirects >= MAX_REDIRECTS) {
      throw new NotificationWebhookError(`Refusing notification webhook: too many redirects for host "${normalizeHost(current.hostname)}"`, 'blocked')
    }
    const location = response.headers.get('location')
    if (location === null || location === '') return response
    await response.body?.cancel()
    const next = new URL(location, current)
    if (next.origin !== current.origin) delete headers.authorization
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET'
      payload = undefined
    }
    current = next
  }
}

/** #544 slice 7: what the caller can prove about a failed request. */
export type WebhookFailureKind = 'blocked' | 'retry' | 'unknown'

export class NotificationWebhookError extends Error {
  constructor(message: string, readonly kind: WebhookFailureKind) {
    super(message)
    this.name = 'NotificationWebhookError'
  }
}

// Anything that may have happened after the request was written is ambiguous.
// Connection refused, DNS and TLS-setup failures are not.
const AMBIGUOUS_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'])

function webhookErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as { code?: unknown; cause?: unknown }
  if (typeof record.code === 'string') return record.code
  if (typeof record.cause === 'object' && record.cause !== null) {
    const cause = record.cause as { code?: unknown }
    if (typeof cause.code === 'string') return cause.code
  }
  return undefined
}

function isAmbiguousWebhookFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as { name?: unknown }
  if (record.name === 'TimeoutError' || record.name === 'AbortError') return true
  const code = webhookErrorCode(error)
  return code !== undefined && AMBIGUOUS_CODES.has(code)
}

/**
 * #544 slice 7: the outbox's webhook transport. It reports the response status
 * and lets the typed failure through, so the caller can record `sent` / `retry`
 * / `dead` / `blocked` / `unknown` instead of losing the outcome in a log line.
 */
export async function postNotificationWebhook(
  config: Config,
  event: string,
  payload: Record<string, unknown>,
  options: WebhookSafetyOptions = {},
): Promise<number> {
  if (config.notifyWebhookUrl === '') throw new NotificationWebhookError('notification webhook is not configured', 'blocked')
  const text = typeof payload.text === 'string' ? payload.text : `${event}: ${JSON.stringify(payload).slice(0, 500)}`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'fledge/0.2',
    ...(config.notifyWebhookSecret === '' ? {} : { authorization: `Bearer ${config.notifyWebhookSecret}` }),
  }
  const response = await postWebhook(new URL(config.notifyWebhookUrl), JSON.stringify({ event, at: nowIso(), text, ...payload }), headers, {
    ...options,
    allowedHosts: config.notifyWebhookAllowedHosts,
  })
  return response.status
}
