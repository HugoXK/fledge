import type { Config } from '../config.js'
import { translator, type Locale } from '../i18n.js'
import { csrfField, escapeHtml, layout, type Viewer } from './layout.js'
import type { StrategyBundleRow, StrategyPointers } from '../db.js'
import { diffStrategies, type StrategySections } from '../strategy/bundle.js'

// #433 slice 1: the strategy page. It shows which strategy version and hash a
// repository is on, what each section is derived from, and one action: freeze the
// current strategy as a new `candidate`. The page carries the candidate version it
// rendered, so a form filled in after another candidate landed is refused instead
// of silently overwriting it. Nothing here promotes, canaries or moves `stable`;
// those are later slices with a human decision behind them.
export function strategyPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  repoId: string
  repoLabel: string
  pointers: StrategyPointers
  bundles: StrategyBundleRow[]
  notice?: string
  refused?: string
}): string {
  const { config, locale, viewer, repoId, pointers, bundles, notice, refused } = input
  const t = translator(locale)
  const candidate = pointers.candidate
  const stable = pointers.stable
  const canary = pointers.canary
  const sections = (bundle: StrategyBundleRow | undefined): Array<[string, string]> => {
    if (bundle === undefined) return []
    try {
      const parsed = JSON.parse(bundle.sections_json) as Record<string, string>
      return Object.entries(parsed).sort(([left], [right]) => left.localeCompare(right))
    } catch {
      return []
    }
  }
  const pointerRow = (name: string, version: string, hash: string): string =>
    `<tr><td><code>${escapeHtml(name)}</code></td><td>${version === '' ? `<span class="fine">${escapeHtml(t('未设置', 'none'))}</span>` : `<span class="fine">v${escapeHtml(version)}</span>`}</td><td>${hash === '' ? '' : `<code>${escapeHtml(hash.slice(0, 12))}</code>`}</td></tr>`
  const history = bundles.length === 0
    ? `<p class="fine">${escapeHtml(t('还没有冻结过策略。', 'No strategy has been frozen yet.'))}</p>`
    : `<ul class="list">${bundles.map((bundle) => {
      const current = candidate !== null && candidate.version === bundle.version
      return `<li><span class="fine">v${String(bundle.version)}</span> <code>${escapeHtml(bundle.hash.slice(0, 12))}</code>${current ? ` · <strong>${escapeHtml(t('当前 candidate', 'current candidate'))}</strong>` : ''}${bundle.parent_version === null ? '' : ` · ${escapeHtml(t('父版本', 'parent'))} v${String(bundle.parent_version)}`} <span class="fine">${escapeHtml(bundle.created_at)}</span></li>`
    }).join('')}</ul>`
  const sectionList = candidate === null ? [] : sections(bundles.find((bundle) => bundle.version === candidate.version))
  const body = `<a class="back" href="/repos/${escapeHtml(repoId)}">← ${escapeHtml(t('返回仓库', 'Back to the repository'))}</a>
    <section class="card" data-strategy>
      <div class="eyebrow">${escapeHtml(t('开发策略', 'DEVELOPMENT STRATEGY'))}</div>
      <h1>${escapeHtml(t('这个仓库的开发策略', 'This repository’s development strategy'))}</h1>
      <p class="muted"><code>${escapeHtml(input.repoLabel)}</code></p>
      <p class="muted">${escapeHtml(t('策略是一个按节键控、按内容寻址的包：每个值只引用来源（规则覆盖的修订、角色手册的版本与指纹、目标的哈希），不复制会移动的路径。冻结只会产生新的 candidate，stable 和 canary 需要之后的提升决定。', 'A strategy is a bundle keyed by section and addressed by content: each value references its source (a rule override revision, the playbook version and fingerprint, the goal hash) and never copies a moving path. Freezing only produces a new candidate; stable and canary need a later promotion decision.'))}</p>
      ${refused === undefined ? '' : `<p class="banner bad" data-strategy-refused>${escapeHtml(refused)}</p>`}
      ${notice === undefined ? '' : `<p class="banner ok" data-strategy-notice>${escapeHtml(notice)}</p>`}
      <table class="table">
        <thead><tr><th>${escapeHtml(t('指针', 'Pointer'))}</th><th>${escapeHtml(t('版本', 'Version'))}</th><th>${escapeHtml(t('哈希', 'Hash'))}</th></tr></thead>
        <tbody>
          ${pointerRow('candidate', candidate === null ? '' : String(candidate.version), candidate?.hash ?? '')}
          ${pointerRow('canary', canary === null ? '' : String(canary.version), canary?.hash ?? '')}
          ${pointerRow('stable', stable === null ? '' : String(stable.version), stable?.hash ?? '')}
        </tbody>
      </table>
      <h2>${escapeHtml(t('当前 candidate 的节', 'Sections of the current candidate'))}</h2>
      ${sectionList.length === 0
        ? `<p class="fine">${escapeHtml(t('当前没有 candidate：冻结一次会得到 v1。', 'There is no candidate yet: freezing once produces v1.'))}</p>`
        : `<ul class="list">${sectionList.map(([key, value]) => `<li><code>${escapeHtml(key)}</code> <span class="fine">${escapeHtml(value)}</span></li>`).join('')}</ul>`}
      <form method="post" action="/repos/${escapeHtml(repoId)}/strategy" class="form">
        ${csrfField(viewer)}
        <input type="hidden" name="base" value="${escapeHtml(candidate === null ? '0' : String(candidate.version))}" />
        <input type="hidden" name="confirm" value="1" />
        <div class="row"><button class="btn" type="submit">${escapeHtml(t('把当前策略冻结为新的 candidate', 'Freeze the current strategy as a new candidate'))}</button></div>
      </form>
      <p class="fine">${escapeHtml(t('这个按钮不会改变 stable，也不会提升或合并任何东西。', 'This button does not change stable and promotes nothing.'))}</p>
      <h2>${escapeHtml(t('历史版本', 'Version history'))}</h2>
      ${history}
    </section>`
  return layout({ title: t('开发策略', 'Development strategy'), viewer, body, config, locale, path: `/repos/${repoId}`, active: 'dashboard', ...(notice === undefined ? {} : { notice }), ...(refused === undefined ? {} : { error: refused }) })
}

// #433 slice 2: the strategy a job recorded, and the section keys that moved
// since the previous job on the same repository. The page states the hash of the
// content the job stored; a strategy that was never frozen says so instead of
// borrowing the candidate's version number, and a job that predates the columns
// says it has no recorded strategy rather than showing an empty one.
export interface JobStrategyView {
  hash: string | null
  version: number | null
  sections: StrategySections | null
  // The previous job on this repository that recorded a strategy, present only
  // when this job recorded one too.
  previous?: {
    jobId: string
    hash: string
    version: number | null
    sections: StrategySections | null
  }
}

export function jobStrategyBlock(input: { locale: Locale; repoId: string; strategy: JobStrategyView }): string {
  const { locale, repoId, strategy } = input
  const t = translator(locale)
  const label = (hash: string, version: number | null): string => version === null
    ? t(`未冻结 · 哈希 ${hash.slice(0, 12)}`, `not frozen · hash ${hash.slice(0, 12)}`)
    : t(`v${String(version)} · 哈希 ${hash.slice(0, 12)}`, `v${String(version)} · hash ${hash.slice(0, 12)}`)
  if (strategy.hash === null) {
    return `<section class="card" data-job-strategy-none>
      <h2>${escapeHtml(t('这次任务的策略', 'Strategy of this job'))}</h2>
      <p class="fine">${escapeHtml(t('这个任务没有记录策略：它创建于策略被记录之前，或者这个仓库当时的策略提到了冻结的节。', 'No strategy was recorded for this job: it was created before strategies were recorded, or the repository’s strategy at that moment named a frozen section.'))}</p>
    </section>`
  }
  const previous = strategy.previous
  const sections = strategy.sections === null
    ? ''
    : `<details class="fine"><summary>${escapeHtml(t('这次任务使用的节', 'Sections this job recorded'))}</summary><ul class="list">${Object.entries(strategy.sections)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `<li><code>${escapeHtml(key)}</code> <span class="fine">${escapeHtml(value)}</span></li>`)
      .join('')}</ul></details>`
  // A diff is shown only against a previous job that recorded a strategy, and
  // only when the two hashes differ. Two identical hashes are one strategy seen
  // twice, so the block says nothing rather than listing zero keys.
  const changes = previous === undefined || previous.sections === null || strategy.sections === null
    ? []
    : diffStrategies(previous.sections, strategy.sections)
  const diff = previous === undefined || previous.hash === strategy.hash
    ? ''
    : `<div data-strategy-diff>
        <p class="fine"><strong>${escapeHtml(t('策略自上一个任务以来发生了变化', 'The strategy changed since the previous job'))}</strong> — ${escapeHtml(label(previous.hash, previous.version))} → <span data-strategy-previous-hash="${escapeHtml(previous.hash)}">${escapeHtml(label(strategy.hash, strategy.version))}</span> · <a href="/repos/${escapeHtml(repoId)}/jobs/${escapeHtml(previous.jobId)}">${escapeHtml(t('上一个任务', 'previous job'))}</a></p>
        ${changes.length === 0
          ? `<p class="fine">${escapeHtml(t('节的内容无法比较，只比较了哈希。', 'The section maps could not be compared; only the hashes were compared.'))}</p>`
          : `<ul class="list">${changes.map((change) => `<li data-strategy-key="${escapeHtml(change.key)}"><code>${escapeHtml(change.key)}</code> <span class="fine">${escapeHtml(change.before ?? t('（新增）', '(added)'))} → ${escapeHtml(change.after ?? t('（移除）', '(removed)'))}</span></li>`).join('')}</ul>`}
        <p class="fine">${escapeHtml(t('这个任务保留它自己的哈希，上一个任务的记录不会被改写。', 'This job keeps its own hash; the earlier job is not rewritten.'))}</p>
      </div>`
  return `<section class="card" data-job-strategy-block>
    <h2>${escapeHtml(t('这次任务的策略', 'Strategy of this job'))}</h2>
    <p class="fine" data-job-strategy data-strategy-hash="${escapeHtml(strategy.hash)}" data-strategy-version="${strategy.version === null ? 'none' : String(strategy.version)}">${escapeHtml(t('任务创建时记录：', 'Recorded when the job was created:'))} <strong>${escapeHtml(label(strategy.hash, strategy.version))}</strong> · <a href="/repos/${escapeHtml(repoId)}/strategy">${escapeHtml(t('这个仓库的开发策略', 'the repository’s strategy'))}</a></p>
    ${diff}
    ${sections}
  </section>`
}
