import { sha256Hex, signPayload, verifyPayload } from './secrets.js'
import { PLAYBOOK_VERSION, TEAM_ROLES, playbookBundleContent, playbookFingerprint, type TeamRole } from '../flybot/playbook.js'

// #380: a loaded skill is executable influence, not documentation. A bundle is
// content plus a manifest that names it, its source, the hash of that content and
// the roles it may influence; Fledge signs the manifest with the instance key so
// the record a job carries cannot be rewritten without the key. The allowlist is
// a separate decision about the *source* (the owner's instance configuration),
// and revocation is a row update read at the next job start.

export const PLAYBOOK_BUNDLE_SOURCE = 'builtin:fledge'
export const PLAYBOOK_BUNDLE_NAME = 'fledge-playbook'
export const SKILL_BUNDLE_TTL_SECONDS = 90 * 24 * 60 * 60

export type SkillBundleState = 'accepted' | 'held' | 'refused' | 'revoked'

export interface UnsignedSkillBundle {
  name: string
  version: number
  source: string
  contentHash: string
  allowedRoles: TeamRole[]
}

export interface SkillBundleManifest extends UnsignedSkillBundle {
  signature: string
}

export interface SkillBundleSourceRow {
  source: string
  state: 'allowed' | 'revoked'
  updatedBy: string
  updatedAt: string
}

export interface SkillBundleAttestation {
  name: string
  source: string
  version: number
  contentHash: string
  allowedRoles: TeamRole[]
  state: SkillBundleState
  reason: string
}

export interface SkillBundleSet {
  state: 'accepted' | 'held' | 'refused'
  reason: string
  hash: string
  bundles: SkillBundleAttestation[]
}

export interface SkillBundleRecordBundle {
  name: string
  source: string
  version: number
  contentHash: string
  state: SkillBundleState
}

export interface SkillBundleRecord {
  hash: string
  decision: 'accepted' | 'held' | 'refused'
  bundles: SkillBundleRecordBundle[]
}

export interface SkillBundleMergeBlock {
  name: string
  source: string
  state: SkillBundleState
  reason: string
}

export function bundleContentHash(content: string): string {
  return sha256Hex(content)
}

export function repoBundleSource(owner: string, name: string): string {
  return `repo:${owner}/${name}`
}

function isRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value)
}

function isUnsigned(value: unknown): value is UnsignedSkillBundle {
  if (typeof value !== 'object' || !value) return false
  const row = value as Record<string, unknown>
  return typeof row.name === 'string'
    && row.name !== ''
    && typeof row.version === 'number'
    && Number.isInteger(row.version)
    && typeof row.source === 'string'
    && row.source !== ''
    && typeof row.contentHash === 'string'
    && /^[0-9a-f]{64}$/.test(row.contentHash)
    && Array.isArray(row.allowedRoles)
    && row.allowedRoles.every(isRole)
}

// The signature carries the expiry `signPayload` always adds, so a manifest is
// a short-lived attestation of what this instance loaded, not a permanent grant.
export function signSkillBundle(bundle: UnsignedSkillBundle, instanceKey: string, ttlSeconds = SKILL_BUNDLE_TTL_SECONDS): SkillBundleManifest {
  if (instanceKey === '') throw new Error('skill bundle signing needs the instance key')
  const signature = signPayload({ ...bundle }, instanceKey, ttlSeconds)
  return { ...bundle, signature }
}

// Returns the signed fields only when the signature verifies and the payload
// still names the same bundle. A caller that reads the manifest without this
// check has a string, not an attestation.
export function verifySkillBundle(manifest: SkillBundleManifest, instanceKey: string): UnsignedSkillBundle | null {
  if (instanceKey === '' || typeof manifest.signature !== 'string' || manifest.signature === '') return null
  const payload = verifyPayload(manifest.signature, instanceKey)
  if (payload === null) return null
  const unsigned: UnsignedSkillBundle = {
    name: manifest.name,
    version: manifest.version,
    source: manifest.source,
    contentHash: manifest.contentHash,
    allowedRoles: manifest.allowedRoles,
  }
  if (!isUnsigned(unsigned)) return null
  const { exp: _exp, ...signed } = payload as Record<string, unknown> & { exp: number }
  if (JSON.stringify(signed) !== JSON.stringify(unsigned)) return null
  return unsigned
}

export function attestSkillBundle(input: {
  manifest: SkillBundleManifest
  content: string
  instanceKey: string
  sources: readonly SkillBundleSourceRow[]
  role: TeamRole
}): SkillBundleAttestation {
  const base = {
    name: input.manifest.name,
    source: input.manifest.source,
    version: input.manifest.version,
    contentHash: input.manifest.contentHash,
    allowedRoles: input.manifest.allowedRoles,
  }
  const signed = verifySkillBundle(input.manifest, input.instanceKey)
  if (signed === null) return { ...base, state: 'refused', reason: 'the bundle signature does not verify' }
  if (bundleContentHash(input.content) !== input.manifest.contentHash) {
    return { ...base, state: 'refused', reason: 'the content does not match the signed hash' }
  }
  const source = input.sources.find((row) => row.source === input.manifest.source)
  if (source === undefined) return { ...base, state: 'held', reason: 'the bundle source is not in the allowlist' }
  if (source.state === 'revoked') return { ...base, state: 'revoked', reason: 'the bundle source is revoked' }
  if (!input.manifest.allowedRoles.includes(input.role)) {
    return { ...base, state: 'refused', reason: `the bundle is not allowed for role ${input.role}` }
  }
  return { ...base, state: 'accepted', reason: 'signed by this instance and allowed for the source' }
}

// The one hash a job records. Sorting by source and name makes it independent of
// the order the rules loader happened to see, so the same set reads the same.
export function skillBundleSetHash(bundles: readonly Pick<SkillBundleAttestation, 'name' | 'source' | 'version' | 'contentHash' | 'state'>[]): string {
  const rows = [...bundles]
    .sort((left, right) => `${left.source}\u0000${left.name}`.localeCompare(`${right.source}\u0000${right.name}`))
    .map((bundle) => [bundle.name, bundle.source, bundle.version, bundle.contentHash, bundle.state])
  return sha256Hex(JSON.stringify(rows))
}

export function assembleSkillBundles(input: {
  bundles: ReadonlyArray<{ manifest: SkillBundleManifest; content: string }>
  instanceKey: string
  sources: readonly SkillBundleSourceRow[]
  role: TeamRole
}): SkillBundleSet {
  const bundles = input.bundles.map((bundle) => attestSkillBundle({
    manifest: bundle.manifest,
    content: bundle.content,
    instanceKey: input.instanceKey,
    sources: input.sources,
    role: input.role,
  }))
  const refused = bundles.find((bundle) => bundle.state === 'refused' || bundle.state === 'revoked')
  const held = bundles.find((bundle) => bundle.state === 'held')
  const state = refused !== undefined ? 'refused' : held !== undefined ? 'held' : 'accepted'
  const reason = refused?.reason ?? held?.reason ?? (bundles.length === 0 ? 'no bundle is loaded' : 'every bundle is accepted')
  return { state, reason, hash: skillBundleSetHash(bundles), bundles }
}

export function skillBundleRecord(set: SkillBundleSet): SkillBundleRecord {
  return {
    hash: set.hash,
    decision: set.state,
    bundles: set.bundles.map((bundle) => ({
      name: bundle.name,
      source: bundle.source,
      version: bundle.version,
      contentHash: bundle.contentHash,
      state: bundle.state,
    })),
  }
}

function isState(value: unknown): value is SkillBundleState {
  return value === 'accepted' || value === 'held' || value === 'refused' || value === 'revoked'
}

// A corrupt record reads as "no record" rather than as "nothing was loaded": the
// merge gate treats the first as a job that predates the attestation and the
// second as a job with no bundle, and those are not the same answer.
export function parseSkillBundleRecord(json: string | null): SkillBundleRecord | null {
  if (json === null || json === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const row = parsed as Record<string, unknown>
  if (typeof row.hash !== 'string' || !/^[0-9a-f]{64}$/.test(row.hash)) return null
  if (row.decision !== 'accepted' && row.decision !== 'held' && row.decision !== 'refused') return null
  if (!Array.isArray(row.bundles)) return null
  const bundles: SkillBundleRecordBundle[] = []
  for (const entry of row.bundles) {
    if (typeof entry !== 'object' || entry === null) return null
    const bundle = entry as Record<string, unknown>
    if (typeof bundle.name !== 'string' || bundle.name === '') return null
    if (typeof bundle.source !== 'string' || bundle.source === '') return null
    if (typeof bundle.version !== 'number' || !Number.isInteger(bundle.version)) return null
    if (typeof bundle.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(bundle.contentHash)) return null
    if (!isState(bundle.state)) return null
    bundles.push({ name: bundle.name, source: bundle.source, version: bundle.version, contentHash: bundle.contentHash, state: bundle.state })
  }
  return { hash: row.hash, decision: row.decision, bundles }
}

// The automatic merge reads the sources again: a source allowed when the job
// started and revoked since then blocks it. A job with no record (written before
// this gate) is not blocked by a rule it could not have known about.
export function skillBundleMergeBlock(record: SkillBundleRecord | null, sources: readonly SkillBundleSourceRow[]): SkillBundleMergeBlock | null {
  if (record === null) return null
  for (const bundle of record.bundles) {
    const source = sources.find((row) => row.source === bundle.source)
    if (source === undefined) {
      return { name: bundle.name, source: bundle.source, state: 'held', reason: 'the bundle source is no longer in the allowlist' }
    }
    if (source.state === 'revoked') {
      return { name: bundle.name, source: bundle.source, state: 'revoked', reason: 'the bundle source is revoked' }
    }
  }
  return null
}

export function playbookBundle(goal: string, instanceKey: string): { manifest: SkillBundleManifest; content: string } {
  const content = playbookBundleContent(goal)
  const manifest = signSkillBundle({
    name: PLAYBOOK_BUNDLE_NAME,
    version: PLAYBOOK_VERSION,
    source: PLAYBOOK_BUNDLE_SOURCE,
    contentHash: playbookFingerprint(goal),
    allowedRoles: [...TEAM_ROLES],
  }, instanceKey)
  return { manifest, content }
}

export function repoSkillBundle(input: {
  owner: string
  name: string
  skill: { name: string; content: string; version?: number }
  instanceKey: string
}): { manifest: SkillBundleManifest; content: string } {
  const manifest = signSkillBundle({
    name: `skill:${input.skill.name}`,
    version: input.skill.version ?? 1,
    source: repoBundleSource(input.owner, input.name),
    contentHash: bundleContentHash(input.skill.content),
    allowedRoles: [...TEAM_ROLES],
  }, input.instanceKey)
  return { manifest, content: input.skill.content }
}
