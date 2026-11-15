// #373 slice 1: a job page is where a maintainer decides, and until now it
// showed what the checks proved but not what the agent said it changed, what it
// thought could go wrong, and what it actually ran — the three sections every
// PR body in this repository already carries. This module is the read model:
// it parses the body the agent wrote and adds the diff totals. Pure, no model
// call, no network.

export const CHANGE_STORY_KEYS = ['whatChanged', 'risks', 'ran'] as const

export type ChangeStoryKey = (typeof CHANGE_STORY_KEYS)[number]

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

export type ChangeStoryDiffState = 'ok' | 'capped' | 'unreadable'

export interface ChangeStory {
  // `unreadable` means GitHub could not be read at all (404, no token, a failed
  // request): every fact is then unavailable rather than "not stated".
  bodyState: 'ok' | 'unreadable'
  sections: ChangeStorySection[]
  totals: DiffTotals | null
  diffState: ChangeStoryDiffState
}

// Labels are the caller's: the parser is language-free and the page passes the
// reader's language in.
export interface ChangeStoryLabels {
  notStated?: string
  unavailable?: string
  capped?: string
  duplicate?: string
  files?: (count: number) => string
}

export interface ChangeStoryFact {
  key: ChangeStoryKey | 'diff'
  value: string
  // A second sentence the page shows under the value; empty when there is none.
  note: string
}

const HEADINGS: Record<string, ChangeStoryKey> = {
  'what changed': 'whatChanged',
  risks: 'risks',
  risk: 'risks',
  ran: 'ran',
}

// `## Risks`, `### Ran`, `# What changed`. The level does not matter: any heading
// the body carries is a boundary, and the ones that name a fact start one.
function headingKey(line: string): ChangeStoryKey | null {
  const heading = /^#{1,6}\s+(.*)$/.exec(line.trim())
  if (heading === null) return null
  const text = (heading[1] ?? '').replace(/[:\s]+$/, '').toLowerCase()
  return HEADINGS[text] ?? null
}

// A `Not run:` line is a fact of its own ("what the agent did not run"), so it
// ends the section above it instead of being read as part of `Ran`.
function isNotRun(line: string): boolean {
  return /^not\s+run\s*:?\s*$/i.test(line.trim())
}

// The house PR template uses a bare `Ran:` line rather than a heading, so the
// block reads this repository's own pull requests and not only PRs that adopted
// heading style.
function isBareRan(line: string): boolean {
  return /^ran\s*:?\s*$/i.test(line.trim())
}

function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line)
}

function endsSection(line: string): boolean {
  return /^#{1,6}\s+/.test(line.trim()) || isNotRun(line)
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
      if (isBareRan(line)) {
        flush()
        current = 'ran'
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

// `totals` is the caller's sum (the reader owns the file walk and its cap);
// `diffState` says whether that sum is the whole change.
export function readChangeStory(input: {
  body: string | null
  totals: DiffTotals | null
  diffState: ChangeStoryDiffState
}): ChangeStory {
  const bodyState: ChangeStory['bodyState'] = input.body === null ? 'unreadable' : 'ok'
  const sections = bodyState === 'ok'
    ? parseChangeStoryBody(input.body ?? '')
    : CHANGE_STORY_KEYS.map((key) => ({ key, text: null, duplicated: false }))
  // A sum that was not produced cannot be rendered as a state of its own.
  const diffState: ChangeStoryDiffState = input.diffState === 'ok' && input.totals === null ? 'unreadable' : input.diffState
  return { bodyState, sections, totals: diffState === 'ok' ? input.totals : null, diffState }
}

const DEFAULT_LABELS: Required<ChangeStoryLabels> = {
  notStated: 'not stated',
  unavailable: 'not available',
  capped: 'the file list exceeded the cap',
  duplicate: 'a repeated heading; the last one is shown',
  files: (count: number) => `${count} files`,
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
  return facts
}
