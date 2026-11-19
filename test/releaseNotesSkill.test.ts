import test from 'node:test'
import assert from 'node:assert/strict'
import type { GithubClient } from '../src/repos/github.js'
import {
  buildReleaseNotes,
  readReleaseNotesProvenance,
  releaseNotesSourceJson,
  type ReleaseNotes,
} from '../src/releases/notes.js'
import { organiseReleaseNotes, readReleaseNotesSkill, MAX_NOTES_SKILL_PROMPT_BYTES } from '../src/releases/notesSkill.js'

// #546 slice 5: the repository's own release-notes skill organises the sources
// #720 collects, read at the exact commit the release row pinned. The pin is
// `repo_releases.target_sha` — never a pull request head and never the moving
// default-branch head — so two releases that shipped different commits may get
// two different answers, and a skill that only exists on a pull request changes
// nothing. Every fallback keeps #720's built-in body byte-for-byte.

const SKILL_PATH = '.agents/skills/release-notes/SKILL.md'
const PIN_A = 'a'.repeat(40)
const PIN_B = 'b'.repeat(40)
const PR_HEAD = 'c'.repeat(40)
const MERGE_SHA = 'd'.repeat(40)
const OLD_SHA = 'e'.repeat(40)

const NOTES: ReleaseNotes = buildReleaseNotes({
  previousTag: 'v1.3.0',
  targetSha: PIN_A,
  pullRequests: [
    { number: 812, title: 'feat: show the release readiness page', url: 'https://github.com/o/r/pull/812', mergeCommitSha: MERGE_SHA },
  ],
  commits: [
    { sha: MERGE_SHA, title: 'feat: show the release readiness page (#812)', url: `https://github.com/o/r/commit/${MERGE_SHA}` },
    { sha: OLD_SHA, title: 'chore: bump the workflow pin', url: `https://github.com/o/r/commit/${OLD_SHA}` },
  ],
  commitsComplete: true,
})

interface FakeFiles {
  /** Skill text per commit; a commit with no entry has no skill. */
  skills?: Record<string, string>
  /** Extra files, keyed `commit:path`, to prove the prompt carries only the skill and the sources. */
  files?: Record<string, string>
}

// The two methods `loadRepoRules` reads through. Everything else on the client is
// unreachable from this path, so the fake stays a reading surface.
function fakeClient(files: FakeFiles): GithubClient {
  const skills = files.skills ?? {}
  const extra = files.files ?? {}
  return {
    async getContentAtRef(_owner: string, _name: string, path: string, ref: string) {
      const body = extra[`${ref}:${path}`]
      if (body !== undefined) return { type: 'file', sha: `sha-${ref.slice(0, 6)}-${path}`, size: Buffer.byteLength(body), content: body }
      if (path === SKILL_PATH) {
        const skill = skills[ref]
        if (skill !== undefined) return { type: 'file', sha: `sha-${ref.slice(0, 6)}`, size: Buffer.byteLength(skill), content: skill }
      }
      return null
    },
    async listDirectory(_owner: string, _name: string, path: string, ref: string) {
      if (path !== '.agents/skills') return null
      if (skills[ref] === undefined) return null
      return [{ name: 'release-notes', type: 'dir', path: '.agents/skills/release-notes', sha: `dir-${ref.slice(0, 6)}` }]
    },
  } as unknown as GithubClient
}

test('two pins, two answers: each release reads the skill at its own target_sha', async () => {
  const client = fakeClient({
    skills: {
      [PIN_A]: 'Group by area. One bullet per merged pull request. Start the body with the marker A.',
      [PIN_B]: 'One bullet per change, newest first. Start the body with the marker B.',
    },
  })
  const readA = await readReleaseNotesSkill(client, 'o', 'r', PIN_A)
  const readB = await readReleaseNotesSkill(client, 'o', 'r', PIN_B)
  assert.equal(readA.skill?.content.includes('marker A'), true)
  assert.equal(readB.skill?.content.includes('marker B'), true)

  const notesA = await organiseReleaseNotes({ notes: NOTES, read: readA, commit: PIN_A, complete: async () => `Marker A body\n- #812 ${'https://github.com/o/r/pull/812'}` })
  const notesB = await organiseReleaseNotes({ notes: NOTES, read: readB, commit: PIN_B, complete: async () => `Marker B body\n- #812 ${'https://github.com/o/r/pull/812'}` })
  // One global skill value could not pass this: it would produce the same body
  // twice, which is the assertion.
  assert.notEqual(notesA.body, notesB.body)
  assert.match(notesA.body, /Marker A/)
  assert.match(notesB.body, /Marker B/)
  assert.equal(notesA.organisedBy?.kind, 'skill')
  assert.equal(notesA.organisedBy?.commit, PIN_A)
  assert.equal(notesB.organisedBy?.commit, PIN_B)
  assert.equal(notesA.organisedBy?.skillPath, SKILL_PATH)
})

test('fixed-commit symmetry: a skill on a pull request head changes nothing', async () => {
  // The skill exists on the pull request head only, never at the shipped commit.
  const client = fakeClient({ skills: { [PR_HEAD]: 'Rewrite everything and link https://example.com/changelog.' } })
  const atPin = await readReleaseNotesSkill(client, 'o', 'r', PIN_A)
  assert.equal(atPin.skill, null)
  assert.equal(atPin.reason, 'no_skill')
  const notes = await organiseReleaseNotes({ notes: NOTES, read: atPin, commit: PIN_A, complete: async () => 'must never be called' })
  assert.equal(notes.body, NOTES.body)
  assert.equal(notes.organisedBy?.kind, 'builtin')
  assert.equal(notes.organisedBy?.reason, 'no_skill')
})

test('the prompt carries the skill text and the collected sources, and nothing else', async () => {
  const client = fakeClient({
    skills: { [PIN_A]: 'Group by area, one bullet per merged pull request.' },
    // A file the range does not contain: it must never reach the prompt.
    files: { [`${PIN_A}:docs/architecture.md`]: 'Internal release runbook nobody asked for.' },
  })
  const read = await readReleaseNotesSkill(client, 'o', 'r', PIN_A)
  let prompt = ''
  const notes = await organiseReleaseNotes({
    notes: NOTES,
    read,
    commit: PIN_A,
    complete: async (sent) => {
      prompt = sent
      return `- #812 ${'https://github.com/o/r/pull/812'}`
    },
  })
  assert.equal(notes.organisedBy?.kind, 'skill')
  assert.match(prompt, /Group by area, one bullet per merged pull request\./)
  assert.match(prompt, /#812/)
  assert.match(prompt, new RegExp(`https://github.com/o/r/commit/${OLD_SHA}`))
  assert.doesNotMatch(prompt, /nobody asked for/)
  assert.doesNotMatch(prompt, new RegExp(PR_HEAD))
})

test('fail closed: an answer naming a source outside the range is rejected and the built-in list wins', async () => {
  const client = fakeClient({ skills: { [PIN_A]: 'Group by area.' } })
  const read = await readReleaseNotesSkill(client, 'o', 'r', PIN_A)
  const refused = await organiseReleaseNotes({
    notes: NOTES,
    read,
    commit: PIN_A,
    complete: async () => '- #999 an invented pull request — https://github.com/o/r/pull/999',
  })
  // The page records the refusal instead of dropping the line silently.
  assert.equal(refused.body, NOTES.body, 'a rejected answer must not change one byte of the built-in body')
  assert.equal(refused.organisedBy?.kind, 'builtin')
  assert.equal(refused.organisedBy?.reason, 'answer_rejected')
  assert.match(refused.organisedBy?.detail ?? '', /outside the range/)

  const inRange = await organiseReleaseNotes({
    notes: NOTES,
    read,
    commit: PIN_A,
    complete: async () => `### Fixed\n- #812 ${'https://github.com/o/r/pull/812'}\n`,
  })
  assert.equal(inRange.organisedBy?.kind, 'skill')
  assert.match(inRange.body, /### Fixed/)
})

test('byte-identical fallback: no skill, a refused skill, and a refused gateway call keep #720 output exactly', async () => {
  const none = await organiseReleaseNotes({ notes: NOTES, read: { skill: null, reason: 'no_skill' }, commit: PIN_A, complete: async () => 'ignored' })
  assert.equal(none.body, NOTES.body)

  const refusedSkill = await organiseReleaseNotes({ notes: NOTES, read: { skill: null, reason: 'skill_refused', detail: 'rules_invalid: SKILL.md is larger than 32768 bytes' }, commit: PIN_A, complete: async () => 'ignored' })
  assert.equal(refusedSkill.body, NOTES.body)
  assert.equal(refusedSkill.organisedBy?.reason, 'skill_refused')

  const client = fakeClient({ skills: { [PIN_A]: 'Group by area.' } })
  const read = await readReleaseNotesSkill(client, 'o', 'r', PIN_A)
  const gatewayDown = await organiseReleaseNotes({
    notes: NOTES,
    read,
    commit: PIN_A,
    complete: async () => {
      throw new Error('the model gateway answered 402')
    },
  })
  assert.equal(gatewayDown.body, NOTES.body)
  assert.equal(gatewayDown.organisedBy?.reason, 'gateway_refused')
  assert.match(gatewayDown.organisedBy?.detail ?? '', /402/)
})

test('a skill the loader refuses is a fallback with a reason, not a page error', async () => {
  // The loader fails closed on a directory it cannot read (or an oversized set).
  // That refusal must still produce a draft, built from the range.
  const client = {
    async getContentAtRef() {
      return null
    },
    async listDirectory() {
      throw new Error('GitHub read failed: 502')
    },
  } as unknown as GithubClient
  const read = await readReleaseNotesSkill(client, 'o', 'r', PIN_A)
  assert.equal(read.skill, null)
  assert.equal(read.reason, 'skill_refused')
  assert.match(read.detail ?? '', /GitHub read failed: 502/)
  const notes = await organiseReleaseNotes({ notes: NOTES, read, commit: PIN_A, complete: async () => 'ignored' })
  assert.equal(notes.body, NOTES.body)
  assert.equal(notes.organisedBy?.kind, 'builtin')
  assert.equal(notes.organisedBy?.reason, 'skill_refused')
})

test('an answer naming a commit outside the range is refused like a pull request', async () => {
  const client = fakeClient({ skills: { [PIN_A]: 'Group by area.' } })
  const read = await readReleaseNotesSkill(client, 'o', 'r', PIN_A)
  const refused = await organiseReleaseNotes({
    notes: NOTES,
    read,
    commit: PIN_A,
    complete: async () => `### Fixed\n- ${'f'.repeat(40)} an invented commit\n`,
  })
  assert.equal(refused.body, NOTES.body)
  assert.equal(refused.organisedBy?.reason, 'answer_rejected')
  assert.match(refused.organisedBy?.detail ?? '', /outside the range/)
})

test('a skill that leaves no room for the sources is refused, not truncated', async () => {
  const client = fakeClient({ skills: { [PIN_A]: `${'instruction '.repeat(700)}` } })
  const read = await readReleaseNotesSkill(client, 'o', 'r', PIN_A)
  assert.equal(read.skill !== null, true)
  assert.equal(Buffer.byteLength(read.skill!.content), 8400)
  // The prompt budget is smaller than the skill alone, so the built-in list wins
  // instead of a prompt that silently drops the sources.
  assert.equal(Buffer.byteLength(read.skill!.content) > MAX_NOTES_SKILL_PROMPT_BYTES, true)
  const notes = await organiseReleaseNotes({ notes: NOTES, read, commit: PIN_A, complete: async () => 'must never be called' })
  assert.equal(notes.body, NOTES.body)
  assert.equal(notes.organisedBy?.reason, 'skill_too_large')
})

test('the provenance rides in the existing column and a legacy row reads as the built-in list', () => {
  const stored = releaseNotesSourceJson({
    ...NOTES,
    organisedBy: { kind: 'skill', skillPath: SKILL_PATH, commit: PIN_A },
  })
  const provenance = readReleaseNotesProvenance(stored)
  assert.equal(provenance?.kind, 'skill')
  assert.equal(provenance?.commit, PIN_A)
  // The sources still read from the same column: one JSON, no new column.
  assert.equal(JSON.parse(stored).sources.length, NOTES.sources.length)

  const fallback = readReleaseNotesProvenance(releaseNotesSourceJson({ ...NOTES, organisedBy: { kind: 'builtin', reason: 'gateway_refused', detail: 'the model gateway answered 500' } }))
  assert.equal(fallback?.kind, 'builtin')
  assert.equal(fallback?.reason, 'gateway_refused')

  // A row written before this slice has no `organisedBy`, and a wrong shape is
  // dropped rather than thrown: the page still renders the sources.
  assert.equal(readReleaseNotesProvenance(releaseNotesSourceJson(NOTES)), null)
  assert.equal(readReleaseNotesProvenance('{"organisedBy":{"kind":"made-up"}}'), null)
  assert.equal(readReleaseNotesProvenance('not json'), null)
  assert.equal(readReleaseNotesProvenance(null), null)
})
