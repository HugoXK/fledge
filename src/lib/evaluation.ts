// #372: the held-out shadow harness. It answers one question — how does the
// team loop do on tasks it has never seen — and nothing here runs a repository
// or holds a credential.
//
// The properties this module owns, and the tests pin:
// - one boundary: the loop arrives as a `ShadowHost` whose capabilities are
//   declared, and a host that can push, merge or read a live token is refused
//   before a single fixture runs. A run that merges is refused, not scored.
// - one score: success, review score, evidence state, cost, time and a failure
//   category per fixture and version, so two versions are compared on the same
//   tasks rather than on two different runs.
// - one interval: a success rate is a Wilson score interval and a difference
//   between versions is Newcombe's hybrid score interval, so a delta of two
//   tasks cannot be read as a difference between playbooks.
// - fail closed: no fixture set, no versions, an unredacted set or a live
//   repository is a named refusal with a readable reason, never an empty report.
import { parseVerification } from './verification.js'

export type ShadowEvidenceState = 'verified' | 'missing' | 'none'

export type ShadowFailureCategory =
  | 'none'
  | 'no-pull-request'
  | 'unexpected-pull-request'
  | 'reported-error'

export type ShadowRefusalCode =
  | 'NO_FIXTURES'
  | 'NO_VERSIONS'
  | 'UNREDACTED_FIXTURES'
  | 'LIVE_REPOSITORY'
  | 'LIVE_HOST'
  | 'UNSIGNED_HOST'
  | 'MERGE_ATTEMPTED'
  | 'MALFORMED_ATTEMPT'

/**
 * What the loop is allowed to do. Every field must be false: a shadow run
 * observes the loop, it never gets the powers that make an observation real
 * work (a push, a merge, a live repository, a user token).
 */
export interface ShadowCapabilities {
  push: boolean
  merge: boolean
  liveAccess: boolean
  tokens: boolean
}

export interface ShadowFixtureRepository {
  owner: string
  name: string
  defaultBranch: string
  /** `fixture` and `fork` are safe; `live` names a user's real repository. */
  origin: 'fixture' | 'fork' | 'live'
}

export interface ShadowFixture {
  id: string
  split: 'train' | 'holdout'
  repository: ShadowFixtureRepository
  issue: { number: number; title: string; body: string; labels: string[] }
  expected: 'pull-request' | 'refusal'
}

export interface ShadowFixtureSet {
  id: string
  /** A checked-in set is redacted by hand; an unredacted set is refused. */
  redacted: true
  note?: string
  fixtures: ShadowFixture[]
}

export interface ShadowVersion {
  id: string
  playbook?: string
  model?: string
  router?: string
}

/** What one fixture did under one version. The host produces it, the harness scores it. */
export interface ShadowAttempt {
  pullRequest: string | null
  /** Must stay false: the harness refuses a run that merged anything. */
  merged: boolean
  reviewScore: number | null
  /** The verification snapshot as stored on a job, scored through `parseVerification`. */
  verificationJson: string | null
  costUsd: number
  durationMs: number
  error?: string
}

export interface ShadowHost {
  name: string
  /** sha256 of the runner bundle the operator started; empty is refused. */
  signature: string
  capabilities: ShadowCapabilities
  run(input: { fixture: ShadowFixture; version: ShadowVersion }): ShadowAttempt | Promise<ShadowAttempt>
}

export interface ShadowTaskRecord {
  fixtureId: string
  split: 'train' | 'holdout'
  version: string
  success: boolean
  merged: boolean
  pullRequest: string | null
  reviewScore: number | null
  evidence: ShadowEvidenceState
  costUsd: number
  durationMs: number
  failure: ShadowFailureCategory
}

export interface ShadowVersionMetrics {
  version: string
  tasks: number
  successes: number
  successRate: number
  successInterval: [number, number]
  meanReviewScore: number | null
  meanCostUsd: number
  costInterval: [number, number] | null
  meanDurationMs: number
  durationInterval: [number, number] | null
  evidence: Record<ShadowEvidenceState, number>
  failures: Record<ShadowFailureCategory, number>
}

export interface ShadowSaturatedTask {
  fixtureId: string
  /** Every version that solved it, so a reader sees what "saturated" rests on. */
  solutions: string[]
}

export interface ShadowComparison {
  baseline: string
  candidate: string
  /** baseline rate minus candidate rate over the shared fixtures: positive means the baseline did better. */
  delta: number
  interval: [number, number]
  /** True only when the interval excludes zero. */
  differs: boolean
  sharedTasks: number
}

export interface ShadowReport {
  fixtureSet: string
  fixtures: { total: number; holdout: number; train: number }
  runner: { name: string; signature: string; push: false; merge: false; liveAccess: false }
  versions: ShadowVersionMetrics[]
  comparisons: ShadowComparison[]
  saturated: ShadowSaturatedTask[]
  tasks: ShadowTaskRecord[]
}

export type ShadowRefusal = { ok: false; code: ShadowRefusalCode; detail: string }

export type ShadowRunResult = { ok: true; report: ShadowReport } | ShadowRefusal

export type ShadowHostVerdict = { ok: true } | ShadowRefusal

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`MALFORMED_FIXTURES: ${where} must be a non-empty string`)
  }
  return value
}

function parseFixture(value: unknown, index: number): ShadowFixture {
  if (!isRecord(value)) throw new Error(`MALFORMED_FIXTURES: fixtures[${String(index)}] must be an object`)
  const where = `fixtures[${String(index)}]`
  const repository = value.repository
  if (!isRecord(repository)) throw new Error(`MALFORMED_FIXTURES: ${where}.repository must be an object`)
  const issue = value.issue
  if (!isRecord(issue)) throw new Error(`MALFORMED_FIXTURES: ${where}.issue must be an object`)
  const origin = repository.origin
  if (origin !== 'fixture' && origin !== 'fork' && origin !== 'live') {
    throw new Error(`MALFORMED_FIXTURES: ${where}.repository.origin must be fixture, fork or live`)
  }
  const split = value.split
  if (split !== 'train' && split !== 'holdout') {
    throw new Error(`MALFORMED_FIXTURES: ${where}.split must be train or holdout`)
  }
  const expected = value.expected
  if (expected !== 'pull-request' && expected !== 'refusal') {
    throw new Error(`MALFORMED_FIXTURES: ${where}.expected must be pull-request or refusal`)
  }
  if (typeof issue.number !== 'number' || !Number.isInteger(issue.number)) {
    throw new Error(`MALFORMED_FIXTURES: ${where}.issue.number must be an integer`)
  }
  const labels = Array.isArray(issue.labels) ? issue.labels : []
  if (!labels.every((label) => typeof label === 'string')) {
    throw new Error(`MALFORMED_FIXTURES: ${where}.issue.labels must be strings`)
  }
  return {
    id: requireString(value.id, `${where}.id`),
    split,
    repository: {
      owner: requireString(repository.owner, `${where}.repository.owner`),
      name: requireString(repository.name, `${where}.repository.name`),
      defaultBranch: requireString(repository.defaultBranch, `${where}.repository.defaultBranch`),
      origin,
    },
    issue: {
      number: issue.number,
      title: requireString(issue.title, `${where}.issue.title`),
      body: typeof issue.body === 'string' ? issue.body : '',
      labels,
    },
    expected,
  }
}

/** Read a fixture set from its checked-in text. Throws a named code, never a partial set. */
export function loadFixtureSet(text: string): ShadowFixtureSet {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`MALFORMED_FIXTURES: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) throw new Error('MALFORMED_FIXTURES: the set must be an object')
  const fixtures = parsed.fixtures
  if (!Array.isArray(fixtures)) throw new Error('MALFORMED_FIXTURES: fixtures must be an array')
  const ids = new Set<string>()
  const parsedFixtures = fixtures.map((fixture, index) => {
    const entry = parseFixture(fixture, index)
    if (ids.has(entry.id)) throw new Error(`MALFORMED_FIXTURES: duplicate fixture id ${entry.id}`)
    ids.add(entry.id)
    return entry
  })
  return {
    id: requireString(parsed.id, 'id'),
    // A set that does not say it is redacted cannot prove it is, and the harness
    // ships into a report that may be attached anywhere.
    redacted: parsed.redacted === true ? true : (() => {
      throw new Error('MALFORMED_FIXTURES: redacted must be true')
    })(),
    ...(typeof parsed.note === 'string' ? { note: parsed.note } : {}),
    fixtures: parsedFixtures,
  }
}

/** The boundary that makes an observation safe: a host may look, never act. */
export function assertShadowHost(host: ShadowHost): ShadowHostVerdict {
  if (host.name.trim() === '') return { ok: false, code: 'UNSIGNED_HOST', detail: 'the host has no name' }
  if (host.signature.trim() === '') {
    return { ok: false, code: 'UNSIGNED_HOST', detail: `host ${host.name} has no runner signature` }
  }
  const capabilities = host.capabilities
  const forbidden = (Object.keys(capabilities) as Array<keyof ShadowCapabilities>).filter((key) => capabilities[key])
  if (forbidden.length > 0) {
    return {
      ok: false,
      code: 'LIVE_HOST',
      detail: `host ${host.name} declares ${forbidden.join(', ')}; a shadow run may only observe`,
    }
  }
  return { ok: true }
}

/** Wilson score interval for a proportion; null when there is nothing to score. */
export function wilsonInterval(successes: number, total: number, z = 1.959963985): [number, number] | null {
  if (total <= 0) return null
  const p = successes / total
  const denominator = 1 + (z * z) / total
  const centre = (p + (z * z) / (2 * total)) / denominator
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

/**
 * Newcombe's hybrid score interval for the difference between two proportions
 * (method 10). It is built from the two Wilson intervals, so a small fixture set
 * produces a wide interval instead of a confident claim.
 */
export function differenceInterval(
  successesA: number,
  totalA: number,
  successesB: number,
  totalB: number,
): [number, number] | null {
  const a = wilsonInterval(successesA, totalA)
  const b = wilsonInterval(successesB, totalB)
  if (a === null || b === null) return null
  const pA = successesA / totalA
  const pB = successesB / totalB
  const delta = pA - pB
  const lower = delta - Math.sqrt((pA - a[0]) ** 2 + (b[1] - pB) ** 2)
  const upper = delta + Math.sqrt((a[1] - pA) ** 2 + (pB - b[0]) ** 2)
  return [Math.max(-1, lower), Math.min(1, upper)]
}

function meanInterval(values: number[], z = 1.959963985): [number, number] | null {
  if (values.length < 2) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  const half = z * Math.sqrt(variance / values.length)
  return [mean - half, mean + half]
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function evidenceOf(attempt: ShadowAttempt): ShadowEvidenceState {
  if (attempt.verificationJson === null) return 'none'
  const verification = parseVerification(attempt.verificationJson)
  if (verification === null) return 'missing'
  return verification.ok ? 'verified' : 'missing'
}

function score(fixture: ShadowFixture, attempt: ShadowAttempt): { success: boolean; failure: ShadowFailureCategory } {
  const opened = attempt.pullRequest !== null
  if (fixture.expected === 'refusal') {
    if (opened) return { success: false, failure: 'unexpected-pull-request' }
    return { success: true, failure: 'none' }
  }
  if (!opened) {
    return { success: false, failure: attempt.error === undefined ? 'no-pull-request' : 'reported-error' }
  }
  if (attempt.error !== undefined && attempt.error !== '') return { success: false, failure: 'reported-error' }
  return { success: true, failure: 'none' }
}

function malformedAttempt(attempt: ShadowAttempt): string | null {
  const finite = [attempt.costUsd, attempt.durationMs]
  if (!finite.every((value) => Number.isFinite(value) && value >= 0)) return 'cost and duration must be finite and non-negative'
  if (attempt.reviewScore !== null && !(Number.isFinite(attempt.reviewScore) && attempt.reviewScore >= 0)) {
    return 'reviewScore must be null or a non-negative number'
  }
  return null
}

function metricsFor(version: ShadowVersion, records: ShadowTaskRecord[]): ShadowVersionMetrics {
  const successes = records.filter((record) => record.success).length
  const costs = records.map((record) => record.costUsd)
  const durations = records.map((record) => record.durationMs)
  const reviewScores = records.flatMap((record) => (record.reviewScore === null ? [] : [record.reviewScore]))
  const evidence: Record<ShadowEvidenceState, number> = { verified: 0, missing: 0, none: 0 }
  const failures: Record<ShadowFailureCategory, number> = {
    none: 0,
    'no-pull-request': 0,
    'unexpected-pull-request': 0,
    'reported-error': 0,
  }
  for (const record of records) {
    evidence[record.evidence]++
    failures[record.failure]++
  }
  const interval = wilsonInterval(successes, records.length) ?? [0, 1]
  return {
    version: version.id,
    tasks: records.length,
    successes,
    successRate: records.length === 0 ? 0 : successes / records.length,
    successInterval: interval,
    meanReviewScore: reviewScores.length === 0 ? null : mean(reviewScores),
    meanCostUsd: mean(costs),
    costInterval: meanInterval(costs),
    meanDurationMs: mean(durations),
    durationInterval: meanInterval(durations),
    evidence,
    failures,
  }
}

/**
 * Compare two versions on the fixtures they share. Rates are computed over the
 * shared set only, so a missing run is not silently scored as a failure.
 */
export function compareVersions(
  baseline: { version: string; results: Array<{ fixtureId: string; success: boolean }> },
  candidate: { version: string; results: Array<{ fixtureId: string; success: boolean }> },
): ShadowComparison {
  const baselineById = new Map(baseline.results.map((result) => [result.fixtureId, result.success]))
  const shared = candidate.results.filter((result) => baselineById.has(result.fixtureId))
  const total = shared.length
  const baselineSuccesses = shared.filter((result) => baselineById.get(result.fixtureId) === true).length
  const candidateSuccesses = shared.filter((result) => result.success).length
  if (total === 0) {
    return { baseline: baseline.version, candidate: candidate.version, delta: 0, interval: [-1, 1], differs: false, sharedTasks: 0 }
  }
  const delta = baselineSuccesses / total - candidateSuccesses / total
  const interval = differenceInterval(baselineSuccesses, total, candidateSuccesses, total) ?? [-1, 1]
  return {
    baseline: baseline.version,
    candidate: candidate.version,
    delta,
    interval,
    differs: interval[0] > 0 || interval[1] < 0,
    sharedTasks: total,
  }
}

/**
 * Run one fixture set across every version through an observing host. Sequential
 * on purpose: two loops running at once would interleave cost and time, and the
 * harness exists to measure those.
 */
export async function runShadow(
  set: ShadowFixtureSet,
  versions: ShadowVersion[],
  host: ShadowHost,
): Promise<ShadowRunResult> {
  if (set.redacted !== true) {
    return { ok: false, code: 'UNREDACTED_FIXTURES', detail: 'the fixture set is not marked redacted; a shadow run writes a file that may be attached anywhere' }
  }
  if (set.fixtures.length === 0) {
    return { ok: false, code: 'NO_FIXTURES', detail: `fixture set ${set.id} is empty; a run with no fixtures cannot say anything about the team` }
  }
  if (versions.length === 0) {
    return { ok: false, code: 'NO_VERSIONS', detail: 'no version was given; a run needs at least one playbook, model or router to score' }
  }
  const live = set.fixtures.find((fixture) => fixture.repository.origin === 'live')
  if (live !== undefined) {
    return { ok: false, code: 'LIVE_REPOSITORY', detail: `fixture ${live.id} names a live repository; a shadow run uses a fixture or a fork` }
  }
  const hostVerdict = assertShadowHost(host)
  if (!hostVerdict.ok) return hostVerdict

  const tasks: ShadowTaskRecord[] = []
  for (const version of versions) {
    for (const fixture of set.fixtures) {
      const attempt = await host.run({ fixture, version })
      const malformed = malformedAttempt(attempt)
      if (malformed !== null) {
        return { ok: false, code: 'MALFORMED_ATTEMPT', detail: `${host.name} returned an unusable attempt for ${fixture.id} under ${version.id}: ${malformed}` }
      }
      if (attempt.merged) {
        return { ok: false, code: 'MERGE_ATTEMPTED', detail: `host ${host.name} merged work for ${fixture.id} under ${version.id}; a shadow run may not merge` }
      }
      const { success, failure } = score(fixture, attempt)
      tasks.push({
        fixtureId: fixture.id,
        split: fixture.split,
        version: version.id,
        success,
        merged: attempt.merged,
        pullRequest: attempt.pullRequest,
        reviewScore: attempt.reviewScore,
        evidence: evidenceOf(attempt),
        costUsd: attempt.costUsd,
        durationMs: attempt.durationMs,
        failure,
      })
    }
  }

  const metrics = versions.map((version) => metricsFor(version, tasks.filter((task) => task.version === version.id)))
  const comparisons: ShadowComparison[] = []
  const [firstVersion] = versions
  if (firstVersion !== undefined) {
    for (const version of versions.slice(1)) {
      comparisons.push(
        compareVersions(
          { version: firstVersion.id, results: tasks.filter((task) => task.version === firstVersion.id) },
          { version: version.id, results: tasks.filter((task) => task.version === version.id) },
        ),
      )
    }
  }
  const saturated: ShadowSaturatedTask[] = set.fixtures
    .map((fixture) => ({
      fixtureId: fixture.id,
      solutions: versions.filter((version) => tasks.some((task) => task.fixtureId === fixture.id && task.version === version.id && task.success)).map((version) => version.id),
    }))
    // Two versions are the minimum that can rank anything; one solution is not a
    // saturated task, it is the only result a run has.
    .filter((entry) => versions.length >= 2 && entry.solutions.length === versions.length)

  return {
    ok: true,
    report: {
      fixtureSet: set.id,
      fixtures: {
        total: set.fixtures.length,
        holdout: set.fixtures.filter((fixture) => fixture.split === 'holdout').length,
        train: set.fixtures.filter((fixture) => fixture.split === 'train').length,
      },
      runner: { name: host.name, signature: host.signature, push: false, merge: false, liveAccess: false },
      versions: metrics,
      comparisons,
      saturated,
      tasks,
    },
  }
}

/** The artifact a human reads. JSON so the AgentDescent exporter can consume it. */
export function renderShadowReport(report: ShadowReport): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/** One line per version for a job summary or a terminal. */
export function shadowSummaryLines(report: ShadowReport): string[] {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`
  const lines = report.versions.map(
    (metrics) =>
      `shadow: ${metrics.version} ${String(metrics.successes)}/${String(metrics.tasks)} (${percent(metrics.successRate)}, 95% ${percent(metrics.successInterval[0])}–${percent(metrics.successInterval[1])}) cost $${metrics.meanCostUsd.toFixed(2)}`,
  )
  for (const comparison of report.comparisons) {
    const verdict = comparison.differs ? 'differs' : 'not distinguishable'
    lines.push(
      `shadow: ${comparison.baseline} − ${comparison.candidate} ${(comparison.delta * 100).toFixed(1)}pp, 95% ${(comparison.interval[0] * 100).toFixed(1)}–${(comparison.interval[1] * 100).toFixed(1)} (${verdict} over ${String(comparison.sharedTasks)} shared tasks)`,
    )
  }
  if (report.saturated.length > 0) {
    lines.push(`shadow: saturated ${report.saturated.map((entry) => entry.fixtureId).join(', ')}`)
  }
  return lines
}
