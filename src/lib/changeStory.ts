// #373 slice 1: a job page is where a maintainer decides, and until now it
// showed what the checks proved but not what the agent said it changed, what it
// thought could go wrong, and what it actually ran — the three sections every
// PR body in this repository already carries. This module is the read model:
// it parses the body the agent wrote and adds the diff totals. Pure, no model
// call, no network.

import { attributionGroundFor, claimedRoleState, parseAttributionJson } from './attribution.js'
import type { AttributionGroundState } from './attribution.js'
import { parseModelRun } from './modelRun.js'

// #793: the body also carries what was considered instead, what remains
// uncertain, and the explicit list of what was not run. Those are the other
// half of the decision, so they are facts of the same block rather than a
// summary of a summary.
export const CHANGE_STORY_KEYS = [
  'whatChanged',
  'risks',
  'ran',
  'alternatives',
  'uncertainty',
  'notVerified',
] as const

export type ChangeStoryKey = (typeof CHANGE_STORY_KEYS)[number]

// `diff` is the caller's sum; `attribution` comes from the job row, not from
// the body, because the body cannot know which model answered.
export type ChangeStoryFactKey = ChangeStoryKey | 'diff' | 'attribution'

export interface DiffTotals {
  files: number
  additions: number
  deletions: number
}

export interface ChangeStorySection {
  key: ChangeStoryKey
  // `null` means the body does not carry that heading. It is never filled from
  // another section: the block says "not stated" instead of guessing.
  text: string | null
  // The heading appeared more than once; the last occurrence is the text above.
  duplicated: boolean
}

// #793: which model answered and which role wrote the change, read from the job
// row. `null` for a half means the row does not record it; it is never inferred
// from the other half or from the body.
//
// #1190: `state` is how the ground record judges that claimed role, or null when
// the role is not claimed (an observation-only seat cannot be a false claim) or
// when the record says the claim was observed. The row's note uses it; the value
// never changes, because the model half is not what the claim is about.
export interface ChangeStoryAttribution {
  model: string | null
  role: string | null
  // Optional so a caller that has no record yet (an older fixture, a unit test of
  // the pair alone) states "no judgement" rather than inventing `grounded`.
  state?: AttributionGroundState | null
}

export type ChangeStoryDiffState = 'ok' | 'capped' | 'unreadable'

export interface ChangeStory {
  // `unreadable` means GitHub could not be read at all (404, no token, a failed
  // request): every body fact is then unavailable rather than "not stated".
  bodyState: 'ok' | 'unreadable'
  sections: ChangeStorySection[]
  totals: DiffTotals | null
  diffState: ChangeStoryDiffState
  // Recorded on the job, so it survives a pull request that could not be read.
  attribution: ChangeStoryAttribution | null
}

// Labels are the caller's: the parser is language-free and the page passes the
// reader's language in.
export interface ChangeStoryLabels {
  notStated?: string
  unavailable?: string
  capped?: string
  duplicate?: string
  files?: (count: number) => string
  // #1190: the two marker words #1186 renders on the job page's team line. The
  // change-story row uses the same vocabulary rather than inventing a second one.
  claimedNotObserved?: string
  claimedNotVerified?: string
}

export interface ChangeStoryFact {
  key: ChangeStoryFactKey
  value: string
  // A second sentence the page shows under the value; empty when there is none.
  note: string
}

const HEADINGS: Record<string, ChangeStoryKey> = {
  'what changed': 'whatChanged',
  risks: 'risks',
  risk: 'risks',
  ran: 'ran',
  'alternatives considered': 'alternatives',
  alternatives: 'alternatives',
  'other options considered': 'alternatives',
  uncertainty: 'uncertainty',
  'residual risk': 'uncertainty',
  'uncertainty and residual risk': 'uncertainty',
  'uncertainty/residual risk': 'uncertainty',
  'not run': 'notVerified',
  'not verified': 'notVerified',
}

// `## Risks`, `### Ran`, `# What changed`. The level does not matter: any heading
// the body carries is a boundary, and the ones that name a fact start one.
function headingKey(line: string): ChangeStoryKey | null {
  const heading = /^#{1,6}\s+(.*)$/.exec(line.trim())
  if (heading === null) return null
  const text = (heading[1] ?? '').replace(/[:\s]+$/, '').toLowerCase()
  return HEADINGS[text] ?? null
}

// A `Not run` line is the list of what the agent did not verify. Slice 1
// treated it only as the end of `Ran`; #793 reads it as a fact of its own, so
// the text under it is captured instead of thrown away. Returns the text the
// line carries after the colon — `Not run: Docker image` is one line and means
// what AGENTS.md's template says — and `''` for the bare form that starts a
// list, so both shapes produce the fact.
function notRunLine(line: string): string | null {
  const match = /^not\s+run\s*(?:[:：]\s*(.*))?$/i.exec(line.trim())
  if (match === null) return null
  return (match[1] ?? '').trim()
}

// The house PR template uses a bare `Ran:` line rather than a heading, so the
// block reads this repository's own pull requests and not only PRs that adopted
// heading style. `scripts/lib/pr-body.mjs` also accepts a qualified line —
// `Ran (author, at tree 1234abc):` — and that shape starts the fact too; matching
// only the bare form dropped its commands, and after a fact heading it appended
// them to that fact instead.
function isRanLine(line: string): boolean {
  return /^ran\b(?:\s*[^:：\n]*[:：])?\s*$/i.test(line.trim())
}

function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line)
}

// A bare `Not run:` line starts a fact instead of ending one, so only a heading
// closes the section that precedes it.
function endsSection(line: string): boolean {
  return /^#{1,6}\s+/.test(line.trim())
}

// A fenced block may hold `#` comments; they are text, not headings.
export function parseChangeStoryBody(body: string): ChangeStorySection[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const found = new Map<ChangeStoryKey, { text: string | null; seen: number }>()
  let current: ChangeStoryKey | null = null
  let buffer: string[] = []
  let fenced = false
  const flush = (): void => {
    if (current === null) return
    const text = buffer.join('\n').trim()
    const prior = found.get(current)
    found.set(current, { text: text === '' ? null : text, seen: (prior?.seen ?? 0) + 1 })
    buffer = []
  }
  for (const line of lines) {
    if (isFence(line)) {
      fenced = !fenced
      if (current !== null) buffer.push(line)
      continue
    }
    if (!fenced) {
      const key = headingKey(line)
      if (key !== null) {
        flush()
        current = key
        continue
      }
      if (isRanLine(line)) {
        flush()
        current = 'ran'
        continue
      }
      const inlineNotRun = notRunLine(line)
      if (inlineNotRun !== null) {
        flush()
        current = 'notVerified'
        // The single-line form carries its text on the line itself; the bare
        // form leaves the buffer for the list that follows.
        if (inlineNotRun !== '') buffer.push(inlineNotRun)
        continue
      }
      if (endsSection(line)) {
        flush()
        current = null
        continue
      }
    }
    if (current !== null) buffer.push(line)
  }
  flush()
  return CHANGE_STORY_KEYS.map((key) => {
    const entry = found.get(key)
    return { key, text: entry?.text ?? null, duplicated: (entry?.seen ?? 0) > 1 }
  })
}

// #793: the model that answered and the role that wrote the change, from the
// job row. `model_json` wins for the model because it is written by the call
// that got the answer, and `writtenBy` wins for the role; when the two disagree
// the block states the recorded pair, never a guess.
export function changeStoryAttribution(input: {
  modelJson: string | null
  attributionJson: string | null
  groundJson?: string | null
  teamStatsJson?: string | null
}): ChangeStoryAttribution | null {
  const model = parseModelRun(input.modelJson)?.model?.label ?? null
  const attribution = parseAttributionJson(input.attributionJson)
  const role = attribution?.writtenBy ?? attribution?.implementedBy ?? null
  if (model === null && role === null) return null
  // #1190: the record, not the page, decides whether the claim was observed. A
  // row that predates the ground column is reconstructed by the same rule.
  const ground = attributionGroundFor({
    groundJson: input.groundJson ?? null,
    attributionJson: input.attributionJson,
    teamStatsJson: input.teamStatsJson ?? null,
  })
  return { model, role, state: claimedRoleState(ground, role) }
}

// `totals` is the caller's sum (the reader owns the file walk and its cap);
// `diffState` says whether that sum is the whole change.
export function readChangeStory(input: {
  body: string | null
  totals: DiffTotals | null
  diffState: ChangeStoryDiffState
  attribution?: ChangeStoryAttribution | null
}): ChangeStory {
  const bodyState: ChangeStory['bodyState'] = input.body === null ? 'unreadable' : 'ok'
  const sections = bodyState === 'ok'
    ? parseChangeStoryBody(input.body ?? '')
    : CHANGE_STORY_KEYS.map((key) => ({ key, text: null, duplicated: false }))
  // A sum that was not produced cannot be rendered as a state of its own.
  const diffState: ChangeStoryDiffState = input.diffState === 'ok' && input.totals === null ? 'unreadable' : input.diffState
  return {
    bodyState,
    sections,
    totals: diffState === 'ok' ? input.totals : null,
    diffState,
    attribution: input.attribution ?? null,
  }
}

const DEFAULT_LABELS: Required<ChangeStoryLabels> = {
  notStated: 'not stated',
  unavailable: 'not available',
  capped: 'the file list exceeded the cap',
  duplicate: 'a repeated heading; the last one is shown',
  files: (count: number) => `${count} files`,
  claimedNotObserved: 'claimed, not observed',
  claimedNotVerified: 'claimed, not verified',
}

export function changeStoryFacts(story: ChangeStory, labels: ChangeStoryLabels = {}): ChangeStoryFact[] {
  const l = { ...DEFAULT_LABELS, ...labels }
  const facts: ChangeStoryFact[] = story.sections.map((section) => ({
    key: section.key,
    value: section.text ?? (story.bodyState === 'ok' ? l.notStated : l.unavailable),
    note: section.duplicated ? l.duplicate : '',
  }))
  const diffValue = story.diffState === 'ok' && story.totals !== null
    ? `${l.files(story.totals.files)} +${story.totals.additions} −${story.totals.deletions}`
    : story.diffState === 'capped' ? l.capped : l.unavailable
  facts.push({ key: 'diff', value: diffValue, note: '' })
  // The job row can be read even when the pull request cannot, so this row says
  // "not stated" (nothing recorded) rather than "not available" (nothing read).
  const recorded = [story.attribution?.model ?? null, story.attribution?.role ?? null]
    .filter((part): part is string => part !== null && part !== '')
  // #1190: the row keeps `model · role` (the claim is about the role, not the
  // model) and puts the claim's state in the note, so a seat nothing observed is
  // not printed as a fact.
  const state = story.attribution?.state ?? null
  const claimNote = state === 'unobserved'
    ? l.claimedNotObserved
    : state === 'no-observation' ? l.claimedNotVerified : ''
  facts.push({ key: 'attribution', value: recorded.length === 0 ? l.notStated : recorded.join(' · '), note: claimNote })
  return facts
}
