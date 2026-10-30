# Fledge · 羽巢

**让仓库自己长大。**

Fledge 是一个自托管的小平台：开发者一次性接入多个 GitHub 仓库，FlyBot
代理会持续阅读代码、先写一个失败的测试、做最小修复，然后开一个你可以审查的
PR。它不会直接推默认分支，也不会自动合并。

[English](README.md) · [架构](docs/architecture.md) · [部署](docs/deploy.md) · [安全](docs/security.md) · [路线图](docs/roadmap.md)

---

## 名字的来历

Fledge 是幼鸟长齐飞羽、离巢试飞的那一刻。它不是被推下去的，而是准备好了。
这正是产品对仓库的承诺：仓库留在你的账号里、在你的审查之下，逐步学会自己
产出改进。候选名字与取舍见 [docs/decisions/0001-name.md](docs/decisions/0001-name.md)。

## 功能

- **GitHub 登录 + 审批**：首次登录生成待审批申请，通过 `flybot@yeah.net`
  发邮件到 `hugo2001xk@gmail.com`。管理员点邮件链接或在 Admin 面板批准。
- **一个账号多个仓库**：每个仓库有独立目标、节奏（手动/每小时/每天/每周）和
  状态。
- **自带 GitHub token**：fine-grained token 会先验证仓库写权限，再用
  AES-256-GCM 加密保存；只在任务运行时解密。
- **FlyBot 自迭代**：平台创建任务，把「一次性凭据 URL」和「任务级模型 token」
  交给 FlyBot bridge；FlyBot 在自己的工作区里改代码、开 PR，再回调平台。
- **每个用户 1 元平台额度**：平台代付的请求走 Fledge 的 OpenAI 兼容网关，
  按真实成本计量；用完返回结构化 `quota_exhausted`。
- **自带模型**：额度用完后，用户可以在设置里填任意 OpenAI 兼容服务
  （Base URL / Key / Model），任务继续跑，平台不再扣额度。
- **天然可审查**：一个任务一个聚焦 PR，不 force-push、不合并，所有状态变更
  写审计日志。

## 架构

```
浏览器 ──cookie session──► Fledge (Fastify + SQLite)
                            │
                            ├─ GitHub API（OAuth、验证仓库、开 PR）
                            ├─ SMTP（flybot@yeah.net → 管理员）
                            ├─ /v1/chat/completions ──► 模型路由 ──► 提供方
                            │        （按用户计费、读取成本头）
                            └─ 任务队列 ──► FlyBot bridge ──► FlyBot 代理
                                                 │
                                                 ├─ GET 凭据（任务级签名）
                                                 └─ POST 回调（任务级签名）
```

平台不会在用户仓库里执行 shell。真正改代码的是 FlyBot 代理，Fledge 只负责
编排、计量和记录。

## 快速开始

要求 Node 22.9+（需要 `node:sqlite`）和 npm 10+。

```sh
npm ci
cp .env.example .env

# 生成两个密钥
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('TOKEN_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))"

npm run dev
# http://localhost:8080
```

把 `ADMIN_GITHUB_LOGIN` 设成你的 GitHub 登录名（默认 `HugoXK`）。管理员首次
登录自动通过；其他人是 pending，需要批准。

本地没有 SMTP 时用 console 邮件：待审批登录后执行 `npm run mail:outbox`，
会打印最新邮件和批准/拒绝链接。

### GitHub OAuth App

在 <https://github.com/settings/developers> 新建 OAuth App：

- Homepage: `http://localhost:8080`（或公网地址）
- Callback: `http://localhost:8080/auth/github/callback`

把 client id/secret 填进 `.env`。默认 scope 是 `read:user user:email repo`；
用户加仓库时仍要单独提供 fine-grained token。

### FlyBot bridge

`RUNNER_MODE=mock`（默认）只模拟任务，不碰仓库。要真正自迭代，在 FlyBot
服务器上运行 bridge：

```sh
BRIDGE_TOKEN=... FLYBOT_CHAT_SESSION_ID=session-... node bridge/flybot-bridge.mjs
```

然后在 Fledge 里设 `RUNNER_MODE=flybot`、`FLYBOT_BRIDGE_URL`、
`FLYBOT_BRIDGE_TOKEN`。详见 [bridge/README.md](bridge/README.md)。

## 额度口径

- 新用户初始 **1 元**（`INITIAL_QUOTA_CNY`）。
- 成本优先读 `x-litellm-response-cost`（USD），否则按
  `PLATFORM_LLM_PRICE_PER_TOKEN` × token 数估算。
- 剩余人民币 = `quota_cny - used_usd * USD_CNY_RATE`。
- 归零时网关返回 HTTP 402，`code: FLEDGE_QUOTA_EXHAUSTED`，并提示去
  `Settings → Model` 配置自己的模型。
- 用户配置了自己的模型后，网关直接代理到该服务，不再扣平台额度。

细节：[docs/quota.md](docs/quota.md)。

## 开发

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run check        # lint + typecheck + test + build
```

测试使用 `node:test`、内存 SQLite、假 GitHub 和假模型上游，不需要网络。

## 部署

最短路径是 Docker：

```sh
cp .env.example .env
# 填密钥、OAuth App、SMTP、模型
docker compose up -d --build
```

也可以 `npm ci && npm run build && npm start`，前面放 nginx。数据目录里有
SQLite 和开发邮件 outbox；用 `npm run db:backup` 备份。详见
[docs/deploy.md](docs/deploy.md)。

## 安全

- GitHub token 和用户模型 key 加密落盘（AES-256-GCM）。
- Session 是 HttpOnly、SameSite=Lax cookie；所有表单有 CSRF token。
- 审批链接一次性、7 天过期。
- 用户模型 Base URL 做 SSRF 检查（拒绝内网），公网必须 HTTPS。
- 日志脱敏；已保存的 token 不会回显。
- 网关按 `flg_` token 识别用户并独立计量。

漏洞请私信报告，见 [SECURITY.md](SECURITY.md)。

## 状态

`v0.1.0` 是第一条可用的竖切：登录、审批邮件、多仓库、加密 token、
mock/FlyBot runner、额度网关、自带模型、Admin、审计、Docker 和测试。
路线图包括 GitHub App、按仓库预算、团队角色和 worker pool。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
