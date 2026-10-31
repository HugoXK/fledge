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
  return MESSAGES[message] ?? message
}

declare module 'fastify' {
  interface FastifyRequest {
    locale?: Locale
  }
}
