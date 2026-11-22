// #372: the bundled observing host for a shadow run. It drives the same
// MockRunner a development instance uses, over a fixture's own repository and
// issue, and it carries nothing a real run would need: no token, no bridge, no
// store. The mock calls out to nothing, so a shadow run through it cannot touch
// a user repository even by accident.
import { createHash } from 'node:crypto'
import type { ShadowAttempt, ShadowFixture, ShadowHost, ShadowVersion } from '../lib/evaluation.js'
import type { Logger } from '../lib/log.js'
import { MockRunner } from './mock.js'
import type { RunnerContext } from './runner.js'

// The runner bundle is this one class, so its source text is what a signature can
// hash without reading a file: the built tree ships no `.ts` to read (#372).
const MOCK_RUNNER_SIGNATURE = `sha256:${createHash('sha256').update(String(MockRunner)).digest('hex')}`

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  with: () => silent,
}

/**
 * A `RunnerContext` with only the fields the mock reads: the job id, the repo and
 * upstream names, the kind and the log. The rest is present but empty on purpose
 * — a runner that expected a credential would fail loudly here instead of
 * inheriting one from a real job.
 */
function contextFor(fixture: ShadowFixture, version: ShadowVersion): RunnerContext {
  const repository = { owner: fixture.repository.owner, name: fixture.repository.name, defaultBranch: fixture.repository.defaultBranch, htmlUrl: '' }
  return {
    job: { id: `shadow-${version.id}-${fixture.id}` },
    log: silent,
    repo: repository,
    user: {},
    kind: 'iterate',
    goal: fixture.issue.body,
    upstream: repository,
    fork: repository,
    isFork: false,
    permission: 'read',
    repoRole: null,
    autoMerge: false,
    canReview: false,
    canCreateIssue: false,
    callback: { url: '', secret: '' },
    credential: { url: '', secret: '' },
    platform: { baseUrl: '', model: '', token: '' },
    timeoutMinutes: 1,
  } as unknown as RunnerContext
}

/**
 * What the recorder observed of an attempt's verification. The mock calls out to
 * nothing, so an attempt that opened a pull request ran and observed zero check
 * runs; in the report's vocabulary that is `missing` — "recorded, not verified" —
 * and publishing it stops the column reading `none`, "nothing was recorded". An
 * attempt that opened nothing has nothing to verify, so no snapshot is published
 * and the attempt stays `none`.
 *
 * The snapshot carries only what the recorder saw: `parseVerification` needs one
 * boolean, and the reason line is the recorder's own. Filling `sha`, `prState`,
 * `mergeableState`, `combinedStatus` or `reviews` would invent a pull-request
 * read, which is the mistake this recorder exists to avoid.
 */
export function observedVerification(pullRequest: string | null): string | null {
  if (pullRequest === null) return null
  return JSON.stringify({
    ok: false,
    reasons: ['shadow recorder: the bundled mock opened a pull request and observed no check runs'],
  })
}

/**
 * The reference host. It records what the loop did as an attempt the harness can
 * score; it declares no power, and `merged` is false because the mock has no
 * merge call at all.
 */
export function createMockShadowHost(): ShadowHost {
  const runner = new MockRunner()
  return {
    name: 'mock',
    signature: MOCK_RUNNER_SIGNATURE,
    capabilities: { push: false, merge: false, liveAccess: false, tokens: false },
    async run({ fixture, version }) {
      const started = performance.now()
      const result = await runner.run(contextFor(fixture, version))
      const pullRequest = result.prUrl ?? null
      const attempt: ShadowAttempt = {
        pullRequest,
        merged: false,
        reviewScore: result.reviewScore ?? null,
        verificationJson: observedVerification(pullRequest),
        costUsd: 0,
        durationMs: Math.round(performance.now() - started),
      }
      if (result.status !== 'succeeded') {
        attempt.error = result.error ?? result.summary ?? `runner finished ${result.status}`
      }
      return attempt
    },
  }
}
