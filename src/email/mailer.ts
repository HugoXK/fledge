import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import nodemailer, { type Transporter } from 'nodemailer'
import type { Config } from '../config.js'
import { log } from '../lib/log.js'
import { redact } from '../lib/secrets.js'

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

export interface Mailer {
  send(message: MailMessage): Promise<void>
}

export class ConsoleMailer implements Mailer {
  constructor(
    private readonly outbox: string,
    private readonly from = 'flybot@yeah.net',
  ) {}

  async send(message: MailMessage): Promise<void> {
    mkdirSync(this.outbox, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(this.outbox, `${stamp}-${message.to.replace(/[^a-z0-9@._-]/gi, '_')}.eml`)
    const body = [
      `Date: ${new Date().toUTCString()}`,
      `From: Fledge <${this.from}>`,
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      message.text,
      '',
    ].join('\r\n')
    writeFileSync(file, body, { mode: 0o600 })
    log.info('mail captured (console transport)', { to: message.to, subject: message.subject, file })
  }
}

export class SmtpMailer implements Mailer {
  private readonly transporter: Transporter

  constructor(private readonly config: Config) {
    this.transporter = nodemailer.createTransport({
      host: config.mail.smtp.host,
      port: config.mail.smtp.port,
      secure: config.mail.smtp.secure,
      auth:
        config.mail.smtp.user === ''
          ? undefined
          : { user: config.mail.smtp.user, pass: config.mail.smtp.pass },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    })
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.config.mail.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
      })
      log.info('mail sent', { to: message.to, subject: message.subject })
    } catch (error) {
      log.error('mail send failed', { to: message.to, subject: message.subject, error: redact(String(error)) })
      throw error
    }
  }
}

export function createMailer(config: Config): Mailer {
  if (config.mail.transport === 'smtp') return new SmtpMailer(config)
  return new ConsoleMailer(join(config.dataDir, 'mail-outbox'), config.mail.from)
}
