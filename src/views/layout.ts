import type { UserRow } from '../db.js'
import { quotaView, type QuotaView } from '../gateway/quota.js'
import type { Config } from '../config.js'
import { localizeMessage, translator, type Locale, type Translate } from '../i18n.js'

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}

export function money(cny: number): string {
  return `¥${cny.toFixed(2)}`
}

export function quotaMoney(cny: number): string {
  return cny > 0 && cny < 1 ? `¥${cny.toFixed(4)}` : money(cny)
}

export function quotaAmount(quota: QuotaView, t: Translate): string {
  return quota.unlimited ? t('不限额', 'Unlimited') : quotaMoney(quota.remainingCny)
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
  locale?: Locale
  path?: string
  active?: string
  notice?: string
  error?: string
}

function languageSwitch(locale: Locale, path: string): string {
  const encoded = encodeURIComponent(path)
  const item = (value: Locale, label: string) =>
    `<a href="/lang/${value}?next=${encoded}" data-lang-btn="${value}" aria-pressed="${value === locale}"${value === locale ? ' aria-current="true"' : ''}>${label}</a>`
  return `<div class="lang" role="group" aria-label="Language">${item('zh', '中')}${item('en', 'EN')}</div>`
}

export function quotaPill(user: UserRow, config: Config, locale: Locale = 'zh'): string {
  const t = translator(locale)
  const quota = quotaView(user, config)
  const cls = quota.unlimited ? 'pill' : quota.exhausted ? 'pill pill-danger' : quota.remainingCny < quota.initialCny * 0.2 ? 'pill pill-warn' : 'pill'
  return `<span class="${cls}" title="${escapeHtml(t('平台额度', 'Platform quota'))}">${quota.exhausted ? t('额度已用完', 'Quota used up') : quotaAmount(quota, t)}</span>`
}

export function layout(options: LayoutOptions): string {
  const { title, viewer, body, config, active } = options
  const locale = options.locale ?? 'zh'
  const path = options.path ?? '/'
  const t = translator(locale)
  const notice = localizeMessage(locale, options.notice)
  const error = localizeMessage(locale, options.error)
  const nav = viewer === undefined || viewer === null
    ? ''
    : `<nav class="nav" aria-label="${escapeHtml(t('主导航', 'Main navigation'))}">
        <a class="${active === 'console' ? 'on' : ''}" href="/console">${escapeHtml(t('工作区', 'Workspace'))}</a>
        <a class="${active === 'dashboard' ? 'on' : ''}" href="/dashboard">${escapeHtml(t('仓库', 'Repositories'))}</a>
        <a class="${active === 'settings' ? 'on' : ''}" href="/settings">${escapeHtml(t('设置', 'Settings'))}</a>
        ${viewer.user.role === 'admin' ? `<a class="${active === 'admin' ? 'on' : ''}" href="/admin">${escapeHtml(t('管理', 'Admin'))}</a>` : ''}
      </nav>`
  const accountAvatar = viewer !== undefined && viewer !== null && viewer.user.avatar_url !== null && viewer.user.avatar_url !== ''
    ? `<img src="${escapeHtml(viewer.user.avatar_url)}" alt="" width="24" height="24" />`
    : viewer !== undefined && viewer !== null
      ? `<span class="account-avatar" aria-hidden="true">${escapeHtml(viewer.user.login.slice(0, 1).toUpperCase())}</span>`
      : ''
  const account = viewer === undefined || viewer === null
    ? `<a class="btn btn-ghost btn-small" href="/auth/github">${escapeHtml(t('GitHub 登录', 'Sign in with GitHub'))}</a>`
    : `<div class="account">
        ${accountAvatar}
        <span class="account-name">@${escapeHtml(viewer.user.login)}</span>
        ${quotaPill(viewer.user, config, locale)}
        <form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}" /><button class="link account-exit" type="submit">${escapeHtml(t('退出', 'Sign out'))}</button></form>
      </div>`
  const brandSmall = locale === 'zh' ? '<small>羽巢</small>' : ''
  const footer = `<footer class="foot">
    <div>${escapeHtml(t('Fledge · 让托管的仓库自己长大 · 由 FlyBot 驱动', 'Fledge · hosted repositories that grow themselves · powered by FlyBot'))}</div>
    <nav class="foot-links" aria-label="${escapeHtml(t('页脚导航', 'Footer navigation'))}">
      <a href="${escapeHtml(config.services.docs)}" target="_blank" rel="noreferrer">${escapeHtml(t('文档', 'Docs'))}</a>
      <a href="${escapeHtml(config.services.portal)}" target="_blank" rel="noreferrer">Portal</a>
      <a href="${escapeHtml(config.services.status)}" target="_blank" rel="noreferrer">${escapeHtml(t('平台状态', 'Status'))}</a>
      <a href="https://github.com/HugoXK/fledge" target="_blank" rel="noreferrer">GitHub</a>
    </nav>
  </footer>`
  return `<!doctype html>
<html lang="${locale === 'en' ? 'en' : 'zh-CN'}" data-locale="${locale}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#07090d" />
  <title>${escapeHtml(title)} · Fledge</title>
  <link rel="stylesheet" href="/assets/app.css" />
</head>
<body>
  <header class="top">
    <div class="top-inner">
      <a class="brand" href="/"><span class="mark">F</span><span>Fledge${brandSmall}</span></a>
      ${nav}
      <div class="spacer"></div>
      ${languageSwitch(locale, path)}
      ${account}
    </div>
  </header>
  <main class="wrap" id="main">
    ${notice === undefined ? '' : `<div class="banner ok" role="status">${escapeHtml(notice)}</div>`}
    ${error === undefined ? '' : `<div class="banner bad" role="alert">${escapeHtml(error)}</div>`}
    ${body}
  </main>
  ${footer}
  <script src="/assets/app.js" defer></script>
</body>
</html>`
}
