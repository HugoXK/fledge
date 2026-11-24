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
  // A provider with at least one model exists, but it may not be selected by a
  // repository yet.
  providerConfigured: boolean
  // A repository can actually run on an own model: it has a selected provider
  // model, or the legacy user-level model is configured. Naming this separately
  // from `providerConfigured` is #732: adding a model in Settings is not the same
  // as making a repository use it.
  modelConfigured: boolean
  /** The platform model is configured and the user's platform quota is not exhausted. */
  platformAvailable: boolean
  /** The remaining platform quota in CNY; `platformQuotaUnlimited` wins when true. */
  platformQuotaRemainingCny: number
  platformQuotaUnlimited: boolean
  /** Config value: below this remaining balance the step warns and recommends an own model. */
  platformQuotaComfortCny: number
  instanceReady: boolean
  /**
   * Whether this deployment runs per-repository workspaces at all. An empty
   * `FLYBOT_INSTANCE_IMAGE` means it runs without containers, so a workspace
   * cannot be started and must be neither a step nor a blocker (#1281).
   */
  instancesUsed: boolean
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
  /** Satisfied by the platform quota rather than an own provider. */
  optional?: boolean
  note?: string
  /** A longer advisory shown under the note, e.g. a low platform balance. */
  warning?: string
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

// The threshold is `PLATFORM_QUOTA_COMFORT_CNY` in config; the checklist keeps
// no second default, so a deployment changes the advice in one place. Below it
// the platform still pays, but the user is advised to bring an own model before
// the first job; at or above it the balance is shown without a warning.
function cny(value: number): string {
  return value > 0 && value < 1 ? `¥${value.toFixed(4)}` : `¥${value.toFixed(2)}`
}

export function setupChecklist(state: SetupState, t: Translate): SetupChecklist {
  const repoHref = state.repoHref ?? '#add-repo'
  const optionalPlatform = state.platformAvailable && !state.modelConfigured
  const quotaText = state.platformQuotaUnlimited ? t('不限额', 'unlimited') : cny(state.platformQuotaRemainingCny)
  const lowPlatformQuota = optionalPlatform && !state.platformQuotaUnlimited && state.platformQuotaRemainingCny < state.platformQuotaComfortCny
  const platformNote = optionalPlatform
    ? state.platformQuotaUnlimited
      ? t('使用平台额度（不限额）', 'Using platform quota (unlimited)')
      : t(`使用平台额度（默认）· 剩余 ${quotaText}`, `Using platform quota (default) · ${quotaText} left`)
    : undefined
  const platformWarning = lowPlatformQuota
    ? state.providerConfigured
      ? t(`当前平台额度只剩 ${quotaText}，首次运行可能不够用；建议现在为仓库选择模型。`, `Only ${quotaText} of platform quota is left; it may not cover the first run. Choose a model for the repository now.`)
      : t(`当前平台额度只剩 ${quotaText}，首次运行可能不够用；建议现在在 Settings → Model 配置自己的模型。`, `Only ${quotaText} of platform quota is left; it may not cover the first run. Add your own model in Settings → Model now.`)
    : undefined
  const modelAction = optionalPlatform
    ? state.providerConfigured
      ? {
          href: repoHref,
          label: lowPlatformQuota
            ? t('立即选择仓库模型', 'Choose a repository model now')
            : t('选择仓库模型（可选）', 'Choose a repository model (optional)'),
        }
      : {
          href: '/settings#model-providers',
          label: lowPlatformQuota
            ? t('立即配置自己的模型', 'Add your own model now')
            : t('以后在 Settings → Model 配置', 'Configure later in Settings → Model'),
        }
    : state.providerConfigured && !state.modelConfigured
      ? { href: repoHref, label: t('选择仓库模型', 'Choose a repository model') }
      : { href: '/settings#model-providers', label: t('打开「设置 → 模型」', 'Open Settings → Model') }
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
      // #732: a provider row is not an own model until a repository selects it.
      // #728: the step is still optional while the platform quota can fund the
      // run; when the quota is exhausted or the platform model is missing, a
      // provider without a selection is the required next action.
      title: !state.modelConfigured && state.providerConfigured && !state.platformAvailable
        ? t('为仓库选择模型', 'Choose a model for the repository')
        : t('添加模型提供方', 'Add a model provider'),
      done: state.modelConfigured || state.platformAvailable,
      optional: optionalPlatform,
      note: platformNote,
      warning: platformWarning,
      action: modelAction,
      // Adding or selecting a model does not depend on the repository role.
      blocked: null,
    },
    {
      key: 'instance',
      title: t('启动工作区', 'Start workspace'),
      done: !state.instancesUsed || state.instanceReady,
      action: { href: repoHref, label: t('打开仓库启动', 'Open the repository') },
      blocked: !state.modelConfigured && !state.platformAvailable
        ? state.providerConfigured
          ? t('先为仓库选择一个模型。', 'Choose a model for the repository first.')
          : t('先添加一个模型。', 'Add a model first.')
        : null,
    },
    {
      key: 'job',
      title: t('运行第一个任务', 'Run the first job'),
      done: state.jobs > 0,
      action: { href: repoHref, label: t('运行任务', 'Run a job') },
      blocked: state.instancesUsed && !state.instanceReady ? t('先启动工作区。', 'Start the workspace first.') : null,
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
