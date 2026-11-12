import type { Translate } from '../i18n.js'

// #227: the first-run checklist. The state is read from the database on every
// request — repository count, a chosen role, a configured model, a ready
// instance and the first job — so nothing here depends on a cookie or a second
// onboarding store. The module is pure: the route reads the rows, this decides
// which step is next, and the dashboard renders exactly one primary action.

export type SetupStepKey = 'repo' | 'role' | 'model' | 'instance' | 'job'

export interface SetupState {
  repos: number
  roleChosen: boolean
  modelConfigured: boolean
  instanceReady: boolean
  jobs: number
  // Status of the account's *first* job, all-time, not a window-scoped count:
  // a success that fell out of the 7-day window must not read as a failure.
  firstJobStatus: string | null
  // The first job's own pull request, so a later job's PR is never attributed
  // to "your first job opened a pull request".
  firstPrUrl: string | null
  repoHref: string | null
}

export interface SetupStep {
  key: SetupStepKey
  title: string
  done: boolean
  action: { href: string; label: string }
  blocked: string | null
}

export interface SetupChecklist {
  steps: SetupStep[]
  done: number
  total: number
  next: SetupStep | undefined
  complete: boolean
}

export interface FirstRunOutcome {
  title: string
  body: string
  action: { href: string; label: string }
}

const TOTAL = 5

export function setupChecklist(state: SetupState, t: Translate): SetupChecklist {
  const repoHref = state.repoHref ?? '#add-repo'
  const steps: SetupStep[] = [
    {
      key: 'repo',
      title: t('接入一个仓库', 'Connect a repository'),
      done: state.repos > 0,
      action: { href: '#add-repo', label: t('添加仓库', 'Add repository') },
      blocked: null,
    },
    {
      key: 'role',
      title: t('选择你的角色', 'Choose your role'),
      done: state.roleChosen,
      action: { href: repoHref, label: t('选择角色', 'Choose role') },
      blocked: state.repos === 0 ? t('先接入一个仓库。', 'Connect a repository first.') : null,
    },
    {
      key: 'model',
      title: t('添加模型提供方', 'Add a model provider'),
      done: state.modelConfigured,
      action: { href: '/settings#model-providers', label: t('打开「设置 → 模型」', 'Open Settings → Model') },
      blocked: state.roleChosen ? null : t('先选择你的角色。', 'Choose your role first.'),
    },
    {
      key: 'instance',
      title: t('启动 FlyBot 实例', 'Start the FlyBot instance'),
      done: state.instanceReady,
      action: { href: repoHref, label: t('打开仓库启动', 'Open the repository') },
      blocked: !state.modelConfigured ? t('先添加一个模型。', 'Add a model first.') : null,
    },
    {
      key: 'job',
      title: t('运行第一个任务', 'Run the first job'),
      done: state.jobs > 0,
      action: { href: repoHref, label: t('运行任务', 'Run a job') },
      blocked: !state.instanceReady ? t('先启动实例。', 'Start the instance first.') : null,
    },
  ]
  const done = steps.filter((step) => step.done).length
  return {
    steps,
    done,
    total: TOTAL,
    next: steps.find((step) => !step.done),
    complete: done === TOTAL,
  }
}

// Shown instead of the checklist once a job exists, so a finished run gets a
// summary and a failed first run still gets a way forward rather than a dead end.
// The outcome comes from the first job's own status: one row, read all-time, so
// the answer cannot change with the ?window control.
export function firstRunOutcome(state: SetupState, t: Translate): FirstRunOutcome | null {
  if (state.jobs === 0) return null
  if (state.firstPrUrl !== null) {
    return {
      title: t('第一个任务已经开出 PR', 'Your first job opened a pull request'),
      body: t(
        '检查和评审都在 GitHub 上完成；之后每个任务最多开一个 PR。',
        'Checks and review happen on GitHub; every later job opens at most one pull request.',
      ),
      action: { href: state.firstPrUrl, label: t('打开 PR', 'Open the pull request') },
    }
  }
  if (state.firstJobStatus === 'succeeded') {
    return {
      title: t('第一个任务已经完成', 'Your first job finished'),
      body: t('之后的运行会出现在下面的最近任务里。', 'Later runs appear in Recent jobs below.'),
      action: { href: '#jobs', label: t('查看最近任务', 'Open recent jobs') },
    }
  }
  if (state.firstJobStatus === 'queued' || state.firstJobStatus === 'running') {
    return {
      title: t('第一个任务正在运行', 'Your first job is running'),
      body: t('进度会出现在下面的最近任务里，完成后这里会给出结果。', 'Progress appears in Recent jobs below, and this card reports the result when it finishes.'),
      action: { href: '#jobs', label: t('查看最近任务', 'Open recent jobs') },
    }
  }
  return {
    title: t('第一个任务没有成功', 'Your first job did not succeed'),
    body: t(
      '失败原因写在任务详情里；修好之后回到仓库页再运行一次。',
      'The failure reason is on the job; fix it and run again from the repository page.',
    ),
    action: { href: state.repoHref ?? '/dashboard#jobs', label: t('回到仓库重试', 'Retry from the repository') },
  }
}
