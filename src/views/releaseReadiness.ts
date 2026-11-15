import type { Config } from '../config.js'
import { translator, type Locale } from '../i18n.js'
import { escapeHtml, layout, type Viewer } from './layout.js'
import type { ReleaseReadinessView } from '../releases/readiness.js'

// #546 slice 1: the read-only release-readiness card. It answers, before a
// version and a SHA are typed, whether there is anything to release and — when
// there is not — why, in the same words the tag route refuses with. Nothing on
// this page writes: no tag, no Release, no token with release scope.
export function releaseReadinessPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  repoId: string
  repoLabel: string
  readiness: ReleaseReadinessView | null
  error?: string
}): string {
  const { config, locale, viewer, repoId, repoLabel, readiness, error } = input
  const t = translator(locale)
  const body = `<a class="back" href="/repos/${escapeHtml(repoId)}">← ${escapeHtml(t('返回仓库', 'Back to the repository'))}</a>
    <section class="card" data-release-readiness>
      <div class="eyebrow">${escapeHtml(t('发布就绪', 'RELEASE READINESS'))}</div>
      <h1>${escapeHtml(t('这个仓库现在可以发布吗？', 'Can this repository be released now?'))}</h1>
      <p class="muted">${escapeHtml(t('这里只读：页面只读取仓库，不打标签、不创建 Release、不用带发布权限的令牌。原因用的是打标签接口拒绝时的那一句话。', 'This page only reads: it creates no tag, no Release and uses no token with release scope. Any reason below is the sentence the tag route would refuse with.'))}</p>
      ${readiness === null
        ? `<p class="banner bad" data-readiness-unreadable>${escapeHtml(t('读不到这个仓库的状态，所以没有就绪结论。', 'The repository state could not be read, so there is no readiness answer.'))}${error === undefined ? '' : ` ${escapeHtml(error)}`}</p>`
        : readinessCard(t, repoLabel, readiness)}
    </section>`
  return layout({ title: t('发布就绪状态', 'Release readiness'), viewer, body, config, locale, path: `/repos/${repoId}`, active: 'dashboard' })
}

function readinessCard(t: (zh: string, en: string) => string, repoLabel: string, view: ReleaseReadinessView): string {
  const tag = view.latestTag === null
    ? `<strong>${escapeHtml(t('还没有 SemVer 标签', 'No SemVer tag yet'))}</strong> <span class="fine">${escapeHtml(t('第一个版本就是整个历史，没有上一个版本可比较。', 'The first release covers the whole history; there is no previous version to compare against.'))}</span>`
    : `<strong><code>${escapeHtml(view.latestTag.name)}</code></strong> <span class="fine">${escapeHtml(view.latestTag.sha.slice(0, 12))} · ${escapeHtml(t('标签提交时间', 'tag commit'))} <code>${escapeHtml(view.latestTag.committedAt)}</code></span>`
  const commits = view.commitsSince === null
    ? escapeHtml(t('没有上一个标签，统计从仓库起点算起。', 'No previous tag, so the count starts at the beginning of the repository.'))
    : view.commitsSince === 0
      ? escapeHtml(t(`自 ${view.latestTag?.name ?? ''} 以来没有新提交。`, `No commits since ${view.latestTag?.name ?? ''}.`))
      : escapeHtml(t(`自 ${view.latestTag?.name ?? ''} 以来有 ${view.commitsSince} 个提交。`, `${view.commitsSince} commits since ${view.latestTag?.name ?? ''}.`))
  const merged = escapeHtml(t(
    `${view.mergedPrs} 个 PR 在 ${view.latestTag?.name ?? t('仓库起点', 'the beginning')} 之后合并，其中 ${view.featurePrs} 个是功能。`,
    `${view.mergedPrs} pull requests merged since ${view.latestTag?.name ?? 'the beginning'}, ${view.featurePrs} of them features.`,
  ))
  const incomplete = view.mergedPrsComplete ? '' : ` <span class="fine">${escapeHtml(t('计数可能更多：合并列表读到上限时仍在窗口内。', 'The count may be higher: the merged list hit its page cap while still inside the window.'))}</span>`
  const fragments = view.changelogFragment
    ? escapeHtml(t(`有 ${view.fragments.length} 个待发布片段：`, `${view.fragments.length} changelog fragment${view.fragments.length === 1 ? '' : 's'} pending:`)) + ' ' + view.fragments.map((name) => `<code>${escapeHtml(name)}</code>`).join(', ')
    : escapeHtml(t('没有待发布的 changelog.d 片段。', 'No pending changelog.d fragment.'))
  const features = view.featurePrs === 0
    ? ''
    : `<ul class="list" data-readiness-features>${view.features.map((feature) => `<li><a class="link" href="${escapeHtml(feature.url)}" target="_blank" rel="noreferrer">#${feature.number}</a> ${escapeHtml(feature.title)} <span class="fine">${escapeHtml(feature.reason === 'label' ? t('按标签算作功能', 'counted as a feature by its label') : t('按标题前缀算作功能', 'counted as a feature by its title prefix'))}</span></li>`).join('')}</ul>`
  const verdict = view.refusal === null
    ? `<p class="banner ok" data-readiness-ready>${escapeHtml(t('可以发布：门禁、标签触发的 release.yml 和新的提交都在。版本仍由你输入，Fledge 从不猜版本。', 'Ready: the gate, the tag-triggered release.yml and new commits are all present. You still enter the version; Fledge never guesses one.'))}</p>`
    : `<p class="banner bad" data-readiness-blocker><code>${escapeHtml(view.refusal.code)}</code> · ${escapeHtml(view.refusal.message)}</p>`
  return `<p class="muted">${escapeHtml(repoLabel)}</p>
    ${verdict}
    <ul class="list">
      <li><div class="list-row"><div class="list-main"><strong>${escapeHtml(t('最新标签', 'Latest tag'))}</strong><small>${tag}</small></div></div></li>
      <li><div class="list-row"><div class="list-main"><strong>${escapeHtml(t('自上一个标签以来', 'Since the previous tag'))}</strong><small>${commits}</small></div></div></li>
      <li><div class="list-row"><div class="list-main"><strong>${escapeHtml(t('合并的 PR 与功能', 'Merged pull requests and features'))}</strong><small>${merged}${incomplete}</small></div></div></li>
      <li><div class="list-row"><div class="list-main"><strong>${escapeHtml(t('待发布片段', 'Pending fragments'))}</strong><small>${fragments}</small></div></div></li>
    </ul>
    ${features}`
}
