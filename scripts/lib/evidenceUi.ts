import type { Store } from '../../src/db.js'

// #1271: the repeatable version of the pair that was produced by hand for #1249
// and #1266. The tool is a capture tool, not a gate: it does not open a PR, move
// a tip or decide whether the images are good enough. The pure half lives here so
// argument, plan and fixture tests do not need a browser.
export const EVIDENCE_REPO = 'HugoXK/fledge'
export const EVIDENCE_SELECTOR_MAX = 500
export const EVIDENCE_PATH_MAX = 300

export type EvidenceLocale = 'en' | 'zh'
export type EvidencePhase = 'before' | 'after'

export interface EvidenceArgs {
  issue: number
  path: string
  selector: string
  base: string
  head: string
  locales: EvidenceLocale[]
  widths: number[]
  open: string[]
  push: boolean
  keep: boolean
  dryRun: boolean
}

export interface EvidencePlanItem {
  phase: EvidencePhase
  locale: EvidenceLocale
  width: number
  file: string
  rawUrl: string
}

export interface EvidenceFixture {
  userId: string
  repoId: string
  jobId: string
  reapedJobId: string
  path: string
}

const LOOP = new Set(['en', 'zh'])
const ISSUE = /^[1-9][0-9]{0,8}$/
const WIDTH = /^[1-9][0-9]{2,4}$/

function valueOf(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

function valuesOf(argv: string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue
    const value = argv[index + 1]
    if (value !== undefined && !value.startsWith('--')) values.push(value)
  }
  return values
}

function list(value: string | undefined, fallback: string): string[] {
  return [...new Set((value ?? fallback).split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''))]
}

export function parseEvidenceArgs(argv: string[]): { ok: true; args: EvidenceArgs } | { ok: false; error: string } {
  const rawIssue = valueOf(argv, '--issue')
  if (rawIssue === undefined || !ISSUE.test(rawIssue)) return { ok: false, error: '--issue must be a positive integer' }
  const rawPath = valueOf(argv, '--path')
  if (rawPath === undefined || !rawPath.startsWith('/') || rawPath.length > EVIDENCE_PATH_MAX) {
    return { ok: false, error: '--path must be a local path starting with /' }
  }
  const selector = valueOf(argv, '--selector')
  if (selector === undefined || selector.trim() === '' || selector.length > EVIDENCE_SELECTOR_MAX) {
    return { ok: false, error: '--selector must be a non-empty CSS selector' }
  }
  const locales = list(valueOf(argv, '--locales'), 'en,zh')
  if (locales.some((locale) => !LOOP.has(locale))) return { ok: false, error: '--locales may contain only en and zh' }
  const widths = list(valueOf(argv, '--widths'), '1280,390').map(Number)
  if (widths.some((width) => !Number.isInteger(width) || width <= 0 || !WIDTH.test(String(width)))) {
    return { ok: false, error: '--widths must be positive integer pixel widths' }
  }
  for (const argument of argv) {
    if (argument.startsWith('--') && !['--issue', '--path', '--selector', '--base', '--head', '--locales', '--widths', '--open', '--push', '--keep', '--dry-run'].includes(argument)) {
      return { ok: false, error: `unknown argument ${argument}` }
    }
  }
  return {
    ok: true,
    args: {
      issue: Number(rawIssue),
      path: rawPath,
      selector,
      base: valueOf(argv, '--base') ?? 'origin/main',
      head: valueOf(argv, '--head') ?? 'HEAD',
      locales: locales as EvidenceLocale[],
      widths: [...new Set(widths)],
      open: valuesOf(argv, '--open'),
      push: argv.includes('--push'),
      keep: argv.includes('--keep'),
      dryRun: argv.includes('--dry-run'),
    },
  }
}

export function evidenceBranch(issue: number): string {
  return `evidence/${String(issue)}`
}

export function evidencePlan(args: EvidenceArgs): EvidencePlanItem[] {
  const items: EvidencePlanItem[] = []
  for (const phase of ['before', 'after'] as const) {
    for (const locale of args.locales) {
      for (const width of args.widths) {
        const file = `${phase}-${locale}-${String(width)}.png`
        items.push({
          phase,
          locale,
          width,
          file: `docs/images/${String(args.issue)}/${file}`,
          rawUrl: `https://raw.githubusercontent.com/${EVIDENCE_REPO}/${evidenceBranch(args.issue)}/docs/images/${String(args.issue)}/${file}`,
        })
      }
    }
  }
  return items
}

export function evidenceSummary(args: EvidenceArgs, plan: EvidencePlanItem[]): string {
  const rows = plan.map((item) => `| ${item.phase} ${item.locale} ${String(item.width)} | ![${item.phase} ${item.locale} ${String(item.width)}](${item.rawUrl}) |`)
  return [
    '## Evidence',
    '',
    `Same seeded database for every image: one live lease and one reaped attempt; the BEFORE is \`${args.base}\`, the AFTER is \`${args.head}\`, and the selector is \`${args.selector}\` on \`${args.path}\`.`,
    '',
    '| View | Image |',
    '|---|---|',
    ...rows,
    '',
    `The images are on \`${evidenceBranch(args.issue)}\` under \`docs/images/${String(args.issue)}/\`.`,
    '',
  ].join('\n')
}

/**
 * The one fixture a UI PR needs in this tree: the dev user, a repository with
 * branch protection on, one live lease and one reaped attempt. It is code, not a
 * production copy, and it creates the reaped job first so the one-active-per-repo
 * index is never asked to hold two live rows.
 */
export function seedEvidenceFixture(store: Store): EvidenceFixture {
  const user = store.upsertGithubUser({
    id: 'usr_evidence_ui',
    githubId: -1,
    login: 'visual-matrix',
    name: 'Evidence',
    email: 'evidence@example.invalid',
    avatarUrl: null,
    isAdmin: false,
    isSuperAdmin: true,
    initialQuotaCny: 0,
  })
  store.setUserStatus(user.id, 'approved', 'evidence-ui')
  const repo = store.createRepo({
    id: 'repo_evidence_ui',
    userId: user.id,
    owner: 'octo',
    name: 'evidence',
    defaultBranch: 'main',
    tokenEnc: '',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: 'evidence',
    autoIterate: false,
    intervalMinutes: 1440,
    autoMerge: true,
    requireProtection: true,
    protectionState: 'unknown',
  })
  const now = Date.now()
  const iso = (ms: number): string => new Date(ms).toISOString()
  const reaped = store.createJob({
    id: 'job_evidence_reaped',
    repoId: repo.id,
    userId: user.id,
    trigger: 'schedule',
    goal: 'evidence reaped lease',
    callbackHash: 'cb_evidence_reaped',
    platformTokenHash: '',
    kind: 'review',
  })
  const attempt = store.startJobAttempt(reaped.id, 'worker:evidence', 300_000)
  if (!attempt) throw new Error('the fixture could not start the reaped attempt')
  store.claimJobTerminal(
    reaped.id,
    'failed',
    null,
    { error: 'lease expired', finished_at: iso(now - 10 * 60_000) },
    { epoch: attempt.epoch, outcome: 'reaped', error: 'lease expired' },
  )
  store.run('UPDATE job_attempts SET finished_at = ? WHERE job_id = ?', iso(now - 10 * 60_000), reaped.id)
  const live = store.createJob({
    id: 'job_evidence_live',
    repoId: repo.id,
    userId: user.id,
    trigger: 'schedule',
    goal: 'evidence live lease',
    callbackHash: 'cb_evidence_live',
    platformTokenHash: '',
    kind: 'iterate',
  })
  if (!store.startJobAttempt(live.id, 'worker:evidence', 300_000)) throw new Error('the fixture could not start the live attempt')
  store.run('UPDATE jobs SET started_at = ?, lease_until = ? WHERE id = ?', iso(now - 5 * 60_000), iso(now + 2 * 60_000), live.id)
  store.run('UPDATE job_attempts SET started_at = ? WHERE job_id = ?', iso(now - 5 * 60_000), live.id)
  return { userId: user.id, repoId: repo.id, jobId: live.id, reapedJobId: reaped.id, path: `/repos/${repo.id}` }
}
