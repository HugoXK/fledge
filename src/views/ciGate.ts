import type { Config } from '../config.js'
import type { RepoRow } from '../db.js'
import { translator, type Locale } from '../i18n.js'
import type { CiGateFinding, CiGateReport } from '../lib/ciGate.js'
import { escapeHtml, layout, type Viewer } from './layout.js'

// #543 slice 1: the read-only answer. Every line here is evidence the operator
// can re-read on GitHub; nothing on this page writes to the repository.
export interface CiGatePageInput {
  config: Config
  locale: Locale
  viewer: Viewer
  repo: RepoRow
  report: CiGateReport
}

const VERDICT: Record<CiGateReport['verdict'], { zh: string; en: string; tone: string }> = {
  gated: { zh: '合并已被 CI 拦住', en: 'Merges are gated by CI', tone: 'ok' },
  gaps: { zh: 'CI 还没有拦住合并', en: 'CI does not gate a merge yet', tone: 'bad' },
  unknown: { zh: '无法确认这道门禁', en: 'This gate could not be confirmed', tone: 'warn' },
}

const STATE_LABEL: Record<CiGateFinding['state'], { zh: string; en: string; tone: string }> = {
  ok: { zh: '通过', en: 'Gate present', tone: 'ok' },
  gap: { zh: '缺口', en: 'Gap', tone: 'bad' },
  unknown: { zh: '未知', en: 'Unknown', tone: 'warn' },
}

export function ciGatePage(input: CiGatePageInput): string {
  const { config, locale, viewer, repo, report } = input
  const t = translator(locale)
  const verdict = VERDICT[report.verdict]
  const rows = report.findings.map((finding) => {
    const label = STATE_LABEL[finding.state]
    const evidence = finding.evidence.length === 0
      ? ''
      : `<ul data-ci-gate-evidence="${escapeHtml(finding.id)}">${finding.evidence.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('')}</ul>`
    return `<li data-ci-gate-finding="${escapeHtml(finding.id)}" data-ci-gate-state="${escapeHtml(finding.state)}"><strong>${escapeHtml(t(finding.title, finding.title))}</strong> <span class="pill ${label.tone}">${escapeHtml(t(label.zh, label.en))}</span><p>${escapeHtml(finding.sentence)}</p>${evidence}</li>`
  }).join('')

  return layout({
    config,
    locale,
    viewer,
    path: `/repos/${repo.id}/ci-gate`,
    title: t('CI 门禁检查', 'CI gate check'),
    body: `<section class="card"><h1>${escapeHtml(t('CI 门禁检查', 'CI gate check'))}</h1>
      <p>${escapeHtml(t(`${repo.owner}/${repo.name} 的默认分支是 ${repo.default_branch}。下面的每一项都是只读读取 GitHub 得到的证据；这次检查不会在仓库里创建分支、写提交或开 PR。`, `The default branch of ${repo.owner}/${repo.name} is ${repo.default_branch}. Each line below is evidence read from GitHub; this check creates no branch, commit or pull request in the repository.`))}</p>
      <p class="banner ${verdict.tone}" data-ci-gate-verdict="${escapeHtml(report.verdict)}">${escapeHtml(t(verdict.zh, verdict.en))}</p>
      <ul class="ci-gate">${rows}</ul>
      <p><a class="btn btn-ghost" href="/repos/${escapeHtml(repo.id)}">${escapeHtml(t('返回仓库', 'Back to the repository'))}</a></p>
    </section>`,
  })
}
