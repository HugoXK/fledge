import type { Config } from '../config.js'
import type { AuditRow, JobRow, NotificationRow, RepoInstanceRow, RepoRow, UserRow, ApiTokenRow } from '../db.js'
import { agreementContent } from '../users/agreements.js'
import { quotaView } from '../gateway/quota.js'
import { humanTimeShort } from '../lib/time.js'
import { ITERATION_INTERVALS, REVIEW_INTERVALS, intervalLabel, normalizeInterval } from '../lib/intervals.js'
import { escapeHtml, layout, money, quotaMoney, type Viewer } from './layout.js'
import { localizeMessage, translator, type Locale, type Translate } from '../i18n.js'
import { parseTeam, type TeamLiveState } from '../flybot/instances.js'

function csrf(viewer: Viewer): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}" />`
}

function agreementHtml(text: string): string {
  return text
    .split(/\n\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function statusLabel(t: Translate, status: string): string {
  const labels: Record<string, string> = {
    succeeded: t('成功', 'Succeeded'),
    failed: t('失败', 'Failed'),
    running: t('运行中', 'Running'),
    queued: t('排队中', 'Queued'),
    approved: t('已批准', 'Approved'),
    rejected: t('已拒绝', 'Rejected'),
    pending: t('待审批', 'Pending'),
    onboarding: t('待申请', 'Onboarding'),
    idle: t('空闲', 'Idle'),
    quota_exhausted: t('额度用完', 'Quota exhausted'),
    ready: t('就绪', 'Ready'),
    starting: t('启动中', 'Starting'),
    provisioning: t('初始化中', 'Provisioning'),
    stopped: t('已停止', 'Stopped'),
    starting_container: t('启动容器', 'Starting container'),
  }
  return labels[status] ?? status
}

function badge(t: Translate, status: string): string {
  const cls = status === 'succeeded' || status === 'approved' ? 'badge good' : status === 'failed' || status === 'rejected' ? 'badge bad' : status === 'running' || status === 'queued' || status === 'pending' ? 'badge busy' : 'badge'
  return `<span class="${cls}">${escapeHtml(statusLabel(t, status))}</span>`
}

function triggerLabel(t: Translate, trigger: string): string {
  if (trigger === 'manual') return t('手动', 'Manual')
  if (trigger === 'schedule') return t('定时', 'Scheduled')
  return trigger
}

function roleLabel(t: Translate, role: string): string {
  if (role === 'admin') return t('管理员', 'Admin')
  if (role === 'user') return t('用户', 'User')
  return role
}

function permissionLabel(t: Translate, permission: string): string {
  const labels: Record<string, [string, string]> = {
    admin: ['管理员', 'Admin'],
    maintain: ['维护者', 'Maintainer'],
    write: ['写入', 'Write'],
    triage: ['分诊', 'Triage'],
    read: ['只读', 'Read'],
    none: ['无', 'None'],
  }
  const value = labels[permission]
  return value === undefined ? permission : t(value[0], value[1])
}

function intervalOptions(t: Translate, selected = 1440, values = ITERATION_INTERVALS): string {
  const current = normalizeInterval(selected)
  const list = values.includes(current) ? values : [...values, current].sort((a, b) => a - b)
  return list
    .map((value) => `<option value="${value}"${value === current ? ' selected' : ''}>${escapeHtml(intervalLabel(value, t))}</option>`)
    .join('')
}

function reviewIntervalOptions(t: Translate, selected = 1440): string {
  return intervalOptions(t, selected, REVIEW_INTERVALS)
}

function jobKindLabel(t: Translate, job: JobRow): string {
  return job.kind === 'review' ? t('审核', 'Review') : t('迭代', 'Iterate')
}

function jobLinks(job: JobRow): string {
  const links = [
    job.pr_url === null ? '' : `<a href="${escapeHtml(job.pr_url)}" target="_blank" rel="noreferrer">PR</a>`,
    job.issue_url === null ? '' : `<a href="${escapeHtml(job.issue_url)}" target="_blank" rel="noreferrer">Issue</a>`,
  ].filter((link) => link !== '')
  return links.length === 0 ? '—' : links.join(' · ')
}

function jobSummary(t: Translate, job: JobRow): string {
  const raw = (job.summary ?? job.error ?? '').trim()
  if (job.kind === 'review') {
    const score = job.review_score === null ? '' : ` · ${job.review_score}/100`
    const meaningful = raw !== '' && raw !== 'probe' && raw.length >= 12
    return meaningful ? `${raw}${score}` : `${t('审核完成', 'Review completed')}${score}`
  }
  if (raw === '' || raw === 'probe' || raw.length < 8) {
    if (job.status === 'succeeded') return t('任务完成', 'Job completed')
    if (job.status === 'failed') return t('任务失败', 'Job failed')
    return '—'
  }
  return raw
}

const ATTRIBUTION_LABELS: Array<[string, string, string]> = [
  ['writtenBy', '编写', 'Written by'],
  ['claimedBy', '领取', 'Claimed by'],
  ['implementedBy', '实现', 'Implemented by'],
  ['testedBy', '测试', 'Tested by'],
  ['reviewedBy', '审核', 'Reviewed by'],
]

function jobAttribution(t: Translate, job: JobRow): string {
  if (job.attribution_json === null) return ''
  try {
    const parsed = JSON.parse(job.attribution_json) as Record<string, unknown>
    return ATTRIBUTION_LABELS
      .map(([key, zh, en]) => {
        const value = parsed[key]
        return typeof value === 'string' && value.trim() !== '' ? `${t(zh, en)}: ${value}` : ''
      })
      .filter((value) => value !== '')
      .join(' · ')
  } catch {
    return ''
  }
}

function jobRows(locale: Locale, jobs: JobRow[]): string {
  const t = translator(locale)
  if (jobs.length === 0) return `<tr><td colspan="6" class="muted">${escapeHtml(t('还没有任务。', 'No jobs yet.'))}</td></tr>`
  return jobs
    .map(
      (job) => `<tr data-job-id="${escapeHtml(job.id)}">
        <td><code>${escapeHtml(job.id)}</code> <span class="badge kind">${escapeHtml(jobKindLabel(t, job))}</span></td>
        <td data-job-status>${badge(t, job.status)}</td>
        <td>${escapeHtml(triggerLabel(t, job.trigger))}</td>
        <td>${jobLinks(job)}</td>
        <td data-job-summary><span data-job-summary-text>${escapeHtml(jobSummary(t, job)).slice(0, 120)}</span>${jobAttribution(t, job) === '' ? '' : `<br /><small class="muted" data-job-attribution>${escapeHtml(jobAttribution(t, job))}</small>`}</td>
        <td>${escapeHtml(humanTimeShort(job.created_at))}</td>
      </tr>`,
    )
    .join('')
}

function jobList(locale: Locale, jobs: JobRow[]): string {
  const t = translator(locale)
  if (jobs.length === 0) return `<p class="muted">${escapeHtml(t('还没有任务。', 'No jobs yet.'))}</p>`
  return `<div class="list">${jobs
    .map(
      (job) => `<div class="list-row">
        <div class="list-main">
          <div class="list-title">${badge(t, job.status)} <span class="badge kind">${escapeHtml(jobKindLabel(t, job))}</span> <span>${escapeHtml(jobSummary(t, job).slice(0, 120))}</span></div>
          <small><code>${escapeHtml(job.id)}</code> · ${escapeHtml(triggerLabel(t, job.trigger))} · ${escapeHtml(humanTimeShort(job.created_at))}</small>
        </div>
        <span class="list-meta">${jobLinks(job)}</span>
      </div>`,
    )
    .join('')}</div>`
}

function noticeBlock(locale: Locale, viewer: Viewer, notifications: NotificationRow[]): string {
  const t = translator(locale)
  const unread = notifications.filter((entry) => entry.read_at === null)
  if (unread.length === 0) return ''
  return `<div class="card notices"><h2>${escapeHtml(t('通知', 'Notifications'))}</h2>${unread
    .slice(0, 3)
    .map((entry) => `<div class="notice"><span>${escapeHtml(entry.message)}</span><small>${escapeHtml(humanTimeShort(entry.created_at))}</small></div>`)
    .join('')}<form method="post" action="/notifications/read">${csrf(viewer)}<button class="link" type="submit">${escapeHtml(t('全部标为已读', 'Mark all read'))}</button></form></div>`
}

export function landingPage(config: Config, viewer?: Viewer | null, devLogin = false, oauthConfigured = true, locale: Locale = 'zh'): string {
  const t = translator(locale)
  const tokenForm = `<details class="card narrow" id="token-login" open style="margin:24px 0 0">
      <summary>${escapeHtml(t('使用 GitHub token 登录（备用）', 'Sign in with a GitHub token (fallback)'))}</summary>
      <form method="post" action="/auth/token" class="form">
        <label>${escapeHtml(t('GitHub token', 'GitHub token'))} <input name="token" type="password" placeholder="github_pat_… 或 ghp_…" required autocomplete="off" /></label>
        <p class="fine">${escapeHtml(t('只用于确认 GitHub 身份，不会保存。仓库 token 在添加仓库时单独填写。', 'Used only to confirm your GitHub identity and never stored. Repository tokens are entered separately when you add a repository.'))}</p>
        <button class="btn" type="submit">${escapeHtml(t('用 token 登录', 'Sign in with token'))}</button>
      </form>
    </details>`
  const body = `<section class="hero">
    <div class="hero-copy">
      <div class="eyebrow">${escapeHtml(t('托管 · 自我迭代 · 可审查', 'HOSTED · SELF-ITERATING · REVIEWABLE'))}</div>
      <h1>${escapeHtml(t('让仓库自己长大。', 'Let your repositories grow.'))}</h1>
      <p class="lede">${escapeHtml(t('把多个 GitHub 仓库交给 Fledge。FlyBot 会持续阅读代码、写失败的测试、修最小的根因，并开一个你可以审查的 PR。你只需要决定合不合。', 'Hand several GitHub repositories to Fledge. FlyBot reads the code, writes a failing test, fixes the smallest root cause and opens a pull request you can review. You only decide whether to merge.'))}</p>
      <div class="actions">
        ${oauthConfigured ? `<a class="btn" href="/auth/github">${escapeHtml(t('使用 GitHub 登录', 'Sign in with GitHub'))}</a>` : `<a class="btn" href="#token-login">${escapeHtml(t('使用 GitHub token 登录', 'Sign in with a GitHub token'))}</a>`}
        ${devLogin ? `<a class="btn btn-ghost" href="/auth/dev">${escapeHtml(t('Dev 登录（本地）', 'Dev sign-in (local)'))}</a>` : ''}
        <a class="btn btn-ghost" href="https://github.com/HugoXK/fledge" target="_blank" rel="noreferrer">${escapeHtml(t('看源码', 'View source'))}</a>
      </div>
    </div>
    <aside class="loop-card" aria-label="${escapeHtml(t('Fledge 迭代循环', 'Fledge iteration loop'))}">
      <div class="loop-head"><span>${escapeHtml(t('迭代循环', 'FLEDGE LOOP'))}</span><span class="loop-tag">${escapeHtml(t('只开 PR', 'PR ONLY'))}</span></div>
      <ol class="loop-steps">
        <li class="loop-step"><span class="loop-num">01</span><div><b>${escapeHtml(t('接入', 'Connect'))}</b><small>${escapeHtml(t('GitHub 登录 + 仓库 token', 'GitHub sign-in + repo token'))}</small></div></li>
        <li class="loop-step"><span class="loop-num">02</span><div><b>${escapeHtml(t('测试', 'Test'))}</b><small>${escapeHtml(t('先写一个失败的测试', 'Write a failing test first'))}</small></div></li>
        <li class="loop-step"><span class="loop-num">03</span><div><b>${escapeHtml(t('修复', 'Fix'))}</b><small>${escapeHtml(t('改最小的根因', 'Fix the smallest root cause'))}</small></div></li>
        <li class="loop-step"><span class="loop-num">04</span><div><b>${escapeHtml(t('审查', 'Review'))}</b><small>${escapeHtml(t('你决定合不合', 'You decide whether to merge'))}</small></div></li>
      </ol>
      <div class="loop-foot">${escapeHtml(t('一个 issue → 一个分支 → 一个 PR', 'one issue → one branch → one PR'))}</div>
    </aside>
    <div class="hero-note">
      <p class="fine">${escapeHtml(t('首次登录需要 GitHub 授权；没有权限时先签署《免责声明》和《信息安全承诺》，提交后可在状态页查看排队位置，不要重复提交。平台初始额度 1 元；用完后配置自己的模型 API 即可继续。', 'The first sign-in needs GitHub authorization. Without access, sign the Disclaimer and the Information Security Commitment first; after submitting, the status page shows your queue position. Do not submit twice. The platform starts with 1 CNY of quota; when it runs out, add your own model API to continue.'))}</p>
      ${oauthConfigured ? '' : `<p class="fine">${escapeHtml(t('OAuth App 尚未配置；先用 GitHub token 登录（只用于确认身份，不会保存），部署后可在 .env 补 OAuth。', 'The OAuth App is not configured yet. Use the GitHub token fallback (identity only, never stored); add OAuth in .env after deployment.'))}</p>`}
      ${oauthConfigured ? '' : tokenForm}
    </div>
  </section>
  <section class="grid3">
    <article class="card feature"><span class="feature-num">01 / REPOS</span><h3>${escapeHtml(t('多仓库', 'Many repositories'))}</h3><p>${escapeHtml(t('一个账号绑定多个仓库，每个仓库有自己的目标、节奏和状态。', 'One account can connect several repositories, each with its own goal, cadence and state.'))}</p></article>
    <article class="card feature"><span class="feature-num">02 / PR</span><h3>${escapeHtml(t('可审查', 'Reviewable'))}</h3><p>${escapeHtml(t('每个任务只产出一个聚焦的 PR。不直接推 main，不自动合并，不隐藏改动。', 'Every job produces one focused pull request. No direct pushes to main, no automatic merges, no hidden changes.'))}</p></article>
    <article class="card feature"><span class="feature-num">03 / MODEL</span><h3>${escapeHtml(t('自己的模型', 'Bring your own model'))}</h3><p>${escapeHtml(t('平台额度用完不会停摆：填入任意 OpenAI 兼容服务，任务继续跑。', 'Running out of platform quota does not stop you: connect any OpenAI-compatible service and jobs keep running.'))}</p></article>
  </section>`
  return layout({ title: t('让仓库自己长大', 'Let your repositories grow'), viewer, body, config, locale, path: '/' })
}

export function pendingPage(config: Config, viewer: Viewer, locale: Locale = 'zh'): string {
  const t = translator(locale)
  const body = `<section class="card narrow">
    <div class="eyebrow">${escapeHtml(t('申请待审批', 'APPLICATION PENDING'))}</div>
    <h1>${escapeHtml(t('申请已提交', 'Application submitted'))}</h1>
    <p>${escapeHtml(t(`@${viewer.user.login}，你的访问申请已经发送给管理员 ${config.mail.adminEmail}。`, `@${viewer.user.login}, your access request was sent to the administrator ${config.mail.adminEmail}.`))}</p>
    <p class="muted">${escapeHtml(t(`批准后会收到邮件。通过后刷新本页即可进入控制台。申请状态：${statusLabel(t, viewer.user.status)}`, `You will receive email after approval. Refresh this page to enter the dashboard once approved. Status: ${statusLabel(t, viewer.user.status)}`))}</p>
    <form method="post" action="/auth/logout">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('退出登录', 'Sign out'))}</button></form>
  </section>`
  return layout({ title: t('申请已提交', 'Application submitted'), viewer, body, config, locale, path: '/apply/status' })
}

export function rejectedPage(config: Config, viewer: Viewer, locale: Locale = 'zh'): string {
  const t = translator(locale)
  const body = `<section class="card narrow">
    <h1>${escapeHtml(t('申请未通过', 'Application not approved'))}</h1>
    <p>${escapeHtml(t(`@${viewer.user.login}，这次申请没有通过。如果情况有变化，可以稍后重新登录申请。`, `@${viewer.user.login}, this application was not approved. If your situation changes, you can sign in and apply again later.`))}</p>
    <form method="post" action="/auth/logout">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('退出登录', 'Sign out'))}</button></form>
  </section>`
  return layout({ title: t('申请未通过', 'Application not approved'), viewer, body, config, locale, path: '/apply/status' })
}

export function dashboardPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  repos: RepoRow[]
  jobs: JobRow[]
  notifications: NotificationRow[]
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, repos, jobs, notifications, notice, error } = input
  const t = translator(locale)
  const quota = quotaView(viewer.user, config)
  const repoRows = repos.length === 0
    ? `<tr><td colspan="5" class="muted">${escapeHtml(t('还没有仓库。先添加一个。', 'No repositories yet. Add one first.'))}</td></tr>`
    : repos
        .map(
          (repo) => `<tr>
            <td><a href="/repos/${escapeHtml(repo.id)}"><strong>${escapeHtml(repo.upstream_owner || repo.owner)}/${escapeHtml(repo.upstream_name || repo.name)}</strong></a>${repo.is_fork === 1 ? `<br /><small class="muted">${escapeHtml(t('fork', 'fork'))} ${escapeHtml(repo.fork_owner)}/${escapeHtml(repo.fork_name)}</small>` : ''}${repo.reviewer_enabled === 1 ? ' <span class="badge">reviewer</span>' : ''}</td>
            <td>${repo.auto_iterate === 1 ? `<span class="badge good">${escapeHtml(t('自动', 'Auto'))}</span><br /><small class="muted">${escapeHtml(intervalLabel(repo.interval_minutes, t))}</small>` : `<span class="badge">${escapeHtml(t('手动', 'Manual'))}</span>`}</td>
            <td>${badge(t, repo.last_status ?? 'idle')}</td>
            <td>${escapeHtml(humanTimeShort(repo.last_run_at))}</td>
            <td><a class="link" href="/repos/${escapeHtml(repo.id)}">${escapeHtml(t('打开', 'Open'))}</a></td>
          </tr>`,
        )
        .join('')
  const body = `<section class="workspace-hero">
    <div class="workspace-intro">
      <div class="eyebrow">${escapeHtml(t('仓库', 'REPOSITORIES'))}</div>
      <h1>${escapeHtml(t('仓库', 'Repositories'))}</h1>
      <p class="muted">${escapeHtml(t('接入仓库、设置迭代目标，并查看最近任务。', 'Connect repositories, set iteration goals and review recent jobs.'))}</p>
    </div>
    <div class="workspace-actions"><a class="btn" href="#add-repo">${escapeHtml(t('添加仓库', 'Add repository'))}</a></div>
  </section>
  ${quota.exhausted ? `<div class="banner bad">${escapeHtml(t('平台额度已用完。请到 Settings → Model 配置你自己的模型 API，任务才能继续。', 'Platform quota is used up. Add your own model API in Settings → Model to keep jobs running.'))}</div>` : ''}
  ${noticeBlock(locale, viewer, notifications)}
  <section class="quota-card card">
    <div>
      <div class="eyebrow">${escapeHtml(t('平台额度', 'PLATFORM QUOTA'))}</div>
      <div class="quota-big">${quota.unlimited ? escapeHtml(t('不限额', 'Unlimited')) : quotaMoney(quota.remainingCny)}${quota.unlimited ? '' : `<small> / ${money(quota.initialCny)}</small>`}</div>
      <p class="muted">${escapeHtml(quota.unlimited ? t(`已用 ${quotaMoney(quota.usedCny)} · 平台额度不限额`, `Used ${quotaMoney(quota.usedCny)} · platform quota is unlimited`) : t(`已用 ${quotaMoney(quota.usedCny)} · 平台额度用完后可配置自己的模型 API`, `Used ${quotaMoney(quota.usedCny)} · add your own model API when the platform quota runs out`))}</p>
    </div>
    <div class="meter"><span style="width:${quota.unlimited ? '0' : Math.min(100, Math.max(0, (quota.usedCny / Math.max(0.0001, quota.initialCny)) * 100)).toFixed(2)}%"></span></div>
  </section>

  <section class="cols">
    <div class="card">
      <h2>${escapeHtml(t('仓库', 'Repositories'))}</h2>
      <table><thead><tr><th>${escapeHtml(t('仓库', 'Repository'))}</th><th>${escapeHtml(t('模式', 'Mode'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('上次运行', 'Last run'))}</th><th></th></tr></thead><tbody>${repoRows}</tbody></table>
    </div>
    <div class="card" id="add-repo">
      <h2>${escapeHtml(t('添加仓库', 'Add repository'))}</h2>
      <form method="post" action="/repos" class="form">
        ${csrf(viewer)}
        <label>${escapeHtml(t('上游仓库', 'Upstream repository'))} <input name="repo" placeholder="owner/name" required autocomplete="off" /></label>
        <label>${escapeHtml(t('GitHub token', 'GitHub token'))} <input name="token" type="password" placeholder="github_pat_… 或 ghp_…" required autocomplete="off" /></label>
        <label>${escapeHtml(t('迭代目标（可选）', 'Iteration goal (optional)'))} <textarea name="goal" rows="3" placeholder="${escapeHtml(t('例如：持续修复 issue 里的可复现 bug，只改最小范围。', 'For example: fix reproducible bugs from issues with the smallest safe change.'))}"></textarea></label>
        <div class="row" data-auto-group>
          <label class="check"><input type="checkbox" name="auto" value="1" /> ${escapeHtml(t('自动迭代', 'Auto-iterate'))}</label>
          <label>${escapeHtml(t('自动迭代间隔', 'Auto-iterate interval'))} <select name="interval">${intervalOptions(t)}</select></label>
        </div>
        <div class="row" data-review-group>
          <label class="check"><input type="checkbox" name="review" value="1" /> ${escapeHtml(t('启用 PR 审核角色', 'Enable PR reviewer role'))}</label>
          <label>${escapeHtml(t('审核间隔', 'Review interval'))} <select name="reviewInterval">${reviewIntervalOptions(t)}</select></label>
        </div>
        <p class="fine">${escapeHtml(t('间隔是两次自动迭代之间的最小间隔，不是 PR/issue 总数上限。每次运行仍会创建一个 issue/PR，仓库可以持续积累多个；上一轮未结束时本轮会跳过。手动运行会重置迭代倒计时，审核任务不会。平台全局同时最多 2 个任务，多个仓库会排队。', 'The interval is the minimum gap between automatic runs, not a cap on issues or PRs. Each run can create one issue/PR and the repository can accumulate many; a run is skipped while the previous one is still active. A manual iterate run resets the countdown; a review run does not. The platform runs at most two jobs at a time, so extra repositories wait in the queue.'))}</p>
        <p class="fine">${escapeHtml(t('填写上游仓库（例如 openJiuwen-ai/DigitalMate）。Fledge 会检查并在需要时创建你的 fork；开发分支推到 fork，issue 和 PR 提到上游。若上游 owner 就是你，则直接在原仓库开分支。审核角色只在上游给你 maintain/write 权限时启用。', 'Enter the upstream repository (for example openJiuwen-ai/DigitalMate). Fledge checks and creates your fork when needed; branches go to the fork, while issues and PRs target the upstream. If you own the upstream, work directly in it. The reviewer role is enabled only when the upstream grants you maintain/write permission.'))}</p>
        <p class="fine">${escapeHtml(t('token 需要能读取上游、创建 fork、写入 fork，并在上游创建 issue/PR；建议使用 fine-grained token 并只授权实际需要的仓库。token 会加密保存，页面不会回显。', 'The token must read the upstream, create a fork, write to the fork, and create issues/PRs on the upstream. Use a fine-grained token limited to the repositories you actually need. It is encrypted at rest and never shown again.'))}</p>
        <button class="btn" type="submit">${escapeHtml(t('添加仓库', 'Add repository'))}</button>
      </form>
    </div>
  </section>

  <section class="card">
    <h2>${escapeHtml(t('最近任务', 'Recent jobs'))}</h2>
    <p class="fine">${escapeHtml(t('任务按时间倒序；同一仓库同时最多运行一个任务，历史任务会保留。', 'Jobs are newest first; one job per repository runs at a time, and history is kept.'))}</p>
    <table><thead><tr><th>${escapeHtml(t('任务', 'Job'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('触发', 'Trigger'))}</th><th>PR</th><th>${escapeHtml(t('摘要', 'Summary'))}</th><th>${escapeHtml(t('时间', 'Time'))}</th></tr></thead><tbody>${jobRows(locale, jobs)}</tbody></table>
  </section>`
  return layout({ title: t('仓库', 'Repositories'), viewer, body, config, locale, path: '/dashboard', active: 'dashboard', notice, error })
}

export function repoPage(input: { config: Config; locale: Locale; viewer: Viewer; repo: RepoRow; instance?: RepoInstanceRow; jobs: JobRow[]; notice?: string; error?: string }): string {
  const { config, locale, viewer, repo, instance, jobs, notice, error } = input
  const t = translator(locale)
  const upstreamOwner = repo.upstream_owner || repo.owner
  const upstreamName = repo.upstream_name || repo.name
  const forkOwner = repo.fork_owner || repo.owner
  const forkName = repo.fork_name || repo.name
  const upstreamUrl = repo.upstream_html_url ?? `https://github.com/${upstreamOwner}/${upstreamName}`
  const forkUrl = repo.fork_html_url ?? `https://github.com/${forkOwner}/${forkName}`
  const canReview = repo.can_review === 1
  const reviewerEnabled = repo.reviewer_enabled === 1
  const reviewerLabel = reviewerEnabled
    ? t('审核已启用', 'Reviewer on')
    : canReview
      ? t('审核可用但未启用', 'Reviewer available')
      : t('审核不可用', 'Reviewer unavailable')
  const reviewStatus = repo.last_review_status === null ? '' : ` · ${badge(t, repo.last_review_status)}`
  const activeJob = jobs.some((job) => job.status === 'queued' || job.status === 'running')
  const lastRun = repo.last_run_at === null ? Number.NaN : Date.parse(repo.last_run_at)
  const nextRun = repo.auto_iterate === 1 && Number.isFinite(lastRun) ? new Date(lastRun + repo.interval_minutes * 60_000) : null
  const nextRunText = repo.auto_iterate !== 1
    ? t('自动迭代已关闭', 'Auto-iterate off')
    : activeJob
      ? t('当前任务结束后再排', 'After the active job finishes')
      : nextRun === null
        ? t('等待首次运行', 'Waiting for first run')
        : nextRun.getTime() <= Date.now()
          ? t('等待调度', 'Waiting for the scheduler')
          : humanTimeShort(nextRun.toISOString())
  const instanceTeam = instance === undefined ? null : parseTeam(instance.team_json)
  const instanceReady = instance?.status === 'ready' && instanceTeam !== null
  const instanceNotice = config.flybot.instanceImage === ''
    ? `<div class="banner">${escapeHtml(t('这个部署没有启用每仓库 FlyBot 实例，任务由全局 mock/runner 处理。', 'This deployment has no per-repository FlyBot instance; jobs use the global mock/runner.'))}</div>`
    : instance === undefined
      ? `<div class="banner">${escapeHtml(t('FlyBot 实例尚未创建。保存仓库后会自动初始化；也可以手动启动。', 'The FlyBot instance has not been created yet. It starts automatically after the repository is saved, or you can start it manually.'))}</div>`
      : instance.status !== 'ready'
        ? `<div class="banner ${instance.status === 'failed' ? 'bad' : ''}">${escapeHtml(t(`FlyBot 实例状态：${instance.status}`, `FlyBot instance status: ${instance.status}`))}${instance.last_error === null ? '' : ` · ${escapeHtml(instance.last_error)}`}</div>`
        : ''
  const teamHtml = instanceTeam === null ? '' : `<div class="list">
    <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('Chief', 'Chief'))}</strong><small><code>${escapeHtml(instanceTeam.chief)}</code></small></div></div>
    <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('Lead', 'Lead'))}</strong><small><code>${escapeHtml(instanceTeam.lead)}</code></small></div></div>
    <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('Product', 'Product'))}</strong><small><code>${escapeHtml(instanceTeam.product)}</code></small></div></div>
    <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('Test', 'Test'))}</strong><small><code>${escapeHtml(instanceTeam.test)}</code></small></div></div>
    <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('Security', 'Security'))}</strong><small><code>${escapeHtml(instanceTeam.security)}</code></small></div></div>
    <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('Reviewer', 'Reviewer'))}</strong><small><code>${escapeHtml(instanceTeam.reviewer ?? '—')}</code> · ${escapeHtml(instanceTeam.reviewerScope)}</small></div></div>
    <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('Dev-1 / Dev-2', 'Dev-1 / Dev-2'))}</strong><small><code>${escapeHtml(instanceTeam.dev1)}</code> · <code>${escapeHtml(instanceTeam.dev2)}</code></small></div></div>
  </div>`
  const instanceActions = config.flybot.instanceImage === ''
    ? ''
    : instance === undefined || instance.status === 'failed' || instance.status === 'stopped'
      ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance">${csrf(viewer)}<button class="btn" type="submit">${escapeHtml(t('启动 FlyBot', 'Start FlyBot'))}</button></form>`
      : instance.status === 'ready'
        ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance/stop">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('停止 FlyBot', 'Stop FlyBot'))}</button></form>`
        : `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('重新初始化 FlyBot', 'Reinitialize FlyBot'))}</button></form>`
  const permission = permissionLabel(t, repo.permission)
  const reviewerScopeText = instanceTeam === null ? '' : instanceTeam.reviewerScope === 'upstream'
    ? t('上游全部 PR', 'all upstream PRs')
    : instanceTeam.reviewerScope === 'self' ? t('仅自审', 'self-review') : t('未启用', 'off')
  const reviewerNote = reviewerEnabled
    ? `${t('已启用', 'Enabled')} · ${reviewerScopeText}`
    : canReview ? t('未启用（设置里开启）', 'Created but disabled (enable in settings)') : t('不可用', 'Unavailable')
  const teamRoles = instanceTeam === null ? [] : [
    { label: t('总控', 'Chief'), id: instanceTeam.chief, note: t('已创建', 'Created') },
    { label: t('负责人', 'Lead'), id: instanceTeam.lead, note: t('已创建', 'Created') },
    { label: t('产品', 'Product'), id: instanceTeam.product, note: t('已创建', 'Created') },
    { label: t('测试', 'Test'), id: instanceTeam.test, note: t('已创建', 'Created') },
    { label: t('安全', 'Security'), id: instanceTeam.security, note: t('已创建', 'Created') },
    { label: t('审核', 'Reviewer'), id: instanceTeam.reviewer ?? '—', note: reviewerNote },
    { label: t('开发 1', 'Dev-1'), id: instanceTeam.dev1, note: t('已创建', 'Created') },
    { label: t('开发 2', 'Dev-2'), id: instanceTeam.dev2, note: t('已创建', 'Created') },
  ]
  const teamGrid = teamRoles.length === 0 ? '' : `<div class="team-grid">${teamRoles.map((role) => `<div class="team-role"><b>${escapeHtml(role.label)}</b><span>${escapeHtml(role.note)}</span></div>`).join('')}</div>
    <details class="fine session-details"><summary>${escapeHtml(t('查看 session ID', 'View session IDs'))}</summary><div class="session-list">${teamRoles.map((role) => `<code>${escapeHtml(role.label)}: ${escapeHtml(role.id)}</code>`).join('')}</div></details>`
  const repoHeader = `<section class="card">
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('仓库', 'REPOSITORY'))}</div>
        <h1>${escapeHtml(upstreamOwner)}/${escapeHtml(upstreamName)}</h1>
        <p class="muted">${escapeHtml(t('默认分支', 'Default branch'))} <code>${escapeHtml(repo.upstream_default_branch || repo.default_branch)}</code> · ${escapeHtml(repo.auto_iterate === 1 ? t('自动迭代已开启', 'Auto-iteration on') : t('仅手动运行', 'Manual runs only'))} · ${escapeHtml(t('自动间隔', 'Auto every'))} <b>${escapeHtml(intervalLabel(repo.interval_minutes, t))}</b> · ${escapeHtml(t('下次约', 'Next'))} ${escapeHtml(nextRunText)} · ${badge(t, repo.last_status ?? 'idle')}</p>
        <p class="fine">${escapeHtml(t('上游', 'Upstream'))} <a href="${escapeHtml(upstreamUrl)}" target="_blank" rel="noreferrer">${escapeHtml(upstreamOwner)}/${escapeHtml(upstreamName)}</a> · ${repo.is_fork === 1 ? `${escapeHtml(t('Fork', 'Fork'))} <a href="${escapeHtml(forkUrl)}" target="_blank" rel="noreferrer">${escapeHtml(forkOwner)}/${escapeHtml(forkName)}</a>` : escapeHtml(t('自有仓库，无需 fork', 'Own repository, no fork'))} · ${escapeHtml(t('角色', 'Role'))} <code>${escapeHtml(permission)}</code> · ${escapeHtml(reviewerLabel)}</p>
      </div>
      <div class="row">
        <a class="btn btn-ghost" href="/repos/${escapeHtml(repo.id)}/team">${escapeHtml(t('团队工作台', 'Team console'))}</a>
        <form method="post" action="/repos/${escapeHtml(repo.id)}/run">${csrf(viewer)}<button class="btn" type="submit">${escapeHtml(t('立即运行', 'Run now'))}</button></form>
        ${canReview && reviewerEnabled ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/review">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('立即审核', 'Review now'))}</button></form>` : ''}
      </div>
    </div>
  </section>`
  const instanceCard = `<section class="card">
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('每仓库 FlyBot', 'PER-REPOSITORY FLYBOT'))}</div>
        <h2>${escapeHtml(t('实例与团队', 'Instance & team'))}</h2>
        <p class="muted">${instance === undefined ? escapeHtml(t('未创建', 'Not created')) : `${badge(t, instance.status)} <span class="muted">${escapeHtml(instance.container)}</span>`}${instanceReady ? ` · ${escapeHtml(t('任务先发给总控，再由负责人执行', 'jobs go to the Chief, then the Lead'))}` : ''}</p>
      </div>
      ${instanceActions}
    </div>
    ${teamGrid}
  </section>`
  const body = `${repoHeader}${instanceNotice}${instanceCard}
  <section class="cols">
    <div class="card" id="repo-settings">
      <h2>${escapeHtml(t('迭代目标', 'Iteration goal'))}</h2>
      <form method="post" action="/repos/${escapeHtml(repo.id)}/settings" class="form">
        ${csrf(viewer)}
        <textarea name="goal" rows="5" placeholder="${escapeHtml(t('这个仓库每次迭代应该关注什么？', 'What should each iteration focus on for this repository?'))}">${escapeHtml(repo.goal)}</textarea>
        <div class="row" data-auto-group>
          <label class="check"><input type="checkbox" name="auto" value="1" ${repo.auto_iterate === 1 ? 'checked' : ''} /> ${escapeHtml(t('自动迭代', 'Auto-iterate'))}</label>
          <label class="check"><input type="checkbox" name="enabled" value="1" ${repo.enabled === 1 ? 'checked' : ''} /> ${escapeHtml(t('启用', 'Enabled'))}</label>
          <label>${escapeHtml(t('自动迭代间隔', 'Auto-iterate interval'))} <select name="interval">${intervalOptions(t, repo.interval_minutes)}</select></label>
        </div>
        <div class="row" data-review-group>
          <label class="check"><input type="checkbox" name="review" value="1" ${reviewerEnabled ? 'checked' : ''} ${canReview ? '' : 'disabled'} /> ${escapeHtml(t('启用 PR 审核', 'Enable PR reviewer'))}</label>
          <label>${escapeHtml(t('审核间隔', 'Review interval'))} <select name="reviewInterval" ${canReview ? '' : 'disabled'}>${reviewIntervalOptions(t, repo.review_interval_minutes)}</select></label>
        </div>
        ${canReview ? '' : `<p class="fine">${escapeHtml(t('你在这个上游没有 maintain/write 权限，审核角色不可用。', 'You do not have maintain/write permission on this upstream, so the reviewer role is unavailable.'))}</p>`}
        <p class="fine">${escapeHtml(t('保存目标后，团队 playbook 会按新目标个性化更新：总控 → 负责人 → 产品/测试/安全/审核/开发。审核角色只有勾选“启用 PR 审核”后才会参与任务。', 'Saving the goal personalizes the team playbook: Chief -> Lead -> Product/Test/Security/Reviewer/Dev. The Reviewer takes part only when "Enable PR reviewer" is checked.'))}</p>
        <p class="fine">${escapeHtml(t('自动迭代间隔是最小运行间隔；每次运行创建一个 PR/issue，仓库可以持续积累多个。上一轮未结束时本轮会跳过；手动运行会重置迭代倒计时，审核任务不会。平台全局同时最多 2 个任务，多个仓库会排队。', 'The auto-iterate interval is the minimum gap between runs; each run creates one PR/issue and the repository can accumulate many. A run is skipped while the previous one is active. A manual iterate run resets the countdown; a review run does not. The platform runs at most two jobs at a time.'))}</p>
        <button class="btn" type="submit">${escapeHtml(t('保存', 'Save'))}</button>
      </form>
    </div>
    <div class="card">
      <h2>${escapeHtml(t('连接', 'Connection'))}</h2>
      <p class="muted">${escapeHtml(t('GitHub token 已加密保存；页面不会显示明文。如果仓库或 token 变了，删除后重新添加。', 'The GitHub token is encrypted and never rendered in plain text. If the repository or token changes, delete and add it again.'))}</p>
      <p class="fine">${escapeHtml(t('审核最近运行', 'Last review'))} ${escapeHtml(repo.last_review_at === null ? t('尚未运行', 'Not run yet') : humanTimeShort(repo.last_review_at))}${reviewStatus}</p>
      <div class="row" style="margin-bottom:12px">
        <form method="post" action="/repos/${escapeHtml(repo.id)}/refresh">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('重新检测上游 / fork', 'Refresh upstream / fork'))}</button></form>
      </div>
      <form method="post" action="/repos/${escapeHtml(repo.id)}/delete" onsubmit="return confirm('${escapeHtml(t('删除这个仓库及其任务记录？', 'Delete this repository and its job history?'))}')">${csrf(viewer)}<button class="btn btn-danger" type="submit">${escapeHtml(t('删除仓库', 'Delete repository'))}</button></form>
      <p class="fine">${escapeHtml(t('平台只通过 GitHub API 读取元数据、创建 fork 和分支/PR；不会 clone 到公共磁盘。', 'The platform only uses the GitHub API to read metadata, create forks and open branches/PRs; it never clones to public disk.'))}</p>
    </div>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('任务', 'Jobs'))}</h2>
    <p class="fine">${escapeHtml(t('任务按时间倒序；同一仓库同时最多运行一个任务，历史任务会保留。', 'Jobs are newest first; one job per repository runs at a time, and history is kept.'))}</p>
    <table><thead><tr><th>${escapeHtml(t('任务', 'Job'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('触发', 'Trigger'))}</th><th>PR / Issue</th><th>${escapeHtml(t('摘要', 'Summary'))}</th><th>${escapeHtml(t('时间', 'Time'))}</th></tr></thead><tbody>${jobRows(locale, jobs)}</tbody></table>
  </section>`
  return layout({ title: `${upstreamOwner}/${upstreamName}`, viewer, body, config, locale, path: `/repos/${repo.id}`, active: 'dashboard', notice, error })
}

function teamRoleLabel(t: Translate, role: string): string {
  const labels: Record<string, [string, string]> = {
    chief: ['总控', 'Chief'],
    lead: ['负责人', 'Lead'],
    product: ['产品', 'Product'],
    test: ['测试', 'Test'],
    security: ['安全', 'Security'],
    reviewer: ['审核', 'Reviewer'],
    dev1: ['开发 1', 'Dev-1'],
    dev2: ['开发 2', 'Dev-2'],
  }
  const value = labels[role]
  return value === undefined ? role : t(value[0], value[1])
}

function activityLabel(t: Translate, activity: string): string {
  if (activity === 'thinking') return t('思考中', 'Thinking')
  if (activity === 'working') return t('工作中', 'Working')
  if (activity === 'idle') return t('空闲', 'Idle')
  if (activity === 'unknown') return t('未知', 'Unknown')
  return activity
}

function teamSession(team: ReturnType<typeof parseTeam>, role: string): string {
  if (team === null) return ''
  if (role === 'chief') return team.chief
  if (role === 'lead') return team.lead
  if (role === 'product') return team.product
  if (role === 'test') return team.test
  if (role === 'security') return team.security
  if (role === 'reviewer') return team.reviewer ?? ''
  if (role === 'dev1') return team.dev1
  if (role === 'dev2') return team.dev2
  return ''
}

export function teamPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  repo: RepoRow
  instance?: RepoInstanceRow
  state?: TeamLiveState
  stateError?: string
  jobs: JobRow[]
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, repo, instance, state, stateError, jobs, notice, error } = input
  const t = translator(locale)
  const team = instance === undefined ? null : parseTeam(instance.team_json)
  const ready = instance?.status === 'ready' && team !== null
  const roleKeys = ['chief', 'lead', 'product', 'test', 'security', 'reviewer', 'dev1', 'dev2']
  const roles = roleKeys.map((role) => {
    const live = state?.bots.find((bot) => bot.role === role)
    return {
      role,
      label: teamRoleLabel(t, role),
      sessionId: live?.sessionId ?? teamSession(team, role),
      activity: live?.activity ?? 'unknown',
      calls: live?.calls ?? 0,
      disabled: live?.disabled ?? (role === 'reviewer' && repo.reviewer_enabled !== 1),
    }
  })
  const roleCards = roles
    .map(
      (role) => `<div class="team-role${role.activity === 'thinking' || role.activity === 'working' ? ' is-thinking' : ''}${role.disabled ? ' is-disabled' : ''}" data-role="${escapeHtml(role.role)}">
        <b>${escapeHtml(role.label)}</b>
        <span class="team-activity">${escapeHtml(role.disabled ? t('未启用', 'Disabled') : activityLabel(t, role.activity))}</span>
        <small class="team-calls">${!role.disabled && role.calls > 0 ? `${role.calls} ${escapeHtml(t('次调用', 'calls'))}` : ''}</small>
      </div>`,
    )
    .join('')
  const sessionDetails = roles.some((role) => role.sessionId !== '')
    ? `<details class="fine session-details"><summary>${escapeHtml(t('查看 session ID', 'View session IDs'))}</summary><div class="session-list">${roles.filter((role) => role.sessionId !== '').map((role) => `<code>${escapeHtml(role.label)}: ${escapeHtml(role.sessionId)}</code>`).join('')}</div></details>`
    : ''
  const questions = state?.questions ?? []
  const questionHtml = questions.length === 0
    ? `<p class="muted">${escapeHtml(t('没有待回答的问题。', 'No open questions.'))}</p>`
    : `<div class="list">${questions.map((question) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(question.question || t('团队提问', 'Team question'))}</strong>${question.options.length === 0 ? '' : `<small>${question.options.map((option) => escapeHtml(option)).join(' · ')}</small>`}</div></div>`).join('')}</div>`
  const stateErrorHtml = stateError === undefined ? '' : `<div class="banner bad">${escapeHtml(t('读取团队状态失败：', 'Could not read team state: '))}${escapeHtml(stateError)}</div>`
  const instanceActions = config.flybot.instanceImage === ''
    ? ''
    : instance === undefined || instance.status === 'failed' || instance.status === 'stopped'
      ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance">${csrf(viewer)}<button class="btn" type="submit">${escapeHtml(t('启动 FlyBot', 'Start FlyBot'))}</button></form>`
      : instance.status === 'ready'
        ? ''
        : `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('重新初始化 FlyBot', 'Reinitialize FlyBot'))}</button></form>`
  const guidanceForm = ready
    ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/team/guidance" class="form">
        ${csrf(viewer)}
        <label>${escapeHtml(t('发送给', 'Send to'))}
          <select name="target">
            ${roles.filter((role) => !role.disabled).map((role) => `<option value="${escapeHtml(role.role)}"${role.role === 'lead' ? ' selected' : ''}>${escapeHtml(role.label)}</option>`).join('')}
          </select>
        </label>
        <label>${escapeHtml(t('新的指导意见', 'New guidance'))}<textarea name="text" rows="4" required placeholder="${escapeHtml(t('例如：先不要改代码，汇报当前实现和风险。', 'For example: do not change code yet; report the current implementation and risks.'))}"></textarea></label>
        <button class="btn" type="submit">${escapeHtml(t('发送给团队', 'Send to team'))}</button>
      </form>`
    : `<p class="muted">${escapeHtml(t('实例就绪后可以给团队发送指导意见。', 'Guidance can be sent after the instance is ready.'))}</p>`
  const body = `<section class="card">
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('团队', 'TEAM'))}</div>
        <h1>${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</h1>
        <p class="muted">${instance === undefined ? escapeHtml(t('未创建实例', 'No instance')) : `${badge(t, instance.status)} <span class="muted">${escapeHtml(instance.container)}</span>`} · <a href="/repos/${escapeHtml(repo.id)}">${escapeHtml(t('返回仓库', 'Back to repository'))}</a></p>
      </div>
      <div class="row">
        ${instanceActions}
        <button class="btn btn-ghost" type="button" onclick="location.reload()">${escapeHtml(t('刷新', 'Refresh'))}</button>
      </div>
    </div>
  </section>
  ${stateErrorHtml}
  <section class="card" id="team-live" data-team-api="/api/repos/${escapeHtml(repo.id)}/team" data-team-locale="${escapeHtml(locale)}">
    <div class="row between"><h2>${escapeHtml(t('团队状态', 'Team status'))}</h2><span class="fine">${escapeHtml(t('上次更新', 'Updated'))} <span data-team-updated>—</span></span></div>
    <div class="team-grid">${roleCards}</div>
    ${sessionDetails}
  </section>
  <section class="cols">
    <div class="card"><h2>${escapeHtml(t('待回答的问题', 'Open questions'))}</h2>${questionHtml}</div>
    <div class="card"><h2>${escapeHtml(t('发送指导意见', 'Send guidance'))}</h2>${guidanceForm}</div>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('最近任务', 'Recent jobs'))}</h2>
    <p class="fine">${escapeHtml(t('任务按时间倒序；同一仓库同时最多运行一个任务，历史任务会保留。', 'Jobs are newest first; one job per repository runs at a time, and history is kept.'))}</p>
    <table><thead><tr><th>${escapeHtml(t('任务', 'Job'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('触发', 'Trigger'))}</th><th>PR / Issue</th><th>${escapeHtml(t('摘要', 'Summary'))}</th><th>${escapeHtml(t('时间', 'Time'))}</th></tr></thead><tbody>${jobRows(locale, jobs)}</tbody></table>
  </section>
  <script src="/assets/team.js" defer></script>`
  return layout({ title: t('团队工作台', 'Team console'), viewer, body, config, locale, path: `/repos/${repo.id}/team`, active: 'dashboard', notice, error })
}

export function settingsPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  tokens: ApiTokenRow[]
  newToken?: string
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, tokens, newToken, notice, error } = input
  const t = translator(locale)
  const user = viewer.user
  const quota = quotaView(user, config)
  const tokenRows = tokens.length === 0
    ? `<tr><td colspan="4" class="muted">${escapeHtml(t('还没有 API token。', 'No API tokens yet.'))}</td></tr>`
    : tokens
        .map(
          (token) => `<tr><td><code>${escapeHtml(token.prefix)}…</code></td><td>${escapeHtml(token.name)}</td><td>${escapeHtml(humanTimeShort(token.last_used_at))}</td><td><form method="post" action="/settings/tokens/${escapeHtml(token.id)}/revoke">${csrf(viewer)}<button class="link" type="submit">${escapeHtml(t('撤销', 'Revoke'))}</button></form></td></tr>`,
        )
        .join('')
  const body = `<section class="card">
    <div class="eyebrow">${escapeHtml(t('账户', 'ACCOUNT'))}</div>
    <h1>@${escapeHtml(user.login)}</h1>
    <p class="muted">${escapeHtml(user.email ?? t('未公开邮箱', 'No public email'))} · ${escapeHtml(t('加入于', 'Joined'))} ${escapeHtml(humanTimeShort(user.created_at))} · ${escapeHtml(t('平台额度', 'Platform quota'))} ${quota.unlimited ? escapeHtml(t('不限额', 'Unlimited')) : `${quotaMoney(quota.remainingCny)} / ${money(quota.initialCny)}`}</p>
    ${user.github_token_enc !== null ? `<p class="fine">${escapeHtml(t('登录时保存了一个默认 GitHub token；添加仓库时仍以仓库表单里的 token 为准。', 'A default GitHub token was saved at sign-in; the token in the repository form still takes precedence.'))}</p>` : ''}
  </section>

  <section class="card" id="model">
    <h2>${escapeHtml(t('模型服务', 'Model service'))}</h2>
    <p class="muted">${escapeHtml(quota.unlimited ? t('你的平台额度不限额，平台会继续记录用量但不拦截任务。', 'Your platform quota is unlimited: usage is still recorded but jobs are never blocked.') : t(`默认使用平台额度（${money(quota.initialCny)}）。额度用完后，填入你自己的 OpenAI 兼容服务即可继续；平台不再扣额度。`, `The platform quota (${money(quota.initialCny)}) is used by default. When it runs out, add your own OpenAI-compatible service to continue; the platform no longer meters it.`))}</p>
    ${quota.exhausted ? `<div class="banner bad">${escapeHtml(t('平台额度已用完。保存自己的模型服务后，任务会自动使用它。', 'Platform quota is used up. After you save your own model service, jobs will use it automatically.'))}</div>` : ''}
    <form method="post" action="/settings/model" class="form">
      ${csrf(viewer)}
      <label>Base URL <input name="baseUrl" value="${escapeHtml(user.own_llm_base_url ?? '')}" placeholder="https://api.example.com/v1" autocomplete="off" /></label>
      <label>API Key <input name="apiKey" type="password" placeholder="${escapeHtml(user.own_llm_key_enc === null ? 'sk-…' : t('已保存，留空不修改', 'Saved; leave blank to keep'))}" autocomplete="off" /></label>
      <label>Model <input name="model" value="${escapeHtml(user.own_llm_model ?? '')}" placeholder="${escapeHtml(t('例如 gpt-4o-mini 或 deepseek-chat', 'e.g. gpt-4o-mini or deepseek-chat'))}" autocomplete="off" /></label>
      <div class="row">
        <button class="btn" name="action" value="save" type="submit">${escapeHtml(t('保存并测试', 'Save and test'))}</button>
        <button class="btn btn-ghost" name="action" value="clear" type="submit">${escapeHtml(t('清除，改回平台额度', 'Clear and use platform quota'))}</button>
      </div>
    </form>
    <p class="fine">${escapeHtml(t('必须是 OpenAI 兼容的 /v1/chat/completions 服务；公网服务要求 https。保存时会发一个 1 token 的测试请求。', 'Must be an OpenAI-compatible /v1/chat/completions service; public endpoints must use https. Saving sends a 1-token test request.'))}</p>
  </section>

  <section class="card">
    <h2>${escapeHtml(t('API token', 'API tokens'))}</h2>
    <p class="muted">${escapeHtml(t('给脚本或 FlyBot 调用的网关 token（flg_…）。它不是你的 GitHub token，也不是模型 key。', 'Gateway tokens (flg_…) for scripts or FlyBot. They are neither your GitHub token nor a model key.'))}</p>
    ${newToken === undefined ? '' : `<div class="banner ok">${escapeHtml(t('新 token（只显示一次）：', 'New token (shown once):'))}<code class="token">${escapeHtml(newToken)}</code></div>`}
    <table><thead><tr><th>${escapeHtml(t('前缀', 'Prefix'))}</th><th>${escapeHtml(t('名称', 'Name'))}</th><th>${escapeHtml(t('最近使用', 'Last used'))}</th><th></th></tr></thead><tbody>${tokenRows}</tbody></table>
    <form method="post" action="/settings/tokens" class="row">${csrf(viewer)}<input name="name" placeholder="${escapeHtml(t('用途，例如 laptop-cli', 'Purpose, e.g. laptop-cli'))}" required /><button class="btn" type="submit">${escapeHtml(t('创建 token', 'Create token'))}</button></form>
  </section>`
  return layout({ title: t('设置', 'Settings'), viewer, body, config, locale, path: '/settings', active: 'settings', notice, error })
}

const AUDIT_ACTIONS: Record<string, [string, string]> = {
  'login.github': ['GitHub 登录', 'GitHub sign-in'],
  'login.github-token': ['GitHub token 登录', 'GitHub token sign-in'],
  'login.dev': ['Dev 登录', 'Dev sign-in'],
  logout: ['退出登录', 'Sign out'],
  'application.submitted': ['提交申请', 'Application submitted'],
  'approval.requested': ['发送审批邮件', 'Approval mail sent'],
  'admin.approved': ['批准用户', 'User approved'],
  'admin.rejected': ['拒绝用户', 'User rejected'],
  'admin.quota': ['调整额度', 'Quota changed'],
  'repo.added': ['添加仓库', 'Repository added'],
  'repo.settings': ['仓库设置', 'Repository settings'],
  'repo.deleted': ['删除仓库', 'Repository deleted'],
  'repo.refreshed': ['刷新仓库', 'Repository refreshed'],
  'job.enqueued': ['任务入队', 'Job queued'],
  'job.succeeded': ['任务成功', 'Job succeeded'],
  'job.failed': ['任务失败', 'Job failed'],
  'review.enqueued': ['审核入队', 'Review queued'],
  'flybot.instance.ready': ['FlyBot 实例就绪', 'FlyBot instance ready'],
  'flybot.instance.failed': ['FlyBot 实例失败', 'FlyBot instance failed'],
  'flybot.instance.stopped': ['FlyBot 实例停止', 'FlyBot instance stopped'],
  'token.created': ['创建 token', 'Token created'],
  'token.revoked': ['撤销 token', 'Token revoked'],
  'model.saved': ['保存模型', 'Model saved'],
  'model.cleared': ['清除模型', 'Model cleared'],
}

function auditLabel(t: Translate, action: string): string {
  const label = AUDIT_ACTIONS[action]
  return label === undefined ? action : t(label[0], label[1])
}

function auditTone(action: string): string {
  if (/failed|rejected|revoked|deleted/.test(action)) return 'bad'
  if (/approved|succeeded|created|added|saved/.test(action)) return 'good'
  if (/enqueued|quota|settings|refreshed/.test(action)) return 'busy'
  return ''
}

function auditRows(locale: Locale, audit: AuditRow[], usersById: Map<string, string>): string {
  const t = translator(locale)
  if (audit.length === 0) return `<tr><td colspan="4" class="muted">${escapeHtml(t('暂无记录。', 'No records yet.'))}</td></tr>`
  return audit
    .map((row) => {
      const rawDetail = row.detail ?? ''
      const by = /\bby @([A-Za-z0-9-]+)\b/.exec(rawDetail)?.[1]
      const targetLogin = row.user_id === null ? undefined : usersById.get(row.user_id)
      const actor = by ?? targetLogin
      const target = by !== undefined && targetLogin !== undefined && by.toLowerCase() !== targetLogin.toLowerCase() ? targetLogin : undefined
      let detail = rawDetail.replace(/^by @[A-Za-z0-9-]+\s*/, '').trim()
      if (detail === `@${actor}`) detail = ''
      const tone = auditTone(row.action)
      const rawAction = AUDIT_ACTIONS[row.action] === undefined ? '' : row.action
      const actorHtml = actor === undefined
        ? escapeHtml(t('系统', 'System'))
        : `@${escapeHtml(actor)}${target === undefined ? '' : ` <span class="muted">→ @${escapeHtml(target)}</span>`}`
      return `<tr>
        <td class="nowrap"><span title="${escapeHtml(row.at)}">${escapeHtml(humanTimeShort(row.at))}</span></td>
        <td><span class="badge ${tone}">${escapeHtml(auditLabel(t, row.action))}</span>${rawAction === '' ? '' : `<br /><small class="muted">${escapeHtml(rawAction)}</small>`}</td>
        <td class="nowrap">${actorHtml}</td>
        <td>${detail === '' ? '—' : `<span title="${escapeHtml(rawDetail)}">${escapeHtml(detail.slice(0, 160))}</span>`}</td>
      </tr>`
    })
    .join('')
}

function pager(path: string, pageParam: string, page: number, total: number, perPage: number, t: Translate, other: Record<string, string | number> = {}): string {
  const pages = Math.max(1, Math.ceil(total / perPage))
  if (pages <= 1) return ''
  const href = (target: number): string => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(other)) if (String(value) !== '') params.set(key, String(value))
    params.set(pageParam, String(target))
    return `${path}?${params.toString()}`
  }
  const prev = page > 1
    ? `<a class="btn btn-ghost btn-small" href="${escapeHtml(href(page - 1))}">${escapeHtml(t('上一页', 'Previous'))}</a>`
    : `<span class="btn btn-ghost btn-small disabled" aria-disabled="true">${escapeHtml(t('上一页', 'Previous'))}</span>`
  const next = page < pages
    ? `<a class="btn btn-ghost btn-small" href="${escapeHtml(href(page + 1))}">${escapeHtml(t('下一页', 'Next'))}</a>`
    : `<span class="btn btn-ghost btn-small disabled" aria-disabled="true">${escapeHtml(t('下一页', 'Next'))}</span>`
  return `<div class="pager">${prev}<span class="pager-info">${page} / ${pages} · ${total}</span>${next}</div>`
}

export function adminPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  users: UserRow[]
  jobs: JobRow[]
  jobsPage: number
  jobsTotal: number
  audit: AuditRow[]
  auditPage: number
  auditTotal: number
  perPage: number
  activity?: Map<string, { repos: number; jobs: number; lastJobAt: string | null }>
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, users, jobs, jobsPage, jobsTotal, audit, auditPage, auditTotal, perPage, activity, notice, error } = input
  const t = translator(locale)
  const usersById = new Map(users.map((user) => [user.id, user.login]))
  const pending = users
    .filter((user) => user.status === 'pending')
    .sort((a, b) => String(a.application_submitted_at ?? a.created_at).localeCompare(String(b.application_submitted_at ?? b.created_at)))
  const pendingRows = pending.length === 0
    ? `<tr><td colspan="4" class="muted">${escapeHtml(t('没有待审批申请。', 'No pending applications.'))}</td></tr>`
    : pending
        .map(
          (user, index) => `<tr>
            <td>@${escapeHtml(user.login)}<br /><small class="muted">${escapeHtml(user.email ?? '')}</small></td>
            <td><b>#${index + 1}</b><br /><small class="muted">${escapeHtml(humanTimeShort(user.application_submitted_at ?? user.created_at))}</small></td>
            <td>${badge(t, user.status)}<br /><small class="muted">${escapeHtml(t('签署：', 'Signed: '))}${escapeHtml(user.disclaimer_name ?? '—')}<br />${escapeHtml(t('免责', 'Disclaimer'))} ${escapeHtml(humanTimeShort(user.disclaimer_accepted_at))}<br />${escapeHtml(t('信息安全', 'Security'))} ${escapeHtml(humanTimeShort(user.security_accepted_at))}<br />IP ${escapeHtml(user.application_ip ?? '—')}</small></td>
            <td class="row">
              <form method="post" action="/admin/users/${escapeHtml(user.id)}/approve">${csrf(viewer)}<button class="link good" type="submit">${escapeHtml(t('批准', 'Approve'))}</button></form>
              <form method="post" action="/admin/users/${escapeHtml(user.id)}/reject">${csrf(viewer)}<button class="link bad" type="submit">${escapeHtml(t('拒绝', 'Reject'))}</button></form>
            </td>
          </tr>`,
        )
        .join('')
  const userRows = users
    .map(
      (user) => `<tr>
        <td>@${escapeHtml(user.login)}<br /><small class="muted">${escapeHtml(user.email ?? '')}</small></td>
        <td>${badge(t, user.status)}</td>
        <td>${escapeHtml(roleLabel(t, user.role))}</td>
        <td>${user.quota_unlimited === 1 ? escapeHtml(t('不限额', 'Unlimited')) : money(user.quota_cny)}</td>
        <td>${quotaMoney(quotaView(user, config).usedCny)}</td>
        <td><small class="muted">${escapeHtml(t('最近登录', 'Last sign-in'))} ${escapeHtml(humanTimeShort(user.last_login_at))}<br />${escapeHtml(t('仓库', 'Repos'))} ${activity?.get(user.id)?.repos ?? 0} · ${escapeHtml(t('任务', 'Jobs'))} ${activity?.get(user.id)?.jobs ?? 0}<br />${escapeHtml(t('最近任务', 'Last job'))} ${escapeHtml(humanTimeShort(activity?.get(user.id)?.lastJobAt))}</small></td>
        <td><form method="post" action="/admin/users/${escapeHtml(user.id)}/quota" class="row">${csrf(viewer)}<input name="quota" type="number" step="0.1" min="0" value="${user.quota_cny}" /><label class="check"><input type="checkbox" name="unlimited" value="1"${user.quota_unlimited === 1 ? ' checked' : ''} /> ${escapeHtml(t('不限额', 'Unlimited'))}</label><button class="link" type="submit">${escapeHtml(t('改额度', 'Set quota'))}</button></form>
          ${user.status === 'rejected' ? `<form method="post" action="/admin/users/${escapeHtml(user.id)}/approve">${csrf(viewer)}<button class="link good" type="submit">${escapeHtml(t('重新批准', 'Re-approve'))}</button></form>` : ''}
          ${user.status === 'approved' ? `<form method="post" action="/admin/users/${escapeHtml(user.id)}/reject" onsubmit="return confirm('${escapeHtml(t('停用这个用户并停止其所有 FlyBot 实例？', 'Disable this user and stop all their FlyBot instances?'))}')">${csrf(viewer)}<button class="link bad" type="submit">${escapeHtml(t('停用', 'Disable'))}</button></form>` : ''}
        </td>
      </tr>`,
    )
    .join('')
  const body = `<section class="card">
    <div class="eyebrow">${escapeHtml(t('管理', 'ADMIN'))}</div>
    <h1>${escapeHtml(t('审批与额度', 'Approvals & quota'))}</h1>
    <p class="muted">${escapeHtml(t(`申请邮件发往 ${config.mail.adminEmail}；这里的操作会写审计日志。`, `Applications are mailed to ${config.mail.adminEmail}; actions here are written to the audit log.`))}</p>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('待审批', 'Pending'))} <small class="count">${pending.length}</small></h2>
    <table><thead><tr><th>${escapeHtml(t('用户', 'User'))}</th><th>${escapeHtml(t('申请时间', 'Applied'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th></th></tr></thead><tbody>${pendingRows}</tbody></table>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('用户', 'Users'))} <small class="count">${users.length}</small></h2>
    <table><thead><tr><th>${escapeHtml(t('登录名', 'Login'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('角色', 'Role'))}</th><th>${escapeHtml(t('额度', 'Quota'))}</th><th>${escapeHtml(t('已用', 'Used'))}</th><th>${escapeHtml(t('活动', 'Activity'))}</th><th>${escapeHtml(t('调整', 'Adjust'))}</th></tr></thead><tbody>${userRows}</tbody></table>
  </section>
  <section class="card">
    <div class="row between"><h2>${escapeHtml(t('最近任务', 'Recent jobs'))} <small class="count">${jobsTotal}</small></h2><span class="fine">${escapeHtml(t('每页 10 条', '10 per page'))}</span></div>
    <table><thead><tr><th>${escapeHtml(t('任务', 'Job'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('触发', 'Trigger'))}</th><th>PR / Issue</th><th>${escapeHtml(t('摘要', 'Summary'))}</th><th>${escapeHtml(t('时间', 'Time'))}</th></tr></thead><tbody>${jobRows(locale, jobs)}</tbody></table>
    ${pager('/admin', 'jobsPage', jobsPage, jobsTotal, perPage, t, { auditPage })}
  </section>
  <section class="card">
    <div class="row between"><h2>${escapeHtml(t('审计', 'Audit'))} <small class="count">${auditTotal}</small></h2><span class="fine">${escapeHtml(t('每页 10 条', '10 per page'))}</span></div>
    <table><thead><tr><th>${escapeHtml(t('时间', 'Time'))}</th><th>${escapeHtml(t('动作', 'Action'))}</th><th>${escapeHtml(t('操作者', 'Actor'))}</th><th>${escapeHtml(t('详情', 'Detail'))}</th></tr></thead><tbody>${auditRows(locale, audit, usersById)}</tbody></table>
    ${pager('/admin', 'auditPage', auditPage, auditTotal, perPage, t, { jobsPage })}
  </section>`
  return layout({ title: t('管理', 'Admin'), viewer, body, config, locale, path: '/admin', active: 'admin', notice, error })
}

export function approvalPage(input: { config: Config; locale: Locale; user: UserRow; action: 'approve' | 'reject'; token: string; error?: string }): string {
  const { config, locale, user, action, token, error } = input
  const t = translator(locale)
  const verb = action === 'approve' ? t('批准', 'Approve') : t('拒绝', 'Reject')
  const body = `<section class="card narrow">
    <div class="eyebrow">${escapeHtml(t('申请审批', 'APPLICATION REVIEW'))}</div>
    <h1>${escapeHtml(t(`${verb} @${user.login} 的申请？`, `${verb} @${user.login}'s application?`))}</h1>
    <p>${escapeHtml(user.name ?? '')} · ${escapeHtml(user.email ?? t('未公开邮箱', 'No public email'))} · <a href="https://github.com/${escapeHtml(user.login)}" target="_blank" rel="noreferrer">GitHub</a></p>
    <p class="muted">${escapeHtml(t(`申请时间 ${humanTimeShort(user.created_at)}。这个链接只能使用一次。`, `Applied ${humanTimeShort(user.created_at)}. This link can be used once.`))}</p>
    <form method="post" action="/approve/${escapeHtml(token)}">
      <button class="btn ${action === 'reject' ? 'btn-danger' : ''}" type="submit">${escapeHtml(verb)}</button>
      <a class="btn btn-ghost" href="/admin">${escapeHtml(t('去 Admin', 'Open Admin'))}</a>
    </form>
  </section>`
  return layout({ title: `${verb}`, body, config, locale, path: `/approve/${token}`, error })
}

export function errorPage(
  config: Config,
  viewer: Viewer | null,
  title: string,
  message: string,
  locale: Locale = 'zh',
  action?: { href: string; label: string },
): string {
  const t = translator(locale)
  const localizedTitle = localizeMessage(locale, title) ?? title
  const localizedMessage = localizeMessage(locale, message) ?? message
  const actionHtml = action === undefined ? '' : `<a class="btn" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`
  return layout({
    title: localizedTitle,
    viewer,
    config,
    locale,
    path: '/',
    body: `<section class="card narrow"><h1>${escapeHtml(localizedTitle)}</h1><p>${escapeHtml(localizedMessage)}</p><div class="actions">${actionHtml}<a class="btn btn-ghost" href="/">${escapeHtml(t('回首页', 'Back home'))}</a></div></section>`,
  })
}

export function applyPage(input: { config: Config; locale: Locale; viewer: Viewer; notice?: string; error?: string }): string {
  const { config, locale, viewer, notice, error } = input
  const t = translator(locale)
  const agreements = agreementContent(locale)
  const body = `<section class="card narrow">
    <div class="eyebrow">${escapeHtml(t('访问申请', 'ACCESS REQUEST'))}</div>
    <h1>${escapeHtml(t('申请访问', 'Request access'))}</h1>
    <p>${escapeHtml(t(`@${viewer.user.login}，你的 GitHub 身份已确认。提交前请阅读并签署下面的两份文件；提交后不能重复提交，可以在状态页查看排队位置和审批结果。`, `@${viewer.user.login}, your GitHub identity is confirmed. Read and sign the two documents below before submitting. After submitting you cannot apply again; the status page shows your queue position and the decision.`))}</p>
    <p class="fine">${escapeHtml(t('此申请只覆盖 Fledge；FlyBot、Bot Social 和 ScienceDiscovery 需要各自授权。', 'This application covers Fledge only; FlyBot, Bot Social and ScienceDiscovery each require their own authorization.'))}</p>
    <div class="flow">
      <div class="flow-step"><span>01 / GitHub</span><b>${escapeHtml(t('登录', 'Sign in'))}</b><small>${escapeHtml(t('已完成', 'Done'))}</small></div>
      <div class="flow-step"><span>02 / Agreements</span><b>${escapeHtml(t('签署', 'Sign'))}</b><small>${escapeHtml(t('免责声明 + 信息安全', 'Disclaimer + security'))}</small></div>
      <div class="flow-step"><span>03 / Queue</span><b>${escapeHtml(t('排队', 'Queue'))}</b><small>${escapeHtml(t('管理员审批', 'Admin review'))}</small></div>
      <div class="flow-step"><span>04 / Service</span><b>${escapeHtml(t('进入', 'Enter'))}</b><small>${escapeHtml(t('获得访问', 'Access granted'))}</small></div>
    </div>
    <div class="agreement">
      <h2>${escapeHtml(agreements.disclaimerTitle)}</h2>
      ${agreementHtml(agreements.disclaimerText)}
      <h2>${escapeHtml(agreements.securityTitle)}</h2>
      ${agreementHtml(agreements.securityText)}
    </div>
    <form method="post" action="/apply" class="form">
      ${csrf(viewer)}
      <label>${escapeHtml(t('签署：输入你的 GitHub 登录名', 'Signature: enter your GitHub username'))} <code>${escapeHtml(viewer.user.login)}</code>
        <input name="signature" placeholder="${escapeHtml(viewer.user.login)}" required autocomplete="off" />
      </label>
      <label class="check"><input type="checkbox" name="disclaimer" value="1" required /> ${escapeHtml(t(`我已阅读并同意《${agreements.disclaimerTitle}》`, `I have read and agree to the ${agreements.disclaimerTitle}.`))}</label>
      <label class="check"><input type="checkbox" name="security" value="1" required /> ${escapeHtml(t(`我已阅读并同意《${agreements.securityTitle}》`, `I have read and agree to the ${agreements.securityTitle}.`))}</label>
      <button class="btn" type="submit">${escapeHtml(t('签署并提交申请', 'Sign and submit'))}</button>
      <p class="fine">${escapeHtml(t('提交即表示以上签名与勾选对应当前 GitHub 身份；平台会记录签署时间、IP 和 User-Agent。', 'Submitting confirms that the signature and checkboxes apply to this GitHub identity; the platform records the signing time, IP and User-Agent.'))}</p>
    </form>
  </section>`
  return layout({ title: t('申请访问', 'Request access'), viewer, body, config, locale, path: '/apply', notice, error })
}

export function applicationStatusPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  position: number | null
  total: number
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, position, total, notice, error } = input
  const t = translator(locale)
  const rejected = viewer.user.status === 'rejected'
  const submitted = viewer.user.application_submitted_at
  const queue = position === null ? '—' : `#${position}`
  const body = `<section class="card narrow">
    <div class="eyebrow">${escapeHtml(rejected ? t('申请已结束', 'APPLICATION CLOSED') : t('等待审批', 'WAITING FOR APPROVAL'))}</div>
    <h1>${escapeHtml(rejected ? t('申请未通过', 'Application not approved') : t('申请已提交，正在排队', 'Application submitted; you are in the queue'))}</h1>
    <p>${escapeHtml(t(`@${viewer.user.login}，${rejected ? '这次申请没有通过。如果情况有变化，请联系管理员；不要重复提交。' : '管理员审批后会发邮件通知，本页每 10 秒自动刷新。不要重复提交申请。'}`, `@${viewer.user.login}, ${rejected ? 'this application was not approved. If your situation changes, contact the administrator; do not submit again.' : 'you will receive email after the administrator reviews it. This page refreshes every 10 seconds. Do not submit again.'}`))}</p>
    <p class="fine">${escapeHtml(t('Fledge 的审批只覆盖 Fledge；FlyBot、Bot Social 和 ScienceDiscovery 需要各自的授权。', 'Fledge approval covers Fledge only; FlyBot, Bot Social and ScienceDiscovery each require their own authorization.'))}</p>
    <div class="flow">
      <div class="flow-step"><span>01 / GitHub</span><b>${escapeHtml(t('登录', 'Sign in'))}</b><small>${escapeHtml(t('已完成', 'Done'))}</small></div>
      <div class="flow-step"><span>02 / Agreements</span><b>${escapeHtml(t('签署', 'Sign'))}</b><small>${escapeHtml(viewer.user.disclaimer_name ?? t('已签署', 'Signed'))}</small></div>
      <div class="flow-step"><span>03 / Queue</span><b>${escapeHtml(rejected ? t('已结束', 'Closed') : t('排队中', 'In queue'))}</b><small>${escapeHtml(rejected ? t('未通过', 'Not approved') : t(`位置 ${queue} / ${total}`, `Position ${queue} / ${total}`))}</small></div>
      <div class="flow-step"><span>04 / Service</span><b>${escapeHtml(t('进入', 'Enter'))}</b><small>${escapeHtml(rejected ? t('需要管理员重新开启', 'The administrator must reopen it') : t('审批通过后', 'After approval'))}</small></div>
    </div>
    <div class="quota-card card">
      <div>
        <div class="eyebrow">${escapeHtml(t('排队位置', 'QUEUE POSITION'))}</div>
        <div class="quota-big" data-queue-position>${escapeHtml(queue)}<small> / ${total} ${escapeHtml(t('待审批', 'pending'))}</small></div>
        <p class="muted">${escapeHtml(t('提交时间', 'Submitted'))} ${escapeHtml(humanTimeShort(submitted))} · ${escapeHtml(t('签署', 'Signed'))} ${escapeHtml(viewer.user.disclaimer_name ?? '—')}</p>
      </div>
    </div>
    ${rejected ? '' : `<p class="fine">${escapeHtml(t('管理员通常在一个工作日内处理。邮件可能进入垃圾箱；也可以回到本页查看状态。', 'The administrator usually reviews within one business day. Check your spam folder or return to this page for the status.'))}</p>`}
    <form method="post" action="/auth/logout">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('退出登录', 'Sign out'))}</button></form>
  </section>
  <script src="/assets/application.js" defer></script>`
  return layout({ title: rejected ? t('申请未通过', 'Application not approved') : t('申请状态', 'Application status'), viewer, body, config, locale, path: '/apply/status', notice, error })
}

export function workspacePage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  repos: RepoRow[]
  jobs: JobRow[]
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, repos, jobs, notice, error } = input
  const t = translator(locale)
  const quota = quotaView(viewer.user, config)
  const active = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length
  const recent = jobs.slice(0, 5)
  const repoBlock = repos.length === 0
    ? `<div class="empty">
        <p><strong>${escapeHtml(t('还没有仓库。', 'No repositories yet.'))}</strong> ${escapeHtml(t('添加第一个仓库后，FlyBot 才会开始迭代。', 'Add your first repository and FlyBot can start iterating.'))}</p>
        <a class="btn" href="/dashboard#add-repo">${escapeHtml(t('添加仓库', 'Add repository'))}</a>
      </div>`
    : `<div class="list">${repos
        .slice(0, 4)
        .map(
          (repo) => `<a class="list-row" href="/repos/${escapeHtml(repo.id)}">
            <div class="list-main">
              <strong>${escapeHtml(repo.upstream_owner || repo.owner)}/${escapeHtml(repo.upstream_name || repo.name)}</strong>
              <small>${repo.auto_iterate === 1 ? `${escapeHtml(t('自动', 'Auto'))} · ${escapeHtml(intervalLabel(repo.interval_minutes, t))}` : escapeHtml(t('手动', 'Manual'))} · ${escapeHtml(t('上次运行', 'Last run'))} ${escapeHtml(humanTimeShort(repo.last_run_at))}${repo.is_fork === 1 ? ` · ${escapeHtml(t('fork', 'fork'))} ${escapeHtml(repo.fork_owner)}/${escapeHtml(repo.fork_name)}` : ''}</small>
            </div>
            <div class="list-meta">${badge(t, repo.last_status ?? 'idle')}${repo.reviewer_enabled === 1 ? ' <span class="badge">reviewer</span>' : ''}</div>
          </a>`,
        )
        .join('')}</div>
      ${repos.length > 4 ? `<p class="fine" style="margin:12px 0 0"><a href="/dashboard">${escapeHtml(t(`查看其余 ${repos.length - 4} 个仓库`, `View the other ${repos.length - 4} repositories`))}</a></p>` : ''}`
  const initial = viewer.user.login.slice(0, 1).toUpperCase()
  const avatar = viewer.user.avatar_url === null || viewer.user.avatar_url === ''
    ? `<span class="workspace-avatar workspace-avatar-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`
    : `<img class="workspace-avatar" src="${escapeHtml(viewer.user.avatar_url)}" alt="" width="56" height="56" />`
  const body = `<section class="workspace-hero">
    <div class="workspace-intro">
      <div class="workspace-user">
        ${avatar}
        <div>
          <div class="eyebrow">${escapeHtml(t('工作区', 'WORKSPACE'))}</div>
          <h1>@${escapeHtml(viewer.user.login)}</h1>
          <p class="workspace-meta">${badge(t, viewer.user.status)} <span class="dot-sep">·</span> ${escapeHtml(t('加入于', 'Joined'))} ${escapeHtml(humanTimeShort(viewer.user.created_at))}</p>
        </div>
      </div>
      <p class="muted">${escapeHtml(t('管理仓库、任务和模型额度；需要完整列表时进入仓库页。', 'Manage repositories, jobs and model quota; open Repositories for the full list.'))}</p>
    </div>
    <div class="workspace-actions">
      <a class="btn" href="/dashboard#add-repo">${escapeHtml(t('添加仓库', 'Add repository'))}</a>
      <a class="btn btn-ghost" href="/settings">${escapeHtml(t('设置', 'Settings'))}</a>
      <a class="btn btn-ghost" href="${escapeHtml(config.services.docs)}" target="_blank" rel="noreferrer">${escapeHtml(t('文档', 'Docs'))}</a>
    </div>
  </section>
  ${quota.exhausted ? `<div class="banner bad">${escapeHtml(t('平台额度已用完。请到 Settings → Model 配置你自己的模型 API，任务才能继续。', 'Platform quota is used up. Add your own model API in Settings → Model to keep jobs running.'))}</div>` : ''}
  <section class="stats">
    <a class="stat" href="/dashboard"><span>${escapeHtml(t('仓库', 'Repositories'))}</span><strong>${repos.length}</strong><small>${escapeHtml(t('已接入', 'Connected'))}</small></a>
    <a class="stat" href="/dashboard"><span>${escapeHtml(t('进行中', 'In progress'))}</span><strong>${active}</strong><small>${escapeHtml(t('排队或运行', 'Queued or running'))}</small></a>
    <a class="stat" href="/settings#model"><span>${escapeHtml(t('平台额度', 'Platform quota'))}</span><strong>${quota.unlimited ? escapeHtml(t('不限额', 'Unlimited')) : quotaMoney(quota.remainingCny)}</strong><small>${escapeHtml(quota.unlimited ? t('用量仍会记录', 'usage is still recorded') : t(`剩余 / ${money(quota.initialCny)}`, `left of ${money(quota.initialCny)}`))}</small></a>
  </section>
  <section class="card">
    <div class="row between"><h2>${escapeHtml(t('仓库', 'Repositories'))}</h2><a class="link" href="/dashboard">${escapeHtml(t('管理全部', 'Manage all'))}</a></div>
    ${repoBlock}
  </section>
  <section class="card">
    <div class="row between"><h2>${escapeHtml(t('最近任务', 'Recent jobs'))}</h2><a class="link" href="/dashboard">${escapeHtml(t('查看全部', 'View all'))}</a></div>
    ${jobList(locale, recent)}
  </section>`
  return layout({ title: t('工作区', 'Workspace'), viewer, body, config, locale, path: '/console', active: 'console', notice, error })
}

export function messagePage(config: Config, title: string, message: string, viewer?: Viewer | null, locale: Locale = 'zh'): string {
  const t = translator(locale)
  const localizedTitle = localizeMessage(locale, title) ?? title
  const localizedMessage = localizeMessage(locale, message) ?? message
  return layout({
    title: localizedTitle,
    viewer,
    config,
    locale,
    path: '/',
    body: `<section class="card narrow"><h1>${escapeHtml(localizedTitle)}</h1><p>${escapeHtml(localizedMessage)}</p><a class="btn btn-ghost" href="/">${escapeHtml(t('回首页', 'Back home'))}</a></section>`,
  })
}
