import type { GithubClient } from './repos/github.js'
import { sha256Hex } from './lib/secrets.js'

export const RULE_PATHS = ['.fledge/rules.md', '.fledge/review.md', '.fledge/develop.md'] as const
export const SKILLS_DIR = '.agents/skills'
export const MAX_RULE_FILE_BYTES = 32 * 1024
export const MAX_RULES_TOTAL_BYTES = 256 * 1024
export const MAX_SKILLS = 32
export const MAX_SKILL_BYTES = 32 * 1024

export type RuleLayer = 'repository' | 'console' | 'builtin'

export interface RuleFile {
  path: string
  sha256: string
  bytes: number
  content: string
  layer: RuleLayer
}

export interface RuleLayerRecord {
  path: string
  layer: RuleLayer
  revision: number | null
}

export interface ConsoleRuleOverride {
  path: string
  content: string
  revision: number
}

export interface SkillFile {
  name: string
  path: string
  description: string
  sha256: string
  bytes: number
  content: string
}

export interface RepoRules {
  owner: string
  name: string
  commit: string
  files: RuleFile[]
  skills: SkillFile[]
  layers: RuleLayerRecord[]
  effective: string
  hash: string
  totalBytes: number
}

export type RulesErrorCode = 'rules_invalid' | 'rules_unavailable'

export class RulesError extends Error {
  constructor(
    readonly code: RulesErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = 'RulesError'
  }
}

export function isRulePath(path: string): boolean {
  return (RULE_PATHS as readonly string[]).includes(path)
}

function decodeSkillPath(name: string): string {
  return `${SKILLS_DIR}/${name}/SKILL.md`
}

function descriptionOf(content: string): string {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (frontMatter !== null) {
    const match = /^description:\s*(.+)$/m.exec(frontMatter[1] ?? '')
    if (match !== null) return match[1]!.trim().replace(/^["']|["']$/g, '').slice(0, 200)
  }
  const first = content.split(/\r?\n/).map((line) => line.replace(/^#+\s*/, '').trim()).find((line) => line !== '')
  return (first ?? '').slice(0, 200)
}

function validateText(path: string, content: string): void {
  if (content.includes('\0')) throw new RulesError('rules_invalid', path, `${path} contains a NUL byte`)
}

async function readRule(client: GithubClient, owner: string, name: string, commit: string, path: string): Promise<RuleFile | null> {
  const file = await client.getContentAtRef(owner, name, path, commit)
  if (file === null) return null
  if (file.type !== 'file') throw new RulesError('rules_invalid', path, `${path} is a ${file.type}, not a regular file`)
  if (file.size > MAX_RULE_FILE_BYTES) throw new RulesError('rules_invalid', path, `${path} is larger than ${MAX_RULE_FILE_BYTES} bytes`)
  validateText(path, file.content)
  return { path, sha256: file.sha === '' ? sha256Hex(file.content) : file.sha, bytes: Buffer.byteLength(file.content), content: file.content, layer: 'repository' }
}

async function readSkills(client: GithubClient, owner: string, name: string, commit: string): Promise<SkillFile[]> {
  const entries = await client.listDirectory(owner, name, SKILLS_DIR, commit)
  if (entries === null) return []
  const directories = entries.filter((entry) => entry.type === 'dir').map((entry) => entry.name).sort()
  if (directories.length > MAX_SKILLS) throw new RulesError('rules_invalid', SKILLS_DIR, `more than ${MAX_SKILLS} skills`)
  const skills: SkillFile[] = []
  for (const directory of directories) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(directory)) throw new RulesError('rules_invalid', SKILLS_DIR, `invalid skill name: ${directory}`)
    const path = decodeSkillPath(directory)
    const file = await client.getContentAtRef(owner, name, path, commit)
    if (file === null) continue
    if (file.type !== 'file') throw new RulesError('rules_invalid', path, `${path} is a ${file.type}, not a regular file`)
    if (file.size > MAX_SKILL_BYTES) throw new RulesError('rules_invalid', path, `${path} is larger than ${MAX_SKILL_BYTES} bytes`)
    validateText(path, file.content)
    skills.push({
      name: directory,
      path,
      description: descriptionOf(file.content),
      sha256: file.sha === '' ? sha256Hex(file.content) : file.sha,
      bytes: Buffer.byteLength(file.content),
      content: file.content,
    })
  }
  return skills
}

export async function loadRepoRules(
  client: GithubClient,
  owner: string,
  name: string,
  commit: string,
  consoleOverrides: readonly ConsoleRuleOverride[] = [],
): Promise<RepoRules> {
  const overrides = new Map(
    consoleOverrides
      .filter((override) => isRulePath(override.path))
      .map((override) => [override.path, override]),
  )
  const files: RuleFile[] = []
  const layers: RuleLayerRecord[] = []
  for (const path of RULE_PATHS) {
    const file = await readRule(client, owner, name, commit, path)
    if (file !== null) {
      files.push(file)
      layers.push({ path, layer: 'repository', revision: null })
      continue
    }
    const override = overrides.get(path)
    if (override !== undefined) {
      validateText(path, override.content)
      if (override.content.trim() === '') throw new RulesError('rules_invalid', path, `${path} override is empty`)
      const bytes = Buffer.byteLength(override.content)
      if (bytes > MAX_RULE_FILE_BYTES) throw new RulesError('rules_invalid', path, `${path} override is larger than ${MAX_RULE_FILE_BYTES} bytes`)
      files.push({ path, sha256: sha256Hex(override.content), bytes, content: override.content, layer: 'console' })
      layers.push({ path, layer: 'console', revision: override.revision })
      continue
    }
    layers.push({ path, layer: 'builtin', revision: null })
  }
  const skills = await readSkills(client, owner, name, commit)
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0) + skills.reduce((sum, skill) => sum + skill.bytes, 0)
  if (totalBytes > MAX_RULES_TOTAL_BYTES) {
    throw new RulesError('rules_invalid', '.fledge', `rules and skills exceed ${MAX_RULES_TOTAL_BYTES} bytes`)
  }
  const effective = files.map((file) => `## ${file.path}\n${file.content.trimEnd()}`).join('\n\n')
  const hash = sha256Hex(JSON.stringify({
    commit,
    files: files.map((file) => [file.path, file.sha256, file.layer]),
    layers: layers.map((layer) => [layer.path, layer.layer, layer.revision]),
    skills: skills.map((skill) => [skill.path, skill.sha256]),
  }))
  return { owner, name, commit, files, skills, layers, effective, hash, totalBytes }
}

export function isRuleChange(path: string): boolean {
  return isRulePath(path) || path === SKILLS_DIR || path.startsWith(`${SKILLS_DIR}/`)
}
