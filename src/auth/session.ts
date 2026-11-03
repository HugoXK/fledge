import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { Store, UserRow } from '../db.js'
import { hmacHex, randomToken, safeEqual, sha256Hex } from '../lib/secrets.js'
import { addDays } from '../lib/time.js'

export const SESSION_COOKIE = 'fledge_session'
export const CSRF_COOKIE = 'fledge_csrf'
export const PREVIEW_COOKIE = 'fledge_preview'
const SESSION_DAYS = 30

export interface Viewer {
  sessionHash: string
  user: UserRow
  csrfToken: string
  preview?: boolean
}

export function isAdminRole(role: string): boolean {
  return role === 'admin' || role === 'superadmin'
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
    const preview = user.role === 'superadmin' && request.cookies[PREVIEW_COOKIE] === 'user'
    return { sessionHash: hash, user, csrfToken: this.csrfFor(hash), preview }
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
    reply.clearCookie(PREVIEW_COOKIE, { path: '/' })
  }

  setPreview(reply: FastifyReply, enabled: boolean): void {
    if (!enabled) {
      reply.clearCookie(PREVIEW_COOKIE, { path: '/' })
      return
    }
    reply.setCookie(PREVIEW_COOKIE, 'user', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.baseUrl.startsWith('https://'),
      maxAge: 8 * 60 * 60,
    })
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
  if (viewer === undefined) throw Object.assign(new Error('请先登录。'), { statusCode: 401, code: 'AUTH_REQUIRED' })
  return viewer
}

export function requireApproved(request: FastifyRequest): Viewer {
  const viewer = requireViewer(request)
  if (viewer.user.status !== 'approved') throw Object.assign(new Error('账号正在等待审批。'), { statusCode: 403, code: 'NOT_APPROVED' })
  return viewer
}

export function requireAdmin(request: FastifyRequest): Viewer {
  const viewer = requireApproved(request)
  if (!isAdminRole(viewer.user.role)) throw Object.assign(new Error('仅管理员可访问。'), { statusCode: 403, code: 'ADMIN_ONLY' })
  return viewer
}

export function requireSuperAdmin(request: FastifyRequest): Viewer {
  const viewer = requireApproved(request)
  if (viewer.user.role !== 'superadmin') throw Object.assign(new Error('仅超级管理员可访问。'), { statusCode: 403, code: 'SUPERADMIN_ONLY' })
  return viewer
}

declare module 'fastify' {
  interface FastifyRequest {
    viewer?: Viewer
  }
}
