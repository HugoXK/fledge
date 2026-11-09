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
  const numeric = typeof raw === 'string' ? Number(raw) : Number.NaN
  if (Number.isFinite(numeric)) {
    if (numeric >= CRITICAL_THRESHOLD) return 'critical'
    if (numeric >= HIGH_THRESHOLD) return 'high'
    if (numeric >= 4) return 'medium'
    return 'low'
  }
  // A SARIF file without a security-severity property still carries a level.
  if (result?.level === 'error') return 'high'
  if (result?.level === 'warning') return 'medium'
  return 'low'
}

export function parseSarif(document) {
  const alerts = []
  for (const run of document?.runs ?? []) {
    const rules = run?.tool?.driver?.rules ?? []
    for (const result of run?.results ?? []) {
      // A result points at its rule by index; the id is a convenience. Prefer the
      // index, because one id can appear under more than one rule entry and the
      // index is what carries that result's own severity.
      const indexed = rules[result?.ruleIndex ?? -1]
      const rule = indexed ?? rules.find((entry) => entry?.id === result?.ruleId)
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
