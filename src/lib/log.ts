import { redact } from './secrets.js'

export type Level = 'debug' | 'info' | 'warn' | 'error'

function write(level: Level, message: string, fields?: Record<string, unknown>): void {
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

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
}
