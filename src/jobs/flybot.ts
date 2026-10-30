import type { Config } from '../config.js'
import { log } from '../lib/log.js'
import type { Runner, RunnerContext, RunnerResult } from './runner.js'

interface BridgePayload {
  jobId: string
  repo: { owner: string; name: string; defaultBranch: string }
  goal: string
  callbackUrl: string
  callbackSecret: string
  credentialUrl: string
  credentialSecret: string
  platform: { baseUrl: string; model: string; token: string }
  timeoutMinutes: number
  instructions: string
}

export class FlyBotRunner implements Runner {
  readonly name = 'flybot'

  constructor(private readonly config: Config) {}

  async run(context: RunnerContext): Promise<RunnerResult> {
    if (this.config.runner.bridgeUrl === '' || this.config.runner.bridgeToken === '') {
      throw new Error('FLYBOT_BRIDGE_URL / FLYBOT_BRIDGE_TOKEN are not configured')
    }
    const payload: BridgePayload = {
      jobId: context.job.id,
      repo: { owner: context.repo.owner, name: context.repo.name, defaultBranch: context.repo.default_branch },
      goal: context.goal,
      callbackUrl: context.callback.url,
      callbackSecret: context.callback.secret,
      credentialUrl: context.credential.url,
      credentialSecret: context.credential.secret,
      platform: context.platform,
      timeoutMinutes: context.timeoutMinutes,
      instructions: [
        'You are the Fledge repository iterator.',
        `Repository: ${context.repo.owner}/${context.repo.name} (base ${context.repo.default_branch}).`,
        `Goal: ${context.goal}`,
        `Get the GitHub token with GET ${context.credential.url} and header "Authorization: Bearer ${context.credential.secret}".`,
        `Use the platform model at ${context.platform.baseUrl} with the job token as the API key; the model is ${context.platform.model}.`,
        'Create a branch, make the smallest correct change with a test, open a pull request, and never push to the base branch.',
        `When done, POST ${context.callback.url} with JSON {status, branch, prUrl, summary, error} and "Authorization: Bearer ${context.callback.secret}".`,
        'Do not print the GitHub token or the job token. Do not force-push. Do not merge.',
      ].join('\n'),
    }
    const response = await fetch(this.config.runner.bridgeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.runner.bridgeToken}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`FlyBot bridge ${response.status}: ${text.slice(0, 300)}`)
    log.info('job handed to FlyBot bridge', { job: context.job.id, status: response.status })
    return { status: 'running' }
  }
}
