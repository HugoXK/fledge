import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import type { Config } from '../config.js'
import type { RepoInstanceRow, RepoRow, Store } from '../db.js'
import { log } from '../lib/log.js'
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../lib/secrets.js'
import { nowIso } from '../lib/time.js'

const execFileAsync = promisify(execFile)

export interface RepoTeam {
  chief: string
  lead: string
  product: string
  test: string
  security: string
  reviewer: string | null
  dev1: string
  dev2: string
  reviewerScope: 'upstream' | 'self' | 'none'
  team: string
}

export interface InstanceBridge {
  url: string
  token: string
  team: RepoTeam
  instance: RepoInstanceRow
}

export function parseTeam(value: string | null): RepoTeam | null {
  if (value === null || value === '') return null
  try {
    const parsed = JSON.parse(value) as Partial<RepoTeam>
    if (typeof parsed.chief !== 'string' || typeof parsed.lead !== 'string') return null
    return {
      chief: parsed.chief,
      lead: parsed.lead,
      product: typeof parsed.product === 'string' ? parsed.product : '',
      test: typeof parsed.test === 'string' ? parsed.test : '',
      security: typeof parsed.security === 'string' ? parsed.security : '',
      reviewer: typeof parsed.reviewer === 'string' ? parsed.reviewer : null,
      dev1: typeof parsed.dev1 === 'string' ? parsed.dev1 : '',
      dev2: typeof parsed.dev2 === 'string' ? parsed.dev2 : '',
      reviewerScope: parsed.reviewerScope === 'upstream' || parsed.reviewerScope === 'self' ? parsed.reviewerScope : 'none',
      team: typeof parsed.team === 'string' ? parsed.team : 'repo',
    }
  } catch {
    return null
  }
}

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo'
}

function yaml(value: string): string {
  return JSON.stringify(value)
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function freePort(start: number, used: Set<number>): Promise<number> {
  if (!Number.isInteger(start) || start < 1024 || start > 65_000) throw new Error(`无效的端口起点：${start}`)
  for (let port = start; port < start + 2000; port += 1) {
    if (used.has(port)) continue
    if (await isFree(port)) return port
  }
  throw new Error(`端口段 ${start} 附近没有空闲端口`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class InstanceManager {
  constructor(
    private readonly store: Store,
    private readonly config: Config,
  ) {}

  userDir(userId: string): string {
    return join(this.config.flybot.instanceRoot, 'users', safe(userId))
  }

  repoDir(userId: string, repoId: string): string {
    return join(this.userDir(userId), 'repos', safe(repoId))
  }

  ensureUserDir(userId: string): string {
    const dir = this.userDir(userId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  }

  private async docker(args: string[], timeout = 120_000): Promise<string> {
    const { stdout } = await execFileAsync('docker', args, { timeout, maxBuffer: 16 * 1024 * 1024 })
    return stdout.trim()
  }

  private async usedPorts(): Promise<Set<number>> {
    const used = new Set<number>()
    for (const row of this.store.listRepoInstances()) {
      used.add(row.dsh_port)
      used.add(row.bridge_port)
      used.add(row.model_port)
    }
    return used
  }

  async provision(repo: RepoRow): Promise<void> {
    if (this.config.flybot.instanceImage === '') throw new Error('FLYBOT_INSTANCE_IMAGE 未配置')
    const existing = this.store.getRepoInstance(repo.id)
    if (existing !== undefined && (existing.status === 'ready' || existing.status === 'provisioning' || existing.status === 'starting')) return
    const user = this.store.userById(repo.user_id)
    if (user === undefined) throw new Error('用户不存在')

    const tag = safe(repo.id)
    const container = `fledge-flybot-${tag}`
    const network = `${this.config.flybot.networkPrefix}-${tag}`
    const dir = this.repoDir(repo.user_id, repo.id)
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dataDir, 'tcp-proxy.mjs'), `import net from 'node:net'
const server = net.createServer((client) => {
  const upstream = net.connect(3080, '127.0.0.1')
  client.pipe(upstream).pipe(client)
  client.on('error', () => upstream.destroy())
  upstream.on('error', () => client.destroy())
})
server.listen(3081, '0.0.0.0')
`, { mode: 0o600 })
    this.ensureUserDir(repo.user_id)

    const used = await this.usedPorts()
    const dshPort = await freePort(this.config.flybot.dshPortStart, used)
    used.add(dshPort)
    const bridgePort = await freePort(this.config.flybot.bridgePortStart, used)
    used.add(bridgePort)
    const modelPort = await freePort(this.config.flybot.modelPortStart, used)

    try {
      await this.docker(['network', 'inspect', network]).catch(async () => {
        await this.docker(['network', 'create', '--label', 'fledge.flybot=1', network])
      })
      const modelBind = await this.docker(['network', 'inspect', network, '--format', '{{(index .IPAM.Config 0).Gateway}}'])
      if (modelBind === '') throw new Error('无法取得 Docker 网络网关地址')

      const gatewayToken = `flg_${randomToken(32)}`
      const bridgeToken = randomToken(32)
      const modelKey = randomToken(24)
      for (const token of this.store.listApiTokens(user.id)) {
        if (token.kind === 'instance' && token.name === `flybot:${repo.id}` && token.revoked_at === null) {
          this.store.revokeApiToken(token.id, user.id)
        }
      }
      this.store.createApiToken({
        id: `tok_${randomToken(8)}`,
        userId: user.id,
        kind: 'instance',
        name: `flybot:${repo.id}`,
        tokenHash: sha256Hex(gatewayToken),
        prefix: gatewayToken.slice(0, 8),
        expiresAt: null,
      })

      const profileDir = join(dataDir, 'profiles', 'web')
      mkdirSync(profileDir, { recursive: true, mode: 0o700 })
      const model = this.config.flybot.model
      const patch = [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      fledge:',
        '        displayName: Fledge',
        '        api: openai-completions',
        `        baseURL: ${yaml(`http://${modelBind}:${modelPort}/v1`)}`,
        `        apiKey: ${yaml(modelKey)}`,
        '        models:',
        `          - id: ${yaml(model)}`,
        `            name: ${yaml(model)}`,
        '- id: agent-default-model',
        '  config:',
        '    provider: fledge',
        `    model: ${yaml(model)}`,
        '- id: flybot-tree',
        '  config:',
        '    dailyTidy: false',
        '- id: flybot-social',
        '  disabled: true',
      ].join('\n') + '\n'
      writeFileSync(join(profileDir, 'cordis.patch.yml'), patch, { mode: 0o600 })

      const bridgeEnv = {
        BRIDGE_HOST: '127.0.0.1',
        BRIDGE_PORT: String(bridgePort),
        BRIDGE_TOKEN: bridgeToken,
        FLYBOT_CHAT_SESSION_ID: 'provisioning',
        FLYBOT_REVIEW_SESSION_ID: 'provisioning',
        FLYBOT_WEB: `http://127.0.0.1:${dshPort}`,
        FLYBOT_LOG: join(dataDir, 'dsh-web.log'),
        MAX_PROMPT_BYTES: '32768',
        FLEDGE_GATEWAY_ORIGIN: `http://127.0.0.1:${this.config.port}`,
        FLEDGE_GATEWAY_TOKEN: gatewayToken,
        MODEL_PROXY_BIND: modelBind,
        MODEL_PROXY_PORT: String(modelPort),
        MODEL_PROXY_KEY: modelKey,
      }
      const envLines = Object.entries(bridgeEnv).map(([key, value]) => `${key}=${value}`).join('\n') + '\n'
      writeFileSync(join(dir, 'bridge.env'), envLines, { mode: 0o600 })
      chmodSync(join(dir, 'bridge.env'), 0o600)

      const row = this.store.saveRepoInstance({
        repo_id: repo.id,
        user_id: repo.user_id,
        container,
        network,
        data_dir: dataDir,
        bridge_script: this.config.flybot.bridgeScript,
        dsh_port: dshPort,
        bridge_port: bridgePort,
        model_port: modelPort,
        model_bind: modelBind,
        image: this.config.flybot.instanceImage,
        status: 'starting',
        chief_session: null,
        team_json: null,
        bridge_token_enc: encryptSecret(bridgeToken, this.config.tokenEncryptionKey),
        bridge_pid: null,
        log_pid: null,
        last_error: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        last_health_at: null,
      })

      const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
      const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
      writeFileSync(join(dataDir, 'dsh-web.log'), '')
      await this.docker([
        'run', '-d',
        '--name', container,
        '--network', network,
        '-p', `127.0.0.1:${dshPort}:3081`,
        '-v', `${dataDir}:/data`,
        '--user', `${uid}:${gid}`,
        '--memory', this.config.flybot.memory,
        '--cpus', this.config.flybot.cpus,
        '--pids-limit', '512',
        '--security-opt', 'no-new-privileges',
        '--restart', 'no',
        '--entrypoint', '/bin/sh',
        '-e', 'HOME=/data',
        '-e', 'DSH_HOME=/data',
        '-e', 'NPM_CONFIG_REGISTRY=https://registry.npmmirror.com',
        '-e', 'npm_config_registry=https://registry.npmmirror.com',
        this.config.flybot.instanceImage,
        '-c', 'node /opt/flybot/docker/entrypoint.mjs >> /data/dsh-web.log 2>&1 & exec node /data/tcp-proxy.mjs',
      ], 180_000)

      await this.waitForDsh(dshPort, row)
      const bridge = this.startBridge(row, bridgeEnv, join(dataDir, 'bridge.log'))
      this.store.updateRepoInstance(repo.id, { bridge_pid: bridge.pid ?? null })
      await this.waitForBridge(bridgePort, bridgeToken)

      const chief = await this.ensureChief(bridgePort, bridgeToken)
      this.store.updateRepoInstance(repo.id, { chief_session: chief, status: 'provisioning' })
      const team = await this.provisionTeam(repo, bridgePort, bridgeToken, chief)
      this.store.updateRepoInstance(repo.id, {
        status: 'ready',
        team_json: JSON.stringify(team),
        last_health_at: nowIso(),
        updated_at: nowIso(),
        last_error: null,
      })
      this.store.audit(repo.user_id, 'flybot.instance.ready', `${repo.owner}/${repo.name} container=${container} team=${team.team}`)
      log.info('flybot instance ready', { repo: `${repo.owner}/${repo.name}`, container, bridgePort })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.updateRepoInstance(repo.id, { status: 'failed', last_error: message.slice(0, 1000), updated_at: nowIso() })
      this.store.audit(repo.user_id, 'flybot.instance.failed', `${repo.owner}/${repo.name}: ${message.slice(0, 300)}`)
      log.error('flybot instance failed', { repo: `${repo.owner}/${repo.name}`, error: message })
      await this.stop(repo.id, false).catch(() => {})
      throw error
    }
  }

  private startBridge(row: RepoInstanceRow, env: Record<string, string>, logPath: string): ChildProcess {
    const fd = openSync(logPath, 'a', 0o600)
    const child = spawn(process.execPath, [this.config.flybot.bridgeScript], {
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    child.unref()
    return child
  }

  private async waitForDsh(_port: number, row: RepoInstanceRow): Promise<void> {
    const deadline = Date.now() + 180_000
    const logPath = join(row.data_dir, 'dsh-web.log')
    while (Date.now() < deadline) {
      try {
        if (existsSync(logPath) && /token=([A-Za-z0-9_-]+)/.test(readFileSync(logPath, 'utf8'))) {
          await sleep(1_000)
          return
        }
      } catch {}
      await sleep(2_000)
    }
    throw new Error(`FlyBot DSH 在 180 秒内没有就绪（${row.container}）`)
  }

  private async waitForBridge(port: number, token: string): Promise<void> {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2_000) })
        if (response.ok) return
      } catch {}
      await sleep(500)
    }
    throw new Error('FlyBot bridge 没有就绪')
  }

  private async dsh(port: number, token: string, endpoint: string, payload: unknown = {}): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${port}/dsh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint, payload }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) throw new Error(`bridge /dsh ${response.status}: ${(await response.text()).slice(0, 300)}`)
    return response.json()
  }

  private async state(port: number, token: string): Promise<{ bots: Array<Record<string, unknown>>; mainBotId?: string }> {
    const raw = await this.dsh(port, token, 'state', {})
    const value = (raw as { value?: Record<string, unknown> }).value ?? (raw as Record<string, unknown>)
    return {
      bots: Array.isArray(value.bots) ? (value.bots as Array<Record<string, unknown>>) : [],
      mainBotId: typeof value.mainBotId === 'string' ? value.mainBotId : undefined,
    }
  }

  private async ensureChief(port: number, token: string): Promise<string> {
    let state = await this.state(port, token)
    let main = state.bots.find((bot) => bot.id === state.mainBotId)
    if (main === undefined) {
      const created = await this.dsh(port, token, 'create-bot', {
        name: 'Chief',
        role: 'Chief of Staff',
        instructions: 'You lead this repository team. Break work into a small number of clear tasks, delegate to the Lead, and never merge or change repository settings.',
      })
      const bot = ((created as { value?: Record<string, unknown> }).value ?? created) as Record<string, unknown>
      if (typeof bot.id !== 'string') throw new Error('DSH 没有返回 Chief id')
      await this.dsh(port, token, 'set-main', { id: bot.id, main: true, primary: true })
      state = await this.state(port, token)
      main = state.bots.find((entry) => entry.id === bot.id) ?? bot
    }
    if (typeof main.id !== 'string') throw new Error('找不到 Chief')
    await this.dsh(port, token, 'update-bot', {
      id: main.id,
      name: 'Chief',
      role: 'Chief of Staff',
      instructions: 'You are the Chief of this repository team. Turn the Fledge goal into a small number of clear tasks for the Lead. Never merge, never push directly, and ask a human for irreversible decisions.',
    }).catch(() => {})
    const refreshed = await this.state(port, token)
    const chief = refreshed.bots.find((entry) => entry.id === main.id)
    const session = chief?.sessionId ?? main.sessionId
    if (typeof session !== 'string') throw new Error('Chief 没有 sessionId')
    return session
  }

  private async provisionTeam(repo: RepoRow, port: number, token: string, chief: string): Promise<RepoTeam> {
    const label = repo.upstream_name.slice(0, 30) || 'Repo'
    const reviewerScope: RepoTeam['reviewerScope'] = repo.can_review === 1 ? 'upstream' : 'self'
    const members = [
      `${label} Product: Own the product positioning, competitor gap, acceptance criteria and issue quality.`,
      `${label} Test: Verify changes with tests, reproduce bugs, and report regressions.`,
      `${label} Security: Check secrets, permissions, injection, supply chain and abuse risks.`,
      `${label} Reviewer: Review pull requests, score them 0-100 with a clear rationale, and post a COMMENT review. Never approve or merge.`,
      `${label} Dev-1: Implement focused changes, one issue at a time, with tests.`,
      `${label} Dev-2: Implement focused changes, one issue at a time, with tests.`,
    ]
    const prompt = [
      'Fledge provisioning request. Do not write code, push, merge or open pull requests.',
      `Create a team for the repository ${repo.upstream_owner}/${repo.upstream_name} using the create_team tool exactly once.`,
      `Team name: ${label}`,
      'Members (use these exact names and roles):',
      ...members.map((entry) => `- ${entry}`),
      `The Lead is created automatically as "${label} Lead".`,
      `Reviewer scope: ${reviewerScope}.`,
      'Do not start work. Reply with the team tree.',
    ].join('\n')
    await this.dsh(port, token, 'send', { sessionId: chief, text: prompt })
    const deadline = Date.now() + this.config.flybot.teamTimeoutSeconds * 1000
    const wanted = [`${label} Lead`, `${label} Product`, `${label} Test`, `${label} Security`, `${label} Reviewer`, `${label} Dev-1`, `${label} Dev-2`]
    while (Date.now() < deadline) {
      await sleep(2_000)
      const state = await this.state(port, token)
      const byName = new Map(state.bots.map((bot) => [String(bot.name ?? ''), bot]))
      if (wanted.every((name) => byName.has(name))) {
        const session = (name: string): string => {
          const value = byName.get(name)?.sessionId
          if (typeof value !== 'string') throw new Error(`团队角色 ${name} 没有 sessionId`)
          return value
        }
        return {
          chief,
          lead: session(`${label} Lead`),
          product: session(`${label} Product`),
          test: session(`${label} Test`),
          security: session(`${label} Security`),
          reviewer: session(`${label} Reviewer`),
          dev1: session(`${label} Dev-1`),
          dev2: session(`${label} Dev-2`),
          reviewerScope,
          team: label,
        }
      }
    }
    throw new Error(`团队在 ${this.config.flybot.teamTimeoutSeconds} 秒内没有创建完成`)
  }

  bridgeFor(repoId: string): InstanceBridge {
    const instance = this.store.getRepoInstance(repoId)
    if (instance === undefined) throw new Error('FlyBot 实例尚未创建')
    if (instance.status !== 'ready') throw new Error(`FlyBot 实例状态：${instance.status}`)
    const team = parseTeam(instance.team_json)
    if (team === null) throw new Error('FlyBot 团队尚未就绪')
    if (instance.bridge_token_enc === null) throw new Error('FlyBot bridge token 缺失')
    return {
      url: `http://127.0.0.1:${instance.bridge_port}/run`,
      token: decryptSecret(instance.bridge_token_enc, this.config.tokenEncryptionKey),
      team,
      instance,
    }
  }

  async stop(repoId: string, update = true): Promise<void> {
    const instance = this.store.getRepoInstance(repoId)
    if (instance === undefined) return
    for (const pid of [instance.bridge_pid, instance.log_pid]) {
      if (pid !== null && pid !== undefined) {
        try { process.kill(pid, 'SIGTERM') } catch {}
      }
    }
    await this.docker(['stop', '-t', '5', instance.container]).catch(() => {})
    await this.docker(['rm', '-f', instance.container]).catch(() => {})
    await this.docker(['network', 'rm', instance.network]).catch(() => {})
    if (update) {
      this.store.updateRepoInstance(repoId, {
        status: 'stopped',
        chief_session: null,
        team_json: null,
        bridge_pid: null,
        log_pid: null,
        updated_at: nowIso(),
      })
    }
  }

  async remove(repoId: string): Promise<void> {
    const instance = this.store.getRepoInstance(repoId)
    if (instance !== undefined) {
      await this.stop(repoId, false)
      for (const token of this.store.listApiTokens(instance.user_id)) {
        if (token.kind === 'instance' && token.name === `flybot:${repoId}` && token.revoked_at === null) {
          this.store.revokeApiToken(token.id, instance.user_id)
        }
      }
      try { rmSync(instance.data_dir, { recursive: true, force: true }) } catch {}
      this.store.deleteRepoInstance(repoId)
    }
  }
}
