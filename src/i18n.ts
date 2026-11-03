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
}

export function localizeMessage(locale: Locale, message: string | undefined): string | undefined {
  if (message === undefined || locale === 'zh') return message
  const application = /^@(.+) 的申请已(批准|拒绝)。$/.exec(message)
  if (application !== null) return `@${application[1]}'s application was ${application[2] === '批准' ? 'approved' : 'rejected'}.`
  const connected = /^已接入 (\d+) 个仓库。$/.exec(message)
  if (connected !== null) return `Connected ${connected[1]} ${connected[1] === '1' ? 'repository' : 'repositories'}.`
  const fork = /^已创建 fork (.+)。$/.exec(message)
  if (fork !== null) return `Created fork ${fork[1]}.`
  const mailFailed = /^测试邮件发送失败：(.+)$/.exec(message)
  if (mailFailed !== null) return `Test email failed: ${mailFailed[1]}`
  const connectFailed = /^连接失败：(.+)$/.exec(message)
  if (connectFailed !== null) return `Connection failed: ${connectFailed[1]}`
  const modelHttp = /^模型服务返回 HTTP (\d+)：(.+)$/.exec(message)
  if (modelHttp !== null) return `The model service returned HTTP ${modelHttp[1]}: ${modelHttp[2]}`
  return MESSAGES[message] ?? message
}

declare module 'fastify' {
  interface FastifyRequest {
    locale?: Locale
  }
}
