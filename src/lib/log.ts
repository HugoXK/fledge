import { redact } from './secrets.js'

export type Level = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

function write(level: Level, message: string, fields?: LogFields): void {
  const line: Record<string, unknown> = { ts: new Date().toISOString(), level, msg: redact(message) }
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      line[key] = typeof value === 'string' ? redact(value) : value
    }
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
