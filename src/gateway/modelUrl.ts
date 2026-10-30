import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  )
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase()
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')
}

export async function assertSafeModelUrl(raw: string, allowPrivate: boolean): Promise<string> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Base URL 不是合法 URL')
  }
  if (url.username !== '' || url.password !== '') throw new Error('Base URL 不能包含用户名或密码')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Base URL 必须是 https://（本地开发可用 http://）')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (url.protocol === 'http:' && !(allowPrivate && loopback)) throw new Error('公网模型服务必须使用 https://')
  if (loopback) {
    if (!allowPrivate) throw new Error('不允许使用本机/内网地址')
    return url.toString().replace(/\/$/, '')
  }
  if (isIP(host) !== 0) {
    if (isPrivateIpv4(host) || isPrivateIpv6(host)) throw new Error('不允许使用内网地址')
    return url.toString().replace(/\/$/, '')
  }
  let addresses
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new Error('无法解析这个域名')
  }
  if (addresses.length === 0) throw new Error('无法解析这个域名')
  for (const entry of addresses) {
    if (entry.family === 4 ? isPrivateIpv4(entry.address) : isPrivateIpv6(entry.address)) {
      throw new Error('不允许使用解析到内网地址的域名')
    }
  }
  return url.toString().replace(/\/$/, '')
}
