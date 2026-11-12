import type { UserRow } from '../db.js'
import { quotaView, type QuotaView } from '../gateway/quota.js'
import type { Config } from '../config.js'
import { localizeMessage, translator, type Locale, type Translate } from '../i18n.js'
import { refusalBanner } from '../lib/failure.js'
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
  // #362: search is the owner's view of their own console data, so the nav keeps
  // Workspace lit there instead of showing no current section.
  if (clean === '/search' || clean.startsWith('/search/')) return 'console'
  if (clean === '/dashboard' || clean.startsWith('/dashboard/') || clean === '/repos' || clean.startsWith('/repos/')) return 'dashboard'
  if (clean === '/settings' || clean.startsWith('/settings/')) return 'settings'
  if (clean === '/admin' || clean.startsWith('/admin/')) return 'admin'
  return ''
}

function withSlash(value: string): string {
  return value === '' || value.endsWith('/') ? value : `${value}/`
}

// #174: the builder decides which refusal value may become an anchor (a pull
// request URL on github.com) and the sentence keeps that value verbatim, so the
// anchor is the first occurrence of it in the escaped text. Everything not marked
// stays escaped text.
function bannerHtml(text: string, link: { href: string; anchor: string } | null): string {
  const escaped = escapeHtml(text)
  if (link === null) return escaped
  const anchor = escapeHtml(link.anchor)
  const index = escaped.indexOf(anchor)
  if (index === -1) return escaped
  const open = `<a href="${escapeHtml(link.href)}" target="_blank" rel="noreferrer">${anchor}</a>`
  return `${escaped.slice(0, index)}${open}${escaped.slice(index + anchor.length)}`
}

export function layout(options: LayoutOptions): string {
  const { title, viewer, body, config, active } = options
  const locale = options.locale ?? 'zh'
  const path = options.path ?? '/'
  const t = translator(locale)
  const notice = localizeMessage(locale, options.notice)
  // A refusal travels as its code, with the writer's text after the colon when the
  // code has no sentence of its own (`QUEUE_FULL:…`, `BRANCH_MISSING:main`); the
  // builder owns the three-step order, so anything that is not a code stays here
  // on the dictionary, as before.
  const refusal = refusalBanner(locale, options.error)
  const error = refusal === null ? localizeMessage(locale, options.error) : refusal.text
  const errorLink = refusal === null ? null : refusal.link
  const preview = viewer !== undefined && viewer !== null && viewer.preview === true
  const release = options.release ?? releaseSurface()
  // #93: "current page" is a claim about the document, so it belongs to the link
  // whose own target is this route and to no ancestor; a section match still gets
  // the highlight, announced as the generic `true`. The route's query string is
  // not part of the comparison.
  const cleanPath = path.split('?')[0] ?? '/'
  const section = active ?? sectionForPath(cleanPath)
  const navItem = (key: string, href: string, label: string): string => {
    const onPage = withSlash(cleanPath) === withSlash(href)
    if (!onPage && section !== key) return `<a href="${href}">${escapeHtml(label)}</a>`
    return `<a class="on" href="${href}" aria-current="${onPage ? 'page' : 'true'}">${escapeHtml(label)}</a>`
  }
  const nav = viewer === undefined || viewer === null
    ? ''
    : `<nav class="nav" id="main-nav" aria-label="${escapeHtml(t('主导航', 'Main navigation'))}">
        ${navItem('console', '/console', t('工作区', 'Workspace'))}
        ${navItem('dashboard', '/dashboard', t('仓库', 'Repositories'))}
        ${navItem('settings', '/settings', t('设置', 'Settings'))}
        ${!preview && (viewer.user.role === 'admin' || viewer.user.role === 'superadmin') ? navItem('admin', '/admin', t('管理', 'Admin')) : ''}
      </nav>`
  // A phone header is one fixed row (#133), so the navigation collapses behind
  // this toggle instead of wrapping. It is rendered only when there is a nav to
  // open, and it stays a plain button: the menu is a CSS panel, not a route.
  const navToggle = viewer === undefined || viewer === null
    ? ''
    : `<button class="nav-toggle" type="button" data-nav-toggle aria-expanded="false" aria-controls="main-nav">${escapeHtml(t('菜单', 'Menu'))}</button>`
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
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="dark" />
  <meta name="theme-color" content="#07090d" />
  <title>${escapeHtml(title)} · Fledge</title>
  <link rel="stylesheet" href="/assets/app.css" />
</head>
<body>
  <a class="skip-link" href="#main">${escapeHtml(t('跳到主要内容', 'Skip to main content'))}</a>
  <header class="top">
    <div class="top-inner">
      <a class="brand" href="/" aria-label="Fledge"><span class="mark">F</span><span>Fledge${brandSmall}</span></a>
      ${navToggle}
      ${nav}
      <div class="spacer"></div>
      ${languageSwitch(locale, path)}
      ${account}
    </div>
  </header>
  <main class="wrap" id="main">
    ${preview && viewer !== undefined && viewer !== null ? `<div class="banner ok preview-banner"><span>${escapeHtml(t('正在预览用户视图。', 'Previewing the user view.'))}</span><form method="post" action="/admin/simulation">${`<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}" />`}<input type="hidden" name="enable" value="0" /><input type="hidden" name="returnTo" value="${escapeHtml(path)}" /><button class="link" type="submit">${escapeHtml(t('退出模拟', 'Exit preview'))}</button></form></div>` : ''}
    ${notice === undefined || notice === '' ? '' : `<div class="banner ok" role="status">${escapeHtml(notice)}</div>`}
    ${error === undefined || error === '' ? '' : `<div class="banner bad" role="alert">${bannerHtml(error, errorLink)}</div>`}
    ${body}
  </main>
  ${footer}
  <script src="/assets/section-nav.js" defer></script>
  <dialog id="confirm-dialog" class="confirm-dialog" aria-labelledby="confirm-dialog-title">
    <form method="dialog">
      <h2 id="confirm-dialog-title">${escapeHtml(t('请确认', 'Please confirm'))}</h2>
      <p data-confirm-message></p>
      <div class="row">
        <button class="btn btn-ghost" value="cancel">${escapeHtml(t('取消', 'Cancel'))}</button>
        <button class="btn btn-danger" value="confirm">${escapeHtml(t('确认', 'Confirm'))}</button>
      </div>
    </form>
  </dialog>
  <script src="/assets/app.js" defer></script>
  <script src="/assets/questions.js" defer></script>
</body>
</html>`
}
