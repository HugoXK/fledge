import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { Store, UserRow } from '../db.js'
import { hmacHex, randomToken, safeEqual, sha256Hex } from '../lib/secrets.js'
import { addDays } from '../lib/time.js'

export const SESSION_COOKIE = 'fledge_session'
export const CSRF_COOKIE = 'fledge_csrf'
const SESSION_DAYS = 30

export interface Viewer {
  sessionHash: string
  user: UserRow
  csrfToken: string
}

export class Sessions {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
  ) {}

  start(userId: string, request: FastifyRequest): string {
    const raw = randomToken(32)
    this.store.createSession({
      idHash: sha256Hex(raw),
      userId,
      expiresAt: addDays(SESSION_DAYS),
      ip: request.ip,
      userAgent: String(request.headers['user-agent'] ?? '').slice(0, 300),
    })
    return raw
  }

  read(request: FastifyRequest): Viewer | null {
    const raw = request.cookies[SESSION_COOKIE]
    if (raw === undefined || raw === '') return null
    const hash = sha256Hex(raw)
    const session = this.store.getSession(hash)
    if (session === undefined) return null
    const user = this.store.userById(session.user_id)
    if (user === undefined) return null
    return { sessionHash: hash, user, csrfToken: this.csrfFor(hash) }
  }

  destroy(request: FastifyRequest): void {
    const raw = request.cookies[SESSION_COOKIE]
    if (raw !== undefined) this.store.deleteSession(sha256Hex(raw))
  }

  setCookies(reply: FastifyReply, raw: string, viewer: Viewer): void {
    const secure = this.config.baseUrl.startsWith('https://')
    reply.setCookie(SESSION_COOKIE, raw, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      maxAge: SESSION_DAYS * 86_400,
    })
    reply.setCookie(CSRF_COOKIE, viewer.csrfToken, {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      secure,
      maxAge: SESSION_DAYS * 86_400,
    })
  }

  clearCookies(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    reply.clearCookie(CSRF_COOKIE, { path: '/' })
  }

  csrfFor(sessionHash: string): string {
    return hmacHex(this.config.sessionSecret, `csrf:${sessionHash}`)
  }

  verifyCsrf(request: FastifyRequest, viewer: Viewer): boolean {
    const supplied = String(
      (request.body as Record<string, unknown> | undefined)?.csrf ??
        request.headers['x-csrf-token'] ??
        '',
    )
    return supplied !== '' && safeEqual(supplied, viewer.csrfToken)
  }
}

export function requireViewer(request: FastifyRequest): Viewer {
  const viewer = request.viewer
  if (viewer === undefined) throw Object.assign(new Error('Sign in first'), { statusCode: 401, code: 'AUTH_REQUIRED' })
  return viewer
}

export function requireApproved(request: FastifyRequest): Viewer {
  const viewer = requireViewer(request)
  if (viewer.user.status !== 'approved') throw Object.assign(new Error('Your account is awaiting approval'), { statusCode: 403, code: 'NOT_APPROVED' })
  return viewer
}

export function requireAdmin(request: FastifyRequest): Viewer {
  const viewer = requireApproved(request)
  if (viewer.user.role !== 'admin') throw Object.assign(new Error('Admin only'), { statusCode: 403, code: 'ADMIN_ONLY' })
  return viewer
}

declare module 'fastify' {
  interface FastifyRequest {
    viewer?: Viewer
  }
}
