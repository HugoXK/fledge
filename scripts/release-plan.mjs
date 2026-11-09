#!/usr/bin/env node
// Daily minor release planner (issue #80).
//
// Pure: no file system, no network, no clock, no environment. The workflow
// collects the inputs and prints the result; every decision lives here so it can
// be tested without a repository, a token or a night.
//
// Anything ambiguous fails closed: an unparsable version, a version that does
// not match the last tag, or a count that cannot be trusted never releases.

export const MIN_PRS = 10
export const MIN_FEATURES = 5

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/
// "feat: x", "feat(ui): x", "feature: x", "feature(scope): x". A conventional
// `feat!:` is deliberately not matched: the rule names those two prefixes, and
// under-counting a feature is the conservative direction.
const FEATURE_TITLE = /^(?:feat|feature)(?:\([^)]*\))?:/
const REVERT_TITLE = /^(?:revert:|revert ")/i
const RELEASE_PR_TITLE = /^release:/

function titleOf(pr) {
  return typeof pr?.title === 'string' ? pr.title : ''
}

function labelsOf(pr) {
  return Array.isArray(pr?.labels) ? pr.labels : []
}

function isRevert(pr) {
  return REVERT_TITLE.test(titleOf(pr))
}

function isFeature(pr) {
  if (isRevert(pr)) return false
  return FEATURE_TITLE.test(titleOf(pr)) || labelsOf(pr).includes('enhancement')
}

function isReleasePr(pr) {
  return RELEASE_PR_TITLE.test(titleOf(pr))
}

// mergedAt is authoritative, so a PR whose timestamp cannot be read is dropped
// once a tag time is known rather than counted: fewer counted merges can only
// make a release less likely.
function windowOf(prs, lastTagCommittedAt) {
  if (lastTagCommittedAt === undefined || lastTagCommittedAt === null) return prs
  const threshold = Date.parse(lastTagCommittedAt)
  if (Number.isNaN(threshold)) return []
  return prs.filter((pr) => {
    const at = Date.parse(pr?.mergedAt)
    return !Number.isNaN(at) && at > threshold
  })
}

function crossCheckLines(apiNumbers, logPrNumbers) {
  const api = new Set(apiNumbers)
  const log = new Set(Array.isArray(logPrNumbers) ? logPrNumbers : [])
  // An empty log set means the cross-check did not run; reporting every API PR
  // as api-only on every night would be noise, not a finding.
  if (log.size === 0) return []
  const logOnly = [...log].filter((number) => !api.has(number)).sort((a, b) => a - b)
  const apiOnly = [...api].filter((number) => !log.has(number)).sort((a, b) => a - b)
  const lines = []
  if (logOnly.length > 0) lines.push(`log-only-prs=${logOnly.join(',')}`)
  if (apiOnly.length > 0) lines.push(`api-only-prs=${apiOnly.join(',')}`)
  return lines
}

/**
 * Plan one night. See scripts/release-plan.d.mts for the shapes.
 */
export function planRelease(input) {
  const {
    lastTag,
    packageVersion,
    prs,
    fragments,
    openReleasePr,
    existingTags,
    crossCheck,
    lastTagCommittedAt,
  } = input ?? {}

  const fragmentList = Array.isArray(fragments) ? fragments : []
  const tags = Array.isArray(existingTags) ? existingTags : []
  const windowed = windowOf(Array.isArray(prs) ? prs : [], lastTagCommittedAt)

  // One PR is one merge even if the API page set repeats it.
  const byNumber = new Map()
  for (const pr of windowed) {
    if (typeof pr?.number !== 'number') continue
    if (!byNumber.has(pr.number)) byNumber.set(pr.number, pr)
  }
  const apiNumbers = [...byNumber.keys()]
  const counted = [...byNumber.values()].filter((pr) => !isReleasePr(pr))
  const total = counted.length
  const features = counted.filter(isFeature).length

  const nextVersion = (() => {
    const match = VERSION.exec(typeof packageVersion === 'string' ? packageVersion : '')
    if (match === null) return ''
    const major = Number(match[1])
    const minor = Number(match[2])
    return `${major}.${minor + 1}.0`
  })()

  const tokens = []
  if (nextVersion === '') tokens.push('invalid-version')
  else if (lastTag !== `v${packageVersion}`) tokens.push('version-tag-mismatch')
  else if (tags.includes(`v${nextVersion}`)) tokens.push('tag-exists')
  else if (openReleasePr === true) tokens.push('open-release-pr')
  else if (total < MIN_PRS) tokens.push('not-enough-prs')
  else if (features < MIN_FEATURES) tokens.push('not-enough-features')
  else if (fragmentList.length === 0) tokens.push('no-fragments')
  else tokens.push('ok')

  tokens.push(...crossCheckLines(apiNumbers, crossCheck?.logPrNumbers))

  return {
    total,
    features,
    fragments: fragmentList.length,
    nextVersion,
    reason: tokens.join('; '),
    shouldRelease: tokens[0] === 'ok',
  }
}
