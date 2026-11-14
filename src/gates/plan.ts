import { createHash } from 'node:crypto'

// #543: the gate plan is the one artifact a repository onboarding run proposes
// before anything is written. It is a closed shape on purpose: a plan is stored,
// hashed and later handed to the gate-PR slice, so an unknown field or lane must
// be refused here rather than silently dropped between analysis and a write.

export const GATE_PLAN_LANES = ['pr-ready', 'pr-merge', 'daily', 'release'] as const
export type GatePlanLaneName = (typeof GATE_PLAN_LANES)[number]

export interface GatePlanLane {
  commands: string[]
  observe: boolean
  source: string
  durationMs?: number
}

export interface GatePlan {
  baseSha: string
  mergeQueue: boolean
  lanes: Record<GatePlanLaneName, GatePlanLane>
  existingFiles: string[]
  gaps: string[]
  notes: string[]
}

export interface GatePlanFailure {
  ok: false
  code: string
  field: string
  message: string
}

export type GatePlanResult = { ok: true; plan: GatePlan } | GatePlanFailure

export const GATE_PLAN_LIMITS = {
  commands: 50,
  commandChars: 2000,
  sourceChars: 200,
  maxDurationMs: 7 * 24 * 60 * 60 * 1000,
  existingFiles: 500,
  existingFileChars: 500,
  gaps: 100,
  gapChars: 1000,
  notes: 100,
  noteChars: 1000,
} as const

const PLAN_KEYS = ['baseSha', 'mergeQueue', 'lanes', 'existingFiles', 'gaps', 'notes'] as const
const LANE_KEYS = ['commands', 'observe', 'source', 'durationMs'] as const
const BASE_SHA = /^[0-9a-f]{40}$/i

type Plain = Record<string, unknown>

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(code: string, field: string, message: string): GatePlanFailure {
  return { ok: false, code, field, message }
}

function unknownKey(value: Plain, allowed: readonly string[], prefix: string, code = 'field_unknown'): GatePlanFailure | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return fail(code, `${prefix}${key}`, `Unknown field: ${prefix}${key}`)
  }
  return null
}

function boundedStrings(value: unknown, field: string, maxItems: number, maxChars: number): { ok: true; value: string[] } | GatePlanFailure {
  if (!Array.isArray(value)) return fail('field_invalid', field, `${field} must be an array`)
  if (value.length > maxItems) return fail('field_oversize', field, `${field} may hold at most ${maxItems} entries`)
  const out: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    const entryField = `${field}[${index}]`
    if (typeof entry !== 'string') return fail('field_invalid', entryField, `${entryField} must be a string`)
    const text = entry.trim()
    if (text === '') return fail('field_empty', entryField, `${entryField} may not be empty`)
    if (text.length > maxChars) return fail('field_oversize', entryField, `${entryField} may hold at most ${maxChars} characters`)
    out.push(text)
  }
  return { ok: true, value: out }
}

function validateLane(value: unknown, lane: GatePlanLaneName): { ok: true; value: GatePlanLane } | GatePlanFailure {
  const field = `lanes.${lane}`
  if (!isPlainObject(value)) return fail('lane_invalid', field, `${field} must be an object`)
  const extra = unknownKey(value, LANE_KEYS, `${field}.`)
  if (extra !== null) return extra

  if (!('commands' in value)) return fail('field_missing', `${field}.commands`, `${field}.commands is required`)
  if (!Array.isArray(value.commands)) return fail('commands_invalid', `${field}.commands`, `${field}.commands must be an array`)
  if (value.commands.length > GATE_PLAN_LIMITS.commands) {
    return fail('commands_oversize', `${field}.commands`, `${field}.commands may hold at most ${GATE_PLAN_LIMITS.commands} entries`)
  }
  const commands: string[] = []
  for (let index = 0; index < value.commands.length; index += 1) {
    const command = value.commands[index]
    const commandField = `${field}.commands[${index}]`
    if (typeof command !== 'string') return fail('command_invalid', commandField, `${commandField} must be a string`)
    const text = command.trim()
    if (text === '') return fail('command_empty', commandField, `${commandField} may not be empty`)
    if (text.length > GATE_PLAN_LIMITS.commandChars) {
      return fail('command_oversize', commandField, `${commandField} may hold at most ${GATE_PLAN_LIMITS.commandChars} characters`)
    }
    commands.push(text)
  }

  if (typeof value.observe !== 'boolean') return fail('observe_invalid', `${field}.observe`, `${field}.observe must be a boolean`)

  if (typeof value.source !== 'string') return fail('source_invalid', `${field}.source`, `${field}.source must be a string`)
  const source = value.source.trim()
  if (source === '') return fail('source_empty', `${field}.source`, `${field}.source may not be empty`)
  if (source.length > GATE_PLAN_LIMITS.sourceChars) {
    return fail('source_oversize', `${field}.source`, `${field}.source may hold at most ${GATE_PLAN_LIMITS.sourceChars} characters`)
  }

  const laneValue: GatePlanLane = { commands, observe: value.observe, source }
  if ('durationMs' in value) {
    const duration = value.durationMs
    if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 0) {
      return fail('duration_invalid', `${field}.durationMs`, `${field}.durationMs must be a non-negative integer`)
    }
    if (duration > GATE_PLAN_LIMITS.maxDurationMs) {
      return fail('duration_oversize', `${field}.durationMs`, `${field}.durationMs must be at most ${GATE_PLAN_LIMITS.maxDurationMs}`)
    }
    laneValue.durationMs = duration
  }
  return { ok: true, value: laneValue }
}

export function validateGatePlan(value: unknown): GatePlanResult {
  if (!isPlainObject(value)) return fail('plan_invalid', '', 'The gate plan must be an object')
  const extra = unknownKey(value, PLAN_KEYS, '')
  if (extra !== null) return extra

  for (const key of PLAN_KEYS) {
    if (!(key in value)) return fail('field_missing', key, `${key} is required`)
  }

  if (typeof value.baseSha !== 'string') return fail('base_sha_invalid', 'baseSha', 'baseSha must be a 40-character hex SHA')
  const baseSha = value.baseSha.trim().toLowerCase()
  if (!BASE_SHA.test(baseSha)) return fail('base_sha_invalid', 'baseSha', 'baseSha must be a 40-character hex SHA')

  if (typeof value.mergeQueue !== 'boolean') return fail('merge_queue_invalid', 'mergeQueue', 'mergeQueue must be a boolean')

  if (!isPlainObject(value.lanes)) return fail('lanes_invalid', 'lanes', 'lanes must be an object')
  const laneExtra = unknownKey(value.lanes, GATE_PLAN_LANES, 'lanes.', 'lane_unknown')
  if (laneExtra !== null) return laneExtra

  const lanes = {} as Record<GatePlanLaneName, GatePlanLane>
  for (const lane of GATE_PLAN_LANES) {
    if (!(lane in value.lanes)) return fail('lane_missing', `lanes.${lane}`, `lanes.${lane} is required`)
    const checked = validateLane(value.lanes[lane], lane)
    if (!checked.ok) return checked
    lanes[lane] = checked.value
  }

  const existingFiles = boundedStrings(value.existingFiles, 'existingFiles', GATE_PLAN_LIMITS.existingFiles, GATE_PLAN_LIMITS.existingFileChars)
  if (!existingFiles.ok) return existingFiles
  const gaps = boundedStrings(value.gaps, 'gaps', GATE_PLAN_LIMITS.gaps, GATE_PLAN_LIMITS.gapChars)
  if (!gaps.ok) return gaps
  const notes = boundedStrings(value.notes, 'notes', GATE_PLAN_LIMITS.notes, GATE_PLAN_LIMITS.noteChars)
  if (!notes.ok) return notes

  return {
    ok: true,
    plan: {
      baseSha,
      mergeQueue: value.mergeQueue,
      lanes,
      existingFiles: existingFiles.value,
      gaps: gaps.value,
      notes: notes.value,
    },
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Plain
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

export function planHash(plan: GatePlan): string {
  return createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex')
}
