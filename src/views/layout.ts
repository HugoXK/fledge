import type { UserRow } from '../db.js'
import { quotaView, type QuotaView } from '../gateway/quota.js'
import type { Config } from '../config.js'
import { localizeMessage, translator, type Locale, type Translate } from '../i18n.js'
import { releaseSurface, type ReleaseSurface } from '../lib/releaseSurface.js'

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
  preview?: boolean
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
  /** Defaults to the running process's surface; a test passes a fixture root. */
  release?: ReleaseSurface
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

// The nav marks the current section from the route so a page cannot forget to
// pass `active`; nested routes stay inside their section.
export function sectionForPath(path: string): string {
  const clean = path.split('?')[0] ?? '/'
  if (clean === '/console' || clean.startsWith('/console/')) return 'console'
  if (clean === '/dashboard' || clean.startsWith('/dashboard/') || clean === '/repos' || clean.startsWith('/repos/')) return 'dashboard'
  if (clean === '/settings' || clean.startsWith('/settings/')) return 'settings'
  if (clean === '/admin' || clean.startsWith('/admin/')) return 'admin'
  return ''
}

function withSlash(value: string): string {
  return value === '' || value.endsWith('/') ? value : `${value}/`
}

export function layout(options: LayoutOptions): string {
  const { title, viewer, body, config, active } = options
  const locale = options.locale ?? 'zh'
  const path = options.path ?? '/'
  const t = translator(locale)
  const notice = localizeMessage(locale, options.notice)
  const error = localizeMessage(locale, options.error)
  const preview = viewer !== undefined && viewer !== null && viewer.preview === true
  const release = options.release ?? releaseSurface()
  const section = active ?? sectionForPath(path)
  const navItem = (key: string, href: string, label: string): string =>
    section === key
      ? `<a class="on" href="${href}" aria-current="page">${escapeHtml(label)}</a>`
      : `<a href="${href}">${escapeHtml(label)}</a>`
  const nav = viewer === undefined || viewer === null
    ? ''
    : `<nav class="nav" aria-label="${escapeHtml(t('主导航', 'Main navigation'))}">
        ${navItem('console', '/console', t('工作区', 'Workspace'))}
        ${navItem('dashboard', '/dashboard', t('仓库', 'Repositories'))}
        ${navItem('settings', '/settings', t('设置', 'Settings'))}
        ${!preview && (viewer.user.role === 'admin' || viewer.user.role === 'superadmin') ? navItem('admin', '/admin', t('管理', 'Admin')) : ''}
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
    <div>${escapeHtml(t('Fledge · 让托管的仓库自己长大 · 由 FlyBot 驱动', 'Fledge · hosted repositories that grow themselves · powered by FlyBot'))}${release.version === null ? '' : ` · <span class="foot-release">v${escapeHtml(release.version)}</span>`}</div>
    <nav class="foot-links" aria-label="${escapeHtml(t('页脚导航', 'Footer navigation'))}">
      <a href="${escapeHtml(withSlash(config.services.docs))}" target="_blank" rel="noreferrer">${escapeHtml(t('文档', 'Docs'))}</a>
      <a href="${escapeHtml(config.services.portal)}" target="_blank" rel="noreferrer">Portal</a>
      <a href="${escapeHtml(withSlash(config.services.status))}" target="_blank" rel="noreferrer">${escapeHtml(t('平台状态', 'Status'))}</a>
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
  <a class="skip-link" href="#main">${escapeHtml(t('跳到主要内容', 'Skip to main content'))}</a>
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
    ${preview && viewer !== undefined && viewer !== null ? `<div class="banner ok preview-banner"><span>${escapeHtml(t('正在预览用户视图。', 'Previewing the user view.'))}</span><form method="post" action="/admin/simulation">${`<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}" />`}<input type="hidden" name="enable" value="0" /><input type="hidden" name="returnTo" value="${escapeHtml(path)}" /><button class="link" type="submit">${escapeHtml(t('退出模拟', 'Exit preview'))}</button></form></div>` : ''}
    ${notice === undefined || notice === '' ? '' : `<div class="banner ok" role="status">${escapeHtml(notice)}</div>`}
    ${error === undefined || error === '' ? '' : `<div class="banner bad" role="alert">${escapeHtml(error)}</div>`}
    ${body}
  </main>
  ${footer}
  <script src="/assets/app.js" defer></script>
  <script src="/assets/questions.js" defer></script>
</body>
</html>`
}
