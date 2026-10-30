export const AGREEMENT_VERSION = '2026-10-30'

export const DISCLAIMER_TITLE = '免责声明'
export const SECURITY_TITLE = '信息安全承诺'

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

import { createHash } from 'node:crypto'

export function agreementHash(disclaimer = DISCLAIMER_TEXT, security = SECURITY_TEXT): string {
  return `${AGREEMENT_VERSION}:${createHash('sha256').update(disclaimer + '\n---\n' + security).digest('hex').slice(0, 32)}`
}
