import type { Config } from '../config.js'
import type { GateSessionRow, GateSessionStatus, RepoRow } from '../db.js'
import { validateGatePlan, type GatePlan, type GatePlanLaneName } from '../gates/plan.js'
import { translator, type Locale } from '../i18n.js'
import { humanTimeShort } from '../lib/time.js'
import { escapeHtml, layout, type Viewer } from './layout.js'

// #543: the gate page is the human half of the first slice. It lists the stored
// sessions, shows the proposed plan exactly as it was hashed, and offers a
// confirm form for a maintainer. Nothing here writes to the repository.

export interface GatePageInput {
  config: Config
  locale: Locale
  viewer: Viewer
  repo: RepoRow
  canMaintain: boolean
  sessions: GateSessionRow[]
  notice?: string
  error?: string
}

const LANE_LABELS: Record<GatePlanLaneName, [string, string]> = {
  'pr-ready': ['PR 就绪', 'PR ready'],
  'pr-merge': ['PR 合并', 'PR merge'],
  daily: ['每日', 'Daily'],
  release: ['发布', 'Release'],
}

function statusLabel(t: (zh: string, en: string) => string, status: GateSessionStatus): string {
  switch (status) {
    case 'analyzing': return t('分析中', 'Analyzing')
    case 'proposed': return t('待确认', 'Proposed')
    case 'confirmed': return t('已确认', 'Confirmed')
    case 'created': return t('已创建', 'Created')
    case 'refused': return t('已拒绝', 'Refused')
    case 'failed': return t('失败', 'Failed')
    default: return status
  }
}

function statusClass(status: GateSessionStatus): string {
  if (status === 'confirmed' || status === 'created') return 'badge ok'
  if (status === 'refused' || status === 'failed') return 'badge bad'
  return 'badge busy'
}

function parsePlan(json: string): GatePlan | null {
  try {
    const result = validateGatePlan(JSON.parse(json))
    return result.ok ? result.plan : null
  } catch {
    return null
  }
}

function planHtml(t: (zh: string, en: string) => string, plan: GatePlan | null): string {
  if (plan === null) return `<p class="banner bad">${escapeHtml(t('存储的计划无法通过校验，未显示。', 'The stored plan does not validate, so it is not shown.'))}</p>`
  const lanes = plan.lanes
  const rows = (Object.keys(LANE_LABELS) as GatePlanLaneName[]).map((lane) => {
    const entry = lanes[lane]
    const label = LANE_LABELS[lane]
    const commands = entry.commands.length === 0
      ? `<span class="muted">${escapeHtml(t('空 lane（将来按 not_applicable 处理）', 'Empty lane (will be not_applicable later)'))}</span>`
      : `<ul>${entry.commands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join('')}</ul>`
    return `<tr data-gate-lane="${escapeHtml(lane)}">
      <td>${escapeHtml(t(...label))}</td>
      <td>${entry.observe ? escapeHtml(t('观察', 'Observe')) : escapeHtml(t('阻断', 'Blocking'))}</td>
      <td><code>${escapeHtml(entry.source)}</code></td>
      <td>${entry.durationMs === undefined ? '—' : `${escapeHtml(String(entry.durationMs))} ms`}</td>
      <td>${commands}</td>
    </tr>`
  }).join('')
  const list = (values: string[], empty: string): string => values.length === 0
    ? `<p class="muted">${escapeHtml(empty)}</p>`
    : `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ul>`
  return `<div class="table-scroll"><table class="table-cards">
      <thead><tr><th>${escapeHtml(t('Lane', 'Lane'))}</th><th>${escapeHtml(t('模式', 'Mode'))}</th><th>${escapeHtml(t('来源', 'Source'))}</th><th>${escapeHtml(t('耗时', 'Duration'))}</th><th>${escapeHtml(t('命令', 'Commands'))}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="fine">${escapeHtml(t(`合并队列：${plan.mergeQueue ? '是' : '否'} · 基线 SHA：`, `Merge queue: ${plan.mergeQueue ? 'yes' : 'no'} · Base SHA: `))}<code>${escapeHtml(plan.baseSha)}</code></p>
    <details${plan.existingFiles.length === 0 ? '' : ' open'}>
      <summary>${escapeHtml(t(`已有文件（${plan.existingFiles.length}）`, `Existing files (${plan.existingFiles.length})`))}</summary>
      ${list(plan.existingFiles, t('没有检测到已有工作流文件。', 'No existing workflow files were detected.'))}
    </details>
    <details${plan.gaps.length === 0 ? '' : ' open'}>
      <summary>${escapeHtml(t(`缺口（${plan.gaps.length}）`, `Gaps (${plan.gaps.length})`))}</summary>
      ${list(plan.gaps, t('没有记录缺口。', 'No gaps were recorded.'))}
    </details>
    <details${plan.notes.length === 0 ? '' : ' open'}>
      <summary>${escapeHtml(t(`说明（${plan.notes.length}）`, `Notes (${plan.notes.length})`))}</summary>
      ${list(plan.notes, t('没有说明。', 'No notes.'))}
    </details>`
}

function sessionHtml(t: (zh: string, en: string) => string, repo: RepoRow, viewer: Viewer, session: GateSessionRow, canMaintain: boolean): string {
  const plan = parsePlan(session.plan_json)
  const confirm = session.status === 'proposed' && canMaintain
    ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/gate/sessions/${escapeHtml(session.id)}/confirm" class="inline-form">
        <input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}" />
        <button class="btn" type="submit">${escapeHtml(t('确认这个计划', 'Confirm this plan'))}</button>
      </form>`
    : session.status === 'proposed'
      ? `<p class="fine">${escapeHtml(t('只有维护者可以确认计划。', 'Only a maintainer can confirm a plan.'))}</p>`
      : ''
  return `<section class="card" id="gate-session-${escapeHtml(session.id)}" data-gate-session="${escapeHtml(session.id)}" data-gate-status="${escapeHtml(session.status)}">
    <h2><span class="${statusClass(session.status)}">${escapeHtml(statusLabel(t, session.status))}</span> <code>${escapeHtml(session.id)}</code></h2>
    <p class="muted">${escapeHtml(t('基线 SHA', 'Base SHA'))}: <code>${escapeHtml(session.base_sha)}</code> · ${escapeHtml(t('计划哈希', 'Plan hash'))}: <code>${escapeHtml(session.plan_hash)}</code> · ${escapeHtml(t('创建', 'Created'))} ${escapeHtml(humanTimeShort(session.created_at))}</p>
    ${session.confirmed_at === null ? '' : `<p class="muted">${escapeHtml(t('由', 'Confirmed by'))} <code>${escapeHtml(session.confirmed_by ?? '—')}</code> ${escapeHtml(t('确认于', 'at'))} ${escapeHtml(humanTimeShort(session.confirmed_at))}</p>`}
    ${session.error_code === null ? '' : `<p class="banner bad">${escapeHtml(session.error_code)}</p>`}
    ${session.pr_url === null ? '' : `<p><a class="link" href="${escapeHtml(session.pr_url)}" target="_blank" rel="noreferrer">${escapeHtml(t('门禁 PR', 'Gate pull request'))}</a></p>`}
    ${session.branch === null ? '' : `<p class="fine">${escapeHtml(t('分支', 'Branch'))}: <code>${escapeHtml(session.branch)}</code></p>`}
    <details${session.status === 'proposed' ? ' open' : ''}>
      <summary>${escapeHtml(t('计划预览', 'Plan preview'))}</summary>
      ${planHtml(t, plan)}
    </details>
    ${confirm}
    <p class="fine">${escapeHtml(t('确认只记录决定，不会写入仓库；创建门禁 PR 属于后续切片。', 'Confirming records the decision only; it writes nothing to the repository. Creating the gate pull request belongs to a later slice.'))}</p>
  </section>`
}

export function gatePage(input: GatePageInput): string {
  const { config, locale, viewer, repo, canMaintain, sessions, notice, error } = input
  const t = translator(locale)
  const banners = [
    notice === undefined || notice === '' ? '' : `<p class="banner ok">${escapeHtml(notice)}</p>`,
    error === undefined || error === '' ? '' : `<p class="banner bad">${escapeHtml(error)}</p>`,
  ].join('')
  const list = sessions.length === 0
    ? `<p class="muted" data-gate-empty="true">${escapeHtml(t('这个仓库还没有门禁会话。计划通过 API 提交后会出现在这里。', 'This repository has no gate sessions yet. A plan submitted through the API appears here.'))}</p>`
    : sessions.map((session) => sessionHtml(t, repo, viewer, session, canMaintain)).join('')
  const body = `<section class="card">
      <h1>${escapeHtml(t('仓库门禁', 'Repository gate'))}</h1>
      <p class="muted">${escapeHtml(t('门禁计划先以只读分析的形式提出，由维护者确认；确认不会写入仓库。', 'A gate plan is proposed from read-only analysis and confirmed by a maintainer; confirmation writes nothing to the repository.'))} · <a class="link" href="/repos/${escapeHtml(repo.id)}">${escapeHtml(t('返回仓库', 'Back to the repository'))}</a></p>
      ${banners}
    </section>
    ${list}`
  return layout({ title: t('仓库门禁', 'Repository gate'), viewer, body, config, locale, path: `/repos/${repo.id}/gate`, active: 'dashboard' })
}
