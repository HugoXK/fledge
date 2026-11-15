// #814: one report, one private triage packet to the Fledge Lead inside the
// server-deployed FlyBot. Two deployment shapes share the packet:
//   - a repo Fledge already manages (`FLEDGE_LEAD_REPO_ID`);
//   - an externally managed bridge (`FLEDGE_LEAD_BRIDGE_URL/TOKEN/SESSION_ID`).
// The report itself must never fail because the Lead is offline; the caller
// keeps the row and the maintainer mail.
import type { Config } from '../config.js'
import type { ErrorReportRow, FeedbackRow, FeedbackTriageRow } from '../db.js'
import { hmacHex, redact, safeEqual } from '../lib/secrets.js'

export interface LeadTransport {
  sendGuidance(repoId: string, target: string, text: string): Promise<void>
}

export type LeadMode = 'repo' | 'bridge' | 'none'

export function leadMode(config: Config): LeadMode {
  if (config.feedback.leadRepoId !== '') return 'repo'
  if (config.feedback.leadBridgeUrl !== '' && config.feedback.leadBridgeToken !== '' && config.feedback.leadSessionId !== '') return 'bridge'
  return 'none'
}

export const TRIAGE_TOKEN_TTL_MS = 7 * 86_400_000

export function triageToken(sessionSecret: string, ref: string, expiresAt = Date.now() + TRIAGE_TOKEN_TTL_MS): string {
  return `${expiresAt}.${hmacHex(sessionSecret, `feedback-triage:${ref}:${expiresAt}`)}`
}

export function verifyTriageToken(sessionSecret: string, ref: string, supplied: string, now = Date.now()): boolean {
  const [expires, signature] = supplied.split('.', 2)
  const at = Number(expires)
  if (!Number.isFinite(at) || at <= now || signature === undefined) return false
  return safeEqual(signature, hmacHex(sessionSecret, `feedback-triage:${ref}:${expires}`))
}

// #814: the only text a Lead should paste into a public issue. It is derived
// from the Lead's own public_summary, never from the raw message or stack, and
// the @mention appears only when the reporter explicitly consented.
export function publicIssueDraft(triage: FeedbackTriageRow): { title: string; body: string; mention: string } {
  const summary = (triage.public_summary ?? '').trim() || 'A Fledge user reported a problem.'
  const mention = triage.publish_consent === 1 && triage.user_login !== null ? `@${triage.user_login}` : ''
  return {
    title: `[feedback] ${summary.slice(0, 80)}`.slice(0, 120),
    body: `${mention === '' ? 'Thanks for the report' : `${mention} thanks for the report`} (ref \`${triage.ref}\`).\n\n${summary}\n\nFledge will update this issue when a fix ships.`,
    mention,
  }
}

export interface TriagePacketInput {
  config: Config
  triage: FeedbackTriageRow
  feedback?: FeedbackRow
  error?: ErrorReportRow
}

// The packet is private (bridge/Lead session), so it may name the reporter and
// the consent flag; the raw message and stack are fetched through the signed
// triage API rather than pasted into a public issue.
export function buildTriagePacket(input: TriagePacketInput): string {
  const { config, triage, feedback, error } = input
  const tokenExpiresAt = Date.now() + TRIAGE_TOKEN_TTL_MS
  const token = triageToken(config.sessionSecret, triage.ref, tokenExpiresAt)
  const summary = redact((feedback?.message ?? error?.error_message ?? '').trim()).slice(0, 500)
  const reporter = triage.user_login === null ? 'anonymous' : `@${triage.user_login}`
  const lines = [
    '[Fledge feedback triage]',
    `ref: ${triage.ref}`,
    `kind: ${triage.kind}`,
    `reporter: ${reporter}`,
    `publishConsent: ${triage.publish_consent === 1 ? 'yes' : 'no'}`,
    `publicRepo: ${config.feedback.publicRepo}`,
    `summary: ${summary === '' ? '(no summary)' : summary}`,
    ...(error === undefined ? [] : [`error: ${error.error_name}: ${error.error_message}`]),
    '',
    `Read: GET ${config.baseUrl}/api/feedback/${encodeURIComponent(triage.ref)}`,
    `Authorization: Bearer ${token}`,
    `Token expires: ${new Date(tokenExpiresAt).toISOString()}`,
    `Write: POST ${config.baseUrl}/api/feedback/${encodeURIComponent(triage.ref)}/triage`,
    'JSON: {status, user_message, public_summary, issue_url, pr_url, fixed_version}',
    'Statuses: user_error | duplicate | needs_info | confirmed | issue_opened | pr_opened | fixed | wontfix',
    'Rules:',
    '- Decide whether this is a user/configuration problem or a platform defect.',
    '- A confirmed defect: create one sanitized public issue in publicRepo; include the ref and @reporter only when publishConsent=yes. Never paste the raw message, stack, email or token into the issue.',
    '- Record issue_url, pr_url and fixed_version through the Write endpoint.',
    '- After setting public_summary, GET the record again for a ready-to-use sanitized issue draft.',
    '- Fledge sends the in-app/email update to the reporter; do not send it yourself.',
  ]
  return lines.join('\n').slice(0, 4000)
}

export async function deliverFeedbackToLead(input: TriagePacketInput & {
  instances: LeadTransport | undefined
  fetchImpl?: typeof fetch
}): Promise<{ ok: boolean; mode: LeadMode; error?: string }> {
  const mode = leadMode(input.config)
  if (mode === 'none') return { ok: false, mode, error: 'no Fledge Lead target configured' }
  const packet = buildTriagePacket(input)
  try {
    if (mode === 'repo') {
      if (input.instances === undefined) return { ok: false, mode, error: 'instance manager is not available' }
      await input.instances.sendGuidance(input.config.feedback.leadRepoId, 'lead', packet)
      return { ok: true, mode }
    }
    const fetchImpl = input.fetchImpl ?? globalThis.fetch
    const response = await fetchImpl(`${input.config.feedback.leadBridgeUrl}/dsh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${input.config.feedback.leadBridgeToken}` },
      body: JSON.stringify({ endpoint: 'send', payload: { sessionId: input.config.feedback.leadSessionId, text: packet } }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return { ok: false, mode, error: `bridge answered ${String(response.status)}` }
    return { ok: true, mode }
  } catch (error) {
    return { ok: false, mode, error: redact(error instanceof Error ? error.message : String(error)).slice(0, 300) }
  }
}
