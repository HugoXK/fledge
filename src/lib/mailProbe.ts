import type { Config } from '../config.js'
import { createMailer } from '../email/mailer.js'
import { redact } from './secrets.js'

export interface MailProbeResult {
  ok: boolean
  transport: string
  host: string
  elapsedMs: number
  summary: string
}

// One delivery attempt over the configured transport. The summary carries the
// transport, the host and the elapsed time only: never the recipient address and
// never a credential, so an operator can paste it into a thread.
export async function probeMail(config: Config, to: string): Promise<MailProbeResult> {
  const transport = config.mail.transport
  const host = transport === 'smtp' ? config.mail.smtp.host : 'local-outbox'
  const started = Date.now()
  try {
    await createMailer(config).send({
      to,
      subject: 'Fledge mail probe',
      text: 'This is a delivery probe from Fledge. Receiving it means the approval mail path works.',
    })
    const elapsedMs = Date.now() - started
    return { ok: true, transport, host, elapsedMs, summary: `transport=${transport} host=${host} elapsed=${elapsedMs}ms ok` }
  } catch (error) {
    const elapsedMs = Date.now() - started
    return { ok: false, transport, host, elapsedMs, summary: `transport=${transport} host=${host} elapsed=${elapsedMs}ms failed: ${redact(String(error))}` }
  }
}
