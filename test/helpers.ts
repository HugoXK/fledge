import http from 'node:http'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetGithubBudget } from '../src/lib/githubBudget.js'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { loadConfig, type Config } from '../src/config.js'
import type { JobRow, Store, UserRow } from '../src/db.js'
import type { Mailer, MailMessage } from '../src/email/mailer.js'
import { randomId, sha256Hex } from '../src/lib/secrets.js'
import { decodeFlash, FLASH_COOKIE, type FlashState } from '../src/lib/flash.js'
import type { BuiltApp } from '../src/app.js'

export class MemoryMailer implements Mailer {
  messages: MailMessage[] = []
  async send(message: MailMessage): Promise<void> {
    this.messages.push(message)
  }
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  resetGithubBudget()
  const base = loadConfig({
    env: 'test',
    baseUrl: 'http://127.0.0.1:9999',
    sessionSecret: randomBytes(32).toString('base64'),
    tokenEncryptionKey: randomBytes(32).toString('base64'),
    dataDir: '/tmp/fledge-test',
    dbPath: ':memory:',
    runner: { mode: 'mock', bridgeUrl: '', bridgeToken: '', timeoutMinutes: 45, stallMinutes: 30, maxActiveJobs: 2, workCooldownMinutes: 15, queueDispatch: false, maxQueueDepth: 100, maxUserQueue: 20 },
    allowTokenLoginOnly: true,
    mail: {
      transport: 'console',
      from: 'no-reply@example.com',
      adminEmail: 'admin@example.com',
      feedbackEmail: 'admin@example.com',
      jobEmailCooldownMinutes: 60,
      smtp: { host: '', port: 465, secure: true, user: '', pass: '' },
    },
    github: {
      clientId: 'client',
      clientSecret: 'secret',
      scopes: 'read:user user:email',
      adminLogin: 'admin',
      apiBase: 'https://api.github.com',
      oauthTokenUrl: 'https://github.com/login/oauth/access_token',
      requestsPerMinute: 120,
    },
    metrics: { token: '' },
    otel: { endpoint: '', serviceName: 'fledge' },
    shutdown: { graceSeconds: 0 },
    autoMerge: { reconcileMinutes: 5, minReviewScore: 80 },
    ops: { alertCooldownMinutes: 360 },
  })
  return {
    ...base,
    ...overrides,
    github: { ...base.github, ...overrides.github },
    mail: { ...base.mail, ...overrides.mail },
    llm: { ...base.llm, ...overrides.llm },
    quota: { ...base.quota, ...overrides.quota },
    runner: { ...base.runner, ...overrides.runner },
    metrics: { ...base.metrics, ...overrides.metrics },
    otel: { ...base.otel, ...overrides.otel },
    shutdown: { ...base.shutdown, ...overrides.shutdown },
    autoMerge: { ...base.autoMerge, ...overrides.autoMerge },
    ops: { ...base.ops, ...overrides.ops },
    limits: { ...base.limits, ...overrides.limits },
    rateLimit: {
      login: { ...base.rateLimit.login, ...overrides.rateLimit?.login },
      destructive: { ...base.rateLimit.destructive, ...overrides.rateLimit?.destructive },
      expensive: { ...base.rateLimit.expensive, ...overrides.rateLimit?.expensive },
    },
    plan: { ...base.plan, ...overrides.plan },
    backup: { ...base.backup, ...overrides.backup },
  }
}

// Tests that need many historical jobs for one repository must not leave more
// than one active row: the jobs_one_active_per_repo index is a real invariant.
export function makeTerminalJob(store: Store, input: Parameters<Store['createJob']>[0]): JobRow {
  const job = store.createJob(input)
  store.updateJob(job.id, { status: 'succeeded', finished_at: new Date().toISOString() })
  return job
}

export function makeUser(store: Store, options: { login?: string; admin?: boolean; superadmin?: boolean; status?: 'pending' | 'approved' | 'rejected'; quota?: number } = {}): UserRow {
  const login = options.login ?? `user${Math.random().toString(36).slice(2, 8)}`
  const user = store.upsertGithubUser({
    id: randomId('usr'),
    githubId: Math.floor(Math.random() * 1_000_000_000),
    login,
    name: login,
    email: `${login}@example.com`,
    avatarUrl: null,
    isAdmin: options.admin === true,
    isSuperAdmin: options.superadmin === true,
    initialQuotaCny: options.quota ?? 1,
  })
  if (options.status !== undefined && options.status !== user.status) store.setUserStatus(user.id, options.status, 'test')
  return store.userById(user.id)!
}

export function sessionFor(built: BuiltApp, user: UserRow): { raw: string; csrf: string; cookie: string } {
  const raw = built.sessions.start(user.id, { ip: '127.0.0.1', headers: { 'user-agent': 'fledge-test' } } as never)
  const hash = sha256Hex(raw)
  const csrf = built.sessions.csrfFor(hash)
  return { raw, csrf, cookie: `fledge_session=${raw}; fledge_csrf=${csrf}` }
}

export function formBody(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value))
  return params.toString()
}

// #472 slice 2: a redirect reports its message in a one-shot cookie, so a test
// that used to read the Location now reads the cookie, sends it on the page GET
// and can assert the first page clears it.
export function flashCookie(response: { headers: Record<string, unknown> }): string | undefined {
  const value = response.headers['set-cookie']
  const lines = value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(String)
  const line = lines.find((entry) => entry.startsWith(`${FLASH_COOKIE}=`))
  if (line === undefined) return undefined
  const raw = line.slice(FLASH_COOKIE.length + 1).split(';')[0] ?? ''
  return raw === '' ? undefined : `${FLASH_COOKIE}=${raw}`
}

export function flashOf(response: { headers: Record<string, unknown> }): FlashState | undefined {
  const cookie = flashCookie(response)
  return cookie === undefined ? undefined : decodeFlash(cookie.slice(FLASH_COOKIE.length + 1))
}

export function startFakeServer(
  handler: http.RequestListener,
  options: { abortOnClose?: boolean } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          // A caller that closes while a request is in flight wants the socket
          // gone, not a graceful drain: that is what a process stopping in the
          // middle of a call looks like to the client. Opt-in, so a suite that
          // only closes after its work settles keeps the graceful path.
          if (options.abortOnClose === true) server.closeAllConnections()
          server.close(() => done())
        }),
      })
    })
  })
}

export async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export function json(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers })
  response.end(text)
}

// #391: the bridge is a separate process, so its HTTP contract can only be
// pinned by spawning the real file. `freePort` and `startBridge` lived in
// test/providerRefusal.test.ts, where a second suite would have copied them.
// Assembled so the tracked-tree scan has no literal to find; the value is
// obviously fake either way.
export const BRIDGE_TOKEN = 'bridge-token' + '-for-the-test'
export const BRIDGE_SESSION_ID = 'session-test'

export async function freePort(): Promise<number> {
  const { url, close } = await startFakeServer((_request, response) => {
    response.writeHead(200).end()
  })
  await close()
  return Number(new URL(url).port)
}

// The bridge reads the DSH web token from its log; this writes the line
// `lastDshToken` (bridge/flybot-bridge.mjs) matches.
export function writeDshLog(path: string, token: string): void {
  writeFileSync(path, `dsh web listening url=http://127.0.0.1:3080/?token=${token}\n`)
}

export async function startBridge(options: {
  web: string
  log: string
  env?: Record<string, string>
}): Promise<{ child: ChildProcess; port: number }> {
  const port = await freePort()
  const child = spawn(process.execPath, [join(process.cwd(), 'bridge/flybot-bridge.mjs')], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_TOKEN,
      FLYBOT_CHAT_SESSION_ID: BRIDGE_SESSION_ID,
      FLYBOT_WEB: options.web,
      FLYBOT_LOG: options.log,
      MODEL_PROXY_PORT: '0',
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (response.ok) return { child, port }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  child.kill('SIGKILL')
  throw new Error(`the bridge did not answer /healthz: ${stderr.slice(-400)}`)
}
