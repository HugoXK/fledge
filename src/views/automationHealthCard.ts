import type { AutomationHealthSummary } from '../jobs/automationHealth.js'
import { translator, type Locale, type Translate } from '../i18n.js'
import { escapeHtml } from './layout.js'

// #807: the automation health card lives beside the page that renders it, not
// inside `pages.ts`, so the page file stays under its size entry.
// #807: one compact row on the metrics page, not a second metrics page. The
// three numbers are the ones that answer "is the platform keeping the team
// busy": ready work nobody picked up, how long a dispatch waited, and how much
// is queued behind it. A number nobody measured reads "—" instead of 0.
function automationWaitText(t: Translate, seconds: number): string {
  if (seconds < 60) return t(`${Math.round(seconds)} 秒`, `${Math.round(seconds)} s`)
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t(`${minutes} 分钟`, `${minutes} minutes`)
  const hours = Math.round(minutes / 60)
  return t(`${hours} 小时`, `${hours} hours`)
}

function automationLatencyText(t: Translate, ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1_000) return t(`${ms} 毫秒`, `${ms} ms`)
  return t(`${(ms / 1_000).toFixed(1)} 秒`, `${(ms / 1_000).toFixed(1)} s`)
}

export function automationHealthCard(locale: Locale, summary: AutomationHealthSummary, idleAlertMinutes: number): string {
  const t = translator(locale)
  const idle = summary.idleWithWork.length
  const longest = summary.idleWithWork[0]?.seconds ?? 0
  const idleBody = idle === 0
    ? t('没有仓库在等派发。', 'No repository is waiting on a dispatch.')
    : t(
        `${idle} 个仓库有就绪工作、但没有任务在跑，最长已等待 ${automationWaitText(t, longest)}。`,
        `${idle} ${idle === 1 ? 'repository' : 'repositories'} with ready work and no active job, longest wait ${automationWaitText(t, longest)}.`,
      )
  const latencyBody = summary.dispatchSamples === 0
    ? t('还没有测量：本进程还没有派发过任务。', 'Not measured yet: this process has not dispatched a job.')
    : t(
        `${summary.dispatchSamples} 次派发的平均值，自本进程启动起算。`,
        `Mean over ${summary.dispatchSamples} dispatch${summary.dispatchSamples === 1 ? '' : 'es'} since this process started.`,
      )
  const queueBody = summary.queueDepth === null
    ? t('还没有测量。', 'Not measured yet.')
    : t('等待 worker 的任务数。', 'Jobs waiting for a worker.')
  const lease = summary.lease
  const leaseBody = lease === null
    ? t('没有存活的租约。', 'No live lease.')
    : t(
        `最老的存活租约：${lease.jobId}（${lease.kind}，${lease.repo}），已持有 ${automationWaitText(t, lease.ageSeconds)}${lease.expiresInSeconds === null ? '' : `，${automationWaitText(t, lease.expiresInSeconds)} 后到期`}。`,
        `Oldest live lease: ${lease.jobId} (${lease.kind}, ${lease.repo}), held for ${automationWaitText(t, lease.ageSeconds)}${lease.expiresInSeconds === null ? '' : `, expires in ${automationWaitText(t, lease.expiresInSeconds)}`}.`,
      )
  const reaped = summary.lastReaped
  const reapedBody = reaped === null
    ? t('没有租约被回收的记录。', 'No reaped lease recorded.')
    : t(
        `最近回收：${reaped.jobId}（${reaped.kind}，${reaped.repo}），${automationWaitText(t, reaped.ageSeconds)} 前。`,
        `Last reaped: ${reaped.jobId} (${reaped.kind}, ${reaped.repo}), ${automationWaitText(t, reaped.ageSeconds)} ago.`,
      )
  return `<section class="card">
    <h2>${escapeHtml(t('自动化健康', 'Automation health'))}</h2>
    <p class="muted">${escapeHtml(t('读取刚结束的调度检查；计数器重启后从零开始，租约记录来自数据库。', 'From the dispatch check that just ran; the counters restart from zero, while the lease rows are read from the database.'))}</p>
    <div class="list">
      <div class="list-row"><div class="list-main"><strong>${idle}</strong><small>${escapeHtml(idleBody)}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(automationLatencyText(t, summary.dispatchLatencyMs))}</strong><small>${escapeHtml(latencyBody)}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${summary.queueDepth === null ? '—' : summary.queueDepth}</strong><small>${escapeHtml(queueBody)}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${lease === null ? '—' : escapeHtml(automationWaitText(t, lease.ageSeconds))}</strong><small>${escapeHtml(leaseBody)}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${reaped === null ? '—' : escapeHtml(automationWaitText(t, reaped.ageSeconds))}</strong><small>${escapeHtml(reapedBody)}</small></div></div>
    </div>
    <p class="fine">${escapeHtml(t(
      `有就绪工作却没有任务在跑，超过 ${idleAlertMinutes} 分钟就会告警；租约被回收也会告警。本页只读，不会触发派发。`,
      `An alert fires when ready work waits more than ${idleAlertMinutes} minutes with no job running, and when a lease is reaped; this page is read-only and dispatches nothing.`,
    ))}</p>
  </section>`
}
