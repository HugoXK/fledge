import { sha256Hex } from './secrets.js'

// #633: one projection per repository, over a closed vocabulary. The kinds are
// the six decisions a maintainer can actually make; the tree's older notice
// kinds (`team`, `ops`) map into them instead of widening the list, so a page
// cannot invent a seventh reason to interrupt someone.
export const ACTION_KINDS = ['question', 'plan', 'review', 'failed', 'release', 'quota'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export interface ActionCandidate {
  id: string
  kind: ActionKind
  repoId: string
  // The object the decision is about: a job id, a question id, a PR number or a
  // tag. It is what makes the id stable across events for the same decision.
  objectId: string
  reason: string
  href: string
  label: string
  // A blocked or time-sensitive decision is delivered at once; the others wait
  // for the digest. Quiet hours and delivery state arrive with the follow-up.
  urgent: boolean
}

export interface ActionJobFacts {
  id: string
  repoId: string
  kind: string
  status: string
  prUrl: string | null
}

// Deterministic and URL-safe: the same decision keeps one id across events and
// restarts, so a duplicate failure cannot open a second row. Twelve hex
// characters are enough for the per-user action space and keep the mail link
// short; the kind is part of the input, so a review and a failure about the same
// job are not the same action.
export function actionIdFor(kind: ActionKind, repoId: string, objectId: string): string {
  return `act_${sha256Hex(`${kind}\u0000${repoId}\u0000${objectId}`).slice(0, 12)}`
}

function candidate(kind: ActionKind, repoId: string, objectId: string, action: Omit<ActionCandidate, 'id' | 'kind' | 'repoId' | 'objectId'>): ActionCandidate {
  return { id: actionIdFor(kind, repoId, objectId), kind, repoId, objectId, ...action }
}

// A failed job is the one thing a maintainer must act on; a successful job with
// nothing to decide is not an action at all, and queued/running/cancelled states
// are progress, not decisions.
export function projectJobAction(job: ActionJobFacts): ActionCandidate | null {
  if (job.status === 'failed') {
    return candidate('failed', job.repoId, job.id, {
      reason: '任务失败，可以重跑。',
      href: `/jobs/${job.id}`,
      label: '重跑',
      urgent: true,
    })
  }
  if (job.status === 'succeeded' && job.prUrl !== null && job.prUrl !== '') {
    return candidate('review', job.repoId, job.prUrl, {
      reason: 'PR 已就绪，等待审核。',
      href: job.prUrl,
      label: '打开 PR',
      urgent: false,
    })
  }
  return null
}

// The other four kinds are projected from the object that raises them. They are
// pure so the wiring can land call site by call site without a second selector.
export function projectQuestion(repoId: string, questionId: string): ActionCandidate {
  return candidate('question', repoId, questionId, {
    reason: '工作区在等你回答。',
    href: '/dashboard#inbox',
    label: '去回答',
    urgent: true,
  })
}

export function projectPlan(repoId: string, planId: string): ActionCandidate {
  return candidate('plan', repoId, planId, {
    reason: '计划等待批准后才会开始写代码。',
    href: `/repos/${repoId}`,
    label: '查看计划',
    urgent: true,
  })
}

export function projectRelease(repoId: string, tag: string): ActionCandidate {
  return candidate('release', repoId, tag, {
    reason: '发布在等你确认版本和提交。',
    href: `/repos/${repoId}/release-readiness`,
    label: '检查发布',
    urgent: false,
  })
}

export function projectQuota(repoId: string, userId: string): ActionCandidate {
  return candidate('quota', repoId, userId, {
    reason: '平台额度已用完，配置自己的模型后才能继续。',
    href: '/settings#model-providers',
    label: '配置模型',
    urgent: true,
  })
}

// The tree writes two notice kinds outside the six: `team` (only the Lead took
// part) is a review decision, and `ops` (an operator alert) is a broken state.
// Mapping here keeps the projection closed without changing the writers yet.
export function projectLegacyNotice(kind: string, repoId: string, objectId: string): ActionCandidate | null {
  if (kind === 'team') {
    return candidate('review', repoId, objectId, {
      reason: '只有负责人参与了这次工作，需要你审核。',
      href: `/repos/${repoId}`,
      label: '打开仓库',
      urgent: false,
    })
  }
  if (kind === 'ops') {
    return candidate('failed', repoId, objectId, {
      reason: '运维告警：有一个状态需要处理。',
      href: `/repos/${repoId}`,
      label: '查看',
      urgent: true,
    })
  }
  return null
}

// The mail and the in-app row show a sentence, never the error a machine wrote.
// Tokens, addresses, stack frames, file paths and internal codes are removed
// before anything reaches a person, and a sentence that is only those parts
// becomes the fixed fallback rather than an empty notice.
const FALLBACK_SENTENCE = '这一步没有完成，请打开页面查看下一步。'

export function sanitizeActionSentence(text: string): string {
  let clean = text
  // A stack frame ends the useful part of a message; the lines after it are
  // paths and symbol names.
  clean = clean.split(/\r?\n/).filter((line) => !/^\s*at\s/.test(line) && !/\((?:src|lib|node_modules)\//.test(line)).join(' ')
  clean = clean.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, ' ')
  clean = clean.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, ' ')
  clean = clean.replace(/\bBearer\s+\S+/gi, ' ')
  clean = clean.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, ' ')
  clean = clean.replace(/\b(?:\/[\w.-]+){2,}\/?/g, ' ')
  clean = clean.replace(/\b(?:src|lib|test|data|node_modules)\/[\w./-]+/g, ' ')
  clean = clean.replace(/\b[A-Za-z]*Error\b:?/g, ' ')
  clean = clean.replace(/\bE[A-Z]{4,}\b/g, ' ')
  clean = clean.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, ' ')
  clean = clean.replace(/\s+/g, ' ').replace(/^[\s:：,，-]+/, '').trim()
  return clean.length < 8 ? FALLBACK_SENTENCE : clean
}
