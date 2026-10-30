import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { loadConfig, type Config } from '../src/config.js'
import type { Store, UserRow } from '../src/db.js'
import type { Mailer, MailMessage } from '../src/email/mailer.js'
import { randomId, sha256Hex } from '../src/lib/secrets.js'
import type { BuiltApp } from '../src/app.js'

export class MemoryMailer implements Mailer {
  messages: MailMessage[] = []
  async send(message: MailMessage): Promise<void> {
    this.messages.push(message)
  }
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({
    env: 'test',
    baseUrl: 'http://127.0.0.1:9999',
    sessionSecret: randomBytes(32).toString('base64'),
    tokenEncryptionKey: randomBytes(32).toString('base64'),
    dataDir: '/tmp/fledge-test',
    dbPath: ':memory:',
    runner: { mode: 'mock', bridgeUrl: '', bridgeToken: '', timeoutMinutes: 45 },
    mail: {
      transport: 'console',
      from: 'no-reply@example.com',
      adminEmail: 'admin@example.com',
      smtp: { host: '', port: 465, secure: true, user: '', pass: '' },
    },
    github: {
      clientId: 'client',
      clientSecret: 'secret',
      scopes: 'read:user user:email',
      adminLogin: 'admin',
      apiBase: 'https://api.github.com',
    },
  })
  return {
    ...base,
    ...overrides,
    github: { ...base.github, ...overrides.github },
    mail: { ...base.mail, ...overrides.mail },
    llm: { ...base.llm, ...overrides.llm },
    quota: { ...base.quota, ...overrides.quota },
    runner: { ...base.runner, ...overrides.runner },
  }
}

export function makeUser(store: Store, options: { login?: string; admin?: boolean; status?: 'pending' | 'approved' | 'rejected'; quota?: number } = {}): UserRow {
  const login = options.login ?? `user${Math.random().toString(36).slice(2, 8)}`
  const user = store.upsertGithubUser({
    id: randomId('usr'),
    githubId: Math.floor(Math.random() * 1_000_000_000),
    login,
    name: login,
    email: `${login}@example.com`,
    avatarUrl: null,
    isAdmin: options.admin === true,
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

export function startFakeServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
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
