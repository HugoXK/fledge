#!/usr/bin/env node
// Supply-chain gate 3: a pull request must not land a new high or critical
// CodeQL result, and `main` must not start accumulating them.
//
// CodeQL on its own is advisory: `github/codeql-action/analyze` uploads results
// and exits 0 whether it found a remote-code-execution sink or nothing at all, so
// three high alerts sat open on `main` while the check stayed green. This reader
// turns the SARIF that run already produces into a verdict, and it is
// diff-scoped: the four high alerts that were open at the recorded base are the
// baseline, so a pull request is failed for *adding* one, not for working in a
// repository that already has them. Nothing is dismissed to make a run green.

// CodeQL writes `security-severity` as a CVSS-like number on the rule. The
// bands match GitHub's own: 9.0+ critical, 7.0-8.9 high.
export const HIGH_THRESHOLD = 7
export const CRITICAL_THRESHOLD = 9

export function severityOf(result, rule) {
  const raw = rule?.properties?.['security-severity']
  // GitHub writes the number as a string, query packs may write the number
  // itself. Both are the same measurement and both are read.
  const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  if (Number.isFinite(numeric)) {
    if (numeric >= CRITICAL_THRESHOLD) return 'critical'
    if (numeric >= HIGH_THRESHOLD) return 'high'
    if (numeric >= 4) return 'medium'
    return 'low'
  }
  // The severity is undeterminable from the score, so fail closed where that
  // matters: a security query with no readable security-severity is high, and so
  // is a result whose rule could not be resolved at all (that is the blindness
  // this gate had: the query-pack rules live under tool.extensions, not under
  // the driver). A resolved non-security query is a quality or correctness
  // finding; it never carried a CVSS score, and its own `level` is the label the
  // analysis assigned, so the old bands still apply to it.
  const tags = Array.isArray(rule?.properties?.tags) ? rule.properties.tags : []
  if (rule === undefined || rule === null) return 'high'
  if (tags.includes('security') || result?.level === 'error') return 'high'
  if (result?.level === 'warning') return 'medium'
  return 'low'
}

export function parseSarif(document) {
  const alerts = []
  for (const run of document?.runs ?? []) {
    // Query-pack rules do not live under the driver: they arrive as a tool
    // component in `tool.extensions`, and a result's `rule.toolComponent.index`
    // says which component its `ruleIndex` counts in (0 is the driver).
    const components = [run?.tool?.driver ?? {}, ...(Array.isArray(run?.tool?.extensions) ? run.tool.extensions : [])]
    const allRules = components.flatMap((component) => (Array.isArray(component?.rules) ? component.rules : []))
    for (const result of run?.results ?? []) {
      // A result points at its rule by index; the id is a convenience. Prefer the
      // index inside the component the result names, because one id can appear
      // under more than one rule entry and the index is what carries that
      // result's own severity. Fall back to the id across every component.
      const componentIndex = Number.isInteger(result?.rule?.toolComponent?.index) ? result.rule.toolComponent.index : 0
      const componentRules = Array.isArray(components[componentIndex]?.rules) ? components[componentIndex].rules : []
      const indexed = Number.isInteger(result?.ruleIndex) ? componentRules[result.ruleIndex] : undefined
      const rule = indexed ?? allRules.find((entry) => entry?.id === result?.ruleId)
      const ruleId = result?.ruleId ?? indexed?.id ?? ''
      const location = result?.locations?.[0]?.physicalLocation
      const path = location?.artifactLocation?.uri ?? ''
      const line = location?.region?.startLine ?? 0
      alerts.push({
        ruleId: String(ruleId),
        path: String(path).replace(/^\.\//, ''),
        line: Number.isInteger(line) ? line : 0,
        severity: severityOf(result, rule),
      })
    }
  }
  return alerts
}

export function highAlerts(alerts) {
  return alerts.filter((alert) => alert.severity === 'high' || alert.severity === 'critical')
}

// A result is the same result when the same rule fires at the same path and
// line. Line drift from an unrelated edit is a new key, which fails loudly
// rather than silently re-labelling an old alert as new: the fix is to update
// the baseline in a reviewed commit, which is the record the issue asks for.
export function alertKey(alert) {
  return `${alert.ruleId}|${alert.path}|${alert.line}`
}

export function addedAlerts(baselineKeys, alerts) {
  const known = new Set(baselineKeys)
  return highAlerts(alerts).filter((alert) => !known.has(alertKey(alert)))
}

// #307: this gate passes a medium or low result by severity, and the branch still
// refuses the merge while that result's review thread is open — `review-gate` owns
// that decision (#308) and fails on any unresolved thread. Two readers describing
// different sets is how #299 looked green on every required check and was refused
// by the merge API, so the accepted set is the one this gate has to name: it is
// passing results a maintainer cannot merge over.
export function acceptedAlerts(alerts) {
  return alerts.filter((alert) => alert.severity !== 'high' && alert.severity !== 'critical')
}

// A thread points at the place its comment was posted. `line` is null once the
// thread is outdated, which is exactly the state #299's four threads were in when
// their fix landed, so `originalLine` decides when `line` does not — the same rule
// `review-gate` prints by.
export function threadAt(alert, threads) {
  const line = Number.isInteger(alert?.line) ? alert.line : null
  const path = String(alert?.path ?? '')
  if (line === null || path === '') return null
  for (const thread of threads ?? []) {
    if (thread?.isResolved === true) continue
    if (String(thread?.path ?? '') !== path) continue
    const threadLine = Number.isInteger(thread?.line) ? thread.line : Number.isInteger(thread?.originalLine) ? thread.originalLine : null
    if (threadLine === line) return thread
  }
  return null
}
