import { PLAYBOOK_VERSION, playbookFingerprint } from '../flybot/playbook.js'
import { sha256Hex } from '../lib/secrets.js'
import { assembleStrategy, ruleSectionKey, type AssembleResult } from './bundle.js'

// #433 slice 1: where a repository's strategy sections come from today. Every
// value is a reference, never a copy: a rule override is its console revision, the
// playbook is its version plus the fingerprint of the goal it was built from, and
// the goal guidance is the hash of the goal text. A path under a frozen family
// keeps its family as the section key, so it is refused by the same check the
// bundle runs rather than by a second list here.
export interface StrategySourceStore {
  listRepoRuleOverrides(repoId: string): Array<{ path: string; revision: number }>
}

export interface StrategySourceRepo {
  id: string
  goal: string
}

export function currentStrategySections(store: StrategySourceStore, repo: StrategySourceRepo): AssembleResult {
  const goal = repo.goal ?? ''
  const sections: Record<string, string> = {
    'goal:guidance': `console:goal:${sha256Hex(goal)}`,
    'playbook:team': `playbook:v${PLAYBOOK_VERSION}:${playbookFingerprint(goal)}`,
  }
  for (const override of store.listRepoRuleOverrides(repo.id)) {
    sections[ruleSectionKey(override.path)] = `console:revision:${override.revision}`
  }
  return assembleStrategy({ sections })
}
