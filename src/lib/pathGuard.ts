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
  // Additive: rows written before these existed read as undefined, and the page
  // keeps its old sentence for them instead of claiming a truncation it cannot know.
  checkedFiles: number
  reportedFiles: number
  truncated: boolean
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
  reportedFilesInput = 0,
  complete = true,
): PathGuardResult {
  const allow = splitPathPatterns(allowInput)
  const deny = splitPathPatterns(denyInput)
  const normalizedFiles = files.map(normalize)
  const checkedFiles = normalizedFiles.length
  const reportedFiles = reportedFilesInput > 0 ? reportedFilesInput : checkedFiles
  // Two ways the guard can fall short of the full change: GitHub reported a
  // count the list did not reach, or the client itself says its walk did not
  // finish (`complete === false`, a page cap with no reported count - the case
  // a bare `reportedFilesInput > 0` test cannot see). A guard that did not see
  // every file must never report the change as clear.
  const truncated = !complete || (reportedFilesInput > 0 && checkedFiles < reportedFiles)
  const violations: PathGuardViolation[] = []
  for (const file of normalizedFiles) {
    if (deny.some((pattern) => matchesPath(file, pattern))) {
      violations.push({ file, reason: 'denied' })
      continue
    }
    if (allow.length > 0 && !allow.some((pattern) => matchesPath(file, pattern))) {
      violations.push({ file, reason: 'not_allowed' })
    }
  }
  return {
    ok: violations.length === 0 && !truncated,
    checkedAt: now,
    allow,
    deny,
    files: normalizedFiles,
    violations,
    checkedFiles,
    reportedFiles,
    truncated,
  }
}
