import type { Config } from '../config.js'
import type { JobRow, RepoRow, UserRow } from '../db.js'
import { FlyBotRunner } from './flybot.js'
import { MockRunner } from './mock.js'

export type JobKind = 'iterate' | 'review'

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
  repo: RepoRow
  user: UserRow
  kind: JobKind
  goal: string
  upstream: RepoRef
  fork: RepoRef
  isFork: boolean
  permission: string
  canReview: boolean
  canCreateIssue: boolean
  callback: JobCredential
  credential: JobCredential
  platform: PlatformModel
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
  return config.runner.mode === 'flybot' ? new FlyBotRunner(config) : new MockRunner()
}
