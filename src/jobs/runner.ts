import type { Config } from '../config.js'
import type { JobRow, RepoRow, UserRow } from '../db.js'
import type { Logger } from '../lib/log.js'
import type { RepoRole } from '../lib/repoRole.js'
import { FlyBotRunner } from './flybot.js'
import { MockRunner } from './mock.js'

export type JobKind = 'iterate' | 'review' | 'plan' | 'scope' | 'verify' | 'discover'

export interface JobCredential {
  url: string
  secret: string
}

export interface PlatformModel {
  baseUrl: string
  model: string
  token: string
}

export interface RepoRef {
  owner: string
  name: string
  defaultBranch: string
  htmlUrl: string
}

export interface RunnerContext {
  job: JobRow
  // #100: the job's own logger, already bound to `trace`. A runner writes its
  // lines through this one instead of the module logger, so the job id is on
  // every line of the handoff without each call site naming it.
  log: Logger
  repo: RepoRow
  user: UserRow
  kind: JobKind
  goal: string
  upstream: RepoRef
  fork: RepoRef
  isFork: boolean
  permission: string
  repoRole: RepoRole | null
  autoMerge: boolean
  canReview: boolean
  canCreateIssue: boolean
  callback: JobCredential
  credential: JobCredential
  platform: PlatformModel
  flybot?: { url: string; token: string; sessionId: string; role: 'chief' | 'lead' | 'reviewer' | 'product' | 'test'; leadName: string }
  timeoutMinutes: number
}

export interface RunnerResult {
  status: 'running' | 'succeeded' | 'failed'
  branch?: string
  prUrl?: string
  issueUrl?: string
  reviewScore?: number
  summary?: string
  error?: string
}

export interface Runner {
  readonly name: string
  run(context: RunnerContext): Promise<RunnerResult>
}

export function createRunner(config: Config): Runner {
  return config.runner.mode === 'flybot' || config.flybot.instanceImage !== '' ? new FlyBotRunner(config) : new MockRunner()
}
