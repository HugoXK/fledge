import type { GithubClient } from '../repos/github.js'
import { loadRepoRules, RulesError } from '../rules.js'
import { redact } from '../lib/secrets.js'
import type { ReleaseNotes, ReleaseNotesProvenance } from './notes.js'

// #546 slice 5: the repository may organise its own release notes with a skill.
// The skill is `.agents/skills/release-notes/SKILL.md` read through the loader
// #609 merged, at the exact commit the release row pins (`repo_releases.target_sha`
// — the commit the tag's workflow shipped), never at a pull request head and
// never at the default-branch head, which moves. When the skill is missing or
// refused, when the model call fails, or when its answer names a source the range
// does not contain, the built-in list from #720 is used byte-for-byte: one
// renderer, and the page says which path produced the body.

export const RELEASE_NOTES_SKILL = 'release-notes'
export const RELEASE_NOTES_SKILL_PATH = `.agents/skills/${RELEASE_NOTES_SKILL}/SKILL.md`
/** The prompt a repository may add without crowding out the sources themselves. */
export const MAX_NOTES_SKILL_PROMPT_BYTES = 8 * 1024
/** An answer longer than this is not a release body; it is refused, not cut. */
export const MAX_NOTES_BODY_BYTES = 16 * 1024

export interface NotesSkill {
  path: string
  sha256: string
  content: string
}

export type NotesSkillRefusal = 'no_skill' | 'skill_refused' | 'skill_too_large'

export interface NotesSkillRead {
  skill: NotesSkill | null
  /** Why there is no skill; `null` when one was read. */
  reason: NotesSkillRefusal | null
  detail?: string
}

function refusalDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return redact(text).slice(0, 300)
}

// One reader, the loader #609 merged: a second `.agents/skills` walk here would
// drift from the rules page and could read a different file than the one the
// maintainer sees. A refused skill is a fallback with a reason, not a page error:
// the release still gets its draft, built from the range.
export async function readReleaseNotesSkill(
  client: GithubClient,
  owner: string,
  name: string,
  commit: string,
): Promise<NotesSkillRead> {
  let rules: Awaited<ReturnType<typeof loadRepoRules>>
  try {
    rules = await loadRepoRules(client, owner, name, commit)
  } catch (error) {
    const code = error instanceof RulesError ? error.code : 'rules_unavailable'
    return { skill: null, reason: 'skill_refused', detail: `${code}: ${refusalDetail(error)}` }
  }
  const skill = rules.skills.find((candidate) => candidate.name === RELEASE_NOTES_SKILL)
  if (skill === undefined) return { skill: null, reason: 'no_skill' }
  return { skill: { path: skill.path, sha256: skill.sha256, content: skill.content }, reason: null }
}

// The prompt carries the skill text and the collected sources, and nothing else:
// no history crawl, no repository files, no earlier release. The sources are
// printed with the same refs and links the built-in body uses, so the answer can
// be checked against the same list.
export function buildNotesSkillPrompt(notes: ReleaseNotes, skill: NotesSkill): string | null {
  const sources = notes.sources.length === 0
    ? '(the range contains no pull request or commit)'
    : notes.sources.map((source) => `- ${source.ref} ${source.title} — ${source.url}`).join('\n')
  const prompt = [
    `# Skill: ${skill.path}`,
    skill.content.trimEnd(),
    '',
    `# Release range`,
    `Previous tag: ${notes.previousTag ?? '(none)'}`,
    `Target commit: ${notes.targetSha}`,
    `Complete range: ${notes.complete ? 'yes' : 'no, the read stopped at its page cap'}`,
    '',
    `# Sources (the only sources that may appear)`,
    sources,
    '',
    `# Task`,
    'Organise the sources above into release notes under the skill instructions.',
    'Keep every reference exactly as it is written: a `#number` for a pull request and the given URL.',
    'You may reorder, group and reword only these sources. Do not add a source, a link, a commit, a number or a claim about anything not listed above.',
    'Answer with the markdown body only, with no preamble, no code fence and no heading about this task.',
  ].join('\n')
  if (Buffer.byteLength(prompt, 'utf8') > MAX_NOTES_SKILL_PROMPT_BYTES) return null
  return prompt
}

export interface NotesAnswerCheck {
  ok: boolean
  /** Why an answer was refused; present only when `ok` is false. */
  detail?: string
}

const URL_PATTERN = /https?:\/\/[^\s<>()"'`]+/g
const PULL_REF_PATTERN = /(^|[^\w#])#(\d+)/g
const SHA_PATTERN = /\b[0-9a-f]{7,40}\b/g

// The model may reorder and reword; it may not introduce a source. Every URL,
// `#number` and hex ref in the answer must already exist in the collected set,
// otherwise the whole answer is refused and the built-in list wins — a partial
// answer would print a release body with an invented line in it.
export function checkNotesAnswer(notes: ReleaseNotes, answer: string): NotesAnswerCheck {
  const body = answer.trim()
  if (body === '') return { ok: false, detail: 'the answer was empty' }
  if (Buffer.byteLength(body, 'utf8') > MAX_NOTES_BODY_BYTES) return { ok: false, detail: `the answer is larger than ${MAX_NOTES_BODY_BYTES} bytes` }
  const urls = new Set(notes.sources.map((source) => source.url))
  const refs = new Set(notes.sources.map((source) => source.ref))
  const shas = new Set(
    notes.sources
      .filter((source) => source.kind === 'commit')
      .map((source) => source.ref.replace(/`/g, '')),
  )
  for (const match of body.match(URL_PATTERN) ?? []) {
    const url = match.replace(/[.,;:]+$/, '')
    if (!urls.has(url)) return { ok: false, detail: `the answer names a URL outside the range: ${url}` }
  }
  for (const match of body.matchAll(PULL_REF_PATTERN)) {
    const ref = `#${match[2] ?? ''}`
    if (!refs.has(ref)) return { ok: false, detail: `the answer names a pull request outside the range: ${ref}` }
  }
  for (const match of body.matchAll(SHA_PATTERN)) {
    const sha = match[0]
    if (![...shas].some((candidate) => candidate.startsWith(sha) || sha.startsWith(candidate.slice(0, 7)))) {
      return { ok: false, detail: `the answer names a commit outside the range: ${sha}` }
    }
  }
  return { ok: true }
}

export interface OrganiseNotesInput {
  notes: ReleaseNotes
  read: NotesSkillRead
  /** The release row's pin; recorded in the provenance, never re-read from a branch. */
  commit: string
  /** The metered gateway call; a refusal is a fallback, not a page error. */
  complete: (prompt: string) => Promise<string>
}

// Returns the notes to store: the built-in body untouched, or the skill's answer
// with the provenance the page prints. Every fallback keeps `notes.body` exactly
// as #720 built it, which is what makes "byte-identical" testable.
export async function organiseReleaseNotes(input: OrganiseNotesInput): Promise<ReleaseNotes> {
  const builtin = (provenance: ReleaseNotesProvenance): ReleaseNotes => ({ ...input.notes, organisedBy: provenance })
  const { notes, read } = input
  if (read.skill === null) {
    return builtin({ kind: 'builtin', reason: read.reason ?? 'no_skill', ...(read.detail === undefined ? {} : { detail: read.detail }) })
  }
  const prompt = buildNotesSkillPrompt(notes, read.skill)
  if (prompt === null) {
    return builtin({ kind: 'builtin', reason: 'skill_too_large', detail: `${read.skill.path} leaves no room for the sources inside the ${MAX_NOTES_SKILL_PROMPT_BYTES}-byte prompt` })
  }
  let answer: string
  try {
    answer = await input.complete(prompt)
  } catch (error) {
    return builtin({ kind: 'builtin', reason: 'gateway_refused', detail: refusalDetail(error) })
  }
  const checked = checkNotesAnswer(notes, answer)
  if (!checked.ok) {
    return builtin({ kind: 'builtin', reason: 'answer_rejected', detail: checked.detail ?? 'the answer could not be checked' })
  }
  return {
    ...notes,
    body: answer.trim(),
    organisedBy: { kind: 'skill', skillPath: read.skill.path, commit: input.commit },
  }
}
