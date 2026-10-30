import type { UserRow } from '../db.js'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}

export function applicationEmail(user: UserRow, approveUrl: string, rejectUrl: string, baseUrl: string): { subject: string; text: string; html: string } {
  const who = user.name === null || user.name === '' ? user.login : `${user.name} (@${user.login})`
  const subject = `[Fledge] 权限申请：${user.login}`
  const text = [
    '有人在 Fledge 申请接入仓库自迭代。',
    '',
    `GitHub：${who}`,
    `邮箱：${user.email ?? '（未公开）'}`,
    `主页：https://github.com/${user.login}`,
    `申请时间：${user.created_at}`,
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
  <li>申请时间：${escapeHtml(user.created_at)}</li>
</ul>
<p><a href="${escapeHtml(approveUrl)}">批准</a> · <a href="${escapeHtml(rejectUrl)}">拒绝</a></p>
<p>两个链接均为一次性，7 天内有效。</p>`
  return { subject, text, html }
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
