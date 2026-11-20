import type { Config } from '../config.js'
import type { Locale } from '../i18n.js'
import { translator } from '../i18n.js'
import type { ProductLoopSnapshot } from '../metrics/product.js'
import { durationText } from './pages.js'
import { escapeHtml, layout, type Viewer } from './layout.js'

/**
 * #635: the loop page. It reads one snapshot and prints it, so the page cannot
 * disagree with the store about what was counted. Nothing here adds a fact: a
 * missing sample prints `n/a`, never a zero, and the off switch prints as a
 * sentence rather than as an empty table.
 */
export function productPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  loop: ProductLoopSnapshot
  windowDays: number
  since: string
  webhook: { configured: boolean; lastPushAt: string | null }
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, loop, windowDays, since, webhook, notice, error } = input
  const t = translator(locale)
  const sample = (metric: { samples: number; medianMs: number | null }): string =>
    metric.samples === 0 ? t('n/a（还没有样本）', 'n/a (no samples yet)') : `${durationText(metric.medianMs)} · ${t(`${metric.samples} 个样本`, `${metric.samples} samples`)}`
  const stage = (label: string, count: number, from: number | null): string => {
    // A drop is a share of the earlier stage, so it only exists when the later
    // count is part of that stage. Stages are counted inside the window, so a
    // repository connected before the window can make `count > from`; printing
    // `−-200%` there would be a number the page cannot defend, so it prints
    // nothing instead.
    const drop = from === null || from === 0 || count > from ? '' : t(`−${Math.round(((from - count) / from) * 100)}%`, `−${Math.round(((from - count) / from) * 100)}%`)
    return `<tr><td>${escapeHtml(label)}</td><td>${count}</td><td class="muted">${escapeHtml(drop)}</td></tr>`
  }
  const funnelRows = [
    stage(t('接入仓库', 'Repository connected'), loop.funnel.connected, null),
    stage(t('第一次任务', 'First job started'), loop.funnel.firstJob, loop.funnel.connected),
    stage(t('第一个 PR', 'First PR opened'), loop.funnel.firstPr, loop.funnel.connected),
    stage(t('第一次合并', 'First PR merged'), loop.funnel.merged, loop.funnel.connected),
  ].join('')
  const mixRows = loop.rescue.mix.length === 0
    ? `<p class="muted">${escapeHtml(t('窗口内没有人出手。', 'Nobody had to step in during this window.'))}</p>`
    : `<ul class="plain">${loop.rescue.mix.map((entry) => `<li><code>${escapeHtml(entry.action)}</code> ${entry.n}</li>`).join('')}</ul>`
  const evidenceRows = [
    [t('成功的任务', 'Succeeded jobs'), loop.evidence.succeeded],
    [t('带 PR', 'With a pull request'), loop.evidence.withPr],
    [t('带已知成本', 'With a known cost'), loop.evidence.withCost],
  ].map(([label, value]) => `<tr><td>${escapeHtml(String(label))}</td><td>${Number(value)}</td></tr>`).join('')
  const percent = (value: number | null): string => (value === null ? t('n/a', 'n/a') : `${value}%`)
  const body = `<section class="workspace-hero">
    <div class="workspace-intro">
      <div class="eyebrow">${escapeHtml(t('产品回路', 'Product loop'))}</div>
      <h1>${escapeHtml(t('回路与人工救援', 'The loop and the rescues'))}</h1>
      <p class="muted">${escapeHtml(t(`最近 ${windowDays} 天，从 ${since} 开始；只读。`, `Last ${windowDays} days starting ${since}; read-only.`))}</p>
    </div>
    <div class="workspace-actions">
      <a class="btn ${windowDays === 7 ? '' : 'btn-ghost'}" href="/admin/product?window=7">${escapeHtml(t('7 天', '7 days'))}</a>
      <a class="btn ${windowDays === 30 ? '' : 'btn-ghost'}" href="/admin/product?window=30">${escapeHtml(t('30 天', '30 days'))}</a>
      <a class="btn btn-ghost" href="/admin/metrics">${escapeHtml(t('原有指标', 'Existing metrics'))}</a>
      ${loop.analyticsEnabled ? `<a class="btn btn-ghost" href="/admin/product.csv?window=${windowDays}">${escapeHtml(t('导出 CSV', 'Export CSV'))}</a>` : ''}
      <a class="btn btn-ghost" href="/admin">${escapeHtml(t('返回管理', 'Back to admin'))}</a>
    </div>
  </section>
  <section class="card" data-loop-terms>
    <h2>${escapeHtml(t('记录什么，不记录什么', 'What is recorded, and what is not'))}</h2>
    ${loop.analyticsEnabled
      ? `<p>${escapeHtml(t('这里记的是事件名、发生时刻、时长，以及用本安装一次性盐做过哈希的仓库指纹——没有任何用户、账号、邮箱、提示词、代码、令牌或完整 URL。两个不同用户的同一件事，落库后无法区分是谁做的；盐保存在本机 settings 里，换掉它就换掉全部指纹。', 'Each row is an event name, the instant it happened, a duration, and a repository fingerprint hashed with a per-installation salt — never a user, an account, an e-mail, a prompt, code, a token or a full URL. The same event from two different people is indistinguishable in the store, and the salt lives in this install\'s settings, so rotating it changes every fingerprint.'))}</p>`
      : `<p class="muted" data-loop-off>${escapeHtml(t('回路统计已关闭：此刻不写任何事件、也不生成盐。打开后只记录从上表那几类事件，已经写的记录不会被改写。', 'Loop analytics is off: nothing is written and no salt is minted. When it is on, only the event kinds above are recorded, and existing rows are never rewritten.'))}</p>`}
  </section>
  <section class="card" data-loop-receiver>
    <h2>${escapeHtml(t('外部接收方（可选）', 'Optional receiver'))}</h2>
    ${webhook.configured
      ? `<p>${escapeHtml(t('已配置一个接收地址：每天最多推送一次，内容就是上面这几张表的数字，没有仓库指纹、没有账号、没有自由文本。', 'One receiver is configured: at most one push a day, carrying the numbers on this page and nothing else — no repository fingerprint, no account, no free text.'))}</p>
    <p class="muted">${escapeHtml(webhook.lastPushAt === null ? t('还没推送过。', 'Nothing has been pushed yet.') : t(`最近一次推送：${webhook.lastPushAt}`, `Last push: ${webhook.lastPushAt}`))}</p>`
      : `<p class="muted" data-loop-receiver-off>${escapeHtml(t('未配置接收地址：不向任何第三方发送数据。运营方设置 PRODUCT_LOOP_WEBHOOK_URL 才会开启。', 'No receiver is configured: nothing is sent anywhere. An operator enables it by setting PRODUCT_LOOP_WEBHOOK_URL.'))}</p>`}
  </section>
  <section class="card">
    <h2>${escapeHtml(t('漏斗', 'Funnel'))}</h2>
    <div class="table-scroll"><table><thead><tr>
      <th>${escapeHtml(t('阶段', 'Stage'))}</th>
      <th>${escapeHtml(t('仓库数', 'Repositories'))}</th>
      <th>${escapeHtml(t('相对接入的落差', 'Against connected'))}</th>
    </tr></thead><tbody>${funnelRows}</tbody></table></div>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('耗时', 'Durations'))}</h2>
    <div class="table-scroll"><table><thead><tr>
      <th>${escapeHtml(t('问题', 'Question'))}</th>
      <th>${escapeHtml(t('中位数', 'Median'))}</th>
    </tr></thead><tbody>
      <tr><td>${escapeHtml(t('接入到第一次任务', 'Connected to first job'))}</td><td>${escapeHtml(sample(loop.toFirstJob))}</td></tr>
      <tr><td>${escapeHtml(t('接入到第一个 PR', 'Connected to first PR'))}</td><td>${escapeHtml(sample(loop.toFirstPr))}</td></tr>
      <tr><td>${escapeHtml(t('接入到第一次合并', 'Connected to first merge'))}</td><td>${escapeHtml(sample(loop.toMerge))}</td></tr>
    </tbody></table></div>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('人工救援', 'Human rescues'))}</h2>
    <p class="muted">${escapeHtml(t('一个动作记一次，所以一个失败被回答两次就是两次救援：这个比值可以超过 100%，那正是"有人得反复处理"的样子。', 'One action is one rescue, so a failure answered twice counts twice: the rate can pass 100%, and that is exactly what "someone had to keep at it" looks like.'))}</p>
    <div class="table-scroll"><table><thead><tr>
      <th>${escapeHtml(t('失败的任务', 'Failed jobs'))}</th>
      <th>${escapeHtml(t('人工动作', 'Human actions'))}</th>
      <th>${escapeHtml(t('每个失败的救援数', 'Rescues per failure'))}</th>
    </tr></thead><tbody><tr><td>${loop.rescue.failed}</td><td>${loop.rescue.actions}</td><td>${escapeHtml(loop.rescue.rate === null ? t('n/a', 'n/a') : `${loop.rescue.rate}%`)}</td></tr></tbody></table></div>
    ${mixRows}
  </section>
  <section class="card">
    <h2>${escapeHtml(t('一周后还在用', 'Comes back a week later'))}</h2>
    <div class="table-scroll"><table><thead><tr>
      <th>${escapeHtml(t('窗口内有活动的仓库', 'Repositories active in the window'))}</th>
      <th>${escapeHtml(t('上一周也活动过', 'Also active in the prior week'))}</th>
    </tr></thead><tbody><tr><td>${loop.returning.repositories}</td><td>${loop.returning.returned}</td></tr></tbody></table></div>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('证据完整度', 'Evidence completeness'))}</h2>
    <div class="table-scroll"><table><thead><tr>
      <th>${escapeHtml(t('项', 'Item'))}</th>
      <th>${escapeHtml(t('数量', 'Count'))}</th>
    </tr></thead><tbody>${evidenceRows}</tbody></table></div>
    <p class="muted">${escapeHtml(t(`同时带 PR 与已知成本的成功任务占 ${percent(loop.evidence.completeRate)}；已结束任务里成本未知的占 ${percent(loop.evidence.unknownCostRate)}（${loop.evidence.unknownCost}/${loop.evidence.completed}）。`, `${percent(loop.evidence.completeRate)} of succeeded jobs carry both a pull request and a known cost; ${percent(loop.evidence.unknownCostRate)} of finished jobs have an unknown cost (${loop.evidence.unknownCost}/${loop.evidence.completed}).`))}</p>
  </section>`
  return layout({ title: t('产品回路', 'Product loop'), viewer, body, config, locale, path: '/admin/product', active: 'admin', notice, error })
}
