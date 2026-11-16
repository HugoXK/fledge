import type { JobRow } from '../db.js'
import type { Translate } from '../i18n.js'
import type { AdversarialRecord } from '../lib/adversarialReview.js'
import type { PathGuardResult } from '../lib/pathGuard.js'
import type { VerificationResult } from '../lib/verification.js'
import { csrfField, escapeHtml, type Viewer } from './layout.js'

// #264: review -> merge was spread over the job page, the checks panel, the
// review score, the path guard and a merge button on another page, so the page
// could not answer "what is the one thing to do now". This module is the one
// read model for that step: it names one state, writes one sentence and offers
// one action. The merge policy itself stays where it already is (`tryMerge` and
// #885); every rule below mirrors a gate that module already applies, so the
// card and the merge cannot disagree. It adds no merge call and no verdict
// vocabulary of its own.

// What the pull request is right now. Read from the same cached call the "why
// this change" block uses, so the page spends no second request and the card can
// compared the tip against the tip the recorded verdict names.
export interface PullTip {
  headSha: string
  state: string
  draft: boolean
  mergeableState: string
}

export type ReviewMergeKind =
  | 'merge'
  | 'review'
  | 'stale'
  | 'fix'
  | 'checks'
  | 'moved-base'
  | 'blocked'
  | 'waiting'
  | 'done'
  | 'none'

export type ReviewMergeReason =
  | 'ready'
  | 'no-verdict'
  | 'stale-verdict'
  | 'unreadable'
  | 'moved-base'
  | 'conflict'
  | 'merge-blocked'
  | 'merge-unknown'
  | 'checks-failing'
  | 'checks-pending'
  | 'path-guard'
  | 'path-guard-missing'
  | 'evidence-failed'
  | 'changes-requested'
  | 'rule-change'
  | 'adversarial-risk'
  | 'adversarial-incomplete'
  | 'draft'
  | 'not-maintainer'
  | 'job-unfinished'
  | 'job-failed'
  | 'merged'
  | 'closed'
  | 'no-pull-request'

export interface ReviewMergeInput {
  job: Pick<JobRow, 'status' | 'pr_url' | 'pr_state'>
  role: string
  verification: VerificationResult | null
  guard: PathGuardResult | null
  adversarial: AdversarialRecord | null
  tip: PullTip | null
}

export interface ReviewMergeState {
  kind: ReviewMergeKind
  reason: ReviewMergeReason
  // Raw data a sentence needs: a sha, a check name list, a violation count.
  detail: string
  headSha: string | null
  verdictSha: string | null
  stale: boolean
  checks: { total: number; green: number; failing: string[]; pending: string[] } | null
  base: string
  queue: 'queued' | 'running' | 'idle' | 'merged' | 'closed'
}

const OPEN_STATES = new Set(['open'])

export function reviewMergeState(input: ReviewMergeInput): ReviewMergeState {
  const { job, role, verification, guard, adversarial, tip } = input
  const base = tip?.mergeableState ?? verification?.mergeableState ?? 'unknown'
  const state = (kind: ReviewMergeKind, reason: ReviewMergeReason, detail: string, queue: ReviewMergeState['queue'] = 'idle'): ReviewMergeState => ({
    kind,
    reason,
    detail,
    headSha: tip?.headSha ?? verification?.sha ?? null,
    verdictSha: verification?.sha ?? null,
    stale: verification !== null && tip !== null && verification.sha !== tip.headSha,
    checks: verification === null ? null : verification.checks,
    base,
    queue,
  })
  // The merge path refuses a job that never produced a pull request, so there is
  // nothing to render for one.
  if (job.pr_url === null || job.pr_url === '') return state('none', 'no-pull-request', '')
  if (job.pr_state === 'merged') return state('done', 'merged', '', 'merged')
  if (job.pr_state === 'closed') return state('done', 'closed', '', 'closed')
  // A queued or running job has no verdict to read yet; the queue answer is the
  // whole answer, and it must not borrow the state of a pull request it has not
  // produced.
  if (job.status === 'queued') return state('waiting', 'job-unfinished', job.status, 'queued')
  if (job.status === 'running') return state('waiting', 'job-unfinished', job.status, 'running')
  if (job.status !== 'succeeded') return state('fix', 'job-failed', job.status)
  if (tip !== null && !OPEN_STATES.has(tip.state)) return state('done', 'closed', '')
  if (tip?.draft === true || verification?.draft === true) return state('blocked', 'draft', '')
  // Without the tip there is nothing to compare the recorded verdict against, so
  // the card says so instead of guessing that the verdict is current.
  if (tip === null) return state('review', 'unreadable', '')
  if (verification === null) return state('review', 'no-verdict', tip.headSha)
  // A verdict names one commit. The tip moving under it is exactly the stale
  // PASS the merge refuses, so it is checked before any "everything is green"
  // reading of the stored verdict.
  if (verification.sha !== tip.headSha) return state('stale', 'stale-verdict', `${verification.sha} ${tip.headSha}`)
  if (tip.mergeableState === 'behind') return state('moved-base', 'moved-base', 'behind')
  if (tip.mergeableState === 'dirty') return state('fix', 'conflict', 'dirty')
  if (tip.mergeableState === 'blocked') return state('blocked', 'merge-blocked', 'blocked')
  if (tip.mergeableState === 'unknown') return state('blocked', 'merge-unknown', 'unknown')
  if (adversarial !== null && (adversarial.status === 'risk' || adversarial.status === 'incomplete')) {
    const target = adversarial.target ?? adversarial.reason ?? ''
    return state('fix', adversarial.status === 'risk' ? 'adversarial-risk' : 'adversarial-incomplete', target)
  }
  if (guard === null) return state('review', 'path-guard-missing', '')
  if (!guard.ok) {
    const count = guard.truncated === true ? guard.reportedFiles - guard.checkedFiles : guard.violations.length
    return state('fix', 'path-guard', String(Math.max(count, guard.violations.length)))
  }
  if (verification.ruleChange !== undefined && !verification.ruleChange.acknowledged) {
    return state('fix', 'rule-change', String(verification.ruleChange.paths.length))
  }
  if (verification.checks.pending.length > 0) return state('checks', 'checks-pending', verification.checks.pending.join(', '))
  if (verification.checks.failing.length > 0) return state('checks', 'checks-failing', verification.checks.failing.join(', '))
  if (verification.reviews.changesRequested) return state('fix', 'changes-requested', '')
  if (!verification.ok) return state('fix', 'evidence-failed', verification.reasons.slice(0, 3).join(' · '))
  // The gate itself refuses a merge from a role that is not a maintainer; the
  // card states that instead of offering a button the route would reject.
  if (role !== 'maintainer') return state('blocked', 'not-maintainer', '')
  return state('merge', 'ready', tip.headSha)
}

function sentence(t: Translate, state: ReviewMergeState): string {
  const sha = state.headSha ?? ''
  const verdictSha = state.verdictSha ?? ''
  switch (state.reason) {
    case 'ready': return t(`合并门在 ${sha.slice(0, 12)} 处全部通过；剩下的只有合并。`, `Every gate passed at ${sha.slice(0, 12)}; merging is the only step left.`)
    case 'no-verdict': return t(`还没有在 ${sha.slice(0, 12)} 处记录过判定；先核实，再决定合不合。`, `No verdict is recorded at ${sha.slice(0, 12)} yet; verify before deciding.`)
    case 'stale-verdict': return t(
      `上次判定记在 ${verdictSha.slice(0, 12)}，PR 现在在 ${sha.slice(0, 12)}。它不覆盖新提交，必须先重新核实。`,
      `The last verdict is recorded at ${verdictSha.slice(0, 12)}; the pull request is now at ${sha.slice(0, 12)}. It does not cover the new commit, so a re-check is required before merging.`,
      )
    case 'unreadable': return t('读不到这个 PR 的当前提示；先重新核实。', 'The current tip could not be read; re-check before merging.')
    case 'moved-base': return t('基分支在核实之后前进了，GitHub 报 behind；分支更新前不会合并。', 'The base branch moved after the check and GitHub reports the pull request as behind; it will not merge until the branch is up to date.')
    case 'conflict': return t('PR 与基分支冲突（dirty）；先解决冲突。', 'The pull request conflicts with its base (dirty); resolve the conflict first.')
    case 'merge-blocked': return t('GitHub 把这个 PR 标为 blocked：缺少必需的检查或批准。', 'GitHub reports the pull request as blocked: a required check or approval is missing.')
    case 'merge-unknown': return t('GitHub 还在计算能不能合并；等它给出结论。', 'GitHub has not decided whether the pull request can merge yet; wait for its answer.')
    case 'checks-failing': return t(`检查在 ${sha.slice(0, 12)} 处失败：${state.detail}。修好后重新核实。`, `Checks failed at ${sha.slice(0, 12)}: ${state.detail}. Fix them, then re-check.`)
    case 'checks-pending': return t(`检查还在跑：${state.detail}。合并要等它们结束。`, `Checks are still running: ${state.detail}. The merge waits for them.`)
    case 'path-guard': return t(`路径守卫拒绝了 ${state.detail} 个文件；先修掉越界的改动。`, `The path guard rejected ${state.detail} file(s); remove the changes outside the allowed paths.`)
    case 'path-guard-missing': return t('路径守卫还没跑过；先重新核实。', 'The path guard has not run yet; re-check first.')
    case 'evidence-failed': return t(`证据没通过：${state.detail}`, `The evidence did not pass: ${state.detail}`)
    case 'changes-requested': return t('PR 上还有 changes requested；先处理意见。', 'The pull request still has changes requested; resolve them first.')
    case 'rule-change': return t(`这个 PR 改了 ${state.detail} 个 Fledge 规则或技能文件，需要 maintainer 先确认。`, `This pull request changes ${state.detail} Fledge rule or skill file(s); a maintainer must acknowledge it first.`)
    case 'adversarial-risk': return t(`独立对抗式审核指出了具体风险（${state.detail}）；自动合并被阻止。`, `The independent adversarial review found a concrete risk (${state.detail}); the automatic merge is blocked.`)
    case 'adversarial-incomplete': return t(`独立对抗式审核没能读完整改动（${state.detail}）；先补全再合并。`, `The independent adversarial review could not read the whole change (${state.detail}); fix that before merging.`)
    case 'draft': return t('PR 还是 draft；先把它标为可审查。', 'The pull request is still a draft; mark it ready for review first.')
    case 'not-maintainer': return t('只有 maintainer 能合并；你的角色是 developer。', 'Only a maintainer can merge; your role is developer.')
    case 'job-unfinished': return t(`任务还没结束（${state.detail}）；PR 出来后才有判定。`, `The job has not finished (${state.detail}); a verdict exists only after the pull request does.`)
    case 'job-failed': return t(`任务没有成功（${state.detail}）；修好后重跑再合并。`, `The job did not succeed (${state.detail}); fix and run again before merging.`)
    case 'merged': return t('这个 PR 已经合并。', 'This pull request is already merged.')
    case 'closed': return t('这个 PR 已关闭，没有合并。', 'This pull request was closed without merging.')
    case 'no-pull-request': return ''
  }
}

function stateLabel(t: Translate, state: ReviewMergeState): { text: string; tone: 'good' | 'busy' | 'bad' } {
  switch (state.kind) {
    case 'merge': return { text: t('可以合并', 'Ready to merge'), tone: 'good' }
    case 'review': return { text: t('待核实', 'Needs a verdict'), tone: 'busy' }
    case 'stale': return { text: t('判定已过期', 'Verdict is stale'), tone: 'bad' }
    case 'fix': return { text: t('要处理', 'Needs a fix'), tone: 'bad' }
    case 'checks': return state.reason === 'checks-failing'
      ? { text: t('检查失败', 'Checks failed'), tone: 'bad' }
      : { text: t('等检查', 'Waiting for checks'), tone: 'busy' }
    case 'moved-base': return { text: t('基分支已前进', 'Base moved'), tone: 'bad' }
    case 'blocked': return { text: t('受阻', 'Blocked'), tone: 'bad' }
    case 'waiting': return { text: t('排队中', 'Waiting'), tone: 'busy' }
    case 'done': return { text: t('已结束', 'Finished'), tone: 'good' }
    case 'none': return { text: '', tone: 'busy' }
  }
}

function factRow(t: Translate, label: [string, string], value: string): string {
  return `<div class="list-row"><div class="list-main"><strong>${escapeHtml(t(label[0], label[1]))}</strong><small>${value}</small></div></div>`
}

export interface ReviewMergeCardInput {
  t: Translate
  viewer: Viewer
  repoId: string
  jobId: string
  prUrl: string | null
  state: ReviewMergeState
  // The command envelope the page rendered; absent on a read-only surface, which
  // then offers no control at all.
  merge?: { revision: number; idempotencyKey: string }
}

export function reviewMergeCard(input: ReviewMergeCardInput): string {
  const { t, state } = input
  if (state.kind === 'none') return ''
  const label = stateLabel(t, state)
  const prHref = input.prUrl !== null && /^https?:\/\//.test(input.prUrl) ? input.prUrl : ''
  const recheck = `<form method="post" action="/repos/${escapeHtml(input.repoId)}/jobs/${escapeHtml(input.jobId)}/recheck">${csrfField(input.viewer)}<button class="btn" type="submit">${escapeHtml(t('重新核实 PR', 'Re-check the pull request'))}</button></form>`
  const merge = input.merge === undefined
    ? ''
    : `<form method="post" action="/repos/${escapeHtml(input.repoId)}/jobs/${escapeHtml(input.jobId)}/merge"><input type="hidden" name="expected_revision" value="${input.merge.revision}" /><input type="hidden" name="idempotency_key" value="${escapeHtml(input.merge.idempotencyKey)}" />${csrfField(input.viewer)}<button class="btn" type="submit">${escapeHtml(t('合并 PR', 'Merge pull request'))}</button></form>`
  const link = (href: string, zh: string, en: string): string => href === ''
    ? ''
    : `<a class="btn btn-ghost" href="${escapeHtml(href)}"${href.startsWith('http') ? ' target="_blank" rel="noreferrer"' : ''}>${escapeHtml(t(zh, en))}</a>`
  // Exactly one control per state: the merge command, the re-check that records a
  // verdict, a link to the place the fix happens, or nothing while waiting.
  let action = ''
  switch (state.kind) {
    case 'merge': action = merge; break
    case 'review': action = recheck; break
    case 'stale': action = recheck; break
    case 'checks': action = link(prHref === '' ? '' : `${prHref}/checks`, '查看检查', 'See the checks'); break
    case 'fix': action = state.reason === 'rule-change' ? link('#pr-verification', '确认规则变更', 'Acknowledge the rule change') : link(prHref, '去 PR 处理', 'Open the pull request to fix'); break
    case 'moved-base': action = link(prHref, '在 GitHub 更新分支', 'Update the branch on GitHub'); break
    case 'blocked': action = state.reason === 'not-maintainer' ? link(`/repos/${escapeHtml(input.repoId)}#repo-settings`, '仓库设置', 'Repository settings') : link(prHref, '打开 PR', 'Open the pull request'); break
    case 'done': action = link(prHref, '打开 PR', 'Open the pull request'); break
    case 'waiting': action = ''; break
  }
  const head = state.headSha === null ? t('—', '—') : `<code>${escapeHtml(state.headSha)}</code>${prHref === '' ? '' : ` · <a class="link" href="${escapeHtml(prHref)}" target="_blank" rel="noreferrer">${escapeHtml(t('打开 PR', 'Open the pull request'))}</a>`}`
  const verdict = state.verdictSha === null
    ? t('还没有记录', 'not recorded yet')
    : `${state.stale ? escapeHtml(t('已过期', 'stale')) + ' · ' : ''}<code>${escapeHtml(state.verdictSha)}</code>${state.stale ? '' : ` · ${escapeHtml(t('覆盖当前提示', 'covers the current tip'))}`}`
  const checks = state.checks === null
    ? t('还没有读', 'not read yet')
    : `${state.checks.green}/${state.checks.total} ${escapeHtml(t('通过', 'green'))}${state.checks.failing.length === 0 ? '' : ` · ${escapeHtml(t('失败', 'failing'))}: ${escapeHtml(state.checks.failing.join(', '))}`}${state.checks.pending.length === 0 ? '' : ` · ${escapeHtml(t('等待', 'pending'))}: ${escapeHtml(state.checks.pending.join(', '))}`}`
  const path = state.reason === 'path-guard'
    ? escapeHtml(t(`${state.detail} 个文件越界`, `${state.detail} file(s) outside the allowed paths`))
    : state.reason === 'path-guard-missing'
      ? escapeHtml(t('还没跑', 'not run yet'))
      : escapeHtml(t('在允许路径内', 'within the allowed paths'))
  const baseText = state.base === 'behind'
    ? escapeHtml(t('已前进（behind）', 'moved (behind)'))
    : state.base === 'dirty'
      ? escapeHtml(t('冲突（dirty）', 'conflict (dirty)'))
      : state.base === 'clean' || state.base === 'has_hooks'
        ? escapeHtml(t('没有前进', 'not moved'))
        : escapeHtml(state.base)
  const queue = state.queue === 'queued'
    ? escapeHtml(t('排队中', 'queued'))
    : state.queue === 'running'
      ? escapeHtml(t('运行中', 'running'))
      : state.queue === 'merged'
        ? escapeHtml(t('已合并', 'merged'))
        : state.queue === 'closed'
          ? escapeHtml(t('已关闭', 'closed'))
          : escapeHtml(t('不在合并队列里', 'not in a merge queue'))
  return `<section class="card review-merge" id="review-merge" data-review-merge data-merge-state="${escapeHtml(state.kind)}" data-merge-reason="${escapeHtml(state.reason)}" aria-labelledby="review-merge-title">
    <div class="row between">
      <div class="eyebrow">${escapeHtml(t('审查 → 合并', 'REVIEW → MERGE'))}</div>
      <span class="badge ${label.tone}">${escapeHtml(label.text)}</span>
    </div>
    <h2 id="review-merge-title">${escapeHtml(sentence(t, state))}</h2>
    ${action === '' ? '' : `<div class="review-merge-action">${action}</div>`}
    <div class="list review-merge-facts">
      ${factRow(t, ['提示', 'Head'], head)}
      ${factRow(t, ['判定', 'Verdict'], verdict)}
      ${factRow(t, ['检查', 'Checks'], checks)}
      ${factRow(t, ['路径与证据', 'Path & evidence'], path)}
      ${factRow(t, ['基线', 'Base'], baseText)}
      ${factRow(t, ['队列', 'Queue'], queue)}
    </div>
  </section>`
}
