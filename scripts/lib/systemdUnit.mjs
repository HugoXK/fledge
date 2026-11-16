// A static parse of a systemd unit file (#882).
//
// `deploy-check` used to run `systemd-analyze verify` when the binary happened to
// be on the runner and write a "gap" into the summary when it was not, which is
// the normal case on a GitHub runner. A broken `deploy/fledge.service` therefore
// merged with the gate green. This parser runs everywhere and covers the subset
// the sample can actually get wrong:
//
// - section names and the shape of a directive line;
// - duplicate keys in one section, which systemd resolves silently to the last;
// - keys whose value has to be an absolute path;
// - the directives a service cannot start without.
//
// It reads text, not a running system, so it cannot answer "would systemd accept
// this host's dependencies" — that stays `systemd-analyze verify`'s job on a real
// host. The unit's own contract is what this gate owns.

const SECTIONS = new Set(['Unit', 'Service', 'Socket', 'Timer', 'Install', 'Path'])

// `Type=` values systemd documents; anything else is a typo that only shows up
// when the unit is started.
const SERVICE_TYPES = new Set(['simple', 'exec', 'forking', 'oneshot', 'notify', 'notify-reload', 'dbus', 'idle'])

// Keys whose value names a path on the host. An exec line's first word is the
// program and the rest are arguments, so only that word is a path; a list-valued
// key separates its paths with whitespace. systemd prefixes exec lines with `-`
// (ignore failure), `@`, `:`, `+` and `!`, and may prefix each listed path with
// `-`, so the prefix is stripped before the absolute check.
const EXEC_KEYS = new Set(['ExecReload', 'ExecStart', 'ExecStartPost', 'ExecStartPre', 'ExecStop', 'ExecStopPost'])
const PATH_KEYS = new Set(['EnvironmentFile', 'ReadOnlyPaths', 'ReadWritePaths', 'WorkingDirectory'])

const REQUIRED_SECTIONS = ['Unit', 'Service', 'Install']

/** Paths in a value, with systemd's `-` prefix removed. */
function pathsOf(value) {
  return value
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => word.replace(/^[-@:+!]+/, ''))
}

/** Join systemd's `\`-continued lines so a continuation is one directive. */
function logicalLines(text) {
  const out = []
  let buffer = ''
  let start = 0
  for (const [index, raw] of text.split('\n').entries()) {
    if (buffer === '') start = index + 1
    if (raw.endsWith('\\')) {
      buffer += raw.slice(0, -1)
      continue
    }
    out.push({ at: start, text: buffer + raw })
    buffer = ''
  }
  if (buffer !== '') out.push({ at: start, text: buffer })
  return out
}

/**
 * Parse a unit file and return every problem found, in file order. An empty
 * `errors` list means the sample satisfies the contract this gate owns.
 */
export function parseSystemdUnit(text) {
  const errors = []
  const sections = []
  const declared = new Set()
  /** @type {Map<string, Map<string, number>>} */
  const keysPerSection = new Map()
  /** @type {Map<string, Map<string, string>>} */
  const valuesPerSection = new Map()
  let current = null
  let directives = 0

  for (const line of logicalLines(text)) {
    const trimmed = line.text.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue

    const header = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(trimmed)
    if (header !== null) {
      const name = header[1]
      if (!SECTIONS.has(name)) errors.push(`${line.at}: unknown section [${name}]`)
      if (declared.has(name)) errors.push(`${line.at}: [${name}] is declared twice`)
      declared.add(name)
      sections.push(name)
      current = name
      if (!keysPerSection.has(name)) keysPerSection.set(name, new Map())
      if (!valuesPerSection.has(name)) valuesPerSection.set(name, new Map())
      continue
    }

    const directive = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(trimmed)
    if (directive === null) {
      errors.push(`${line.at}: not a section header or a Key=Value directive: ${trimmed}`)
      continue
    }
    const [, key, value] = directive
    if (current === null) {
      errors.push(`${line.at}: ${key}= appears before any [section]`)
      continue
    }
    directives += 1
    const keys = keysPerSection.get(current)
    valuesPerSection.get(current).set(key, value)
    if (keys.has(key)) {
      errors.push(`${line.at}: duplicate ${key}= in [${current}] (first at line ${keys.get(key)})`)
    } else {
      keys.set(key, line.at)
    }
    const paths = EXEC_KEYS.has(key) ? pathsOf(value).slice(0, 1) : PATH_KEYS.has(key) ? pathsOf(value) : []
    // An empty `ExecStart=` is systemd's reset form; it is meaningful only when
    // a later line sets it again, which the required-key check proves.
    for (const path of paths) {
      if (!path.startsWith('/')) errors.push(`${line.at}: ${key}= must name an absolute path: ${value.trim()}`)
    }
    if (key === 'Type' && current === 'Service' && !SERVICE_TYPES.has(value.trim())) {
      errors.push(`${line.at}: Type=${value.trim()} is not a systemd service type`)
    }
  }

  for (const name of REQUIRED_SECTIONS) {
    if (!declared.has(name)) errors.push(`[${name}] section is missing`)
  }

  // A directive that is present but empty is systemd's reset form, so presence
  // is not enough: an emptied `WantedBy=` is a unit that cannot be enabled.
  const value = (section, key) => (valuesPerSection.get(section)?.get(key) ?? '').trim()
  const set = (section, key) => value(section, key) !== ''

  if (declared.has('Unit') && !set('Unit', 'Description')) errors.push('[Unit] Description= is required')
  if (declared.has('Service')) {
    if (!set('Service', 'Type')) errors.push('[Service] Type= is required')
    if (!set('Service', 'ExecStart')) errors.push('[Service] ExecStart= is required; a service with none cannot start')
  }
  if (declared.has('Install') && !set('Install', 'WantedBy') && !set('Install', 'RequiredBy')) {
    errors.push('[Install] WantedBy= or RequiredBy= is required; otherwise the unit cannot be enabled')
  }

  return { sections, directives, errors }
}
