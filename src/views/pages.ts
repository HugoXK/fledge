import type { Config } from '../config.js'
import type { AuditRow, JobRow, NotificationRow, RepoRow, UserRow, ApiTokenRow } from '../db.js'
import { quotaView } from '../gateway/quota.js'
import { humanTime } from '../lib/time.js'
import { escapeHtml, layout, money, type Viewer } from './layout.js'

function csrf(viewer: Viewer): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}" />`
}

function badge(status: string): string {
  const cls = status === 'succeeded' || status === 'approved' ? 'badge good' : status === 'failed' || status === 'rejected' ? 'badge bad' : status === 'running' || status === 'queued' ? 'badge busy' : 'badge'
  return `<span class="${cls}">${escapeHtml(status)}</span>`
}

function jobRows(jobs: JobRow[]): string {
  if (jobs.length === 0) return '<tr><td colspan="6" class="muted">还没有任务。</td></tr>'
  return jobs
    .map(
      (job) => `<tr>
        <td><code>${escapeHtml(job.id)}</code></td>
        <td>${badge(job.status)}</td>
        <td>${escapeHtml(job.trigger)}</td>
        <td>${job.pr_url === null ? '—' : `<a href="${escapeHtml(job.pr_url)}" target="_blank" rel="noreferrer">PR</a>`}</td>
        <td>${escapeHtml(job.summary ?? job.error ?? '—').slice(0, 120)}</td>
        <td>${escapeHtml(humanTime(job.created_at))}</td>
      </tr>`,
    )
    .join('')
}

function noticeBlock(viewer: Viewer, notifications: NotificationRow[]): string {
  const unread = notifications.filter((entry) => entry.read_at === null)
  if (unread.length === 0) return ''
  return `<div class="card notices"><h2>通知</h2>${unread
    .slice(0, 3)
    .map((entry) => `<div class="notice"><span>${escapeHtml(entry.message)}</span><small>${escapeHtml(humanTime(entry.created_at))}</small></div>`)
    .join('')}<form method="post" action="/notifications/read">${csrf(viewer)}<button class="link" type="submit">全部标为已读</button></form></div>`
}

export function landingPage(config: Config, viewer?: Viewer | null, devLogin = false, oauthConfigured = true): string {
  const body = `<section class="hero">
    <div class="eyebrow">HOSTED · SELF-ITERATING · REVIEWABLE</div>
    <h1>让仓库自己长大。</h1>
    <p class="lede">把多个 GitHub 仓库交给 Fledge。FlyBot 会持续阅读代码、写失败的测试、修最小的根因，并开一个你可以审查的 PR。你只需要决定合不合。</p>
    <div class="actions">
      ${oauthConfigured ? '<a class="btn" href="/auth/github">使用 GitHub 登录</a>' : '<a class="btn" href="#token-login">使用 GitHub token 登录</a>'}
      ${devLogin ? '<a class="btn btn-ghost" href="/auth/dev">Dev 登录（本地）</a>' : ''}
      <a class="btn btn-ghost" href="https://github.com/HugoXK/fledge" target="_blank" rel="noreferrer">看源码</a>
    </div>
    <p class="fine">首次登录需要管理员批准。平台初始额度 1 元；用完后配置你自己的模型 API 即可继续。</p>
    ${oauthConfigured ? '' : '<p class="fine">OAuth App 尚未配置；先用 GitHub token 登录（只用于确认身份，不会保存），部署后可在 .env 补 OAuth。</p>'}
    <details class="card narrow" id="token-login" ${oauthConfigured ? '' : 'open'} style="margin:24px 0 0">
      <summary>使用 GitHub token 登录（备用）</summary>
      <form method="post" action="/auth/token" class="form">
        <label>GitHub token <input name="token" type="password" placeholder="github_pat_… 或 ghp_…" required autocomplete="off" /></label>
        <p class="fine">只用于确认 GitHub 身份，不会保存。仓库 token 在添加仓库时单独填写。</p>
        <button class="btn" type="submit">用 token 登录</button>
      </form>
    </details>
  </section>
  <section class="grid3">
    <article class="card"><h3>多仓库</h3><p>一个账号绑定多个仓库，每个仓库有自己的目标、节奏和状态。</p></article>
    <article class="card"><h3>可审查</h3><p>每个任务只产出一个聚焦的 PR。不直接推 main，不自动合并，不隐藏改动。</p></article>
    <article class="card"><h3>自己的模型</h3><p>平台额度用完不会停摆：填入任意 OpenAI 兼容服务，任务继续跑。</p></article>
  </section>`
  return layout({ title: '让仓库自己长大', viewer, body, config })
}

export function pendingPage(config: Config, viewer: Viewer): string {
  const body = `<section class="card narrow">
    <div class="eyebrow">APPLICATION PENDING</div>
    <h1>申请已提交</h1>
    <p>@${escapeHtml(viewer.user.login)}，你的访问申请已经发送给管理员 <strong>${escapeHtml(config.mail.adminEmail)}</strong>。</p>
    <p class="muted">批准后会收到邮件。通过后刷新本页即可进入控制台。申请状态：${badge(viewer.user.status)}</p>
    <form method="post" action="/auth/logout">${csrf(viewer)}<button class="btn btn-ghost" type="submit">退出登录</button></form>
  </section>`
  return layout({ title: '申请已提交', viewer, body, config })
}

export function rejectedPage(config: Config, viewer: Viewer): string {
  const body = `<section class="card narrow">
    <h1>申请未通过</h1>
    <p>@${escapeHtml(viewer.user.login)}，这次申请没有通过。如果情况有变化，可以稍后重新登录申请。</p>
    <form method="post" action="/auth/logout">${csrf(viewer)}<button class="btn btn-ghost" type="submit">退出登录</button></form>
  </section>`
  return layout({ title: '申请未通过', viewer, body, config })
}

export function dashboardPage(input: {
  config: Config
  viewer: Viewer
  repos: RepoRow[]
  jobs: JobRow[]
  notifications: NotificationRow[]
  notice?: string
  error?: string
}): string {
  const { config, viewer, repos, jobs, notifications, notice, error } = input
  const quota = quotaView(viewer.user, config)
  const repoRows = repos.length === 0
    ? '<tr><td colspan="5" class="muted">还没有仓库。先添加一个。</td></tr>'
    : repos
        .map(
          (repo) => `<tr>
            <td><a href="/repos/${escapeHtml(repo.id)}"><strong>${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</strong></a></td>
            <td>${repo.auto_iterate === 1 ? '<span class="badge good">自动</span>' : '<span class="badge">手动</span>'}</td>
            <td>${badge(repo.last_status ?? 'idle')}</td>
            <td>${escapeHtml(humanTime(repo.last_run_at))}</td>
            <td><a class="link" href="/repos/${escapeHtml(repo.id)}">打开</a></td>
          </tr>`,
        )
        .join('')
  const body = `${quota.exhausted ? `<div class="banner bad">平台额度已用完。请到 <a href="/settings#model">Settings → Model</a> 配置你自己的模型 API，任务才能继续。</div>` : ''}
  ${noticeBlock(viewer, notifications)}
  <section class="quota-card card">
    <div>
      <div class="eyebrow">PLATFORM QUOTA</div>
      <div class="quota-big">${money(quota.remainingCny)}<small> / ${money(quota.initialCny)}</small></div>
      <p class="muted">已用 ${money(quota.usedCny)} · 平台额度用完后可配置自己的模型 API</p>
    </div>
    <div class="meter"><span style="width:${Math.min(100, Math.max(0, (quota.usedCny / Math.max(0.0001, quota.initialCny)) * 100)).toFixed(2)}%"></span></div>
  </section>

  <section class="cols">
    <div class="card">
      <h2>仓库</h2>
      <table><thead><tr><th>仓库</th><th>模式</th><th>状态</th><th>上次运行</th><th></th></tr></thead><tbody>${repoRows}</tbody></table>
    </div>
    <div class="card">
      <h2>添加仓库</h2>
      <form method="post" action="/repos" class="form">
        ${csrf(viewer)}
        <label>仓库 <input name="repo" placeholder="owner/name" required autocomplete="off" /></label>
        <label>GitHub token <input name="token" type="password" placeholder="github_pat_… 或 ghp_…" required autocomplete="off" /></label>
        <label>迭代目标（可选） <textarea name="goal" rows="3" placeholder="例如：持续修复 issue 里的可复现 bug，只改最小范围。"></textarea></label>
        <div class="row">
          <label class="check"><input type="checkbox" name="auto" value="1" /> 自动迭代</label>
          <label>间隔 <select name="interval"><option value="60">每小时</option><option value="360">每 6 小时</option><option value="1440" selected>每天</option><option value="10080">每周</option></select></label>
        </div>
        <p class="fine">建议使用 fine-grained token，只授权目标仓库的 <code>Contents: read/write</code> 与 <code>Pull requests: read/write</code>。token 会加密保存，页面不会回显。</p>
        <button class="btn" type="submit">添加仓库</button>
      </form>
    </div>
  </section>

  <section class="card">
    <h2>最近任务</h2>
    <table><thead><tr><th>任务</th><th>状态</th><th>触发</th><th>PR</th><th>摘要</th><th>时间</th></tr></thead><tbody>${jobRows(jobs)}</tbody></table>
  </section>`
  return layout({ title: '控制台', viewer, body, config, active: 'dashboard', notice, error })
}

export function repoPage(input: { config: Config; viewer: Viewer; repo: RepoRow; jobs: JobRow[]; notice?: string; error?: string }): string {
  const { config, viewer, repo, jobs, notice, error } = input
  const body = `<section class="card">
    <div class="row between">
      <div>
        <div class="eyebrow">REPOSITORY</div>
        <h1>${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</h1>
        <p class="muted">默认分支 <code>${escapeHtml(repo.default_branch)}</code> · ${repo.auto_iterate === 1 ? '自动迭代已开启' : '仅手动运行'} · ${badge(repo.last_status ?? 'idle')}</p>
      </div>
      <form method="post" action="/repos/${escapeHtml(repo.id)}/run">${csrf(viewer)}<button class="btn" type="submit">立即运行</button></form>
    </div>
  </section>
  <section class="cols">
    <div class="card">
      <h2>迭代目标</h2>
      <form method="post" action="/repos/${escapeHtml(repo.id)}/settings" class="form">
        ${csrf(viewer)}
        <textarea name="goal" rows="5" placeholder="这个仓库每次迭代应该关注什么？">${escapeHtml(repo.goal)}</textarea>
        <div class="row">
          <label class="check"><input type="checkbox" name="auto" value="1" ${repo.auto_iterate === 1 ? 'checked' : ''} /> 自动迭代</label>
          <label class="check"><input type="checkbox" name="enabled" value="1" ${repo.enabled === 1 ? 'checked' : ''} /> 启用</label>
          <label>间隔 <select name="interval"><option value="60" ${repo.interval_minutes === 60 ? 'selected' : ''}>每小时</option><option value="360" ${repo.interval_minutes === 360 ? 'selected' : ''}>每 6 小时</option><option value="1440" ${repo.interval_minutes === 1440 ? 'selected' : ''}>每天</option><option value="10080" ${repo.interval_minutes === 10080 ? 'selected' : ''}>每周</option></select></label>
        </div>
        <button class="btn" type="submit">保存</button>
      </form>
    </div>
    <div class="card">
      <h2>连接</h2>
      <p class="muted">GitHub token 已加密保存；页面不会显示明文。如果仓库或 token 变了，删除后重新添加。</p>
      <form method="post" action="/repos/${escapeHtml(repo.id)}/delete" onsubmit="return confirm('删除这个仓库及其任务记录？')">${csrf(viewer)}<button class="btn btn-danger" type="submit">删除仓库</button></form>
      <p class="fine">平台只通过 GitHub API 读取元数据和创建分支/PR；不会 clone 到公共磁盘。</p>
    </div>
  </section>
  <section class="card">
    <h2>任务</h2>
    <table><thead><tr><th>任务</th><th>状态</th><th>触发</th><th>PR</th><th>摘要</th><th>时间</th></tr></thead><tbody>${jobRows(jobs)}</tbody></table>
  </section>`
  return layout({ title: `${repo.owner}/${repo.name}`, viewer, body, config, active: 'dashboard', notice, error })
}

export function settingsPage(input: {
  config: Config
  viewer: Viewer
  tokens: ApiTokenRow[]
  newToken?: string
  notice?: string
  error?: string
}): string {
  const { config, viewer, tokens, newToken, notice, error } = input
  const user = viewer.user
  const quota = quotaView(user, config)
  const tokenRows = tokens.length === 0
    ? '<tr><td colspan="4" class="muted">还没有 API token。</td></tr>'
    : tokens
        .map(
          (token) => `<tr><td><code>${escapeHtml(token.prefix)}…</code></td><td>${escapeHtml(token.name)}</td><td>${escapeHtml(humanTime(token.last_used_at))}</td><td><form method="post" action="/settings/tokens/${escapeHtml(token.id)}/revoke">${csrf(viewer)}<button class="link" type="submit">撤销</button></form></td></tr>`,
        )
        .join('')
  const body = `<section class="card">
    <div class="eyebrow">ACCOUNT</div>
    <h1>@${escapeHtml(user.login)}</h1>
    <p class="muted">${escapeHtml(user.email ?? '未公开邮箱')} · 加入于 ${escapeHtml(humanTime(user.created_at))} · 平台额度 ${money(quota.remainingCny)} / ${money(quota.initialCny)}</p>
    ${user.github_token_enc !== null ? '<p class="fine">登录时保存了一个默认 GitHub token；添加仓库时仍以仓库表单里的 token 为准。</p>' : ''}
  </section>

  <section class="card" id="model">
    <h2>模型服务</h2>
    <p class="muted">默认使用平台额度（1 元，约 ${money(quota.initialCny)}）。额度用完后，填入你自己的 OpenAI 兼容服务即可继续；平台不再扣额度。</p>
    ${quota.exhausted ? '<div class="banner bad">平台额度已用完。保存自己的模型服务后，任务会自动使用它。</div>' : ''}
    <form method="post" action="/settings/model" class="form">
      ${csrf(viewer)}
      <label>Base URL <input name="baseUrl" value="${escapeHtml(user.own_llm_base_url ?? '')}" placeholder="https://api.example.com/v1" autocomplete="off" /></label>
      <label>API Key <input name="apiKey" type="password" placeholder="${user.own_llm_key_enc === null ? 'sk-…' : '已保存，留空不修改'}" autocomplete="off" /></label>
      <label>Model <input name="model" value="${escapeHtml(user.own_llm_model ?? '')}" placeholder="例如 gpt-4o-mini 或 deepseek-chat" autocomplete="off" /></label>
      <div class="row">
        <button class="btn" name="action" value="save" type="submit">保存并测试</button>
        <button class="btn btn-ghost" name="action" value="clear" type="submit">清除，改回平台额度</button>
      </div>
    </form>
    <p class="fine">必须是 OpenAI 兼容的 <code>/v1/chat/completions</code> 服务；公网服务要求 https。保存时会发一个 1 token 的测试请求。</p>
  </section>

  <section class="card">
    <h2>API tokens</h2>
    <p class="muted">给脚本或 FlyBot 调用的网关 token（<code>flg_…</code>）。它不是你的 GitHub token，也不是模型 key。</p>
    ${newToken === undefined ? '' : `<div class="banner ok">新 token（只显示一次）：<code class="token">${escapeHtml(newToken)}</code></div>`}
    <table><thead><tr><th>前缀</th><th>名称</th><th>最近使用</th><th></th></tr></thead><tbody>${tokenRows}</tbody></table>
    <form method="post" action="/settings/tokens" class="row">${csrf(viewer)}<input name="name" placeholder="用途，例如 laptop-cli" required /><button class="btn" type="submit">创建 token</button></form>
  </section>`
  return layout({ title: '设置', viewer, body, config, active: 'settings', notice, error })
}

export function adminPage(input: {
  config: Config
  viewer: Viewer
  users: UserRow[]
  jobs: JobRow[]
  audit: AuditRow[]
  notice?: string
  error?: string
}): string {
  const { config, viewer, users, jobs, audit, notice, error } = input
  const pending = users.filter((user) => user.status === 'pending')
  const pendingRows = pending.length === 0
    ? '<tr><td colspan="4" class="muted">没有待审批申请。</td></tr>'
    : pending
        .map(
          (user) => `<tr>
            <td>@${escapeHtml(user.login)}<br /><small class="muted">${escapeHtml(user.email ?? '')}</small></td>
            <td>${escapeHtml(humanTime(user.created_at))}</td>
            <td>${badge(user.status)}</td>
            <td class="row">
              <form method="post" action="/admin/users/${escapeHtml(user.id)}/approve">${csrf(viewer)}<button class="link good" type="submit">批准</button></form>
              <form method="post" action="/admin/users/${escapeHtml(user.id)}/reject">${csrf(viewer)}<button class="link bad" type="submit">拒绝</button></form>
            </td>
          </tr>`,
        )
        .join('')
  const userRows = users
    .map(
      (user) => `<tr>
        <td>@${escapeHtml(user.login)}</td>
        <td>${badge(user.status)}</td>
        <td>${escapeHtml(user.role)}</td>
        <td>${money(user.quota_cny)}</td>
        <td>${money(quotaView(user, config).usedCny)}</td>
        <td><form method="post" action="/admin/users/${escapeHtml(user.id)}/quota" class="row"><input name="quota" type="number" step="0.1" min="0" value="${user.quota_cny}" /><button class="link" type="submit">改额度</button></form></td>
      </tr>`,
    )
    .join('')
  const body = `<section class="card">
    <div class="eyebrow">ADMIN</div>
    <h1>审批与额度</h1>
    <p class="muted">申请邮件发往 ${escapeHtml(config.mail.adminEmail)}；这里的操作会写审计日志。</p>
  </section>
  <section class="card">
    <h2>待审批 (${pending.length})</h2>
    <table><thead><tr><th>用户</th><th>申请时间</th><th>状态</th><th></th></tr></thead><tbody>${pendingRows}</tbody></table>
  </section>
  <section class="card">
    <h2>用户</h2>
    <table><thead><tr><th>登录名</th><th>状态</th><th>角色</th><th>额度</th><th>已用</th><th>调整</th></tr></thead><tbody>${userRows}</tbody></table>
  </section>
  <section class="cols">
    <div class="card"><h2>最近任务</h2><table><thead><tr><th>任务</th><th>状态</th><th>触发</th><th>PR</th><th>摘要</th><th>时间</th></tr></thead><tbody>${jobRows(jobs)}</tbody></table></div>
    <div class="card"><h2>审计</h2><table><thead><tr><th>时间</th><th>动作</th><th>用户</th><th>详情</th></tr></thead><tbody>${audit
      .map((row) => `<tr><td>${escapeHtml(humanTime(row.at))}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.user_id ?? '—')}</td><td>${escapeHtml(row.detail ?? '')}</td></tr>`)
      .join('') || '<tr><td colspan="4" class="muted">暂无记录。</td></tr>'}</tbody></table></div>
  </section>`
  return layout({ title: 'Admin', viewer, body, config, active: 'admin', notice, error })
}

export function approvalPage(input: { config: Config; user: UserRow; action: 'approve' | 'reject'; token: string; error?: string }): string {
  const { config, user, action, token, error } = input
  const verb = action === 'approve' ? '批准' : '拒绝'
  const body = `<section class="card narrow">
    <div class="eyebrow">APPLICATION ${action.toUpperCase()}</div>
    <h1>${verb} @${escapeHtml(user.login)} 的申请？</h1>
    <p>${escapeHtml(user.name ?? '')} · ${escapeHtml(user.email ?? '未公开邮箱')} · <a href="https://github.com/${escapeHtml(user.login)}" target="_blank" rel="noreferrer">GitHub 主页</a></p>
    <p class="muted">申请时间 ${escapeHtml(humanTime(user.created_at))}。这个链接只能使用一次。</p>
    <form method="post" action="/approve/${escapeHtml(token)}">
      <button class="btn ${action === 'reject' ? 'btn-danger' : ''}" type="submit">${verb}</button>
      <a class="btn btn-ghost" href="/admin">去 Admin</a>
    </form>
  </section>`
  return layout({ title: `${verb}申请`, body, config, error })
}

export function errorPage(config: Config, viewer: Viewer | null, title: string, message: string): string {
  return layout({
    title,
    viewer,
    config,
    body: `<section class="card narrow"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="btn btn-ghost" href="/">回首页</a></section>`,
  })
}

export function messagePage(config: Config, title: string, message: string, viewer?: Viewer | null): string {
  return layout({
    title,
    viewer,
    config,
    body: `<section class="card narrow"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="btn btn-ghost" href="/">回首页</a></section>`,
  })
}
