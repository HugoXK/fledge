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
      const attempt: ShadowAttempt = {
        pullRequest: result.prUrl ?? null,
        merged: false,
        reviewScore: result.reviewScore ?? null,
        verificationJson: null,
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
