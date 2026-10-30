import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

export type RunnerMode = 'mock' | 'flybot'
export type MailTransport = 'console' | 'smtp'

export interface Config {
  env: 'development' | 'production' | 'test'
  port: number
  host: string
  baseUrl: string
  sessionSecret: string
  tokenEncryptionKey: string
  github: {
    clientId: string
    clientSecret: string
    scopes: string
    adminLogin: string
    apiBase: string
  }
  mail: {
    transport: MailTransport
    from: string
    adminEmail: string
    smtp: {
      host: string
      port: number
      secure: boolean
      user: string
      pass: string
    }
  }
  llm: {
    baseUrl: string
    key: string
    model: string
    pricePerTokenUsd: number
  }
  quota: {
    initialCny: number
    usdCny: number
  }
  runner: {
    mode: RunnerMode
    bridgeUrl: string
    bridgeToken: string
    timeoutMinutes: number
  }
  dataDir: string
  dbPath: string
  allowPrivateModelUrls: boolean
  allowTokenLoginOnly: boolean
  devLogin: {
    login: string
    admin: boolean
  }
}

function loadDotEnv(file = '.env'): void {
  const path = resolve(file)
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function text(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim()
}

function number(name: string, fallback: number): number {
  const n = Number(text(name))
  return Number.isFinite(n) ? n : fallback
}

function bool(name: string, fallback: boolean): boolean {
  const value = text(name).toLowerCase()
  if (value === '') return fallback
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function secret(name: string, bytes: number): string {
  const value = text(name)
  if (value !== '') return value
  return randomBytes(bytes).toString('base64')
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  loadDotEnv()
  const env = (text('NODE_ENV', 'development') as Config['env']) || 'development'
  const keyB64 = text('TOKEN_ENCRYPTION_KEY')
  const encryptionKey = keyB64 === '' ? randomBytes(32).toString('base64') : keyB64
  const dataDir = resolve(text('DATA_DIR', './data'))
  const config: Config = {
    env,
    port: number('PORT', 8080),
    host: text('HOST', '0.0.0.0'),
    baseUrl: text('BASE_URL', 'http://localhost:8080').replace(/\/$/, ''),
    sessionSecret: secret('SESSION_SECRET', 32),
    tokenEncryptionKey: encryptionKey,
    github: {
      clientId: text('GITHUB_CLIENT_ID'),
      clientSecret: text('GITHUB_CLIENT_SECRET'),
      scopes: text('GITHUB_OAUTH_SCOPES', 'read:user user:email repo'),
      adminLogin: text('ADMIN_GITHUB_LOGIN', 'HugoXK'),
      apiBase: text('GITHUB_API_BASE', 'https://api.github.com').replace(/\/$/, ''),
    },
    mail: {
      transport: (text('MAIL_TRANSPORT', 'console') as MailTransport) || 'console',
      from: text('MAIL_FROM', 'no-reply@example.com'),
      adminEmail: text('ADMIN_EMAIL', 'admin@example.com'),
      smtp: {
        host: text('SMTP_HOST', 'smtp.yeah.net'),
        port: number('SMTP_PORT', 465),
        secure: bool('SMTP_SECURE', true),
        user: text('SMTP_USER', ''),
        pass: text('SMTP_PASS'),
      },
    },
    llm: {
      baseUrl: text('PLATFORM_LLM_BASE_URL', 'http://127.0.0.1:8081/v1').replace(/\/$/, ''),
      key: text('PLATFORM_LLM_KEY'),
      model: text('PLATFORM_LLM_MODEL', 'DeepSeek-V4.1-Flash-1017'),
      pricePerTokenUsd: number('PLATFORM_LLM_PRICE_PER_TOKEN', 0.0000002),
    },
    quota: {
      initialCny: number('INITIAL_QUOTA_CNY', 1),
      usdCny: number('USD_CNY_RATE', 7.2),
    },
    runner: {
      mode: (text('RUNNER_MODE', 'mock') as RunnerMode) || 'mock',
      bridgeUrl: text('FLYBOT_BRIDGE_URL', 'http://127.0.0.1:8787/run'),
      bridgeToken: text('FLYBOT_BRIDGE_TOKEN'),
      timeoutMinutes: number('JOB_TIMEOUT_MINUTES', 45),
    },
    dataDir,
    dbPath: resolve(text('DB_PATH', `${dataDir}/fledge.db`)),
    allowPrivateModelUrls: bool('ALLOW_PRIVATE_MODEL_URLS', false),
    allowTokenLoginOnly: bool('ALLOW_TOKEN_LOGIN_ONLY', false),
    devLogin: {
      login: text('DEV_LOGIN_LOGIN'),
      admin: bool('DEV_LOGIN_ADMIN', true),
    },
  }
  return { ...config, ...overrides }
}

export function assertProductionConfig(config: Config): void {
  if (config.env !== 'production') return
  const missing: string[] = []
  if (config.sessionSecret.length < 32) missing.push('SESSION_SECRET (>=32 chars)')
  try {
    if (Buffer.from(config.tokenEncryptionKey, 'base64').length !== 32) missing.push('TOKEN_ENCRYPTION_KEY (32 bytes, base64)')
  } catch {
    missing.push('TOKEN_ENCRYPTION_KEY (32 bytes, base64)')
  }
  if ((config.github.clientId === '' || config.github.clientSecret === '') && !config.allowTokenLoginOnly) missing.push('GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET (or ALLOW_TOKEN_LOGIN_ONLY=true)')
  if (config.mail.transport === 'smtp' && config.mail.smtp.pass === '') missing.push('SMTP_PASS')
  if (config.llm.key === '' && config.runner.mode === 'flybot') missing.push('PLATFORM_LLM_KEY (needed by the FlyBot runner)')
  if (config.devLogin.login !== '') missing.push('DEV_LOGIN_LOGIN must be empty in production')
  if (missing.length > 0) throw new Error(`Fledge cannot start in production. Missing: ${missing.join(', ')}`)
}
