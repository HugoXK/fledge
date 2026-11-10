import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import type { Config } from '../config.js'
import type { RepoInstanceRow, RepoRow, Store } from '../db.js'
import { log } from '../lib/log.js'
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../lib/secrets.js'
import { nowIso } from '../lib/time.js'
import { PLAYBOOK_VERSION, TEAM_ROLES, playbookFingerprint, playbookFor } from './playbook.js'
import { clearWorkspaceCookie, dshCookie } from './workspace.js'
import { readZipText } from '../lib/zip.js'
import { parseChiefTranscript, type ChiefMessage } from '../lib/chiefTranscript.js'

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
  playbook: number
  playbookHash: string
}

export interface TeamBotState {
  role: string
  label: string
  sessionId: string
  name: string
  activity: string
  calls: number
  since: number | null
  tool: string
  step: string
  lastActivityAt: number | null
  disabled: boolean
}

export interface TeamQuestionState {
  id: string
  sessionId: string
  question: string
  detail: string
  options: string[]
  multiSelect: boolean
}

export interface TeamTimelineEntry {
  role: string
  label: string
  at: number
  calls: number
  kind: 'active' | 'ended'
  activity: string
  tool: string
  step: string
}

export interface TeamLiveState {
  bots: TeamBotState[]
  questions: TeamQuestionState[]
  timeline: TeamTimelineEntry[]
  instance: { status: string; container: string }
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
      playbook: typeof parsed.playbook === 'number' ? parsed.playbook : 0,
      playbookHash: typeof parsed.playbookHash === 'string' ? parsed.playbookHash : '',
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

  private readonly provisioning = new Set<string>()
  private readonly transcriptCache = new Map<string, { at: number; messages: ChiefMessage[] }>()

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

  private revokeTokens(repoId: string, userId: string): void {
    for (const token of this.store.listApiTokens(userId)) {
      if (token.kind === 'instance' && token.name === `flybot:${repoId}` && token.revoked_at === null) {
        this.store.revokeApiToken(token.id, userId)
      }
    }
  }

  isProvisioning(repoId: string): boolean {
    return this.provisioning.has(repoId)
  }

  async provision(repo: RepoRow): Promise<void> {
    if (this.provisioning.has(repo.id)) return
    this.provisioning.add(repo.id)
    try {
      await this.provisionUnlocked(repo)
    } finally {
      this.provisioning.delete(repo.id)
    }
  }

  private async provisionUnlocked(repo: RepoRow): Promise<void> {
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
      this.revokeTokens(repo.id, user.id)
      this.store.createApiToken({
        id: `tok_${randomToken(8)}`,
        userId: user.id,
        kind: 'instance',
        name: `flybot:${repo.id}`,
        tokenHash: sha256Hex(gatewayToken),
        prefix: gatewayToken.slice(0, 8),
        repoId: repo.id,
        expiresAt: null,
      })

      const profileDir = join(dataDir, 'profiles', 'web')
      mkdirSync(profileDir, { recursive: true, mode: 0o700 })
      writeFileSync(join(profileDir, 'cordis.patch.yml'), this.modelPatch(repo.id, modelBind, modelPort), { mode: 0o600 })

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
        '-e', `FLEDGE_MODEL_KEY=${modelKey}`,
        this.config.flybot.instanceImage,
        '-c', 'node /opt/flybot/docker/entrypoint.mjs >> /data/dsh-web.log 2>&1 & exec node /data/tcp-proxy.mjs',
      ], 180_000)

      await this.waitForDsh(dshPort, row)
      if (this.store.getRepo(repo.id) === undefined) throw new Error('仓库已删除，停止初始化')
      const bridge = this.startBridge(row, bridgeEnv, join(dataDir, 'bridge.log'))
      this.store.updateRepoInstance(repo.id, { bridge_pid: bridge.pid ?? null })
      await this.waitForBridge(bridgePort)

      const chief = await this.ensureChief(bridgePort, bridgeToken)
      this.store.updateRepoInstance(repo.id, { chief_session: chief, status: 'provisioning' })
      const team = await this.provisionTeam(repo, bridgePort, bridgeToken, chief)
      const applied = await this.applyPlaybook(bridgePort, bridgeToken, team, repo.goal)
      team.playbook = applied ? PLAYBOOK_VERSION : 0
      team.playbookHash = applied ? playbookFingerprint(repo.goal) : ''
      this.store.updateRepoInstance(repo.id, {
        status: 'ready',
        team_json: JSON.stringify(team),
        last_health_at: nowIso(),
        updated_at: nowIso(),
        last_error: null,
      })
      this.store.audit(repo.user_id, 'flybot.instance.ready', `${repo.owner}/${repo.name} container=${container} team=${team.team}`)
      await this.applyBotModels(repo.id).catch((error) => log.warn('bot model assignment after provision failed', { repo: repo.id, error: String(error) }))
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
    const script = row.bridge_script !== '' ? row.bridge_script : this.config.flybot.bridgeScript
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    child.unref()
    try { closeSync(fd) } catch {}
    return child
  }


  modelPatch(repoId: string, modelBind: string, modelPort: number): string {
    const selected = this.store.listRepoModelSelection(repoId)
    const lines = ['- id: llm-pi-ai', '  config:', '    providers:']
    if (selected.length === 0) {
      const model = this.config.flybot.model
      lines.push(
        '      fledge:',
        '        displayName: Fledge',
        '        api: openai-completions',
        `        baseURL: ${yaml(`http://${modelBind}:${modelPort}/v1`)}`,
        '        apiKeyEnv: FLEDGE_MODEL_KEY',
        '        models:',
        `          - id: ${yaml(model)}`,
        `            name: ${yaml(model)}`,
      )
      lines.push('- id: agent-default-model', '  config:', '    provider: fledge', `    model: ${yaml(model)}`)
    } else {
      const providerIds = [...new Set(selected.map((entry) => entry.provider_id))]
      for (const providerId of providerIds) {
        const models = selected.filter((entry) => entry.provider_id === providerId)
        const first = models[0]!
        lines.push(
          `      fledge-${providerId}:`,
          `        displayName: ${yaml(first.provider_label)}`,
          '        api: openai-completions',
          `        baseURL: ${yaml(`http://${modelBind}:${modelPort}/v1`)}`,
          '        apiKeyEnv: FLEDGE_MODEL_KEY',
          '        models:',
        )
        for (const entry of models) {
          lines.push(`          - id: ${yaml(entry.id)}`, `            name: ${yaml(entry.label)}`)
        }
      }
      const preferred = selected.find((entry) => entry.is_default === 1) ?? selected[0]!
      lines.push('- id: agent-default-model', '  config:', `    provider: fledge-${preferred.provider_id}`, `    model: ${yaml(preferred.id)}`)
    }
    lines.push('- id: flybot-tree', '  config:', '    dailyTidy: false', '- id: flybot-social', '  disabled: true')
    return lines.join('\n') + '\n'
  }

  async applyBotModels(repoId: string): Promise<{ updated: number; skipped: string[] }> {
    const instance = this.store.getRepoInstance(repoId)
    if (instance === undefined || instance.status !== 'ready') return { updated: 0, skipped: [] }
    const selectedRows = this.store.listRepoModelSelection(repoId)
    if (selectedRows.length === 0) return { updated: 0, skipped: [] }
    const selected = new Map(selectedRows.map((model) => [model.id, model]))
    const defaultModel = selectedRows.find((model) => model.is_default === 1) ?? selectedRows[0]!
    const mappings = new Map(this.store.listRepoBotModels(repoId).map((mapping) => [mapping.role, mapping.provider_model_id]))
    const token = decryptSecret(instance.bridge_token_enc ?? '', this.config.tokenEncryptionKey)
    const state = await this.state(instance.bridge_port, token)
    const suffix: Record<string, string> = { lead: 'Lead', product: 'Product', test: 'Test', security: 'Security', reviewer: 'Reviewer', dev1: 'Dev-1', dev2: 'Dev-2' }
    let updated = 0
    const skipped: string[] = []
    for (const bot of state.bots) {
      const name = String(bot.name ?? '')
      const role = name === 'Chief' ? 'chief' : Object.entries(suffix).find(([, label]) => name.endsWith(` ${label}`))?.[0]
      if (role === undefined || typeof bot.id !== 'string') continue
      const mapping = mappings.get(role)
      const model = mapping === undefined ? defaultModel : selected.get(mapping)
      if (model === undefined) {
        skipped.push(role)
        continue
      }
      const alias = `fledge-${model.provider_id}/${model.id}`
      if (bot.model === alias) continue
      try {
        await this.dsh(instance.bridge_port, token, 'update-bot', { id: bot.id, model: alias })
        updated += 1
      } catch (error) {
        skipped.push(role)
        log.warn('bot model update failed', { repo: repoId, role, error: String(error) })
      }
    }
    this.store.audit(instance.user_id, 'flybot.bot_models.applied', `${repoId} updated=${updated} skipped=${skipped.join(',')}`)
    return { updated, skipped }
  }

  async applyModels(repoId: string): Promise<{ ok: boolean; code?: string; error?: string }> {
    const instance = this.store.getRepoInstance(repoId)
    if (instance === undefined || instance.status !== 'ready') return { ok: false, code: 'INSTANCE_NOT_READY', error: '实例尚未就绪。' }
    if (this.store.activeJobForRepo(repoId) !== undefined) return { ok: false, code: 'JOB_ACTIVE', error: '有运行中的任务，完成后才能重启工作区。' }
    const profileDir = join(instance.data_dir, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), this.modelPatch(repoId, instance.model_bind, instance.model_port), { mode: 0o600 })
    writeFileSync(join(instance.data_dir, 'dsh-web.log'), '')
    clearWorkspaceCookie(repoId)
    await this.docker(['restart', '-t', '15', instance.container])
    await this.waitForDsh(instance.dsh_port, instance)
    let assignment: { updated: number; skipped: string[] }
    try {
      assignment = await this.applyBotModels(repoId)
    } catch (error) {
      this.store.updateRepo(repoId, { models_dirty: 1 })
      this.store.audit(instance.user_id, 'flybot.bot_models.failed', `${repoId}: ${String(error).slice(0, 300)}`)
      return { ok: false, code: 'BOT_MODEL_ASSIGNMENT_FAILED', error: `模型配置已写入，但机器人模型更新失败：${String(error).slice(0, 200)}` }
    }
    if (assignment.skipped.length > 0) {
      this.store.updateRepo(repoId, { models_dirty: 1 })
      this.store.audit(instance.user_id, 'flybot.bot_models.failed', `${repoId} skipped=${assignment.skipped.join(',')}`)
      return { ok: false, code: 'BOT_MODEL_ASSIGNMENT_FAILED', error: `机器人模型未全部更新：${assignment.skipped.join(', ')}` }
    }
    this.store.markRepoModelsApplied(repoId)
    this.store.audit(instance.user_id, 'flybot.models.applied', `${repoId} models=${this.store.listRepoModelSelection(repoId).length} bots=${assignment.updated}`)
    log.info('models applied', { repo: repoId, updated: assignment.updated })
    return { ok: true }
  }

  async restartBridge(repoId: string): Promise<void> {
    const instance = this.store.getRepoInstance(repoId)
    if (instance === undefined) return
    if (instance.bridge_pid !== null) {
      try { process.kill(instance.bridge_pid, 'SIGTERM') } catch {}
      await sleep(300)
    }
    const env: Record<string, string> = {}
    const envPath = join(dirname(instance.data_dir), 'bridge.env')
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const index = trimmed.indexOf('=')
      if (index <= 0) continue
      env[trimmed.slice(0, index)] = trimmed.slice(index + 1)
    }
    const child = this.startBridge(instance, env, join(instance.data_dir, 'bridge.log'))
    this.store.updateRepoInstance(repoId, { bridge_pid: child.pid ?? null, updated_at: nowIso() })
    await this.waitForBridge(instance.bridge_port)
    this.store.audit(instance.user_id, 'flybot.bridge.restarted', `${repoId} pid=${child.pid ?? '?'}`)
    log.info('bridge restarted', { repo: repoId, pid: child.pid ?? null })
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

  private async waitForBridge(port: number): Promise<void> {
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

  private async dsh(port: number, token: string, endpoint: string, payload: unknown = {}, timeoutMs = 120_000): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${port}/dsh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint, payload }),
      signal: AbortSignal.timeout(timeoutMs),
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
          playbook: 0,
          playbookHash: '',
        }
      }
    }
    throw new Error(`团队在 ${this.config.flybot.teamTimeoutSeconds} 秒内没有创建完成`)
  }

  private teamSession(team: RepoTeam, role: string): string {
    if (role === 'chief') return team.chief
    if (role === 'lead') return team.lead
    if (role === 'product') return team.product
    if (role === 'test') return team.test
    if (role === 'security') return team.security
    if (role === 'reviewer') return team.reviewer ?? ''
    if (role === 'dev1') return team.dev1
    if (role === 'dev2') return team.dev2
    return ''
  }

  private async applyPlaybook(port: number, token: string, team: RepoTeam, goal: string): Promise<boolean> {
    const state = await this.state(port, token)
    const bySession = new Map<string, Record<string, unknown>>()
    for (const bot of state.bots) {
      if (typeof bot.id === 'string' && bot.id !== '') bySession.set(bot.id, bot)
      if (typeof bot.sessionId === 'string' && bot.sessionId !== '') bySession.set(bot.sessionId, bot)
    }
    let expected = 0
    for (const role of TEAM_ROLES) {
      const sessionId = this.teamSession(team, role)
      if (sessionId === '') continue
      expected += 1
      const bot = bySession.get(sessionId)
      if (bot === undefined || typeof bot.id !== 'string') {
        log.warn('team playbook role missing', { role, sessionId })
        continue
      }
      const payload: Record<string, unknown> = { id: bot.id, instructions: playbookFor(role, team.team, goal) }
      if (typeof bot.name === 'string' && bot.name !== '') payload.name = bot.name
      if (typeof bot.role === 'string' && bot.role !== '') payload.role = bot.role
      await this.dsh(port, token, 'update-bot', payload).catch((error) => {
        log.warn('team playbook update failed', { role, error: String(error) })
      })
    }
    const refreshed = await this.state(port, token)
    const marker = `Fledge team playbook v${PLAYBOOK_VERSION}`
    const applied = refreshed.bots.filter((bot) => typeof bot.instructions === 'string' && bot.instructions.includes(marker)).length
    if (applied < expected) {
      log.warn('team playbook incomplete', { repo: team.team, applied, expected })
      return false
    }
    return true
  }

  async ensurePlaybook(repoId: string): Promise<void> {
    const instance = this.store.getRepoInstance(repoId)
    if (instance === undefined || instance.status !== 'ready' || instance.bridge_token_enc === null) return
    const team = parseTeam(instance.team_json)
    if (team === null) return
    const repo = this.store.getRepo(repoId)
    const goal = repo?.goal ?? ''
    const hash = playbookFingerprint(goal)
    if (team.playbook === PLAYBOOK_VERSION && team.playbookHash === hash) return
    const token = decryptSecret(instance.bridge_token_enc, this.config.tokenEncryptionKey)
    if (!await this.applyPlaybook(instance.bridge_port, token, team, goal)) return
    this.store.updateRepoInstance(repoId, {
      team_json: JSON.stringify({ ...team, playbook: PLAYBOOK_VERSION, playbookHash: hash }),
      updated_at: nowIso(),
    })
    log.info('team playbook applied', { repo: repoId, version: PLAYBOOK_VERSION })
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

  async teamState(repoId: string, timeoutMs = 120_000): Promise<TeamLiveState> {
    const bridge = this.bridgeFor(repoId)
    const repo = this.store.getRepo(repoId)
    const raw = await this.dsh(bridge.instance.bridge_port, bridge.token, 'state', {}, timeoutMs)
    const value = ((raw as { value?: Record<string, unknown> }).value ?? raw) as Record<string, unknown>
    const bots = Array.isArray(value.bots) ? (value.bots as Array<Record<string, unknown>>) : []
    const activity = (value.activity ?? {}) as Record<string, unknown>
    const workRoot = (value.work ?? {}) as Record<string, unknown>
    const work = workRoot.bots as Record<string, { calls?: number; since?: number; tool?: string; step?: string }> | undefined
    const ended = Array.isArray(workRoot.ended) ? workRoot.ended as Array<Record<string, unknown>> : []
    const questions = (value.questions ?? {}) as Record<string, Record<string, unknown>>
    const roleMap: Array<[string, string, string]> = [
      ['chief', 'Chief', bridge.team.chief],
      ['lead', 'Lead', bridge.team.lead],
      ['product', 'Product', bridge.team.product],
      ['test', 'Test', bridge.team.test],
      ['security', 'Security', bridge.team.security],
      ['reviewer', 'Reviewer', bridge.team.reviewer ?? ''],
      ['dev1', 'Dev-1', bridge.team.dev1],
      ['dev2', 'Dev-2', bridge.team.dev2],
    ]
    const roleBySession = new Map(roleMap.map(([role, label, sessionId]) => [sessionId, { role, label }]))
    const lastEnded = (sessionId: string): Record<string, unknown> | undefined => ended
      .filter((entry) => entry !== null && typeof entry === 'object')
      .filter((entry) => entry.sessionId === sessionId)
      .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))[0]
    const timeline: TeamTimelineEntry[] = []
    for (const entry of ended) {
      if (entry === null || typeof entry !== 'object') continue
      const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : ''
      const role = roleBySession.get(sessionId)
      if (role === undefined) continue
      timeline.push({
        role: role.role,
        label: role.label,
        at: Number(entry.at ?? 0),
        calls: Number(entry.calls ?? 0),
        kind: 'ended',
        activity: 'ended',
        tool: '',
        step: '',
      })
    }
    for (const [role, label, sessionId] of roleMap) {
      const current = work?.[sessionId]
      if (current === null || typeof current !== 'object' || typeof current.since !== 'number') continue
      timeline.push({
        role,
        label,
        at: current.since,
        calls: Number(current.calls ?? 0),
        kind: 'active',
        activity: typeof activity[sessionId] === 'string' ? String(activity[sessionId]) : 'idle',
        tool: typeof current.tool === 'string' ? current.tool.slice(0, 160) : '',
        step: typeof current.step === 'string' ? current.step.slice(0, 300) : '',
      })
    }
    timeline.sort((a, b) => b.at - a.at)
    return {
      bots: roleMap.map(([role, label, sessionId]) => {
        const bot = bots.find((entry) => entry !== null && typeof entry === 'object' && entry.sessionId === sessionId)
        const current = work?.[sessionId]
        const endedEntry = lastEnded(sessionId)
        return {
          role,
          label,
          sessionId,
          name: typeof bot?.name === 'string' ? bot.name : label,
          activity: typeof activity[sessionId] === 'string' ? String(activity[sessionId]) : 'idle',
          calls: Number(current?.calls ?? 0),
          since: typeof current?.since === 'number' ? Number(current.since) : null,
          tool: typeof current?.tool === 'string' ? current.tool.slice(0, 160) : '',
          step: typeof current?.step === 'string' ? current.step.slice(0, 300) : '',
          lastActivityAt: typeof current?.since === 'number' ? Number(current.since) : endedEntry === undefined ? null : Number(endedEntry.at ?? 0),
          disabled: role === 'reviewer' && repo?.reviewer_enabled !== 1,
        }
      }),
      questions: Object.entries(questions).map(([sessionId, raw]) => {
        const question = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
        return {
          id: typeof question.id === 'string' ? question.id : '',
          sessionId,
          question: typeof question.question === 'string' ? question.question.slice(0, 500) : '',
          detail: typeof question.detail === 'string' ? question.detail.slice(0, 1000) : '',
          options: Array.isArray(question.options) ? question.options.map((option) => {
            if (typeof option === 'string') return option
            const value = (option !== null && typeof option === 'object' ? option : {}) as Record<string, unknown>
            if (typeof value.label === 'string') return value.label
            return typeof value.value === 'string' ? value.value : ''
          }).filter((value) => value !== '') : [],
          multiSelect: question.multiSelect === true,
        }
      }).filter((question) => question.id !== '' && question.question !== '' && question.sessionId !== '').slice(0, 10),
      timeline: timeline.slice(0, 12),
      instance: { status: bridge.instance.status, container: bridge.instance.container },
    }
  }

  async chiefTranscript(repoId: string, limit = 20): Promise<ChiefMessage[]> {
    const cached = this.transcriptCache.get(repoId)
    if (cached !== undefined && Date.now() - cached.at < 5_000) return cached.messages.slice(-Math.max(1, limit))
    const instance = this.store.getRepoInstance(repoId)
    if (instance === undefined || instance.status !== 'ready') return []
    const team = parseTeam(instance.team_json)
    if (team === null || team.chief === '') return []
    try {
      const cookie = await dshCookie(instance)
      const url = `http://127.0.0.1:${instance.dsh_port}/api/session.export?sessionId=${encodeURIComponent(team.chief)}&includeDescendants=false`
      const response = await fetch(url, { headers: { cookie }, signal: AbortSignal.timeout(8_000) })
      if (!response.ok) throw new Error(`DSH session export ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > 20 * 1024 * 1024) throw new Error('DSH session export is too large')
      const jsonl = readZipText(buffer, /^session(?:\.v\d+)?\.jsonl$/)
      if (jsonl === null) {
        this.transcriptCache.set(repoId, { at: Date.now(), messages: [] })
        return []
      }
      const messages = parseChiefTranscript(jsonl, 30)
      this.transcriptCache.set(repoId, { at: Date.now(), messages })
      return messages.slice(-Math.max(1, limit))
    } catch (error) {
      this.transcriptCache.set(repoId, { at: Date.now(), messages: [] })
      throw error
    }
  }

  clearChiefTranscript(repoId: string): void {
    this.transcriptCache.delete(repoId)
  }

  async sendGuidance(repoId: string, target: string, text: string): Promise<void> {
    const bridge = this.bridgeFor(repoId)
    const sessions: Record<string, string> = {
      chief: bridge.team.chief,
      lead: bridge.team.lead,
      product: bridge.team.product,
      test: bridge.team.test,
      security: bridge.team.security,
      reviewer: bridge.team.reviewer ?? '',
      dev1: bridge.team.dev1,
      dev2: bridge.team.dev2,
    }
    const sessionId = sessions[target]
    if (sessionId === undefined || sessionId === '') throw new Error('请选择有效的团队角色')
    const body = text.trim().slice(0, 4000)
    if (body === '') throw new Error('指导意见不能为空')
    await this.dsh(bridge.instance.bridge_port, bridge.token, 'send', { sessionId, text: body })
  }

  async answerQuestion(repoId: string, sessionId: string, questionId: string, selected: string[], custom: string): Promise<void> {
    if (sessionId === '' || questionId === '') throw new Error('问题已失效，请刷新后重试')
    const bridge = this.bridgeFor(repoId)
    const answer: Record<string, unknown> = {}
    const picked = [...new Set(selected.map((value) => value.trim()).filter((value) => value !== ''))].slice(0, 20)
    if (picked.length > 0) answer.selected = picked.map((value) => value.slice(0, 200))
    const text = custom.trim().slice(0, 2000)
    if (text !== '') answer.custom = text
    if (Object.keys(answer).length === 0) throw new Error('请选择或填写一个答案')
    await this.dsh(bridge.instance.bridge_port, bridge.token, 'answer-question', { sessionId, questionId, answer })
  }

  async stopSessions(repoId: string, sessionIds: string[]): Promise<{ stopped: string[]; requested: string[] }> {
    const bridge = this.bridgeFor(repoId)
    const raw = await this.dsh(bridge.instance.bridge_port, bridge.token, 'state', {})
    const value = ((raw as { value?: Record<string, unknown> }).value ?? raw) as Record<string, unknown>
    const rooms = (value.rooms ?? {}) as Record<string, Record<string, unknown>>
    const stopped: string[] = []
    const requested: string[] = []
    const text = 'Human stop request from Fledge. Stop the current work at the next safe point, do not start another step, and wait for further instructions. Do not merge.'
    for (const sessionId of new Set(sessionIds.filter((value) => value !== ''))) {
      let roomId = ''
      let botId = ''
      for (const [id, room] of Object.entries(rooms)) {
        const sessions = (room.sessions ?? {}) as Record<string, string>
        const entry = Object.entries(sessions).find(([, value]) => value === sessionId)
        if (entry !== undefined) {
          roomId = id
          botId = entry[0]
          break
        }
      }
      if (roomId !== '' && botId !== '') {
        const result = await this.dsh(bridge.instance.bridge_port, bridge.token, 'stop-member-work', { roomId, botId }).catch(() => undefined)
        if ((result as { ok?: boolean } | undefined)?.ok === true) {
          stopped.push(sessionId)
          continue
        }
      }
      await this.dsh(bridge.instance.bridge_port, bridge.token, 'send', { sessionId, text })
      requested.push(sessionId)
    }
    return { stopped, requested }
  }

  async clearJobToken(repoId: string, jobId: string): Promise<void> {
    const instance = this.store.getRepoInstance(repoId)
    if (instance === undefined || instance.status !== 'ready' || instance.bridge_token_enc === null) return
    const token = decryptSecret(instance.bridge_token_enc, this.config.tokenEncryptionKey)
    const response = await fetch(`http://127.0.0.1:${instance.bridge_port}/job-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error(`bridge /job-done ${response.status}`)
  }

  private async probeInstance(instance: RepoInstanceRow): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${instance.bridge_port}/healthz`, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) throw new Error(`bridge ${response.status}`)
    if (instance.bridge_token_enc === null) throw new Error('bridge token missing')
    const token = decryptSecret(instance.bridge_token_enc, this.config.tokenEncryptionKey)
    await this.dsh(instance.bridge_port, token, 'state', {}, 10_000)
  }

  private async waitForDshState(instance: RepoInstanceRow, timeoutMs: number): Promise<void> {
    if (instance.bridge_token_enc === null) throw new Error('bridge token missing')
    const token = decryptSecret(instance.bridge_token_enc, this.config.tokenEncryptionKey)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        await this.dsh(instance.bridge_port, token, 'state', {}, 5_000)
        return
      } catch {}
      await sleep(2_000)
    }
    throw new Error(`FlyBot DSH did not answer within ${Math.round(timeoutMs / 1000)}s`)
  }

  async healthSweep(): Promise<{ ready: number; failed: number; total: number }> {
    let ready = 0
    let failed = 0
    for (const instance of this.store.listRepoInstances()) {
      if (instance.status !== 'ready') continue
      try {
        await this.probeInstance(instance)
        this.store.updateRepoInstance(instance.repo_id, { last_health_at: nowIso(), last_error: null })
        ready += 1
      } catch (error) {
        const detail = String(error).slice(0, 200)
        const active = this.store.activeJobForRepo(instance.repo_id) !== undefined
        const restartKey = `instance_restart:${instance.repo_id}`
        const lastRestart = this.store.getSetting(restartKey)
        const canRestart = this.config.flybot.instanceImage !== '' && this.config.env !== 'test' && !active &&
          (lastRestart === undefined || Date.now() - Date.parse(lastRestart) >= 10 * 60_000)
        if (canRestart) {
          try {
            this.store.setSetting(restartKey, nowIso())
            await this.docker(['restart', '-t', '15', instance.container])
            await this.waitForDshState(instance, 90_000)
            this.store.updateRepoInstance(instance.repo_id, { last_health_at: nowIso(), last_error: null })
            this.store.audit(instance.user_id, 'flybot.instance.auto_restarted', `${instance.repo_id}: ${detail}`)
            log.warn('instance auto-restarted after health failure', { repo: instance.repo_id, error: detail })
            ready += 1
            continue
          } catch (restartError) {
            log.warn('instance auto-restart failed', { repo: instance.repo_id, error: String(restartError) })
          }
        }
        failed += 1
        this.store.updateRepoInstance(instance.repo_id, {
          status: 'failed',
          last_error: `health check failed: ${detail}`,
          updated_at: nowIso(),
        })
        log.warn('instance health check failed', { repo: instance.repo_id, error: detail, active })
      }
    }
    return { ready, failed, total: ready + failed }
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
    this.revokeTokens(repoId, instance.user_id)
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
      try { rmSync(instance.data_dir, { recursive: true, force: true }) } catch {}
      this.store.deleteRepoInstance(repoId)
    }
  }
}
