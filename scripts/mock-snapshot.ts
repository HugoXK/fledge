import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// #777: the UI mock was a hand-written second application. It drifted from the
// real views because nothing regenerated or checked it. This script renders the
// real views with one deterministic seed, writes a static tree, and can compare
// that tree with the committed `mock/` in CI.
//
// Determinism rules:
//   - the clock is frozen before `src/` is imported;
//   - the session secret, CSRF token, user/repo/job ids and timestamps are fixed;
//   - JavaScript is omitted and forms/links are inert, so no request leaves the
//     page and no random id is created by a browser;
//   - the footer version is pinned to `v0.0.0-mock`, so a release bump does not
//     stale the snapshot.
const FIXED_NOW = Date.parse('2026-11-15T12:00:00Z')
const RealDate = Date
class FixedDate extends RealDate {
  constructor(...args: [] | [string | number | Date]) {
    if (args.length === 0) super(FIXED_NOW)
    else {
      const value = args[0]
      super(value instanceof RealDate ? value.getTime() : value)
    }
  }
  static override now(): number {
    return FIXED_NOW
  }
}
;(globalThis as { Date: DateConstructor }).Date = FixedDate as unknown as DateConstructor

const { buildApp } = await import('../src/app.js')
const { Store } = await import('../src/db.js')
const { MockRunner } = await import('../src/jobs/mock.js')
const { sha256Hex } = await import('../src/lib/secrets.js')
const { MemoryMailer, testConfig } = await import('../test/helpers.js')

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MOCK_DIR = join(ROOT, 'mock')

const at = (ms: number): string => new Date(FIXED_NOW + ms).toISOString()
const minutesAgo = (minutes: number): string => at(-minutes * 60_000)
const daysAgo = (days: number): string => at(-days * 86_400_000)

interface Seed {
  userId: string
  repoMainId: string
  repoSecondId: string
  jobSuccessId: string
  jobFailedId: string
}

function seed(store: InstanceType<typeof Store>): Seed {
  const user = store.upsertGithubUser({
    id: 'usr_mock',
    githubId: 900000001,
    login: 'HugoXK',
    name: 'Hugo XK',
    email: 'hugo@example.com',
    avatarUrl: null,
    isAdmin: false,
    isSuperAdmin: false,
    initialQuotaCny: 50,
  })
  store.setUserStatus(user.id, 'approved', 'mock-snapshot')
  store.setUserQuota(user.id, 50)
  const owner = store.userById(user.id)!

  const repoMain = store.createRepo({
    id: 'repo_fledge',
    userId: owner.id,
    owner: 'HugoXK',
    name: 'fledge',
    defaultBranch: 'main',
    tokenEnc: 'mock-token',
    goal: 'Keep Fledge tests, docs and scheduled work in step.',
    autoIterate: true,
    intervalMinutes: 1440,
    repoRole: 'maintainer',
    autoMerge: true,
    planRequired: true,
    allowPaths: 'src/, test/, docs/',
    denyPaths: '.github/, deploy/',
    monthlyBudgetCny: 200,
    jobBudgetCny: 20,
    jobBudgetAction: 'pause',
    permission: 'admin',
    canReview: true,
    reviewerEnabled: true,
    reviewIntervalMinutes: 1440,
    upstreamHtmlUrl: 'https://github.com/HugoXK/fledge',
  })
  const repoSecond = store.createRepo({
    id: 'repo_demo',
    userId: owner.id,
    owner: 'HugoXK',
    name: 'demo-app',
    defaultBranch: 'main',
    tokenEnc: 'mock-token',
    goal: 'Add focused tests for the highest-risk paths.',
    autoIterate: false,
    intervalMinutes: 60,
    repoRole: 'developer',
    permission: 'write',
    canReview: false,
  })

  const provider = store.createModelProvider({
    id: 'prv_mock',
    userId: owner.id,
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnc: 'mock-key-enc',
    allowPrivate: false,
    region: 'cn',
    dataPolicyUrl: 'https://api-docs.deepseek.com/',
    allowed: true,
  })
  const model = store.createProviderModel({ id: 'pvm_mock', providerId: provider.id, model: 'deepseek-chat', label: 'DeepSeek Chat' })
  store.setRepoModelSelection(repoMain.id, [model.id], model.id)
  for (const role of ['chief', 'lead', 'product', 'test', 'security', 'reviewer', 'dev1', 'dev2']) {
    store.setRepoBotModel(repoMain.id, role, model.id)
  }

  const jobSuccess = store.createJob({
    id: 'job_mock_success',
    repoId: repoMain.id,
    userId: owner.id,
    trigger: 'manual',
    goal: 'Fix the release verifier missing digest link.',
    callbackHash: 'cb_mock_success',
    platformTokenHash: '',
    kind: 'iterate',
    workType: 'iterate',
    createdAt: daysAgo(2),
  })
  store.updateJob(jobSuccess.id, {
    status: 'succeeded',
    summary: 'Fixed the release verifier missing digest link and added a regression test.',
    pr_url: 'https://github.com/HugoXK/fledge/pull/742',
    issue_url: 'https://github.com/HugoXK/fledge/issues/739',
    review_score: 88,
    cost_usd: 0.42,
    started_at: daysAgo(2),
    finished_at: at(-2 * 86_400_000 + 18 * 60_000),
  })

  const jobFailed = store.createJob({
    id: 'job_mock_failed',
    repoId: repoMain.id,
    userId: owner.id,
    trigger: 'schedule',
    goal: 'Continue the oldest open work item.',
    callbackHash: 'cb_mock_failed',
    platformTokenHash: '',
    kind: 'iterate',
    workType: 'iterate',
    createdAt: minutesAgo(55),
  })
  store.updateJob(jobFailed.id, {
    status: 'failed',
    error: 'bridge refused the run: FlyBot instance is still starting',
    error_code: 'BRIDGE_FAILED',
    started_at: minutesAgo(50),
    finished_at: minutesAgo(45),
  })

  store.createWorkItem({
    id: 'wi_mock_1',
    repoId: repoMain.id,
    userId: owner.id,
    title: 'Audit the schedule console after the planner change',
    detail: 'Check the row-vs-interval answer on the page, dashboard and digest.',
    state: 'triaged',
    priority: 2,
    issueUrl: 'https://github.com/HugoXK/fledge/issues/544',
  })
  store.createWorkItem({
    id: 'wi_mock_2',
    repoId: repoMain.id,
    userId: owner.id,
    title: 'Make the digest print the scheduled next run',
    detail: 'Use the same next-run choice as the repository page.',
    state: 'in_progress',
    priority: 1,
    jobId: jobFailed.id,
    issueUrl: 'https://github.com/HugoXK/fledge/issues/713',
  })
  store.createWorkItem({
    id: 'wi_mock_3',
    repoId: repoMain.id,
    userId: owner.id,
    title: 'Give the schedule facts a real console layout',
    detail: 'Replace the browser-default definition list.',
    state: 'pr_ready',
    priority: 2,
    prUrl: 'https://github.com/HugoXK/fledge/pull/745',
  })

  const schedule = store.saveSchedule({
    id: 'sch_mock',
    repoId: repoMain.id,
    kind: 'cron',
    expression: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
  })
  const revision = schedule.timing_revision
  const first = Date.parse('2026-11-14T01:00:00Z')
  const second = Date.parse('2026-11-15T01:00:00Z')
  store.claimScheduleOccurrence({
    id: 'occ_mock_1',
    scheduleId: schedule.id,
    repoId: repoMain.id,
    logicalTime: first,
    timingRevision: revision,
    leaseToken: 'lease_mock_1',
    leaseMs: 3_600_000,
    now: first - 60_000,
  })
  store.settleScheduleOccurrence({
    scheduleId: schedule.id,
    logicalTime: first,
    timingRevision: revision,
    leaseToken: 'lease_mock_1',
    state: 'dispatched',
    jobId: jobSuccess.id,
    dispatchedAt: first,
    lagMs: 120_000,
    now: first + 120_000,
  })
  store.claimScheduleOccurrence({
    id: 'occ_mock_2',
    scheduleId: schedule.id,
    repoId: repoMain.id,
    logicalTime: second,
    timingRevision: revision,
    leaseToken: 'lease_mock_2',
    leaseMs: 3_600_000,
    now: second - 60_000,
  })
  store.settleScheduleOccurrence({
    scheduleId: schedule.id,
    logicalTime: second,
    timingRevision: revision,
    leaseToken: 'lease_mock_2',
    state: 'skipped',
    reason: 'active-job',
    missed: 0,
    now: second + 60_000,
  })

  store.notify(owner.id, 'ops', 'PR #742 等待合并', 'PR_STALE')
  store.notify(owner.id, 'quota', '平台额度剩余 ¥50.00；首次运行可能不够用时，建议配置自己的模型。', 'QUOTA_COMFORT')
  store.createApiToken({
    id: 'tok_mock',
    userId: owner.id,
    kind: 'pat',
    name: 'laptop-cli',
    tokenHash: 'mock-token-hash',
    prefix: 'flg_mock',
    expiresAt: at(30 * 86_400_000),
  })

  return {
    userId: owner.id,
    repoMainId: repoMain.id,
    repoSecondId: repoSecond.id,
    jobSuccessId: jobSuccess.id,
    jobFailedId: jobFailed.id,
  }
}

interface Page {
  file: string
  label: string
  url: string
}

function pages(seedRow: Seed): Page[] {
  return [
    { file: 'dashboard.html', label: 'Dashboard', url: '/dashboard' },
    { file: 'console.html', label: 'Workspace', url: '/console' },
    { file: 'repository.html', label: 'Repository detail', url: `/repos/${seedRow.repoMainId}` },
    { file: 'repository-demo.html', label: 'Repository detail (developer)', url: `/repos/${seedRow.repoSecondId}` },
    { file: 'schedule-console.html', label: 'Schedule console', url: `/repos/${seedRow.repoMainId}/schedule` },
    { file: 'job.html', label: 'Job detail', url: `/repos/${seedRow.repoMainId}/jobs/${seedRow.jobFailedId}` },
    { file: 'settings.html', label: 'Settings', url: '/settings' },
    { file: 'add-repository.html', label: 'Add repository', url: '/repos/new' },
    { file: 'schedule-preview.html', label: 'Schedule preview', url: '/schedule?mode=daily&daily_time=09:00&timezone=Asia/Shanghai&count=5' },
  ]
}

function localPage(path: string, seedRow: Seed): string {
  const clean = path === '' || path === '/' ? '/' : path.replace(/\/+$/, '')
  if (clean === '/') return 'index.html'
  if (clean === '/dashboard') return 'dashboard.html'
  if (clean === '/console') return 'console.html'
  if (clean === '/repos') return 'dashboard.html'
  if (clean === '/repos/new') return 'add-repository.html'
  if (clean === `/repos/${seedRow.repoMainId}`) return 'repository.html'
  if (clean === `/repos/${seedRow.repoSecondId}`) return 'repository-demo.html'
  if (clean === `/repos/${seedRow.repoMainId}/schedule`) return 'schedule-console.html'
  if (clean.startsWith(`/repos/${seedRow.repoMainId}/jobs/`)) return 'job.html'
  if (clean === '/settings') return 'settings.html'
  if (clean === '/schedule') return 'schedule-preview.html'
  return ''
}

function isExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}

function rewriteHref(value: string, seedRow: Seed): string {
  if (value === '' || value.startsWith('#') || value.startsWith('assets/') || isExternalUrl(value)) return value
  const [beforeHash, hash] = value.split('#', 2)
  const pathPart = (beforeHash ?? '').split('?')[0] ?? ''
  const local = localPage(pathPart, seedRow)
  if (local === '') return '#'
  return hash === undefined ? local : `${local}#${hash}`
}

// The generator owns this HTML, so a small tag walker is enough to drop the
// layout's script elements. A regex that strips tags is the class of sanitizer
// CodeQL flags (`js/incomplete-multi-character-sanitization`); this walker reads
// the exact closing tag and keeps every other byte.
function stripScripts(html: string): string {
  const lower = html.toLowerCase()
  let out = ''
  let index = 0
  for (;;) {
    const start = lower.indexOf('<script', index)
    if (start === -1) return out + html.slice(index)
    out += html.slice(index, start)
    const end = lower.indexOf('</script>', start)
    if (end === -1) return out
    index = end + '</script>'.length
    while (index < html.length && /\s/.test(html[index] ?? '')) index += 1
  }
}

function rewrite(html: string, seedRow: Seed, csrf: string): string {
  let out = html.split(csrf).join('mock-csrf')
  // The command helpers mint a fresh idempotency key on every render. A snapshot
  // has no submit path, so one stable placeholder is the honest value.
  out = out.replace(/cmd_[A-Za-z0-9_-]+/g, 'cmd_mock')
  out = out.replace(/(href|src)="\/assets\/([^"]+)"/g, '$1="assets/$2"')
  out = stripScripts(out)
  out = out.replace(/href="([^"]*)"/g, (_match, href: string) => `href="${rewriteHref(href, seedRow)}"`)
  out = out.replace(/<form\b([^>]*)>/g, (_match, attrs: string) => {
    const withoutAction = attrs.replace(/\baction="[^"]*"/g, 'action="#"')
    return `<form${withoutAction} data-mock-inert onsubmit="return false;">`
  })
  // A release bump must not stale the snapshot; the footer version is a mock
  // marker, not the running package version.
  out = out.replace(/(<span class="foot-release">)v[^<]*(<\/span>)/g, '$1v0.0.0-mock$2')
  out = out.replace(
    '<main class="wrap" id="main">',
    '<main class="wrap" id="main">\n<div class="banner" data-mock-snapshot>静态快照 · 由 <code>npm run mock:snapshot</code> 从真实视图生成；表单和链接不会提交。Static snapshot generated from the real views; forms and links are inert.</div>',
  )
  return out
}

function gallery(pageList: Page[]): string {
  const items = pageList.map((page) => `<li><a href="${page.file}">${page.label}</a></li>`).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex" />
  <title>Fledge UI snapshot</title>
  <link rel="stylesheet" href="assets/app.css" />
</head>
<body>
  <main class="wrap">
    <section class="card">
      <div class="eyebrow">FLEDGE UI SNAPSHOT</div>
      <h1>静态界面快照</h1>
      <p class="muted">由 <code>npm run mock:snapshot</code> 从真实视图和固定演示数据生成。不要手工修改；表单和链接不会提交，JavaScript 已移除。</p>
      <ul>${items}</ul>
      <p class="fine">重新生成：<code>npm run mock:snapshot</code> · 检查是否过期：<code>npm run mock:check</code></p>
    </section>
  </main>
</body>
</html>
`
}

function readme(pageList: Page[]): string {
  const rows = pageList.map((page) => `- [${page.label}](${page.file})`).join('\n')
  return `# Fledge UI snapshot

Generated by \`npm run mock:snapshot\` from the real \`src/views/\` with a fixed demo
seed. **Do not edit these files by hand.** Re-run the generator after a UI change
and commit the result; \`npm run mock:check\` fails when the tree is stale.

Captured pages:

${rows}

The snapshot is read-only: forms and links are inert and JavaScript is omitted.
The footer version is pinned to \`v0.0.0-mock\` so a release bump does not stale
the tree. No real user data or secret is used; the seed is fictional.
`
}

function listFiles(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

function compare(expected: string, actual: string): string[] {
  const expectedFiles = listFiles(expected)
  const actualFiles = listFiles(actual)
  const problems: string[] = []
  for (const file of expectedFiles) {
    const actualPath = join(actual, file)
    if (!existsSync(actualPath)) {
      problems.push(`${file} is missing`)
      continue
    }
    if (!readFileSync(join(expected, file)).equals(readFileSync(actualPath))) problems.push(`${file} differs`)
  }
  for (const file of actualFiles) {
    if (!expectedFiles.includes(file)) problems.push(`${file} is no longer generated`)
  }
  return problems
}

async function generate(output: string): Promise<number> {
  rmSync(output, { recursive: true, force: true })
  mkdirSync(join(output, 'assets'), { recursive: true })
  // Every stylesheet the product serves, not just the main one: a mock page
  // links whatever `public/` holds, so a second sheet added there is part of the
  // rendered snapshot. Naming one file left `workspace-brand.css` out of
  // `mock/assets/` and kept a stale copy of the sheet that was named.
  const sheets = readdirSync(join(ROOT, 'public')).filter((file) => file.endsWith('.css')).sort()
  for (const sheet of sheets) {
    copyFileSync(join(ROOT, 'public', sheet), join(output, 'assets', sheet))
  }

  const config = testConfig()
  config.env = 'test'
  config.baseUrl = 'https://fledge.example'
  config.dataDir = join(tmpdir(), 'fledge-mock-snapshot')
  config.sessionSecret = Buffer.from('mock-snapshot-session-secret-000000').toString('base64')
  config.tokenEncryptionKey = Buffer.from('mock-snapshot-token-key-000000000000').toString('base64')
  config.runner.mode = 'mock'
  config.runner.bridgeUrl = ''
  config.runner.bridgeToken = ''
  config.flybot.instanceImage = ''
  config.llm = { baseUrl: 'https://platform.example/v1', key: 'mock-platform-key', model: 'platform-model', pricePerTokenUsd: 0.0000002 }
  config.quota.initialCny = 1
  config.quota.usdCny = 7.2
  config.quota.comfortCny = 50
  config.mail.transport = 'console'
  config.githubApp.id = '12345'
  config.githubApp.slug = 'fledge-mock'
  config.githubApp.privateKeyPath = join(tmpdir(), 'fledge-mock-app.pem')
  config.githubApp.webhookSecret = 'mock-webhook-secret'
  config.devLogin.login = ''
  config.allowTokenLoginOnly = true

  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const seedRow = seed(store)
    const rawSession = 'mock-snapshot-session'
    const sessionHash = sha256Hex(rawSession)
    store.createSession({
      idHash: sessionHash,
      userId: seedRow.userId,
      expiresAt: at(30 * 86_400_000),
      recentAuthAt: at(0),
      ip: '127.0.0.1',
      userAgent: 'mock-snapshot',
    })
    const csrf = built.sessions.csrfFor(sessionHash)
    const cookie = `fledge_session=${rawSession}; fledge_csrf=${csrf}; fledge_lang=zh`
    const pageList = pages(seedRow)
    for (const page of pageList) {
      const response = await built.app.inject({
        method: 'GET',
        url: page.url,
        headers: { cookie, 'user-agent': 'mock-snapshot' },
      })
      if (response.statusCode !== 200) {
        throw new Error(`${page.url} answered ${String(response.statusCode)}: ${response.body.slice(0, 200)}`)
      }
      writeFileSync(join(output, page.file), rewrite(response.body, seedRow, csrf))
    }
    writeFileSync(join(output, 'index.html'), gallery(pageList))
    writeFileSync(join(output, 'README.md'), readme(pageList))
    return listFiles(output).length
  } finally {
    await built.close()
  }
}

const check = process.argv.includes('--check')
// The target is always one this script owns: `mock/` for a regeneration, a fresh
// temporary directory for a check. There is no `--output`: `generate()` clears
// its target first, so a flag that took any path would give a typo the power to
// delete a directory the script did not create.
const output = check ? mkdtempSync(join(tmpdir(), 'fledge-mock-check-')) : MOCK_DIR

if (check) {
  const expectedCount = await generate(output)
  try {
    const problems = compare(output, MOCK_DIR)
    if (problems.length > 0) {
      console.error('mock-snapshot: mock/ is stale. Run `npm run mock:snapshot` and commit the result.')
      for (const problem of problems.slice(0, 30)) console.error(`- ${problem}`)
      if (problems.length > 30) console.error(`- … ${String(problems.length - 30)} more`)
      process.exitCode = 1
    } else {
      console.log(`mock-snapshot: ok (${String(expectedCount)} files)`)
    }
  } finally {
    // A check always writes into a fresh temporary directory, so it always
    // removes it; a regeneration wrote into `mock/` and leaves it in place.
    rmSync(output, { recursive: true, force: true })
  }
} else {
  const count = await generate(output)
  console.log(`mock-snapshot: wrote ${String(count)} files to ${output}`)
}
