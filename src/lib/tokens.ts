// #355: a personal `flg_` token is a capability. Two properties decide what it
// may do and for how long: a scope, and an expiry. Only `gateway` exists today,
// so the list below is the whole policy: adding a scope is a code change and a
// test, never a free-form value posted by a form.
export const TOKEN_SCOPES = ['gateway'] as const

export type TokenScope = (typeof TOKEN_SCOPES)[number]

export const GATEWAY_SCOPE: TokenScope = 'gateway'

/** Personal tokens minted without an expiry are given this window, in days. */
export const DEFAULT_PAT_EXPIRY_DAYS = 90

/** The expiry choices the create form offers, in days. `never` is admin-only. */
export const PAT_EXPIRY_CHOICES = [30, 90, 365] as const

export function isTokenScope(value: unknown): value is TokenScope {
  return typeof value === 'string' && (TOKEN_SCOPES as readonly string[]).includes(value)
}

/**
 * Turn a form choice into an expiry. `never` and anything unknown answer the
 * default, because a form value can never mint a token without a deadline: only
 * an operator token is created with an explicit NULL, and that path is decided
 * by the route's role check, not by a posted string.
 */
export function patExpiryDays(choice: string | undefined, fallbackDays: number): number | null {
  if (choice === 'never') return null
  const parsed = Number(choice)
  if (Number.isInteger(parsed) && (PAT_EXPIRY_CHOICES as readonly number[]).includes(parsed)) return parsed
  return fallbackDays
}

export function expiryFromDays(days: number, now = Date.now()): string {
  return new Date(now + days * 86_400_000).toISOString()
}
