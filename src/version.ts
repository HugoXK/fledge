import { readFileSync } from 'node:fs'

function readPackageVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  const parsed = JSON.parse(raw) as { version?: unknown }
  return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
}

export const VERSION = readPackageVersion()
