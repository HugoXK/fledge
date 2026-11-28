import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isBlockedIpAddress } from '../lib/ipAddress.js'

export interface ProviderPolicy {
  allowlist: ReadonlySet<string>
  requiredRegion: string
}

export interface ProviderIdentity {
  id: string
  region: string
  allowed: number
}

export interface ProviderPolicyRefusal {
  code: 'FLEDGE_PROVIDER_DISABLED' | 'FLEDGE_PROVIDER_NOT_ALLOWED' | 'FLEDGE_PROVIDER_REGION_NOT_ALLOWED'
  message: string
}

const PROVIDER_ID = /^[A-Za-z0-9_-]{1,80}$/

export function parseProviderAllowlist(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.trim() === '') return []
  const ids = raw.split(',').map((id) => id.trim()).filter((id) => PROVIDER_ID.test(id))
  return [...new Set(ids)].slice(0, 200)
}

export function normalizeProviderRegion(raw: string | null | undefined): string {
  return Array.from(raw ?? '')
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
    .trim()
    .slice(0, 80)
}

export function normalizeDataPolicyUrl(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return ''
  if (trimmed.length > 2048) throw new Error('数据政策 URL 太长')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('数据政策 URL 不是合法 URL')
  }
  if (url.username !== '' || url.password !== '') throw new Error('数据政策 URL 不能包含用户名或密码')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('数据政策 URL 必须是 https:// 或 http://')
  return url.toString()
}

export function providerPolicyRefusal(provider: ProviderIdentity, policy: ProviderPolicy): ProviderPolicyRefusal | null {
  if (provider.allowed !== 1) {
    return { code: 'FLEDGE_PROVIDER_DISABLED', message: 'This model provider is disabled by its owner.' }
  }
  if (policy.allowlist.size > 0 && !policy.allowlist.has(provider.id)) {
    return { code: 'FLEDGE_PROVIDER_NOT_ALLOWED', message: 'This model provider is outside the repository allowlist.' }
  }
  const required = normalizeProviderRegion(policy.requiredRegion).toLowerCase()
  if (required !== '' && normalizeProviderRegion(provider.region).toLowerCase() !== required) {
    return { code: 'FLEDGE_PROVIDER_REGION_NOT_ALLOWED', message: `This model provider does not match the repository region (${required}).` }
  }
  return null
}

export type ModelAddressResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>

export interface PinnedModelDestination {
  url: string
  addresses: Array<{ address: string; family: number }>
}

const RESOLVE_TIMEOUT_MS = 5_000

const defaultResolver: ModelAddressResolver = (hostname) => lookup(hostname, { all: true })

// #1319: a seam for the test that must replay two DNS answers (public when the
// provider is saved, loopback when it is used). Production never sets it; the
// default is node:dns. Each node:test file runs in its own process, so the
// override cannot leak between suites.
let resolverForTest: ModelAddressResolver | null = null

export function setModelAddressResolverForTest(resolver: ModelAddressResolver | null): void {
  resolverForTest = resolver
}

function activeResolver(): ModelAddressResolver {
  return resolverForTest ?? defaultResolver
}

async function resolveAddresses(resolver: ModelAddressResolver, hostname: string): Promise<Array<{ address: string; family: number }>> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      resolver(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('解析域名超时')), RESOLVE_TIMEOUT_MS)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function parseModelBaseUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Base URL 不是合法 URL')
  }
  if (url.username !== '' || url.password !== '') throw new Error('Base URL 不能包含用户名或密码')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Base URL 必须是 https:// 或 http://')
  return url
}

// #1319: the save-time guard and the use-time guard are one function. It
// resolves the host once and returns the addresses the caller may connect to,
// so the connection can pin them instead of asking DNS again. The URL keeps the
// hostname for Host/SNI and for the caller's own record.
export async function resolveSafeModelUrl(raw: string, allowPrivate: boolean, resolver: ModelAddressResolver = activeResolver()): Promise<PinnedModelDestination> {
  const url = parseModelBaseUrl(raw)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(host)
  if (!allowPrivate) {
    const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    if (url.protocol === 'http:') throw new Error('公网模型服务必须使用 https://')
    if (loopback) throw new Error('不允许使用本机/内网地址')
    if (family !== 0 && isBlockedIpAddress(host)) throw new Error('不允许使用内网地址')
  }
  if (family !== 0) {
    return { url: url.toString().replace(/\/$/, ''), addresses: [{ address: host, family: family === 6 ? 6 : 4 }] }
  }
  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await resolveAddresses(resolver, host)
  } catch (error) {
    if (error instanceof Error && error.message === '解析域名超时') throw error
    throw new Error('无法解析这个域名')
  }
  if (addresses.length === 0) throw new Error('无法解析这个域名')
  if (!allowPrivate) {
    for (const entry of addresses) {
      if (isBlockedIpAddress(entry.address)) throw new Error('不允许使用解析到内网地址的域名')
    }
  }
  return { url: url.toString().replace(/\/$/, ''), addresses }
}

export async function assertSafeModelUrl(raw: string, allowPrivate: boolean, resolver?: ModelAddressResolver): Promise<string> {
  return (await resolveSafeModelUrl(raw, allowPrivate, resolver)).url
}
