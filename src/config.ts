import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { buildIdentity } from './lib/buildIdentity.js'
import { DEFAULT_EXPECTED_HOURS } from './lib/backupStatus.js'
import { DEFAULT_PAT_EXPIRY_DAYS } from './lib/tokens.js'

export type RunnerMode = 'mock' | 'flybot'
export type MailTransport = 'console' | 'smtp'

export interface Config {
  env: 'development' | 'production' | 'test'
  port: number
  host: string
  // Hops allowed to append X-Forwarded-For. Never empty, never a wildcard: see
  // parseTrustProxy and docs/deploy.md for the topology each list belongs to.
  trustProxy: string[]
  baseUrl: string
  sessionSecret: string
  // Ceilings on what one user may create that consumes host resources. 0 means
  // no ceiling; admins and superadmins are exempt (see src/lib/limits.ts).
  limits: {
    reposPerUser: number
    instancesPerUser: number
    instancesGlobal: number
  }
  // How long a GitHub re-authentication stays "recent" for destructive actions.
  recentAuthMinutes: number
  tokenEncryptionKey: string
  github: {
    clientId: string
    clientSecret: string
    scopes: string
    adminLogin: string
    apiBase: string
    oauthTokenUrl: string
    requestsPerMinute: number
  }
  githubApp: {
    id: string
    slug: string
    privateKeyPath: string
    webhookSecret: string
    useUserToken: boolean
  }
  mail: {
    transport: MailTransport
    from: string
    adminEmail: string
    /** #353: how long one repository's failure mail stays coalesced, in minutes. */
    jobEmailCooldownMinutes: number
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
    stallMinutes: number
    maxActiveJobs: number
    /** Min gap between scheduled work sessions; an open work item does not wait for interval_minutes. */
    workCooldownMinutes: number
    queueDispatch: boolean
    maxQueueDepth: number
    maxUserQueue: number
  }
  metrics: {
    token: string
  }
  // Build identity stamped by the release job (src/lib/buildIdentity.ts).
  // `/healthz` serves it so a deploy can be named from outside; a local build
  // carries no stamp and answers `unknown` rather than inventing a value.
  build: {
    commit: string
    builtAt: string
  }
  otel: {
    endpoint: string
    serviceName: string
  }
  shutdown: {
    graceSeconds: number
  }
  autoMerge: {
    reconcileMinutes: number
    /** A linked work item below this review score cannot auto-merge. */
    minReviewScore: number
  }
  ops: {
    alertCooldownMinutes: number
  }
  tokens: {
    /** Default lifetime of a new personal `flg_` token, in days. */
    patExpiryDays: number
  }
  plan: {
    /** Days a plan may wait for a maintainer before it expires into `closed`. */
    expiryDays: number
    /** Days before the deadline when the single reminder is sent. */
    reminderDays: number
  }
  digest: {
    hour: number
    timeZone: string
  }
  flybot: {
    instanceImage: string
    instanceRoot: string
    bridgeScript: string
    networkPrefix: string
    dshPortStart: number
    bridgePortStart: number
    modelPortStart: number
    memory: string
    cpus: string
    model: string
    teamTimeoutSeconds: number
  }
  services: {
    portal: string
    docs: string
    status: string
  }
  dataDir: string
  dbPath: string
  backup: {
    /** Where `npm run db:backup` writes: the same BACKUP_DIR ?? DATA_DIR/backups the script uses. */
    dir: string
    /** Age above which the newest copy is shown as stale, in hours. */
    expectedIntervalHours: number
  }
  allowPrivateModelUrls: boolean
  inboundEmailSecret: string
  notifyWebhookUrl: string
  notifyWebhookSecret: string
  // Exact webhook hosts the operator trusts for self-hosted targets. Empty means
  // only public https targets are allowed; a listed host may be private or http.
  notifyWebhookAllowedHosts: string[]
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

function withTrailingSlash(value: string): string {
  if (value === '') return ''
  return value.endsWith('/') ? value : `${value}/`
}

function text(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim()
}

function number(name: string, fallback: number): number {
  const raw = text(name)
  if (raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function bool(name: string, fallback: boolean): boolean {
  const value = text(name).toLowerCase()
  if (value === '') return fallback
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

export function parseHostAllowlist(raw: string): string[] {
  const hosts = raw
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''))
    .filter((host) => host !== '')
  return [...new Set(hosts)]
}

function secret(name: string, bytes: number): string {
  const value = text(name)
  if (value !== '') return value
  return randomBytes(bytes).toString('base64')
}

const DEFAULT_TRUST_PROXY = '127.0.0.1,::1'

function isAddressOrCidr(value: string): boolean {
  const parts = value.split('/')
  if (parts.length > 2) return false
  const address = parts[0] ?? ''
  const version = isIP(address)
  if (version === 0) return false
  const prefix = parts[1]
  if (prefix === undefined) return true
  if (!/^\d{1,3}$/.test(prefix)) return false
  const bits = Number(prefix)
  // A /0 range trusts every caller, which is the one thing this option exists
  // to prevent.
  return bits >= 1 && bits <= (version === 4 ? 32 : 128)
}

export function parseTrustProxy(raw: string): string[] {
  const source = raw.trim() === '' ? DEFAULT_TRUST_PROXY : raw
  const hops = source.split(',').map((hop) => hop.trim()).filter((hop) => hop !== '')
  if (hops.length === 0) throw new Error('TRUST_PROXY: no trusted hops. Name the proxy address or CIDR that may append X-Forwarded-For, for example 127.0.0.1,::1.')
  for (const hop of hops) {
    if (!isAddressOrCidr(hop)) {
      throw new Error(`TRUST_PROXY: "${hop}" is not a trusted hop. Name the proxy address or CIDR that may append X-Forwarded-For (for example 127.0.0.1,::1). true, false, "*", "all" and a /0 range are refused because they trust the caller-supplied left end of the header.`)
    }
  }
  return hops
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  loadDotEnv()
  const rawEnv = text('NODE_ENV', 'production').toLowerCase()
  const env = (rawEnv === 'prod' ? 'production' : rawEnv === 'dev' ? 'development' : rawEnv) as Config['env']
  if (env !== 'development' && env !== 'production' && env !== 'test') throw new Error(`unknown NODE_ENV: ${rawEnv}`)
  const keyB64 = text('TOKEN_ENCRYPTION_KEY')
  const encryptionKey = keyB64 === '' ? randomBytes(32).toString('base64') : keyB64
  const dataDir = resolve(text('DATA_DIR', './data'))
  const config: Config = {
    env,
    port: number('PORT', 8080),
    host: text('HOST', '0.0.0.0'),
    trustProxy: parseTrustProxy(text('TRUST_PROXY', DEFAULT_TRUST_PROXY)),
    baseUrl: text('BASE_URL', 'http://localhost:8080').replace(/\/$/, ''),
    sessionSecret: secret('SESSION_SECRET', 32),
    limits: {
      reposPerUser: Math.max(0, number('LIMIT_REPOS_PER_USER', 10)),
      instancesPerUser: Math.max(0, number('LIMIT_INSTANCES_PER_USER', 3)),
      instancesGlobal: Math.max(0, number('LIMIT_INSTANCES_GLOBAL', 0)),
    },
    recentAuthMinutes: Math.max(1, number('RECENT_AUTH_MINUTES', 15)),
    tokenEncryptionKey: encryptionKey,
    github: {
      clientId: text('GITHUB_CLIENT_ID'),
      clientSecret: text('GITHUB_CLIENT_SECRET'),
      scopes: text('GITHUB_OAUTH_SCOPES', 'read:user user:email'),
      adminLogin: text('ADMIN_GITHUB_LOGIN'),
      apiBase: text('GITHUB_API_BASE', 'https://api.github.com').replace(/\/$/, ''),
      oauthTokenUrl: text('GITHUB_OAUTH_TOKEN_URL', 'https://github.com/login/oauth/access_token'),
      requestsPerMinute: Math.max(1, number('GITHUB_REQUESTS_PER_MINUTE', 120)),
    },
    githubApp: {
      id: text('GITHUB_APP_ID'),
      slug: text('GITHUB_APP_SLUG'),
      privateKeyPath: text('GITHUB_APP_PRIVATE_KEY_PATH'),
      webhookSecret: text('GITHUB_APP_WEBHOOK_SECRET'),
      useUserToken: bool('GITHUB_APP_USER_TOKEN', false),
    },
    mail: {
      transport: (text('MAIL_TRANSPORT', 'console') as MailTransport) || 'console',
      from: text('MAIL_FROM', 'no-reply@example.com'),
      adminEmail: text('ADMIN_EMAIL', 'admin@example.com'),
      // #353: the window that keeps a failing repository from mailing once per run.
      jobEmailCooldownMinutes: Math.max(0, number('JOB_EMAIL_COOLDOWN_MINUTES', 60)),
      smtp: {
        host: text('SMTP_HOST', 'smtp.yeah.net'),
        port: number('SMTP_PORT', 465),
        secure: bool('SMTP_SECURE', true),
        user: text('SMTP_USER', ''),
        pass: text('SMTP_PASS'),
      },
    },
    llm: {
      baseUrl: text('PLATFORM_LLM_BASE_URL').replace(/\/$/, ''),
      key: text('PLATFORM_LLM_KEY'),
      model: text('PLATFORM_LLM_MODEL', 'your-model'),
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
      timeoutMinutes: number('JOB_TIMEOUT_MINUTES', 90),
      stallMinutes: number('JOB_STALL_MINUTES', 30),
      maxActiveJobs: Math.max(1, number('PLATFORM_MAX_ACTIVE_JOBS', 2)),
      // #478: a due repo with no work item must idle, and a work item must not
      // wait for the old 12-hour interval. 15 is the smallest interval the UI
      // already renders; a repo may choose a longer gap.
      workCooldownMinutes: Math.max(15, number('WORK_SESSION_COOLDOWN_MINUTES', 15)),
      queueDispatch: bool('QUEUE_DISPATCH', false),
      maxQueueDepth: Math.max(1, number('QUEUE_MAX_DEPTH', 100)),
      maxUserQueue: Math.max(1, number('QUEUE_MAX_PER_USER', 20)),
    },
    metrics: {
      token: text('METRICS_TOKEN'),
    },
    build: buildIdentity(),
    otel: {
      endpoint: text('OTEL_EXPORTER_OTLP_ENDPOINT').replace(/\/$/, ''),
      serviceName: text('OTEL_SERVICE_NAME', 'fledge'),
    },
    shutdown: {
      graceSeconds: Math.max(0, number('SHUTDOWN_GRACE_SECONDS', 20)),
    },
    autoMerge: {
      reconcileMinutes: Math.max(1, number('AUTO_MERGE_RECONCILE_MINUTES', 5)),
      minReviewScore: Math.min(100, Math.max(0, number('AUTO_MERGE_MIN_REVIEW_SCORE', 80))),
    },
    ops: {
      alertCooldownMinutes: Math.max(0, number('OPS_ALERT_COOLDOWN_MINUTES', 360)),
    },
    tokens: {
      patExpiryDays: Math.max(1, number('PAT_EXPIRY_DAYS', DEFAULT_PAT_EXPIRY_DAYS)),
    },
    plan: {
      expiryDays: Math.max(1, number('PLAN_EXPIRY_DAYS', 7)),
      reminderDays: Math.max(0, number('PLAN_REMINDER_DAYS', 2)),
    },
    digest: {
      hour: Math.min(23, Math.max(0, number('DIGEST_HOUR', 9))),
      timeZone: text('DIGEST_TIMEZONE', 'Asia/Shanghai'),
    },
    flybot: {
      instanceImage: text('FLYBOT_INSTANCE_IMAGE'),
      instanceRoot: resolve(text('FLYBOT_INSTANCE_ROOT', `${dataDir}/flybot-users`)),
      bridgeScript: resolve(text('FLYBOT_BRIDGE_SCRIPT', 'bridge/flybot-bridge.mjs')),
      networkPrefix: text('FLYBOT_NETWORK_PREFIX', 'fledge'),
      dshPortStart: number('FLYBOT_DSH_PORT_START', 31000),
      bridgePortStart: number('FLYBOT_BRIDGE_PORT_START', 32000),
      modelPortStart: number('FLYBOT_MODEL_PORT_START', 33000),
      memory: text('FLYBOT_MEMORY', '2g'),
      cpus: text('FLYBOT_CPUS', '1'),
      model: text('FLYBOT_MODEL', text('PLATFORM_LLM_MODEL', 'your-model')),
      teamTimeoutSeconds: number('FLYBOT_TEAM_TIMEOUT_SECONDS', 180),
    },
    services: {
      portal: text('PORTAL_URL', 'https://portal.hugoxk.online').replace(/\/$/, ''),
      docs: withTrailingSlash(text('FLEDGE_DOCS_URL', 'https://fledge-docs.hugoxk.online/docs/')),
      status: withTrailingSlash(text('STATUS_URL', 'https://hugoxk.online/status/')),
    },
    dataDir,
    dbPath: resolve(text('DB_PATH', `${dataDir}/fledge.db`)),
    backup: {
      dir: resolve(text('BACKUP_DIR', `${dataDir}/backups`)),
      expectedIntervalHours: Math.max(1, number('BACKUP_EXPECTED_HOURS', DEFAULT_EXPECTED_HOURS)),
    },
    allowPrivateModelUrls: bool('ALLOW_PRIVATE_MODEL_URLS', false),
    inboundEmailSecret: text('INBOUND_EMAIL_SECRET'),
    notifyWebhookUrl: text('NOTIFY_WEBHOOK_URL'),
    notifyWebhookSecret: text('NOTIFY_WEBHOOK_SECRET'),
    notifyWebhookAllowedHosts: parseHostAllowlist(text('NOTIFY_WEBHOOK_ALLOWED_HOSTS')),
    allowTokenLoginOnly: bool('ALLOW_TOKEN_LOGIN_ONLY', false),
    devLogin: {
      login: text('DEV_LOGIN_LOGIN'),
      admin: bool('DEV_LOGIN_ADMIN', true),
    },
  }
  // Deliberately not asserting here: maintenance scripts (rotate-instance-tokens,
  // set-role, mail-probe) call loadConfig() to read one value, and a missing
  // production secret must not block an operator repair. The startup gate is
  // buildApp(), which src/index.ts also calls unguarded. See docs/deploy.md.
  const merged = { ...config, ...overrides }
  // #420: the reminder is the deadline minus an offset, so a reminder at or after
  // the deadline makes the window zero and every unapproved plan is "reminded" on
  // the next tick with its deadline still days away. This is not a missing
  // operator secret — it is a pair that cannot mean what the operator wrote, it
  // happens in every environment, and only the merged value can see it.
  if (merged.plan.reminderDays >= merged.plan.expiryDays) {
    throw new Error(`PLAN_REMINDER_DAYS (${merged.plan.reminderDays}) must be smaller than PLAN_EXPIRY_DAYS (${merged.plan.expiryDays}); a reminder at or after the deadline is sent immediately.`)
  }
  return merged
}

function isAbsoluteHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname !== ''
  } catch {
    return false
  }
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
  // #127: /metrics stays unauthenticated without a token, and the alert webhook
  // carries the payload plus a bearer secret, so both are startup refusals rather
  // than a warning in a log nobody reads.
  if (config.metrics.token === '') missing.push('METRICS_TOKEN')
  if (config.notifyWebhookUrl !== '' && !isAbsoluteHttpsUrl(config.notifyWebhookUrl)) {
    missing.push('NOTIFY_WEBHOOK_URL (must be an absolute https: URL)')
  }
  if (missing.length > 0) throw new Error(`Fledge cannot start in production. Missing: ${missing.join(', ')}`)
}
