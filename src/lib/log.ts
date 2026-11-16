import { maskEmail, maskIp, redact } from './secrets.js'

export type Level = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

// #694: a log line outlives the account it names — it is rotated, shipped and
// read long after a purge — so the sink is the one surface that never carries an
// account identifier. The row, the inbox and the job page keep the real value
// (masking lives here, not in `redact()`, which cleans what is stored and shown).
// Fields are decided by name because a login and a `usr_` id have no shape; text
// is decided by shape because a call site can glue one into a sentence.
const EMAIL_KEY = /^(?:admin|admin_?email|e-?mail|feedback_?email|from|recipient|reply_?to|to)$/i
const LOGIN_KEY = /^(?:account|login|user|user_?name)$/i
const ID_KEY = /^(?:account_?id|user_?id)$/i
const IP_KEY = /^(?:client_?ip|ip|ip_?address|remote_?addr|remote_?ip)$/i
// A repository field is `owner/name`: the owner is a GitHub login and is masked,
// the repository name is not an account and is kept so a line still says which
// repo it is about. Left out of the table, `owner/name` passed through whole.
const REPO_KEY = /^(?:repos?|repository|repo_?name)$/i

const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const USER_ID_SHAPE = /\busr_[A-Za-z0-9]{3,}\b/g
const IPV4_SHAPE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g

function maskName(value: string): string {
  return value === '' ? '' : `${value.slice(0, 1)}***`
}

function maskText(text: string): string {
  return text.replace(EMAIL_SHAPE, maskEmail).replace(USER_ID_SHAPE, 'usr_***').replace(IPV4_SHAPE, maskIp)
}

function maskField(key: string, value: string): string {
  if (EMAIL_KEY.test(key)) return value.includes('@') ? maskEmail(value) : maskName(value)
  if (LOGIN_KEY.test(key) || ID_KEY.test(key)) return maskName(value)
  if (IP_KEY.test(key)) return maskIp(value)
  if (REPO_KEY.test(key)) return value.replace(/^([^/]+)\//, (_match, owner: string) => `${maskName(owner)}/`)
  return value
}

// The key table is an optimisation, not the contract: a field the table does not
// name is still a string on its way to a sink that promises no account
// identifier, so the shape pass runs over every value (#694 review). An email
// glued into an unlisted field, a nested `{ user: { email } }` or an array of
// logins therefore cannot slip through just because a call site invented a key.
function maskValue(key: string, value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redact(maskText(maskField(key, value)))
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => maskValue(key, item, seen))
  const nested: Record<string, unknown> = {}
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    nested[nestedKey] = maskValue(nestedKey, nestedValue, seen)
  }
  return nested
}

function write(level: Level, message: string, fields?: LogFields): void {
  const line: Record<string, unknown> = { ts: new Date().toISOString(), level, msg: redact(maskText(message)) }
  if (fields !== undefined) {
    const seen = new WeakSet<object>()
    for (const [key, value] of Object.entries(fields)) line[key] = maskValue(key, value, seen)
  }
  const output = JSON.stringify(line)
  if (level === 'error') process.stderr.write(`${output}\n`)
  else process.stdout.write(`${output}\n`)
}

export interface Logger {
  debug: (message: string, fields?: LogFields) => void
  info: (message: string, fields?: LogFields) => void
  warn: (message: string, fields?: LogFields) => void
  error: (message: string, fields?: LogFields) => void
  /** The same logger with fields merged into every line it writes. */
  with: (fields: LogFields) => Logger
}

// #100: one correlation value has to be written by every line that belongs to a
// job, including the lines a runner and the gateway write. Binding it once — and
// passing that logger down — is what keeps the call sites from naming the job
// three different ways. A bound field wins over a call-site field of the same
// name: the job a line belongs to is decided where the line is bound, so a
// stray `{ trace: somethingElse }` at one call site cannot split the job's
// lines across two ids. Re-binding with `with` still wins, because that is the
// binding, not a call site.
export function boundLog(bound: LogFields): Logger {
  const merge = (fields?: LogFields): LogFields => (fields === undefined ? { ...bound } : { ...fields, ...bound })
  return {
    debug: (message, fields) => write('debug', message, merge(fields)),
    info: (message, fields) => write('info', message, merge(fields)),
    warn: (message, fields) => write('warn', message, merge(fields)),
    error: (message, fields) => write('error', message, merge(fields)),
    with: (fields) => boundLog({ ...bound, ...fields }),
  }
}

export const log: Logger = boundLog({})
