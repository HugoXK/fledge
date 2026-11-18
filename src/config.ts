import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { resolve } from 'node:path'
import { buildIdentity } from './lib/buildIdentity.js'
import { DEFAULT_EXPECTED_HOURS } from './lib/backupStatus.js'
import { DEFAULT_PAT_EXPIRY_DAYS } from './lib/tokens.js'
import { registerRedactionSecrets } from './lib/secrets.js'
import { DEFAULT_RATE_LIMIT_BUDGETS, type RateLimitBudgets } from './lib/rateLimit.js'
import { parseManagementService, type ManagementServiceMode } from './management/mode.js'
import { RETENTION_CLASSES, retentionDefaultWindows, retentionWindow, type RetentionId, type RetentionWindows } from '../scripts/lib/retention.mjs'

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
  // #897: the superadmin release action dispatches the existing release
  // workflow. The token needs Actions: write to dispatch and Contents: read,
  // Checks: read and Pull requests: read to build the preview; it is a server
  // secret and is never rendered or logged.
  release: {
    dispatchToken: string
    repo: string
    workflow: string
    ref: string
  }
  // #690: how long after its `trial.expired` row a never-used rejected account is
  // erased. The sweep's purge phase reads this; 72 hours is the host-side cron it
  // replaces.
  trialPurgeGraceHours: number
  /** #803: promote a discovered issue into one proposed work item. Off by default. */
  autoPromoteDiscovery: boolean
  /** #803: maximum automatic discovery promotions per UTC day; 0 disables them. */
  autoPromoteDiscoveryDailyCap: number
  // #708: the per-class windows mutating routes take. A route names its class;
  // the numbers live here so a deployment tightens a limit without a rebuild.
  rateLimit: RateLimitBudgets
  // #281: the age windows `pruneOldData` enforces, read from config so a deploy
  // can change one without a code change. `configured` is false when the env var
  // is unset, so the operator surface can mark the built-in value as the default.
  // Unset means today's window, never "keep forever": the rows are deleted at
  // that age today, and stopping that quietly would be a privacy regression.
  retention: {
    windows: RetentionWindows
    configured: Record<RetentionId, boolean>
  }
  // #637: the comment names that count as a trigger. `@<name>` in an issue or
  // pull request comment starts a review; a deployment renames or adds names
  // here rather than in code, and an empty list disables the trigger.
  triggers: {
    mentions: string[]
  }
  // #540: how far the console adapters go for commands added after slice 1.
  // `off` (the default) is the route that existed before the contract.
  managementService: ManagementServiceMode
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
    // #466: the rotation slot. Both are empty when no overlap is open, so a
    // config assembled by hand (a test, a maintenance script) can omit them:
    // absent means the same thing as empty, and loadConfig always writes both.
    webhookSecretPrevious?: string
    webhookSecretPreviousUntil?: string
    useUserToken: boolean
  }
  mail: {
    transport: MailTransport
    from: string
    adminEmail: string
    /** #786: feedback and error reports; empty falls back to ADMIN_EMAIL. */
    feedbackEmail: string
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
    /** #636: JSON price table per model; empty means the single USD price above. */
    priceTable?: string
  }
  quota: {
    initialCny: number
    usdCny: number
    /** Below this remaining balance the first-run checklist recommends an own model. */
    comfortCny: number
  }
  // #814: the server-deployed FlyBot's Fledge Lead. `leadRepoId` uses a repo
  // Fledge already manages; the bridge trio targets an externally managed
  // instance. `publicRepo` is the sanitized issue target the Lead may write to.
  feedback: {
    leadRepoId: string
    leadBridgeUrl: string
    leadBridgeToken: string
    leadSessionId: string
    publicRepo: string
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
    /** #807: how long ready work may wait for a dispatch before the alert fires. */
    automationIdleAlertMinutes: number
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
  const ranges = hops.flatMap((hop) => trustedRanges(hop))
  for (const space of ['ipv4', 'ipv6'] as const) {
    const covering = coveringSubset(ranges.filter((range) => range.space === space), space === 'ipv4' ? IPV4_SPACE : IPV6_SPACE)
    if (covering !== null) throw new Error(coveringMessage(covering, space === 'ipv4' ? 'IPv4' : 'IPv6'))
  }
  return hops
}

// `true`, `*`, `all` and a literal /0 are refused one entry at a time above, but
// a list whose union is the whole space trusts every caller just the same. The
// check below is numeric: host bits are masked, IPv6 uses BigInt, and an
// IPv4-mapped entry is folded into the IPv4 space because
// @fastify/proxy-addr canonicalises a mapped candidate to IPv4 and then matches
// a mapped subnet whose prefix is at least /96.
const IPV4_SPACE = 1n << 32n
const IPV6_SPACE = 1n << 128n

interface TrustedRange {
  space: 'ipv4' | 'ipv6'
  start: bigint
  end: bigint
  label: string
}

function parseIPv4(address: string): bigint | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

function parseIPv6(address: string): bigint | null {
  const halves = address.replace(/%.*$/, '').split('::')
  if (halves.length > 2) return null
  const groupsOf = (part: string): number[] | null => {
    if (part === '') return []
    const groups: number[] = []
    for (const group of part.split(':')) {
      if (group.includes('.')) {
        const embedded = parseIPv4(group)
        if (embedded === null) return null
        groups.push(Number(embedded >> 16n), Number(embedded & 0xffffn))
        continue
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null
      groups.push(Number.parseInt(group, 16))
    }
    return groups
  }
  const head = groupsOf(halves[0] ?? '')
  if (head === null) return null
  if (halves.length === 1) {
    if (head.length !== 8) return null
    return head.reduce((value, group) => (value << 16n) | BigInt(group), 0n)
  }
  const tail = groupsOf(halves[1] ?? '')
  if (tail === null) return null
  const zeros = 8 - head.length - tail.length
  if (zeros < 1) return null
  const groups = [...head, ...Array<number>(zeros).fill(0), ...tail]
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n)
}

function maskRange(space: 'ipv4' | 'ipv6', value: bigint, prefix: number, label: string): TrustedRange {
  const bits = space === 'ipv4' ? 32n : 128n
  const block = 1n << (bits - BigInt(prefix))
  const start = value & -block
  return { space, start, end: start + block - 1n, label }
}

function trustedRanges(hop: string): TrustedRange[] {
  const [address = '', prefixText] = hop.split('/')
  const version = isIP(address)
  if (version === 4) {
    const value = parseIPv4(address)
    if (value === null) return []
    return [maskRange('ipv4', value, prefixText === undefined ? 32 : Number(prefixText), `"${hop}"`)]
  }
  if (version !== 6) return []
  const value = parseIPv6(address)
  if (value === null) return []
  const prefix = prefixText === undefined ? 128 : Number(prefixText)
  // A mapped prefix below the marker matches no candidate at all in
  // proxy-addr (its cross-family guard only spans IPv4 when range >= 96).
  if (value >> 32n !== 0xffffn) return [maskRange('ipv6', value, prefix, `"${hop}"`)]
  if (prefix < 96) return []
  return [maskRange('ipv4', value & 0xffffffffn, prefix - 96, `"${hop}" (an IPv4-mapped prefix)`)]
}

// Greedy cover from the bottom of the space. Returns the entries that reach the
// top when the union is contiguous, or null when a gap remains. Only the subset
// that does the covering is returned, so a long hop list is not echoed back.
function coveringSubset(ranges: TrustedRange[], space: bigint): TrustedRange[] | null {
  const sorted = [...ranges].sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1 : 0))
  const covering: TrustedRange[] = []
  let cursor = 0n
  let index = 0
  while (cursor < space) {
    let best: TrustedRange | null = null
    while (index < sorted.length && sorted[index]!.start <= cursor) {
      const candidate = sorted[index]!
      if (best === null || candidate.end > best.end) best = candidate
      index += 1
    }
    if (best === null || best.end < cursor) return null
    covering.push(best)
    cursor = best.end + 1n
  }
  return covering
}

function coveringMessage(covering: TrustedRange[], space: 'IPv4' | 'IPv6'): string {
  const labels = covering.map((range) => range.label)
  const named = labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]!}`
  return `TRUST_PROXY: ${named} ${labels.length === 1 ? 'covers' : 'together cover'} the whole ${space} space, so the list trusts the caller-supplied left end of X-Forwarded-For. Name the proxy address or its narrow CIDR instead; a set that covers the space is refused like a /0 range.`
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  loadDotEnv()
  const rawEnv = text('NODE_ENV', 'production').toLowerCase()
  const env = (rawEnv === 'prod' ? 'production' : rawEnv === 'dev' ? 'development' : rawEnv) as Config['env']
  if (env !== 'development' && env !== 'production' && env !== 'test') throw new Error(`unknown NODE_ENV: ${rawEnv}`)
  const keyB64 = text('TOKEN_ENCRYPTION_KEY')
  const encryptionKey = keyB64 === '' ? randomBytes(32).toString('base64') : keyB64
  const dataDir = resolve(text('DATA_DIR', './data'))
  // #281: one window per retention class, with the shipped literal as the
  // effective default. `retentionWindow` refuses 0 and non-integers rather than
  // reading them as "delete everything", and marks a fallback `configured:false`.
  const retentionWindows = retentionDefaultWindows()
  const retentionConfigured = {} as Record<RetentionId, boolean>
  for (const cls of RETENTION_CLASSES) {
    const parsed = retentionWindow(process.env[cls.env], cls.defaultDays)
    retentionWindows[cls.id] = parsed.days
    retentionConfigured[cls.id] = parsed.configured
  }
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
    release: {
      dispatchToken: text('RELEASE_DISPATCH_TOKEN'),
      repo: text('RELEASE_DISPATCH_REPO', 'HugoXK/fledge'),
      workflow: text('RELEASE_DISPATCH_WORKFLOW', 'daily-release.yml'),
      ref: text('RELEASE_DISPATCH_REF', 'main'),
    },
    trialPurgeGraceHours: Math.max(1, number('TRIAL_PURGE_GRACE_HOURS', 72)),
    autoPromoteDiscovery: bool('AUTO_PROMOTE_DISCOVERY', false),
    autoPromoteDiscoveryDailyCap: Math.max(0, number('AUTO_PROMOTE_DISCOVERY_DAILY_CAP', 3)),
    rateLimit: {
      login: {
        max: Math.max(1, number('RATE_LIMIT_LOGIN_MAX', DEFAULT_RATE_LIMIT_BUDGETS.login.max)),
        windowMs: Math.max(1_000, number('RATE_LIMIT_LOGIN_WINDOW_MS', DEFAULT_RATE_LIMIT_BUDGETS.login.windowMs)),
      },
      destructive: {
        max: Math.max(1, number('RATE_LIMIT_DESTRUCTIVE_MAX', DEFAULT_RATE_LIMIT_BUDGETS.destructive.max)),
        windowMs: Math.max(1_000, number('RATE_LIMIT_DESTRUCTIVE_WINDOW_MS', DEFAULT_RATE_LIMIT_BUDGETS.destructive.windowMs)),
      },
      expensive: {
        max: Math.max(1, number('RATE_LIMIT_EXPENSIVE_MAX', DEFAULT_RATE_LIMIT_BUDGETS.expensive.max)),
        windowMs: Math.max(1_000, number('RATE_LIMIT_EXPENSIVE_WINDOW_MS', DEFAULT_RATE_LIMIT_BUDGETS.expensive.windowMs)),
      },
    },
    retention: {
      windows: retentionWindows,
      configured: retentionConfigured,
    },
    triggers: {
      mentions: text('FLEDGE_MENTION_NAMES', 'fledge')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    },
    managementService: parseManagementService(text('MANAGEMENT_SERVICE', 'off')),
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
      webhookSecretPrevious: text('GITHUB_APP_WEBHOOK_SECRET_PREVIOUS'),
      webhookSecretPreviousUntil: text('GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL'),
      useUserToken: bool('GITHUB_APP_USER_TOKEN', false),
    },
    mail: {
      transport: (text('MAIL_TRANSPORT', 'console') as MailTransport) || 'console',
      from: text('MAIL_FROM', 'no-reply@example.com'),
      adminEmail: text('ADMIN_EMAIL', 'admin@example.com'),
      feedbackEmail: text('FEEDBACK_EMAIL', '') || text('ADMIN_EMAIL', 'admin@example.com'),
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
      priceTable: text('PLATFORM_LLM_PRICE_TABLE'),
    },
    quota: {
      initialCny: number('INITIAL_QUOTA_CNY', 1),
      usdCny: number('USD_CNY_RATE', 7.2),
      comfortCny: number('PLATFORM_QUOTA_COMFORT_CNY', 50),
    },
    feedback: {
      leadRepoId: text('FLEDGE_LEAD_REPO_ID'),
      leadBridgeUrl: text('FLEDGE_LEAD_BRIDGE_URL').replace(/\/$/, ''),
      leadBridgeToken: text('FLEDGE_LEAD_BRIDGE_TOKEN'),
      leadSessionId: text('FLEDGE_LEAD_SESSION_ID'),
      publicRepo: text('FEEDBACK_PUBLIC_REPO', 'HugoXK/fledge'),
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
      automationIdleAlertMinutes: Math.max(1, number('AUTOMATION_IDLE_ALERT_MINUTES', 30)),
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
  // #466: an overlap with no end accepts a retired webhook secret forever, so a
  // `_PREVIOUS` with no `_UNTIL` is a boot refusal and never a warning. The check
  // lives beside the pair rather than in the verifier so a unit test can pin it
  // without starting the app; the undo is one edit, and docs/security.md carries
  // it, because this refusal is itself a way to keep the unit down mid-rotation.
  const rotationPrevious = merged.githubApp.webhookSecretPrevious ?? ''
  const rotationUntil = merged.githubApp.webhookSecretPreviousUntil ?? ''
  if (rotationPrevious !== '') {
    if (rotationUntil === '') {
      throw new Error('GITHUB_APP_WEBHOOK_SECRET_PREVIOUS is set but GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL is empty, so the overlap would never end. Unset GITHUB_APP_WEBHOOK_SECRET_PREVIOUS, or set GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL to the ISO 8601 instant the old secret stops being accepted.')
    }
    if (Number.isNaN(Date.parse(rotationUntil))) {
      throw new Error(`GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL (${rotationUntil}) is not an ISO 8601 timestamp, so the overlap would never close. Fix the value, or unset GITHUB_APP_WEBHOOK_SECRET_PREVIOUS.`)
    }
  }
  if (merged.plan.reminderDays >= merged.plan.expiryDays) {
    throw new Error(`PLAN_REMINDER_DAYS (${merged.plan.reminderDays}) must be smaller than PLAN_EXPIRY_DAYS (${merged.plan.expiryDays}); a reminder at or after the deadline is sent immediately.`)
  }
  // #458: these values have no recognisable shape, so the one redactor is told
  // them here, once, before anything can log, store or mail them.
  registerRedactionSecrets([
    merged.sessionSecret,
    merged.tokenEncryptionKey,
    merged.github.clientSecret,
    merged.githubApp.webhookSecret,
    merged.githubApp.webhookSecretPrevious ?? '',
    merged.mail.smtp.pass,
    merged.llm.key,
    merged.runner.bridgeToken,
    merged.metrics.token,
  ])
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
