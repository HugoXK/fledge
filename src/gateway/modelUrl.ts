import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isBlockedIpAddress } from '../lib/ipAddress.js'

export async function assertSafeModelUrl(raw: string, allowPrivate: boolean): Promise<string> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Base URL 不是合法 URL')
  }
  if (url.username !== '' || url.password !== '') throw new Error('Base URL 不能包含用户名或密码')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Base URL 必须是 https:// 或 http://')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (allowPrivate) return url.toString().replace(/\/$/, '')
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (url.protocol === 'http:') throw new Error('公网模型服务必须使用 https://')
  if (loopback) throw new Error('不允许使用本机/内网地址')
  if (isIP(host) !== 0) {
    if (isBlockedIpAddress(host)) throw new Error('不允许使用内网地址')
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
    if (isBlockedIpAddress(entry.address)) {
      throw new Error('不允许使用解析到内网地址的域名')
    }
  }
  return url.toString().replace(/\/$/, '')
}
