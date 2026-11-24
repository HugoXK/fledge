import test from 'node:test'
import assert from 'node:assert/strict'
import * as visualMatrix from '../src/lib/visualMatrix.js'
import { VISUAL_PATHS, cellLabel } from '../src/lib/visualMatrix.js'

// #1240: the matrix measured geometry, focus, control names and overflow, so a
// landmark, a role or a contrast failure that does not move a box stayed
// invisible. axe is the semantic layer; it reads the same gate cells the matrix
// already renders, and only serious/critical impacts fail.
//
// The API is reached through the module object so this file still loads on the
// pin's tree, which has no axe filter yet, instead of failing at import time and
// hiding which assertion is missing.
interface Violation {
  readonly id: string
  readonly impact: string | null
  readonly help: string
  readonly targets: readonly string[]
}

interface Waiver {
  readonly rule: string
  readonly path: string
  readonly expires: string
}

interface AxeReport {
  readonly violations: readonly Violation[]
  readonly waivers: readonly Waiver[]
  readonly path: string
  readonly today: string
}

interface AxeApi {
  axeFailures?: (report: AxeReport) => string[]
  AXE_WAIVERS?: readonly Waiver[]
}

const api = visualMatrix as unknown as AxeApi

function exported<T>(name: keyof AxeApi): T {
  const value = api[name]
  assert.equal(
    typeof value,
    'function',
    `src/lib/visualMatrix.ts must export ${String(name)}: without it an axe violation cannot fail the matrix`,
  )
  return value as unknown as T
}

const GATE_CELL = { kind: 'gate', locale: 'en', width: 360, scheme: 'light', path: '/dashboard' } as const

/** The message the runner prints, built the same way it builds it. */
function run(report: AxeReport): string[] {
  const axeFailures = exported<(input: AxeReport) => string[]>('axeFailures')
  const prefix = cellLabel(GATE_CELL as unknown as Parameters<typeof cellLabel>[0])
  return axeFailures(report).map((message) => `${prefix}: ${message}`)
}

/** A fixture of a page a reader cannot use: an image button with no name. */
const KNOWN_BAD: Violation = {
  id: 'image-alt',
  impact: 'critical',
  help: 'Ensure <img> elements have alternate text or a role of none or presentation',
  targets: ['button.icon > img'],
}

test('the gate exports an axe filter that ships with no waiver', () => {
  exported<(input: AxeReport) => string[]>('axeFailures')
  const waivers = api.AXE_WAIVERS
  assert.ok(Array.isArray(waivers), 'AXE_WAIVERS must be an explicit list, even when it is empty')
  assert.deepEqual([...waivers], [], 'the gate ships with zero violations, so the waiver list starts empty')
})

test('a known bad fixture fails with the rule id, the path, the locale and the width', () => {
  const messages = run({ violations: [KNOWN_BAD], waivers: [], path: '/dashboard', today: '2026-11-24' })
  assert.equal(messages.length, 1)
  const message = messages[0] ?? ''
  assert.match(message, /image-alt/, 'the failure must name the rule id')
  assert.match(message, /\/dashboard/, 'the failure must name the path')
  assert.match(message, /\ben\b/, 'the failure must name the locale')
  assert.match(message, /360/, 'the failure must name the width')
  assert.match(message, /critical/, 'the failure must name the impact so a reader can rank it')
  assert.match(message, /button\.icon > img/, 'the failure must name the element it hit')
})

test('a serious violation fails and moderate or minor ones only record', () => {
  const moderate: Violation = { ...KNOWN_BAD, id: 'region', impact: 'moderate' }
  const minor: Violation = { ...KNOWN_BAD, id: 'landmark-one-main', impact: 'minor' }
  const serious: Violation = { ...KNOWN_BAD, id: 'color-contrast', impact: 'serious' }
  const unknown: Violation = { ...KNOWN_BAD, id: 'some-rule', impact: null }
  const messages = run({ violations: [moderate, minor, serious, unknown], waivers: [], path: '/dashboard', today: '2026-11-24' })
  assert.equal(messages.length, 1)
  assert.match(messages[0] ?? '', /color-contrast/)
})

test('a live waiver silences its rule on its own path and no other', () => {
  const waiver: Waiver = { rule: 'image-alt', path: '/dashboard', expires: '2026-12-01' }
  assert.deepEqual(run({ violations: [KNOWN_BAD], waivers: [waiver], path: '/dashboard', today: '2026-11-24' }), [])
  const elsewhere = run({ violations: [KNOWN_BAD], waivers: [waiver], path: '/settings', today: '2026-11-24' })
  assert.equal(elsewhere.length, 1, 'a waiver is scoped to one path; the same rule on another page still fails')
})

test('an expired waiver does not hide a violation and says when it lapsed', () => {
  const waiver: Waiver = { rule: 'image-alt', path: '/dashboard', expires: '2026-11-01' }
  const messages = run({ violations: [KNOWN_BAD], waivers: [waiver], path: '/dashboard', today: '2026-11-24' })
  assert.equal(messages.length, 1)
  assert.match(messages[0] ?? '', /expired on 2026-11-01/, 'an entry that lapsed must be visible, not silently kept')
})

test('a waiver without a dated expiry is refused before it can hide anything', () => {
  const broken: Waiver = { rule: 'image-alt', path: '/dashboard', expires: 'when it is fixed' }
  const messages = run({ violations: [KNOWN_BAD], waivers: [broken], path: '/dashboard', today: '2026-11-24' })
  assert.equal(messages.length, 2, 'the malformed entry is its own failure, and it does not waive the violation')
  assert.ok(
    messages.some((message) => /YYYY-MM-DD/.test(message)),
    'the refusal must say what shape the expiry needs',
  )
})

test('every shipped waiver names a matrix path', () => {
  for (const waiver of api.AXE_WAIVERS ?? []) {
    assert.ok(
      (VISUAL_PATHS as readonly string[]).includes(waiver.path),
      `waiver ${waiver.rule} names ${waiver.path}, which the matrix never renders`,
    )
  }
})
