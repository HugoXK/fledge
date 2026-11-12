import { createHash } from 'node:crypto'
import type { Locale } from '../i18n.js'

export const AGREEMENT_VERSION = '2026-10-30'

export const DISCLAIMER_TITLE = '免责声明'
export const SECURITY_TITLE = '信息安全承诺'
export const DISCLAIMER_TITLE_EN = 'Disclaimer'
export const SECURITY_TITLE_EN = 'Information Security Commitment'

export const DISCLAIMER_TEXT = `Fledge 是实验性平台，模型生成的代码、测试和 PR 可能不完整、不正确，也可能引入安全或合规问题。

1. 你对自己接入的仓库、分支、PR 和合并决定负责；合并前必须自行审查、运行测试并确认影响。
2. 平台不保证可用性、连续性、正确性或适合特定用途；因使用或无法使用平台造成的损失，由使用者自行承担。
3. 不要接入生产环境密钥、客户数据、未授权的私有代码或其他敏感资产。你应使用最小权限的 fine-grained token。
4. 你应遵守 GitHub 服务条款、仓库所在组织的政策以及适用法律。`

export const SECURITY_TEXT = `接入 Fledge 前，请确认以下信息安全要求：

1. 只为目标仓库创建最小权限的 fine-grained token（Contents 读写、Pull requests 读写、Metadata 读取），不要使用全权限 PAT。
2. 不要在仓库、issue、PR、提示词或测试数据中放入 API key、密码、cookie、私钥或客户个人信息。
3. 发现平台漏洞、越权、额度绕过或数据泄露风险时，请私下报告给管理员，不要在公开渠道披露利用细节。
4. 不尝试绕过登录、审批、额度、隔离或审计；不扫描、不攻击平台或其他用户。
5. 不再使用时，请在 GitHub 撤销对应 token，并在平台删除仓库或撤销 API token。
6. 平台会记录登录、申请、审批、任务、额度与仓库操作的审计信息（含 IP 和 User-Agent 的必要字段），用于安全与计费。`

export const DISCLAIMER_TEXT_EN = `Fledge is an experimental platform. Model-generated code, tests and pull requests may be incomplete, incorrect, or introduce security or compliance issues.

1. You are responsible for the repositories, branches, pull requests and merge decisions you connect. Review the changes, run the tests and confirm the impact before merging.
2. The platform does not guarantee availability, continuity, correctness or fitness for a particular purpose. Losses caused by using or being unable to use the platform are borne by the user.
3. Do not connect production credentials, customer data, unauthorized private code or other sensitive assets. Use a least-privilege fine-grained token.
4. You must comply with the GitHub Terms of Service, the policies of the repository's organization and applicable law.`

export const SECURITY_TEXT_EN = `Before connecting Fledge, confirm the following information-security requirements:

1. Create a least-privilege fine-grained token for the target repository only (Contents read/write, Pull requests read/write, Metadata read). Do not use a full-access PAT.
2. Do not put API keys, passwords, cookies, private keys or customer personal data in repositories, issues, pull requests, prompts or test data.
3. If you find a platform vulnerability, privilege escalation, quota bypass or data leak, report it privately to the administrator; do not disclose exploitation details publicly.
4. Do not attempt to bypass sign-in, approval, quota, isolation or auditing; do not scan or attack the platform or other users.
5. When you stop using the service, revoke the token on GitHub and delete the repository or API token in the platform.
6. The platform records audit information for sign-in, applications, approvals, jobs, quota and repository operations (including the necessary IP and User-Agent fields) for security and billing.`

export interface AgreementContent {
  disclaimerTitle: string
  disclaimerText: string
  securityTitle: string
  securityText: string
}

export function agreementContent(locale: Locale): AgreementContent {
  return locale === 'en'
    ? {
        disclaimerTitle: DISCLAIMER_TITLE_EN,
        disclaimerText: DISCLAIMER_TEXT_EN,
        securityTitle: SECURITY_TITLE_EN,
        securityText: SECURITY_TEXT_EN,
      }
    : {
        disclaimerTitle: DISCLAIMER_TITLE,
        disclaimerText: DISCLAIMER_TEXT,
        securityTitle: SECURITY_TITLE,
        securityText: SECURITY_TEXT,
      }
}

export function agreementHash(disclaimer = DISCLAIMER_TEXT, security = SECURITY_TEXT): string {
  return `${AGREEMENT_VERSION}:${createHash('sha256').update(disclaimer + '\n---\n' + security).digest('hex').slice(0, 32)}`
}

export function agreementHashFor(locale: Locale): string {
  const content = agreementContent(locale)
  return agreementHash(content.disclaimerText, content.securityText)
}
