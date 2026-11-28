// #1234: the CLI half of the incident bundle. It reads a copy, not the live
// database: the admin route exports the running instance, and this command is
// for a backup or a support copy where opening the file is safe.
//
//   npm run incident:bundle -- --db /path/to/copy.db
//   npm run incident:bundle -- --db /path/to/copy.db --window 6h --format markdown
//
// The builder in `src/lib/incident.ts` does the redaction and the caps; the CLI
// only parses argv, refuses the configured live path, and prints.

import { resolve, sep } from 'node:path'
import { loadConfig } from '../src/config.js'
import { openStore } from '../src/db.js'
import { buildIncidentBundle, incidentMarkdown, parseIncidentWindow } from '../src/lib/incident.js'

const usage = 'usage: npm run incident:bundle -- --db <copy.db> [--window 1h..24h] [--format json|markdown]'

function argvValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

const argv = process.argv.slice(2)
const dbArg = argvValue(argv, '--db')
if (dbArg === undefined || dbArg === '') {
  console.error(usage)
  process.exit(2)
}
const windowArg = argvValue(argv, '--window')
const format = argvValue(argv, '--format') ?? 'json'
if (format !== 'json' && format !== 'markdown' && format !== 'md') {
  console.error(`${usage}\n--format must be json or markdown`)
  process.exit(2)
}
const parsed = parseIncidentWindow(windowArg)
if (!parsed.ok) {
  console.error(`${usage}\n${parsed.error}`)
  process.exit(2)
}
const config = loadConfig()
const target = resolve(dbArg)
const live = [config.dbPath, config.dataDir]
  .filter((value): value is string => typeof value === 'string' && value !== '')
  .map((value) => resolve(value))
if (live.some((path) => target === path || target.startsWith(`${path}${sep}`))) {
  console.error('incident-bundle: refusing the configured live database; pass a backup or support copy')
  process.exit(2)
}
const store = openStore(target)
try {
  const bundle = buildIncidentBundle({ store, config, window: parsed.window })
  if (format === 'markdown' || format === 'md') process.stdout.write(incidentMarkdown(bundle))
  else process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`)
} finally {
  store.close()
}
