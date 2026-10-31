import type { Config } from '../config.js'
import { log } from '../lib/log.js'
import type { Runner, RunnerContext, RunnerResult } from './runner.js'

interface BridgePayload {
  jobId: string
  kind: 'iterate' | 'review'
  sessionId?: string
  repo: { owner: string; name: string; defaultBranch: string }
  upstream: { owner: string; name: string; defaultBranch: string; htmlUrl: string }
  fork: { owner: string; name: string; defaultBranch: string; htmlUrl: string }
  isFork: boolean
  permission: string
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
    `Fork: ${fork.owner}/${fork.name}${context.isFork ? ' (Fledge will use this fork)' : ' (same as upstream)'}.`,
    target,
    context.canCreateIssue
      ? `Create one focused issue on the upstream repository ${upstream.owner}/${upstream.name} before opening the PR (or reuse an existing related issue). The PR body must reference it with "Fixes #<number>".`
      : `The token cannot create issues on the upstream repository; if an issue is required, report a clear error in the callback instead of inventing a PR.`,
    'Create exactly one branch and one focused pull request. Never push to the upstream base branch.',
    'Write a failing test first when a test is possible. Never force-push, merge or change repository settings.',
  ]
}

function reviewInstructions(context: RunnerContext): string[] {
  const upstream = context.upstream
  return [
    `Mode: review. You are a dedicated reviewer for ${upstream.owner}/${upstream.name}. Do not modify code, push branches or open pull requests.`,
    `List all open pull requests on the upstream repository with GET /repos/${upstream.owner}/${upstream.name}/pulls?state=open&per_page=100.`,
    'For each PR, inspect the diff and tests, assess correctness, scope, test coverage, security and regressions, then give an integer score from 0 to 100 with a short rationale.',
    'Post the score and rationale as a review comment. Use event "COMMENT"; never APPROVE, never merge, never request changes as a blocking action.',
    'Review all open PRs, including PRs not created by Fledge.',
    'Finish by POSTing the callback with JSON {status, summary, reviewScore, error}; reviewScore should be the average score across reviewed PRs. Do not send branch or prUrl.',
  ]
}

export class FlyBotRunner implements Runner {
  readonly name = 'flybot'

  constructor(private readonly config: Config) {}

  async run(context: RunnerContext): Promise<RunnerResult> {
    const bridgeUrl = context.flybot?.url ?? this.config.runner.bridgeUrl
    const bridgeToken = context.flybot?.token ?? this.config.runner.bridgeToken
    if (bridgeUrl === '' || bridgeToken === '') {
      throw new Error('FlyBot bridge is not configured for this repository')
    }
    const payload: BridgePayload = {
      jobId: context.job.id,
      kind: context.kind,
      sessionId: context.flybot?.sessionId,
      repo: { owner: context.upstream.owner, name: context.upstream.name, defaultBranch: context.upstream.defaultBranch },
      upstream: context.upstream,
      fork: context.fork,
      isFork: context.isFork,
      permission: context.permission,
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
        ...(context.kind === 'review' ? reviewInstructions(context) : iterateInstructions(context)),
        `When done, POST ${context.callback.url} with JSON {status, branch, prUrl, issueUrl, reviewScore, summary, error} and "Authorization: Bearer ${context.callback.secret}".`,
        'Do not print the GitHub token or the job token. Do not force-push. Do not merge.',
      ].join('\n'),
    }
    const response = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bridgeToken}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`FlyBot bridge ${response.status}: ${text.slice(0, 300)}`)
    log.info('job handed to FlyBot bridge', { job: context.job.id, kind: context.kind, status: response.status })
    return { status: 'running' }
  }
}
