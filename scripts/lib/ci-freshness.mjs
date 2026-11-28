// #1338: a green may not be counted when it was produced before the gate that
// would have failed it. The base's gate inputs move on, the head's check run does
// not, and nothing in the merge path asked how old the green was.
//
// The comparison is one pure function so the push-to-main sweep and its test
// share exactly one rule. It is fail-closed in every direction: no `started_at`,
// an unreadable base, an unresolvable commit — each refuses with its own line
// instead of assuming fresh.

const SHA = /^[0-9a-f]{40}$/

/** Files whose last change on the base defines when the gate changed. Order is
 * priority: the file named in the refusal is the first of these that the gate
 * commit touched, so the recorded 11-24 commit names the ratchet's test. */
export const GATE_PATHS = [
  'test/archBoundaries.test.ts',
  'scripts/lib/arch-boundaries.mjs',
  'scripts/ci-ok.mjs',
  '.github/workflows/ci.yml',
  '.github/workflows/ci-ok-publish.yml',
  '.github/workflows/ci-ok-refresh.yml',
  '.github/agent/risk-rules.json',
  '.github/agent/review-policy.json',
  'scripts/lib/gate-compare.mjs',
]

function instantOf(value) {
  if (typeof value !== 'string' || value === '') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isoOf(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * The refusal line for a check that started before the base's gate change, or
 * null when the check is fresh. The line carries all three facts a reader needs:
 * the check name and start, the base commit, and when it changed a gate file.
 */
export function freshnessRefusal({ checkName = 'ci-ok', startedAt, base } = {}) {
  const started = instantOf(startedAt)
  if (started === null) return `freshness: ${checkName} has no started_at, so freshness cannot be proven; refusing`
  if (base === null || base === undefined) return 'freshness: the base gate change cannot be resolved; refusing'
  if (typeof base !== 'object') return 'freshness: the base gate change cannot be resolved; refusing'
  if (typeof base.error === 'string') return `freshness: the base gate change cannot be read (${base.error}); refusing`
  const at = instantOf(base.at)
  if (at === null || typeof base.commit !== 'string' || !SHA.test(base.commit)) {
    return 'freshness: the base gate change cannot be resolved; refusing'
  }
  if (started >= at) return null
  const path = typeof base.path === 'string' && base.path !== '' ? base.path : 'a gate file'
  return `freshness: ${checkName} started ${isoOf(started)}, before ${base.commit.slice(0, 8)} added ${path} on ${isoOf(at)}`
}

/**
 * Parse `git log -1 --format='%H%n%cI%n%s' --name-only -- <gate paths>` into the
 * commit, its committer instant and the first gate path it touched (by
 * `GATE_PATHS` priority). Returns null when the output does not resolve.
 */
export function parseGateChange(log) {
  const lines = String(log ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length < 2) return null
  const [commit, at] = lines
  if (!SHA.test(commit) || instantOf(at) === null) return null
  const path = GATE_PATHS.find((candidate) => lines.includes(candidate))
  if (path === undefined) return null
  return { commit, at, path }
}

/**
 * The check-run body the sweep publishes at the unchanged head. It is a `ci-ok`
 * verdict (policy line included) so the required context turns red on the old
 * green; no new required id is introduced.
 */
export function freshnessPayload({ headSha, policy, refusal }) {
  return {
    name: 'ci-ok',
    head_sha: headSha,
    status: 'completed',
    conclusion: 'failure',
    output: {
      title: 'the check run predates the base gate change',
      summary: [
        policy.text,
        '',
        refusal,
        '',
        'reason: stale-freshness',
        `head: ${headSha}`,
        'Published by the push-to-main sweep (#1338); a new push or a close/reopen clears it, not an empty commit.',
      ].join('\n'),
    },
  }
}
