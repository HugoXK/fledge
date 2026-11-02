import type { UserRow } from '../db.js'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}

export function applicationEmail(user: UserRow, approveUrl: string, rejectUrl: string, baseUrl: string, position: number | null): { subject: string; text: string; html: string } {
  const who = user.name === null || user.name === '' ? user.login : `${user.name} (@${user.login})`
  const subject = `[Fledge] 权限申请：${user.login}`
  const text = [
    '有人在 Fledge 申请接入仓库自迭代。',
    '',
    `GitHub：${who}`,
    `邮箱：${user.email ?? '（未公开）'}`,
    `主页：https://github.com/${user.login}`,
    `签署：${user.disclaimer_name ?? user.login}`,
    `提交时间：${user.application_submitted_at ?? user.created_at}`,
    `排队：第 ${position ?? '?'} 位`,
    `IP：${user.application_ip ?? '—'}`,
    '',
    `批准：${approveUrl}`,
    `拒绝：${rejectUrl}`,
    '',
    `两个链接均为一次性，7 天内有效。也可以登录 ${baseUrl} 在 Admin 面板处理。`,
  ].join('\n')
  const html = `<p>有人在 <strong>Fledge</strong> 申请接入仓库自迭代。</p>
<ul>
  <li>GitHub：<strong>${escapeHtml(who)}</strong></li>
  <li>邮箱：${escapeHtml(user.email ?? '（未公开）')}</li>
  <li>主页：<a href="https://github.com/${escapeHtml(user.login)}">github.com/${escapeHtml(user.login)}</a></li>
  <li>签署：${escapeHtml(user.disclaimer_name ?? user.login)}</li>
  <li>提交时间：${escapeHtml(user.application_submitted_at ?? user.created_at)}</li>
  <li>排队：第 ${position ?? '?'} 位</li>
  <li>IP：${escapeHtml(user.application_ip ?? '—')}</li>
</ul>
<p><a href="${escapeHtml(approveUrl)}">批准</a> · <a href="${escapeHtml(rejectUrl)}">拒绝</a></p>
<p>两个链接均为一次性，7 天内有效。</p>`
  return { subject, text, html }
}

export function applicationReceivedEmail(user: UserRow, position: number | null): { subject: string; text: string } {
  return {
    subject: '[Fledge] 申请已收到',
    text: [
      `@${user.login}，你好：`,
      '',
      '你的 Fledge 访问申请已经收到。',
      `排队位置：第 ${position ?? '—'} 位。`,
      '管理员审批后会再发一封通知；请不要重复提交，排队状态可以在申请页查看。',
      '',
      '注意：Fledge 的审批只覆盖 Fledge，不代表获得 FlyBot、Bot Social 或 ScienceDiscovery 的权限。',
    ].join('\n'),
  }
}

export function approvedEmail(user: UserRow, baseUrl: string): { subject: string; text: string } {
  return {
    subject: '[Fledge] 你的访问申请已通过',
    text: [
      `@${user.login}，你好：`,
      '',
      '你的 Fledge 访问申请已经通过。登录后可以：',
      '· 绑定一个或多个 GitHub 仓库（提供 fine-grained token）；',
      '· 让 FlyBot 持续分析、提交变更并开 PR；',
      '· 平台初始额度 1 元，用完后在设置里配置你自己的模型 API。',
      '',
      'Fledge 的批准只覆盖 Fledge；FlyBot、Bot Social 和 ScienceDiscovery 需要分别授权。',
      '',
      `登录：${baseUrl}`,
    ].join('\n'),
  }
}

export function rejectedEmail(user: UserRow, reason: string): { subject: string; text: string } {
  return {
    subject: '[Fledge] 你的访问申请未通过',
    text: [`@${user.login}，你好：`, '', '这次申请没有通过。', reason === '' ? '' : `原因：${reason}`, '', '如果情况有变化，可以稍后重新申请。'].join('\n'),
  }
}

export function quotaExhaustedEmail(user: UserRow, baseUrl: string): { subject: string; text: string } {
  return {
    subject: '[Fledge] 平台额度已用完，请配置自己的模型 API',
    text: [
      `@${user.login}，你好：`,
      '',
      '你的 1 元平台初始额度已经用完，平台不会再替你调用模型。',
      '请到 Settings → Model 填入你自己的 OpenAI 兼容服务（Base URL / Key / Model），然后重新运行仓库任务。',
      '',
      `登录：${baseUrl}/settings`,
    ].join('\n'),
  }
}

export interface JobMailContext {
  repo: string
  jobId: string
  kind: string
  teamUrl: string
  issueUrl: string | null
  prUrl: string | null
  summary: string
  error: string
  reviewScore: number | null
}

function mailFooter(): string {
  return 'Fledge · powered by FlyBot'
}

function linkLine(label: string, url: string | null): string {
  return url === null || url === '' ? `${label}：—` : `${label}：${url}`
}

export function jobSucceededEmail(user: UserRow, context: JobMailContext): { subject: string; text: string; html: string } {
  const review = context.kind === 'review'
  const score = context.reviewScore === null ? '' : `评分：${context.reviewScore}/100`
  const subject = review ? `[Fledge] 审核完成：${context.repo}` : `[Fledge] 任务完成：${context.repo}`
  const text = [
    `@${user.login}，你好：`,
    '',
    review ? `${context.repo} 的审核任务已完成。` : `${context.repo} 的任务已完成。`,
    score,
    '',
    `任务：${context.jobId}`,
    linkLine('Issue', context.issueUrl),
    linkLine('PR', context.prUrl),
    '',
    context.summary === '' ? '' : `摘要：${context.summary}`,
    '',
    'Fledge 不会自动合并；请到 GitHub review 后由你决定是否 merge。',
    '',
    `团队工作台：${context.teamUrl}`,
    '',
    mailFooter(),
  ].filter((line) => line !== '').join('\n')
  const html = `<p>@${escapeHtml(user.login)}，你好：</p>
<p>${escapeHtml(review ? `${context.repo} 的审核任务已完成。` : `${context.repo} 的任务已完成。`)}${score === '' ? '' : ` ${escapeHtml(score)}`}</p>
<ul>
  <li>任务：<code>${escapeHtml(context.jobId)}</code></li>
  <li>Issue：${context.issueUrl === null ? '—' : `<a href="${escapeHtml(context.issueUrl)}">${escapeHtml(context.issueUrl)}</a>`}</li>
  <li>PR：${context.prUrl === null ? '—' : `<a href="${escapeHtml(context.prUrl)}">${escapeHtml(context.prUrl)}</a>`}</li>
</ul>
${context.summary === '' ? '' : `<p>${escapeHtml(context.summary)}</p>`}
<p>Fledge 不会自动合并；请到 GitHub review 后由你决定是否 merge。</p>
<p><a href="${escapeHtml(context.teamUrl)}">打开团队工作台</a></p>
<p><small>${escapeHtml(mailFooter())}</small></p>`
  return { subject, text, html }
}

export function jobFailedEmail(user: UserRow, context: JobMailContext): { subject: string; text: string; html: string } {
  const subject = context.kind === 'review' ? `[Fledge] 审核失败：${context.repo}` : `[Fledge] 任务失败：${context.repo}`
  const text = [
    `@${user.login}，你好：`,
    '',
    `${context.repo} 的${context.kind === 'review' ? '审核' : '任务'}没有完成。`,
    '',
    `任务：${context.jobId}`,
    context.error === '' ? '' : `原因：${context.error}`,
    linkLine('Issue', context.issueUrl),
    linkLine('PR', context.prUrl),
    '',
    '可以在团队工作台查看最后进度，修正后重新运行；Fledge 不会自动合并。',
    '',
    `团队工作台：${context.teamUrl}`,
    '',
    mailFooter(),
  ].filter((line) => line !== '').join('\n')
  const html = `<p>@${escapeHtml(user.login)}，你好：</p>
<p>${escapeHtml(context.repo)} 的${escapeHtml(context.kind === 'review' ? '审核' : '任务')}没有完成。</p>
<ul>
  <li>任务：<code>${escapeHtml(context.jobId)}</code></li>
  ${context.error === '' ? '' : `<li>原因：${escapeHtml(context.error)}</li>`}
  <li>Issue：${context.issueUrl === null ? '—' : `<a href="${escapeHtml(context.issueUrl)}">${escapeHtml(context.issueUrl)}</a>`}</li>
  <li>PR：${context.prUrl === null ? '—' : `<a href="${escapeHtml(context.prUrl)}">${escapeHtml(context.prUrl)}</a>`}</li>
</ul>
<p>可以在团队工作台查看最后进度，修正后重新运行；Fledge 不会自动合并。</p>
<p><a href="${escapeHtml(context.teamUrl)}">打开团队工作台</a></p>
<p><small>${escapeHtml(mailFooter())}</small></p>`
  return { subject, text, html }
}

export function jobAttentionEmail(user: UserRow, input: { repo: string; question: string; detail: string; options: string[]; teamUrl: string }): { subject: string; text: string; html: string } {
  const subject = `[Fledge] 团队需要你回答：${input.repo}`
  const options = input.options.length === 0 ? [] : ['可选答案：', ...input.options.map((option) => `· ${option}`)]
  const text = [
    `@${user.login}，你好：`,
    '',
    `${input.repo} 的团队在等你回答一个问题：`,
    '',
    input.question,
    input.detail === '' ? '' : input.detail,
    ...options,
    '',
    `在团队工作台回答：${input.teamUrl}`,
    '',
    '如果不回答，任务可能停在当前步骤。',
    '',
    mailFooter(),
  ].filter((line) => line !== '').join('\n')
  const html = `<p>@${escapeHtml(user.login)}，你好：</p>
<p>${escapeHtml(input.repo)} 的团队在等你回答一个问题：</p>
<blockquote>${escapeHtml(input.question)}${input.detail === '' ? '' : `<br /><small>${escapeHtml(input.detail)}</small>`}</blockquote>
${input.options.length === 0 ? '' : `<ul>${input.options.map((option) => `<li>${escapeHtml(option)}</li>`).join('')}</ul>`}
<p><a href="${escapeHtml(input.teamUrl)}">打开团队工作台回答</a></p>
<p>如果不回答，任务可能停在当前步骤。</p>
<p><small>${escapeHtml(mailFooter())}</small></p>`
  return { subject, text, html }
}
