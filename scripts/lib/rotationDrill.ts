import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import type { FastifyRequest } from 'fastify'
import type { Store } from '../../src/db.js'
import { authenticateApiToken } from '../../src/lib/apiToken.js'
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../../src/lib/secrets.js'

// #1236: a drill, not a rotation. It mints a job token and an instance token
// against a throwaway database, proves both resolve, revokes and replaces them,
// then proves the old values are refused and the new ones work. The "use" step is
// the same `authenticateApiToken` the gateway and the credential endpoint call,
// so the drill exercises the rule that decides 401/403 rather than a copy of it.
export interface RotationDrillInput {
  store: Store
  userId: string
  repoId: string
  jobId: string
  /** A throwaway TOKEN_ENCRYPTION_KEY; the drill never touches the live one. */
  key: string
  random?: (bytes?: number) => string
}

export interface RotationDrillResult {
  ok: boolean
  steps: string[]
  reason?: string
}

const GATEWAY_SCOPE = 'gateway' as const

function requestWith(token: string): FastifyRequest {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as FastifyRequest
}

function accepted(store: Store, token: string): boolean {
  return authenticateApiToken(requestWith(token), store, GATEWAY_SCOPE).kind === 'ok'
}

export function runRotationDrill(input: RotationDrillInput): RotationDrillResult {
  const { store, userId, repoId, jobId, key } = input
  const random = input.random ?? randomToken
  const steps: string[] = []
  const audit = (action: string, detail: string): void => {
    store.audit(userId, `rotation.drill.${action}`, detail)
  }
  const mint = (): string => `flg_${random(32)}`
  const create = (kind: string, name: string, raw: string): string =>
    store.createApiToken({
      id: `tok_${random(8)}`,
      userId,
      kind,
      name,
      tokenHash: sha256Hex(raw),
      prefix: raw.slice(0, 8),
      repoId,
      scope: GATEWAY_SCOPE,
      expiresAt: null,
    }).id

  const oldJob = mint()
  const oldInstance = mint()
  const oldJobId = create('job', `job:${jobId}`, oldJob)
  const oldInstanceId = create('instance', `flybot:${repoId}`, oldInstance)
  audit('minted', `job=${jobId} repo=${repoId}`)
  steps.push('minted a job token and an instance token')

  if (!accepted(store, oldJob) || !accepted(store, oldInstance)) {
    audit('failed', 'an old token was not accepted before rotation')
    return { ok: false, steps, reason: 'an old token was not accepted before rotation' }
  }
  steps.push('accepted both old tokens')

  const newJob = mint()
  const newInstance = mint()
  store.revokeApiToken(oldJobId, userId)
  store.revokeApiToken(oldInstanceId, userId)
  create('job', `job:${jobId}`, newJob)
  create('instance', `flybot:${repoId}`, newInstance)
  const bridge = random(32)
  if (decryptSecret(encryptSecret(bridge, key), key) !== bridge) {
    audit('failed', 'the bridge token did not decrypt after re-sealing')
    return { ok: false, steps, reason: 'the bridge token did not decrypt after re-sealing' }
  }
  audit('rotated', `job=${jobId} repo=${repoId}`)
  steps.push('revoked the old tokens, minted replacements and re-sealed the bridge token')

  if (accepted(store, oldJob) || accepted(store, oldInstance)) {
    audit('failed', 'an old token is still accepted after rotation')
    return { ok: false, steps, reason: 'an old token is still accepted after rotation' }
  }
  if (!accepted(store, newJob) || !accepted(store, newInstance)) {
    audit('failed', 'a replacement token was refused')
    return { ok: false, steps, reason: 'a replacement token was refused' }
  }
  steps.push('refused both old tokens and accepted both replacements')
  audit('passed', `job=${jobId} repo=${repoId}`)
  return { ok: true, steps }
}

// The CLI always uses a fresh temporary directory, but a caller may pass
// `--db`. This guard is the one rule that decides whether a path is safe to
// write: production, the configured live DB/DATA_DIR, or anywhere outside the
// temporary root is refused before the file is opened.
export function drillDbRefusal(input: {
  dbPath?: string
  env?: NodeJS.ProcessEnv
  tempRoot?: string
}): string | null {
  const env = input.env ?? process.env
  if (env.NODE_ENV === 'production') return 'refusing to run with NODE_ENV=production'
  if (input.dbPath === undefined) return null
  const target = resolve(input.dbPath)
  const root = resolve(input.tempRoot ?? tmpdir())
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    return 'refusing a database outside the temporary directory'
  }
  const live = [env.DB_PATH, env.DATA_DIR]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .map((value) => resolve(value))
  for (const path of live) {
    if (target === path || target.startsWith(`${path}${sep}`)) {
      return 'refusing the configured live database path'
    }
  }
  return null
}
