import type { Config } from '../config.js'
import type { JobRow, RepoRow, UserRow } from '../db.js'
import { FlyBotRunner } from './flybot.js'
import { MockRunner } from './mock.js'

export interface JobCredential {
  url: string
  secret: string
}

export interface PlatformModel {
  baseUrl: string
  model: string
  token: string
}

export interface RunnerContext {
  job: JobRow
  repo: RepoRow
  user: UserRow
  goal: string
  callback: JobCredential
  credential: JobCredential
  platform: PlatformModel
  timeoutMinutes: number
}

export interface RunnerResult {
  status: 'running' | 'succeeded' | 'failed'
  branch?: string
  prUrl?: string
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
