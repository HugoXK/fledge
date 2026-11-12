import type { FastifyRequest } from 'fastify'

export type Locale = 'zh' | 'en'
export type Translate = (zh: string, en: string) => string

export const LOCALE_COOKIE = 'fledge_lang'
export const LOCALES: readonly Locale[] = ['zh', 'en']

export function isLocale(value: unknown): value is Locale {
  return value === 'zh' || value === 'en'
}

export function resolveLocale(request: FastifyRequest): Locale {
  const saved = request.cookies?.[LOCALE_COOKIE]
  if (isLocale(saved)) return saved
  const header = String(request.headers['accept-language'] ?? '')
  return /(^|,)\s*en(?:-|;|,|$)/i.test(header) ? 'en' : 'zh'
}

export function translator(locale: Locale): Translate {
  return (zh, en) => (locale === 'en' ? en : zh)
}

const MESSAGES: Record<string, string> = {
  '表单已过期，请刷新页面后重试。': 'This form has expired. Refresh the page and try again.',
  '仓库不存在。': 'Repository not found.',
  '页面不存在': 'Page not found',
  'Dev 登录没有开启。': 'Developer sign-in is disabled.',
  '请求过多': 'Too many requests',
  '请稍后再试。': 'Please try again later.',
  '缺少 token': 'Missing token',
  '请填写一个 GitHub token。': 'Enter a GitHub token.',
  'GitHub token 无效': 'Invalid GitHub token',
  '无法用这个 token 读取 GitHub 身份，请检查权限或重新生成。': 'This token cannot read your GitHub identity. Check its permissions or create a new one.',
  'GitHub OAuth 未配置': 'GitHub OAuth is not configured',
  '请先在 .env 设置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET。': 'Set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET in .env first.',
  '登录失败': 'Sign-in failed',
  '登录链接已失效': 'Sign-in link expired',
  '这个 GitHub 登录链接已失效或已经被使用。请重新登录；如果是在微信/QQ 内置浏览器打开，请改用 Safari 或 Chrome。': 'This GitHub sign-in link has expired or has already been used. Sign in again; if you opened it inside WeChat/QQ, use Safari or Chrome instead.',
  '无法完成 GitHub 登录，请重试。': 'Could not complete GitHub sign-in. Try again.',
  'OAuth 已启用': 'OAuth is enabled',
  '这个部署已经启用 GitHub OAuth，请使用 GitHub 登录。': 'This deployment uses GitHub OAuth. Sign in with GitHub.',
  '这个仓库已经添加过了。': 'This repository has already been added.',
  'OAuth state 无效或已过期，请重新登录。': 'The OAuth state is invalid or expired. Sign in again.',
  'GitHub 登录失败': 'GitHub sign-in failed',
  '签名必须与你的 GitHub 登录名一致。': 'The signature must match your GitHub username.',
  '请逐项勾选免责声明和信息安全承诺。': 'Check the disclaimer and the information-security commitment.',
  '申请已提交，正在排队。': 'Application submitted. You are in the queue.',
  '请填写 GitHub token': 'Enter a GitHub token',
  '仓库已添加。': 'Repository added.',
  '任务已排队。': 'Job queued.',
  '任务启动失败。': 'Could not start the job.',
  '设置已保存。': 'Settings saved.',
  '设置已保存；团队规则已按新目标更新。': 'Settings saved; the team playbook now follows the new goal.',
  '计划任务已排队，不会写代码或开 PR。': 'Plan queued. It will not write code or open a PR.',
  '计划任务启动失败。': 'Could not start the plan job.',
  '已重新排队。': 'Re-queued.',
  '已按计划开始执行。': 'Started executing the plan.',
  '通知邮箱格式不正确。': 'The notification email format is invalid.',
  '请先填写通知邮箱。': 'Add a notification email first.',
  '测试邮件每分钟最多发送一次。': 'A test email can be sent at most once per minute.',
  '测试邮件已发送。': 'Test email sent.',
  '通知设置已保存。': 'Notification settings saved.',
  '额度已设为不限额。': 'Quota set to unlimited.',
  'GitHub App 未配置。': 'The GitHub App is not configured.',
  'GitHub App 未配置；仍可使用 PAT 接入。': 'The GitHub App is not configured; you can still connect with a PAT.',
  '安装回调缺少 installation_id。': 'The install callback is missing installation_id.',
  '找不到这个 GitHub App 安装。': 'This GitHub App installation was not found.',
  '安装状态已过期，请重新从工作区发起安装。': 'The installation state expired. Start the install again from the workspace.',
  '这个安装已经绑定到另一个 Fledge 用户。': 'This installation is already bound to another Fledge user.',
  '这个安装不属于当前 GitHub 用户；请用安装它的账号登录。': 'This installation does not belong to the current GitHub user; sign in with the account that installed it.',
  '请选择至少一个仓库。': 'Choose at least one repository.',
  '没有新增仓库；可能已经添加过，或 App 权限不足。': 'No repositories were added; they may already be connected, or the App lacks permission.',
  '这个仓库已有任务在运行。': 'A job is already running for this repository.',
  '只有已暂停的任务可以恢复。': 'Only a paused job can be resumed.',
  '这个任务已经结束。': 'This job has already finished.',
  '目标分支格式不正确。': 'The target branch name is invalid.',
  '目标分支不存在或不可访问。': 'The target branch does not exist or is not accessible.',
  '平台当前已有 2 个任务在运行，请稍后再试。': 'Two jobs are already running on the platform; try again later.',
  '账号已被管理员停用': 'The account was disabled by an administrator.',
  '仓库格式应为 owner/name': 'Use the owner/name repository format.',
  '仓库名只能包含字母、数字、. _ -': 'Repository names may only contain letters, numbers, dots, underscores and hyphens.',
  'GitHub token 无效或已过期': 'The GitHub token is invalid or expired.',
  '上游仓库不存在，或 token 没有该仓库的访问权限': 'The upstream repository does not exist, or the token cannot access it.',
  'GitHub 拒绝了访问，请检查 token 权限或组织 SSO 授权': 'GitHub denied access; check the token permissions or organization SSO authorization.',
  '无法创建 fork：token 权限不足，或上游组织禁止 fork': 'Could not create the fork: the token lacks permission or the upstream organization disallows forks.',
  '无法创建 fork：你的账号下已有同名仓库或组织策略冲突': 'Could not create the fork: a repository with the same name exists or an organization policy conflicts.',
  'Base URL 不是合法 URL': 'The Base URL is not a valid URL.',
  'Base URL 不能包含用户名或密码': 'The Base URL must not contain a username or password.',
  'Base URL 必须是 https://（本地开发可用 http://）': 'The Base URL must use https:// (http:// is allowed for local development).',
  '公网模型服务必须使用 https://': 'A public model service must use https://.',
  '不允许使用本机/内网地址': 'Local or private network addresses are not allowed.',
  '不允许使用内网地址': 'Private network addresses are not allowed.',
  '无法解析这个域名': 'Could not resolve this domain.',
  '不允许使用解析到内网地址的域名': 'A domain that resolves to a private address is not allowed.',
  'FlyBot 实例管理器未配置': 'The FlyBot instance manager is not configured.',
  '任务超时未回报': 'The job timed out before reporting back.',
  '任务排队超时未启动': 'The queued job timed out before starting.',
  '任务失败': 'The job failed.',
  '重试失败。': 'Could not retry the job.',
  '执行计划失败。': 'Could not execute the plan.',
  '这个失败已经跟进过': 'This failure has already been followed up.',
  '平台额度已用完，请在 Settings → Model 配置自己的模型 API 后重试。': 'Platform quota is used up. Configure your own model API in Settings → Model and retry.',
  '平台额度已用完，请在 Settings → Model 配置自己的模型 API。': 'Platform quota is used up. Configure your own model API in Settings → Model.',
  '仓库已删除。': 'Repository deleted.',
  '已改回平台额度。': 'Switched back to platform quota.',
  '请填写 Base URL': 'Enter a Base URL',
  '请填写 API Key': 'Enter an API key',
  '模型服务已保存并通过测试。': 'Model service saved and tested.',
  'Token 已撤销。': 'Token revoked.',
  '会话已撤销，那个 cookie 现在就会被拒绝。': 'Session revoked; that cookie is refused from its next request.',
  '已换成新的会话 cookie，旧 cookie 已作废。': 'This session now uses a new cookie; the old one is no longer valid.',
  '没有其他会话需要退出。': 'No other session needed to be signed out.',
  '这个会话不存在，或不属于你。': 'That session does not exist, or it is not yours.',
  '这是当前会话。请用“轮换当前会话”换一个新 cookie，或用退出登录结束它。': 'That is the current session. Use "Rotate this session" for a new cookie, or sign out to end it.',
  '已批准。': 'Approved.',
  '已拒绝。': 'Rejected.',
  '额度必须是 0–10000 之间的数字。': 'Quota must be a number between 0 and 10000.',
  '额度已更新。': 'Quota updated.',
  '链接无效': 'Invalid link',
  '这个审批链接无效或已经过期。': 'This approval link is invalid or has expired.',
  '已经处理过': 'Already handled',
  '这个申请已经处理过了。': 'This application has already been handled.',
  '无法处理': 'Could not process',
  '用户不存在。': 'User not found.',
  'Admin only': 'Administrators only',
  '请先登录。': 'Sign in first.',
  '账号正在等待审批。': 'Your account is awaiting approval.',
  '仅管理员可访问。': 'Administrators only.',
  '仅管理员可访问实时团队页面。': 'Only administrators can open the live team page.',
  '仅超级管理员可访问实时团队页面。': 'Only a super admin can open the live team page.',
  '仅超级管理员可访问。': 'Super admin access only.',
  '不能修改这个账号。': 'This account cannot be changed.',
  '角色无效。': 'Invalid role.',
  '只有超级管理员可以设置不限额。': 'Only a super admin can set unlimited quota.',
  '已设为管理员。': 'Promoted to administrator.',
  '已设为用户。': 'Set to user.',
  '出错了': 'Something went wrong',
  '服务器出了点问题，请稍后再试。': 'The server had a problem. Try again later.',
  '新 token 只显示这一次，请现在复制保存。': 'This token is shown only once. Copy it now.',
  '审核任务已排队。': 'Review job queued.',
  '审核任务启动失败。': 'Could not start the review job.',
  '这个仓库没有启用审核角色': 'The reviewer role is not enabled for this repository.',
  '这个仓库已停用': 'This repository is disabled.',
  '这个仓库已有任务在运行': 'A job is already running for this repository.',
  '用户不可用': 'The user is not available.',
  '平台额度已用完，请先配置自己的模型 API': 'Platform quota is used up. Configure your own model API first.',
  'FlyBot 实例初始化中。': 'FlyBot instance is initializing.',
  'FlyBot 实例未配置': 'FlyBot instance is not configured.',
  'FlyBot 实例已停止。': 'FlyBot instance stopped.',
  'FlyBot 实例未就绪': 'FlyBot instance is not ready.',
  '已批准': 'Approved',
  '已拒绝': 'Rejected',
  '请先选择你在这个仓库的角色。': 'Choose your role for this repository first.',
  '只有 maintainer 可以运行审核任务。': 'Only a maintainer can run review jobs.',
  'GitHub 权限检查已过期，请刷新仓库后再审核。': 'The GitHub permission check has expired; refresh the repository before reviewing.',
  '你的 GitHub 权限不允许选择这个角色。': 'Your GitHub permission does not allow this role.',
  '请选择 maintainer 或 developer。': 'Choose maintainer or developer.',
  '请先选择你的角色。': 'Choose your role first.',
  '已选择角色：Maintainer。': 'Role selected: Maintainer.',
  '已选择角色：Developer。': 'Role selected: Developer.',
  'follow-up 分支不能是目标分支。': 'A follow-up branch cannot be the target branch.',
  '仓库已停用': 'Repository disabled.',
  'FlyBot 实例已停止': 'FlyBot instance stopped.',
  '无法确认你的 GitHub maintain 权限；如这是你自己的仓库，请重新授权 GitHub。': 'Could not confirm your GitHub maintain permission; re-authorize GitHub if this is your repository.',
  // Route banners (#240). A sentence a route hands to a redirect's notice/error
  // value is a user-facing sentence too, so it lives here with the rest rather
  // than as an English string at the call site; test/pages.test.ts walks every
  // redirect and fails when a banner has no row or localizer.
  'GitHub OAuth 未配置。': 'GitHub OAuth is not configured.',
  'PR 已合并。': 'The pull request was merged.',
  'PR 证据与路径检查通过。': 'The PR evidence and path checks passed.',
  'Product 范围任务已排队。': 'The Product scoping job is queued.',
  'Test 验证任务已排队。': 'The Test verification job is queued.',
  'Webhook 已重试。': 'The webhook was retried.',
  '不能从这个状态切换。': 'The work item cannot move from that state.',
  '仓库已停用，任务不会再运行。': 'Repository disabled; no jobs will run again.',
  '仓库已启用；自动迭代不会自动打开，需要时在设置里开启。': 'Repository enabled. Auto-iteration does not start by itself; turn it on in settings when you want it.',
  '仓库连接已删除；GitHub 仓库不受影响。': 'The repository connection was deleted; the GitHub repository itself is unaffected.',
  '任务已取消。': 'The job was canceled.',
  '任务已暂停。': 'The job was paused.',
  '取消失败。': 'Could not cancel the job.',
  '只有 maintainer 可以合并 PR。': 'Only a maintainer can merge a pull request.',
  '只有 maintainer 可以执行计划。': 'Only a maintainer can execute a plan.',
  '只有 maintainer 可以执行这个操作。': 'Only a maintainer can do this.',
  '只有 maintainer 可以批准计划。': 'Only a maintainer can approve a plan.',
  '只有 maintainer 可以批量合并 PR。': 'Only a maintainer can merge pull requests in bulk.',
  '只有 maintainer 可以拒绝计划。': 'Only a maintainer can reject a plan.',
  '只有失败的 delivery 可以重试。': 'Only a failed delivery can be retried.',
  '合并失败。': 'The merge failed.',
  '安装回调缺少 installation_id；请在 GitHub App 设置的 Setup URL 指向 /auth/github/app/installed，或从已安装列表重新选择仓库。': 'The install callback is missing installation_id. Point the GitHub App Setup URL at /auth/github/app/installed, or pick the repository again from the installed list.',
  '审批邮件仍然发送失败，请检查 SMTP 配置。': 'The approval email still cannot be sent; check the SMTP settings.',
  '审批邮件已重新发送。': 'The approval email was sent again.',
  '工作项任务已排队。': 'The work item job is queued.',
  '工作项启动失败。': 'Could not start the work item.',
  '工作项已创建。': 'Work item created.',
  '工作项状态已更新。': 'Work item state updated.',
  '工作项状态无效。': 'That work item state is invalid.',
  '已允许这个用户配置 HTTP/内网模型。': 'This user may now configure HTTP/private-network models.',
  '已恢复任务。': 'The job was resumed.',
  '已禁止这个用户配置 HTTP/内网模型。': 'This user may no longer configure HTTP/private-network models.',
  '恢复失败。': 'Could not resume the job.',
  '暂停失败。': 'Could not pause the job.',
  '模型已删除。': 'Model deleted.',
  '模型已应用，工作区已重启。': 'Model applied and the workspace restarted.',
  '模型已通过连接测试并保存。': 'The model passed the connection test and was saved.',
  '模型应用失败。': 'Could not apply the model.',
  '模型提供方已删除。': 'Model provider deleted.',
  '模型提供方已更新。': 'Model provider updated.',
  '模型提供方已添加。添加模型时会由 Fledge 测试连接。': 'Model provider added. Fledge tests the connection when you add a model.',
  '范围任务启动失败。': 'Could not start the scoping job.',
  '计划任务已排队。': 'Plan job queued.',
  '计划任务已排队；批准后才会写代码。': 'Plan job queued; no code is written until it is approved.',
  '计划尚未批准。': 'The plan has not been approved yet.',
  '不支持这个 token 范围。': 'That token scope is not supported.',
  '只有管理员可以创建永不过期的 token。': 'Only an admin can create a token without an expiry.',
  '计划已过期关闭，不能再批准；重新创建工作项即可生成新计划。': 'This plan expired and is closed, so it cannot be approved; create a new work item to plan again.',
  '计划已批准，可以执行。': 'The plan was approved and can be executed.',
  '计划已拒绝。': 'The plan was rejected.',
  '请填写工作项标题。': 'Enter a work item title.',
  '请输入仓库名确认删除。': 'Type the repository name to confirm deletion.',
  '请选择至少一个模型。': 'Choose at least one model.',
  '这个 delivery 没有可重试的 payload。': 'This delivery has no payload to retry.',
  '这个工作项已经结束。': 'This work item is already finished.',
  '这个工作项还没有 PR。': 'This work item has no pull request yet.',
  '这封邮件刚刚发送过，24 小时内不重复发送。': 'This email was sent moments ago; it is not sent again within 24 hours.',
  '重新检查失败。': 'The re-check failed.',
  '验证任务启动失败。': 'Could not start the verification job.',
}

export function localizeMessage(locale: Locale, message: string | undefined): string | undefined {
  if (message === undefined || locale === 'zh') return message
  const application = /^@(.+) 的申请已(批准|拒绝)。$/.exec(message)
  if (application !== null) return `@${application[1]}'s application was ${application[2] === '批准' ? 'approved' : 'rejected'}.`
  const connected = /^已接入 (\d+) 个仓库。$/.exec(message)
  if (connected !== null) return `Connected ${connected[1]} ${connected[1] === '1' ? 'repository' : 'repositories'}.`
  const fork = /^已创建 fork (.+)。$/.exec(message)
  if (fork !== null) return `Created fork ${fork[1]}.`
  const duplicateWork = /^已有 PR 覆盖这个 issue：(.+)$/.exec(message)
  if (duplicateWork !== null) return `A pull request already covers this issue: ${duplicateWork[1]}`
  const mailFailed = /^测试邮件发送失败：(.+)$/.exec(message)
  if (mailFailed !== null) return `Test email failed: ${mailFailed[1]}`
  const connectFailed = /^连接失败：(.+)$/.exec(message)
  if (connectFailed !== null) return `Connection failed: ${connectFailed[1]}`
  const modelHttp = /^模型服务返回 HTTP (\d+)：(.+)$/.exec(message)
  if (modelHttp !== null) return `The model service returned HTTP ${modelHttp[1]}: ${modelHttp[2]}`
  // Route banners whose value is built from data (#240). The rendered sentence
  // is what reaches the console, so these match the rendered shape.
  const merged = /^已合并 (\d+) 个 PR(?:，([\s\S]+))?$/.exec(message)
  if (merged !== null) {
    const count = merged[1] ?? '0'
    const skipped = (merged[2] ?? '')
      .replace(/跳过 (\d+) 个（最新任务还没有成功）/g, (_whole: string, skippedJobs: string) => `skipped ${skippedJobs} (the latest job has not succeeded)`)
      .replace(/跳过 (\d+) 个（未通过合并检查）/g, (_whole: string, skippedPrs: string) => `skipped ${skippedPrs} (the merge checks did not pass)`)
      .split('，')
      .filter((part) => part !== '')
      .join(', ')
    return `Merged ${count} ${count === '1' ? 'pull request' : 'pull requests'}${skipped === '' ? '' : `, ${skipped}`}.`
  }
  const modelsSaved = /^(\d+) 个模型已通过测试并保存(?:；失败：([\s\S]+))?$/.exec(message)
  if (modelsSaved !== null) {
    const count = modelsSaved[1] ?? '0'
    const failed = modelsSaved[2] === undefined ? '' : `; failed: ${modelsSaved[2]}`
    return `${count} ${count === '1' ? 'model' : 'models'} passed the test and ${count === '1' ? 'was' : 'were'} saved${failed}.`
  }
  const providerTestFailed = /^提供方测试失败，未保存：([\s\S]+)$/.exec(message)
  if (providerTestFailed !== null) return `The provider test failed and nothing was saved: ${providerTestFailed[1]}`
  const modelsFound = /^发现 (\d+) 个模型。$/.exec(message)
  if (modelsFound !== null) {
    const count = modelsFound[1] ?? '0'
    return `Found ${count} ${count === '1' ? 'model' : 'models'}.`
  }
  const othersRevoked = /^已退出 (\d+) 个其他会话。$/.exec(message)
  if (othersRevoked !== null) {
    const count = othersRevoked[1] ?? '0'
    return `Signed out ${count} other ${count === '1' ? 'session' : 'sessions'}.`
  }
  const modelsReadFailed = /^读取模型失败：([\s\S]+)$/.exec(message)
  if (modelsReadFailed !== null) return `Could not read the models: ${modelsReadFailed[1]}`
  const connectionTestFailed = /^连接测试失败，未保存：([\s\S]+)$/.exec(message)
  if (connectionTestFailed !== null) return `The connection test failed and nothing was saved: ${connectionTestFailed[1]}`
  const retryFailed = /^重试失败：([\s\S]+)$/.exec(message)
  if (retryFailed !== null) return `Retry failed: ${retryFailed[1]}`
  return MESSAGES[message] ?? message
}

// A notification row is written as a finished sentence by the code that produced
// the event, so its stored text is in the writer's language, not the reader's:
// the quota path writes Chinese and the ops alerts write English. The dashboard
// knows the locale at render time, so the sentence is rebuilt here from the
// template it matches; a message no template knows is returned unchanged.
type Localizer = (match: RegExpExecArray) => string

export const ZH_TO_EN: ReadonlyArray<readonly [RegExp, Localizer]> = [
  [/^(.+) 的 GitHub token 权限不足，自动迭代已暂停；请重新授权后手动开启。$/, (m) => `${m[1]}: the GitHub token is missing permissions, so auto-iteration is paused. Re-authorize GitHub and start it again manually.`],
  [/^(审核|任务) (\S+) 启动失败：([\s\S]+)$/, (m) => `The ${m[1] === '审核' ? 'review job' : 'job'} ${m[2]} failed to start: ${m[3]}`],
  [/^(审核|任务) (\S+) 失败：([\s\S]+)$/, (m) => `The ${m[1] === '审核' ? 'review job' : 'job'} ${m[2]} failed: ${m[3]}`],
  // Every job kind can miss stage evidence, not just iterate/review: checkStage
  // returns errors for scope and verify too, and the writer interpolates
  // `${job.kind}` verbatim, so the kind is read as data rather than enumerated.
  [/^(\S+) 任务 (\S+) 缺少阶段证据：([\s\S]+)$/, (m) => `The ${m[1]} job ${m[2]} is missing stage evidence: ${m[3]}`],
  [/^任务 (\S+) 成本 ([\d.]+) 元，超过单任务预算 ([\d.]+) 元。$/, (m) => `Job ${m[1]} cost ${m[2]} CNY, over its ${m[3]} CNY single-job budget.`],
  [/^任务 (\S+) 属于临时失败，将在约 (\d+) 分钟后自动重试。$/, (m) => `Job ${m[1]} hit a temporary failure; it will retry automatically in about ${m[2]} minutes.`],
  [/^任务 (\S+) 的 PR 改动的文件列表不完整，无法确认路径约束，已阻止合并：([\s\S]+)$/, (m) => `The PR for job ${m[1]} has an incomplete changed-file list, so the path constraint could not be confirmed and the merge was blocked: ${m[2]}`],
  [/^任务 (\S+) 改动的文件列表不完整，无法确认路径约束：([\s\S]+)$/, (m) => `Job ${m[1]} has an incomplete changed-file list, so the path constraint could not be confirmed: ${m[2]}`],
  [/^任务 (\S+) 的 PR 改动了受保护路径，已阻止合并：([\s\S]+)$/, (m) => `The PR for job ${m[1]} changed protected paths, so the merge was blocked: ${m[2]}`],
  [/^任务 (\S+) 改动了受保护路径：([\s\S]+)$/, (m) => `Job ${m[1]} changed protected paths: ${m[2]}`],
  [/^(.+) 连续 3 个任务失败，自动迭代已暂停；请检查 bridge、GitHub 凭据和模型额度后手动重新开启。$/, (m) => `${m[1]} failed 3 jobs in a row, so auto-iteration is paused. Check the bridge, the GitHub credential and the model quota, then start it again manually.`],
  [/^(.+) 的本次任务只有 Lead 参与，其他团队角色没有实际介入。$/, (m) => `Only the Lead took part in this job for ${m[1]}; no other team role was involved.`],
  [/^(.+) 团队提问：([\s\S]+)$/, (m) => `${m[1]} team question: ${m[2]}`],
  [/^平台额度已用完，请(?:到|在) Settings → Model 配置你自己的模型 API。(?:后重试。)?$/, () => 'Platform quota is used up. Configure your own model API in Settings → Model.'],
  [/^平台额度已用完，请在 Settings → Model 配置自己的模型 API。$/, () => 'Platform quota is used up. Configure your own model API in Settings → Model.'],
]

export const EN_TO_ZH: ReadonlyArray<readonly [RegExp, Localizer]> = [
  [/^The (\S+) job (\S+) is missing stage evidence: ([\s\S]+)$/, (m) => `${m[1]} 任务 ${m[2]} 缺少阶段证据：${m[3]}`],
  [/^job (\S+) has no callback for (\d+)m$/, (m) => `任务 ${m[1]} 已有 ${m[2]} 分钟没有回报。`],
  [/^PR (\S+) has been open for (\d+)h$/, (m) => `PR ${m[1]} 已开启 ${m[2]} 小时。`],
  [/^(.+): GitHub credential is (.+)$/, (m) => `${m[1]}：GitHub 凭据状态为 ${m[2]}。`],
  [/^(.+): spent ([\d.]+) of ([\d.]+) CNY in 30 days$/, (m) => `${m[1]}：30 天已花费 ${m[2]} / ${m[3]} 元。`],
]

// The tables are exported so the suite can pin every row with a rendering of
// its own: a row added without a sample, or a sample whose sentence stopped
// matching, fails there instead of in a user's console.
export const NOTIFICATION_TEMPLATES: Readonly<Record<Locale, ReadonlyArray<readonly [RegExp, Localizer]>>> = {
  en: ZH_TO_EN,
  zh: EN_TO_ZH,
}

export function localizeNotification(locale: Locale, message: string): string {
  for (const [pattern, build] of NOTIFICATION_TEMPLATES[locale]) {
    const match = pattern.exec(message)
    if (match !== null) return build(match)
  }
  return message
}

declare module 'fastify' {
  interface FastifyRequest {
    locale?: Locale
  }
}
