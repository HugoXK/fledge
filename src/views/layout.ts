import type { UserRow } from '../db.js'
import { quotaView } from '../gateway/quota.js'
import type { Config } from '../config.js'

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}

export function money(cny: number): string {
  return `¥${cny.toFixed(2)}`
}

export interface Viewer {
  user: UserRow
  csrfToken: string
}

export interface LayoutOptions {
  title: string
  viewer?: Viewer | null
  body: string
  config: Config
  active?: string
  notice?: string
  error?: string
}

export function quotaPill(user: UserRow, config: Config): string {
  const quota = quotaView(user, config)
  const cls = quota.exhausted ? 'pill pill-danger' : quota.remainingCny < quota.initialCny * 0.2 ? 'pill pill-warn' : 'pill'
  return `<span class="${cls}" title="平台额度">${quota.exhausted ? '额度已用完' : money(quota.remainingCny)}</span>`
}

export function layout(options: LayoutOptions): string {
  const { title, viewer, body, config, active, notice, error } = options
  const nav = viewer === undefined || viewer === null
    ? ''
    : `<nav class="nav">
        <a class="${active === 'console' ? 'on' : ''}" href="/console">服务</a>
        <a class="${active === 'dashboard' ? 'on' : ''}" href="/dashboard">仓库</a>
        <a class="${active === 'settings' ? 'on' : ''}" href="/settings">设置</a>
        ${viewer.user.role === 'admin' ? `<a class="${active === 'admin' ? 'on' : ''}" href="/admin">Admin</a>` : ''}
      </nav>`
  const account = viewer === undefined || viewer === null
    ? `<a class="btn btn-ghost" href="/auth/github">GitHub 登录</a>`
    : `<div class="account">
        <img src="${escapeHtml(viewer.user.avatar_url ?? '')}" alt="" width="24" height="24" />
        <span>@${escapeHtml(viewer.user.login)}</span>
        ${quotaPill(viewer.user, config)}
        <form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}" /><button class="link" type="submit">退出</button></form>
      </div>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <title>${escapeHtml(title)} · Fledge</title>
  <link rel="stylesheet" href="/assets/app.css" />
</head>
<body>
  <header class="top">
    <a class="brand" href="/"><span class="mark">F</span><span>Fledge<small>羽巢</small></span></a>
    ${nav}
    <div class="spacer"></div>
    ${account}
  </header>
  <main class="wrap">
    ${notice === undefined ? '' : `<div class="banner ok">${escapeHtml(notice)}</div>`}
    ${error === undefined ? '' : `<div class="banner bad">${escapeHtml(error)}</div>`}
    ${body}
  </main>
  <footer class="foot">Fledge · hosted repositories that grow themselves · powered by FlyBot</footer>
  <script src="/assets/app.js" defer></script>
</body>
</html>`
}
