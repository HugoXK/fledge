export interface PathGuardViolation {
  file: string
  reason: 'denied' | 'not_allowed'
}

export interface PathGuardResult {
  ok: boolean
  checkedAt: string
  allow: string[]
  deny: string[]
  files: string[]
  violations: PathGuardViolation[]
}

function normalize(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

export function splitPathPatterns(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return []
  return value
    .split(/[\n,]+/)
    .map(normalize)
    .filter((pattern) => pattern !== '')
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

export function matchesPath(file: string, pattern: string): boolean {
  const normalizedFile = normalize(file)
  const normalizedPattern = normalize(pattern)
  if (normalizedPattern === '') return false
  if (/[*?]/.test(normalizedPattern)) return patternToRegex(normalizedPattern).test(normalizedFile)
  if (normalizedPattern.endsWith('/')) return normalizedFile.startsWith(normalizedPattern)
  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`)
}

export function checkPathGuard(
  files: string[],
  allowInput: string | null | undefined,
  denyInput: string | null | undefined,
  now = new Date().toISOString(),
): PathGuardResult {
  const allow = splitPathPatterns(allowInput)
  const deny = splitPathPatterns(denyInput)
  const violations: PathGuardViolation[] = []
  for (const file of files.map(normalize)) {
    if (deny.some((pattern) => matchesPath(file, pattern))) {
      violations.push({ file, reason: 'denied' })
      continue
    }
    if (allow.length > 0 && !allow.some((pattern) => matchesPath(file, pattern))) {
      violations.push({ file, reason: 'not_allowed' })
    }
  }
  return { ok: violations.length === 0, checkedAt: now, allow, deny, files: files.map(normalize), violations }
}
