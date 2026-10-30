import type { Config } from '../config.js'
import type { ApprovalRow, Store, UserRow } from '../db.js'
import type { Mailer } from '../email/mailer.js'
import { applicationEmail, approvedEmail, rejectedEmail } from '../email/templates.js'
import { log } from '../lib/log.js'
import { randomToken, sha256Hex } from '../lib/secrets.js'
import { addDays } from '../lib/time.js'

const RESEND_AFTER_MS = 24 * 60 * 60 * 1000
const TOKEN_TTL_DAYS = 7

export interface ResolvedApproval {
  row: ApprovalRow
  user: UserRow
  token: string
}

export class Approvals {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly mailer: Mailer,
  ) {}

  async request(user: UserRow): Promise<{ sent: boolean; approveUrl?: string; rejectUrl?: string }> {
    if (user.status !== 'pending') return { sent: false }
    if (user.approval_sent_at !== null) {
      const sentAt = Date.parse(user.approval_sent_at)
      if (Number.isFinite(sentAt) && Date.now() - sentAt < RESEND_AFTER_MS) return { sent: false }
    }
    const approve = randomToken(32)
    const reject = randomToken(32)
    const expiresAt = addDays(TOKEN_TTL_DAYS)
    this.store.createApprovalToken(sha256Hex(approve), user.id, 'approve', expiresAt)
    this.store.createApprovalToken(sha256Hex(reject), user.id, 'reject', expiresAt)
    this.store.markApprovalSent(user.id)
    const approveUrl = `${this.config.baseUrl}/approve/${approve}`
    const rejectUrl = `${this.config.baseUrl}/approve/${reject}`
    const mail = applicationEmail(user, approveUrl, rejectUrl, this.config.baseUrl)
    try {
      await this.mailer.send({ to: this.config.mail.adminEmail, ...mail })
    } catch (error) {
      log.error('approval mail failed; links are only in this log', { user: user.login, approveUrl })
      throw error
    }
    this.store.audit(user.id, 'approval.requested', `mail to ${this.config.mail.adminEmail}`)
    log.info('approval requested', { user: user.login, admin: this.config.mail.adminEmail })
    return { sent: true, approveUrl, rejectUrl }
  }

  resolve(token: string): ResolvedApproval | undefined {
    const row = this.store.findApprovalToken(sha256Hex(token))
    if (row === undefined) return undefined
    const user = this.store.userById(row.user_id)
    if (user === undefined) return undefined
    return { row, user, token }
  }

  async apply(token: string, actor: string): Promise<{ ok: true; user: UserRow } | { ok: false; reason: string }> {
    const resolved = this.resolve(token)
    if (resolved === undefined) return { ok: false, reason: '这个链接无效或已经过期。' }
    if (resolved.user.status !== 'pending') return { ok: false, reason: '这个申请已经处理过了。' }
    this.store.useApprovalToken(resolved.row.token_hash)
    if (resolved.row.action === 'approve') {
      this.store.setUserStatus(resolved.user.id, 'approved', actor)
      this.store.audit(resolved.user.id, 'approval.approved', `by ${actor}`)
      const updated = this.store.userById(resolved.user.id)!
      try {
        await this.mailer.send({ to: updated.email ?? this.config.mail.adminEmail, ...approvedEmail(updated, this.config.baseUrl) })
      } catch (error) {
        log.warn('approval notice failed', { error: String(error) })
      }
      return { ok: true, user: updated }
    }
    this.store.setUserStatus(resolved.user.id, 'rejected', actor)
    this.store.audit(resolved.user.id, 'approval.rejected', `by ${actor}`)
    const updated = this.store.userById(resolved.user.id)!
    try {
      await this.mailer.send({ to: updated.email ?? this.config.mail.adminEmail, ...rejectedEmail(updated, '') })
    } catch (error) {
      log.warn('rejection notice failed', { error: String(error) })
    }
    return { ok: true, user: updated }
  }
}
