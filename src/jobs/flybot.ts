import type { Config } from '../config.js'
import { log } from '../lib/log.js'
import { incCounter, observeHistogram } from '../lib/metrics.js'
import { endSpan, startSpan } from '../lib/otel.js'
import type { Runner, RunnerContext, RunnerResult } from './runner.js'

interface BridgePayload {
  jobId: string
  kind: 'iterate' | 'review' | 'plan' | 'scope' | 'verify'
  branch?: string
  prUrl?: string
  sessionId?: string
  dispatchRole?: 'chief' | 'lead' | 'reviewer' | 'product' | 'test'
  leadName?: string
  repo: { owner: string; name: string; defaultBranch: string }
  upstream: { owner: string; name: string; defaultBranch: string; htmlUrl: string }
  fork: { owner: string; name: string; defaultBranch: string; htmlUrl: string }
  isFork: boolean
  permission: string
  repoRole: 'maintainer' | 'developer' | null
  autoMerge: boolean
  canReview: boolean
  canCreateIssue: boolean
  goal: string
  callbackUrl: string
  callbackSecret: string
  credentialUrl: string
  credentialSecret: string
  platform: { baseUrl: string; model: string; token: string }
  timeoutMinutes: number
  instructions: string
}

function iterateInstructions(context: RunnerContext): string[] {
  const upstream = context.upstream
  const fork = context.fork
  const target = context.isFork
    ? `Push your branch to the fork ${fork.owner}/${fork.name} and open the pull request against ${upstream.owner}/${upstream.name} with base "${upstream.defaultBranch}" and head "${fork.owner}:<branch>".`
    : `This is the user's own repository. Push your branch to ${upstream.owner}/${upstream.name} and open the pull request with base "${upstream.defaultBranch}".`
  return [
    `Mode: iterate. Repository: ${upstream.owner}/${upstream.name} (base ${upstream.defaultBranch}).`,
    `Before doing any work, read the latest upstream branch ${upstream.defaultBranch} and the open issues/PRs. If the defect is already fixed or an open PR already covers it, do not duplicate it: report the existing link and finish successfully without creating a branch or PR.`,
    context.isFork ? `If the fork ${fork.owner}/${fork.name} is behind upstream, sync the fork target branch from upstream before creating the working branch. Never open a PR from a stale fork.` : 'Work from the latest upstream target branch; do not start from a stale local branch.',
    `Fork: ${fork.owner}/${fork.name}${context.isFork ? ' (Fledge will use this fork)' : ' (same as upstream)'}.`,
    target,
    context.canCreateIssue
      ? `Create one focused issue on the upstream repository ${upstream.owner}/${upstream.name} before opening the PR (or reuse an existing related issue). The PR body must reference it with "Fixes #<number>".`
      : `The token cannot create issues on the upstream repository; if an issue is required, report a clear error in the callback instead of inventing a PR.`,
    ...(context.job.pr_url === null || context.job.pr_url === ''
      ? ['Create exactly one branch and one focused pull request. Never push to the upstream base branch.']
      : [
          `This is a follow-up on the existing pull request ${context.job.pr_url} and branch ${context.job.branch ?? ''}.`,
          'Push to the same branch and update that PR. Do not open a second PR and do not create a new issue.',
        ]),
    'Team participation is mandatory: Product scopes the issue, Test writes/verifies the failing test, Dev-1 or Dev-2 implements, Security reviews material risk, and Reviewer reviews the PR. Do not let the Lead implement the whole change alone; if a role is unavailable, say so in the callback.',
    'Write a failing test first when a test is possible. Never force-push or change repository settings.',
    'Never merge. Fledge performs the maintainer-enabled auto-merge only after independently checking the PR checks and reviews.',
  ]
}

function planInstructions(context: RunnerContext): string[] {
  const upstream = context.upstream
  return [
    `Mode: plan. Repository: ${upstream.owner}/${upstream.name}. Do not write code, create a branch, push, open a PR/issue or change settings.`,
    'Inspect the repository, README, docs, existing issues/PRs and tests. Produce one concrete plan for the next change.',
    'The plan must include: problem/evidence, files to touch, ordered steps, tests to add/run, acceptance criteria, risks, rollback and expected size.',
    'Finish by POSTing the callback with status succeeded and the plan in summary; no branch, prUrl or issueUrl.',
  ]
}

function scopeInstructions(context: RunnerContext): string[] {
  const upstream = context.upstream
  return [
    `Mode: scope. You are the Product role for ${upstream.owner}/${upstream.name}. Do not write code, create a branch, push, open a PR/issue or change settings.`,
    'Read the issue, repository docs, open issues/PRs and tests. Produce a scope with non-goals, acceptance criteria and a test plan.',
    'Finish with status succeeded and evidence.scope, evidence.acceptance and evidence.testPlan in the callback; do not send branch, prUrl or issueUrl.',
  ]
}

function verifyInstructions(context: RunnerContext): string[] {
  const upstream = context.upstream
  return [
    `Mode: verify. You are the Test role for ${upstream.owner}/${upstream.name}. Do not write code, push, open a PR or merge.`,
    'Read the existing PR/branch and run the relevant tests. Report the failing test evidence and the passing evidence after the fix, plus CI/check status.',
    'Finish with status succeeded and evidence.testRed, evidence.testGreen, evidence.tests and evidence.checks in the callback; do not send branch, prUrl or issueUrl.',
  ]
}

function reviewInstructions(context: RunnerContext): string[] {
  const upstream = context.upstream
  return [
    `Mode: review. You are a dedicated reviewer for ${upstream.owner}/${upstream.name}. Do not modify code, push branches or open pull requests.`,
    `List all open pull requests on the upstream repository with GET /repos/${upstream.owner}/${upstream.name}/pulls?state=open&per_page=100.`,
    'For each PR, inspect the diff and tests, assess correctness, scope, test coverage, security and regressions, then give an integer score from 0 to 100 with a short rationale.',
    'Post a COMMENT review with concrete findings. For every Fledge pull request that needs changes, return a followUps entry with the PR URL, branch, head SHA and reason so Fledge can schedule a same-branch fix. Never REQUEST_CHANGES, APPROVE, merge or push.',
    'Review all open PRs, including PRs not created by Fledge.',
    'Finish by POSTing the callback with JSON {status, summary, reviewScore, error, followUps}; reviewScore is the average across reviewed PRs. For each Fledge PR that needs changes, include followUps: [{prUrl, branch, headSha, baseBranch, reason:"review requested changes"}] so Fledge queues a same-branch fix after this review. Do not send branch or prUrl for the review itself.',
  ]
}

// #163: when the dispatch itself fails, the bridge is the component that did not
// answer, and the classifier can only read the string stored on the job. Name
// the target here and keep the transport cause inside the message (#55: the
// original error is never hidden or rewritten). The path and the host are enough
// to identify the target: the bridge URL can carry a token in its query or its
// userinfo, and this message is stored on the job and rendered on the job page.
function bridgeEndpoint(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return 'the configured bridge'
  }
}

// A bridge failure body is JSON (`{error, detail}`) since #260 and was a plain
// string before. Both shapes have to reach `jobs.error` unchanged, because the
// classifier reads that text and the job page shows it.
function bridgeFailureText(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown }
    const parts = [parsed.error, parsed.detail].filter((part): part is string => typeof part === 'string' && part !== '')
    if (parts.length > 0) return parts.join(': ')
  } catch {}
  return text
}

export class FlyBotRunner implements Runner {
  readonly name = 'flybot'

  constructor(private readonly config: Config) {}

  async run(context: RunnerContext): Promise<RunnerResult> {
    const span = startSpan('bridge.dispatch', { kind: context.kind, job: context.job.id })
    const startedAt = Date.now()
    const bridgeUrl = context.flybot?.url ?? this.config.runner.bridgeUrl
    const bridgeToken = context.flybot?.token ?? this.config.runner.bridgeToken
    if (bridgeUrl === '' || bridgeToken === '') {
      throw new Error('FlyBot bridge is not configured for this repository')
    }
    const payload: BridgePayload = {
      jobId: context.job.id,
      kind: context.kind,
      branch: context.job.branch ?? undefined,
      prUrl: context.job.pr_url ?? undefined,
      sessionId: context.flybot?.sessionId,
      dispatchRole: context.flybot?.role,
      leadName: context.flybot?.leadName,
      repo: { owner: context.upstream.owner, name: context.upstream.name, defaultBranch: context.upstream.defaultBranch },
      upstream: context.upstream,
      fork: context.fork,
      isFork: context.isFork,
      permission: context.permission,
      repoRole: context.repoRole,
      autoMerge: context.autoMerge,
      canReview: context.canReview,
      canCreateIssue: context.canCreateIssue,
      goal: context.goal,
      callbackUrl: context.callback.url,
      callbackSecret: context.callback.secret,
      credentialUrl: context.credential.url,
      credentialSecret: context.credential.secret,
      platform: context.platform,
      timeoutMinutes: context.timeoutMinutes,
      instructions: [
        'You are the Fledge repository worker.',
        `Get the GitHub token with GET ${context.credential.url} and header "Authorization: Bearer ${context.credential.secret}".`,
        `Use the platform model at ${context.platform.baseUrl} with the job token as the API key; the model is ${context.platform.model}.`,
        ...(context.kind === 'review' ? reviewInstructions(context) : context.kind === 'plan' ? planInstructions(context) : context.kind === 'scope' ? scopeInstructions(context) : context.kind === 'verify' ? verifyInstructions(context) : iterateInstructions(context)),
        `Send a progress heartbeat after each major step and at least every 10 minutes: POST ${context.callback.url} with JSON {"status":"running","summary":"<one line progress>","checkpoint":"<done + next>"} and "Authorization: Bearer ${context.callback.secret}".`,
        'GitHub attribution: end every issue, PR and comment you create with one small line: "<sub>Fledge · <team> · <role> · <step></sub>" where step is claimed, implemented, tested or reviewed. Never claim a role that did not do the work.',
        'Final callback: include "attribution": {"writtenBy":"...","claimedBy":"...","implementedBy":"...","testedBy":"...","reviewedBy":"..."} with role names only (Lead, Product, Test, Security, Reviewer, Dev-1, Dev-2). Omit a key for a step that did not happen; never write "not run", "pending" or "(Team)".',
        'Also include "evidence": {"scope":"<scope>","acceptance":"<acceptance>","testPlan":"<test plan>","testRed":"<failing test>","testGreen":"<passing test>","tests":"<command and pass/fail>","checks":"<CI/check status>","files":<changed files>,"risk":"low|medium|high","rollback":"<one line>"}; use only what you actually ran.',
        `The job is failed after ${context.timeoutMinutes} minutes without a final callback; finish one focused change before then or report the concrete blocker.`,
        `When done, POST ${context.callback.url} with JSON {status, branch, prUrl, issueUrl, reviewScore, summary, error} and "Authorization: Bearer ${context.callback.secret}".`,
        'Do not print the GitHub token or the job token. Do not force-push. Do not merge; Fledge handles maintainer-enabled auto-merge.',
      ].join('\n'),
    }
    let response: Response
    try {
      response = await fetch(bridgeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bridgeToken}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      incCounter('fledge_bridge_requests_total', { status: 0 }, 1, 'FlyBot bridge requests')
      const cause = error instanceof Error ? error.message : String(error)
      endSpan(span, 'ERROR', cause, { status: 0 })
      // #163: a bridge that is down (reboot, container restart, wrong port or
      // host) used to reach the job as a bare transport error, so the page said
      // "unknown — retry once" and the metrics counted an outage as a defect.
      const endpoint = bridgeEndpoint(bridgeUrl)
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`FlyBot bridge timed out after 20s: ${cause}`)
      }
      throw new Error(`FlyBot bridge unreachable (${endpoint}): ${cause}`)
    }
    const text = await response.text()
    incCounter('fledge_bridge_requests_total', { status: response.status }, 1, 'FlyBot bridge requests')
    observeHistogram('fledge_bridge_request_seconds', (Date.now() - startedAt) / 1000, { kind: context.kind }, 'Bridge request duration')
    if (!response.ok) {
      endSpan(span, 'ERROR', `bridge ${response.status}`, { status: response.status })
      // #260: the bridge now answers a refused send with `{error, detail}` where
      // `detail` is the DSH refusal (a provider budget or rate-limit answer).
      // Keep that text: it is the only provider signal Fledge ever receives.
      throw new Error(`FlyBot bridge ${response.status}: ${bridgeFailureText(text).slice(0, 400)}`)
    }
    endSpan(span, 'OK', undefined, { status: response.status })
    log.info('job handed to FlyBot bridge', { job: context.job.id, kind: context.kind, status: response.status })
    return { status: 'running' }
  }
}
