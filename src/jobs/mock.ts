import { log } from '../lib/log.js'
import type { Runner, RunnerContext, RunnerResult } from './runner.js'

export class MockRunner implements Runner {
  readonly name = 'mock'

  async run(context: RunnerContext): Promise<RunnerResult> {
    log.info('mock runner started', { job: context.job.id, repo: `${context.repo.owner}/${context.repo.name}` })
    await new Promise((resolve) => setTimeout(resolve, 250))
    return {
      status: 'succeeded',
      branch: `fledge/mock-${context.job.id.slice(-6)}`,
      prUrl: `https://github.com/${context.repo.owner}/${context.repo.name}/pull/0`,
      summary: 'Mock run: no code was changed. Set RUNNER_MODE=flybot to use the real FlyBot bridge.',
    }
  }
}
