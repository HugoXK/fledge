import http from 'node:http'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { RepoInstanceRow, RepoRow } from '../db.js'
import { log } from '../lib/log.js'

const cookieCache = new Map<string, { cookie: string; at: number }>()

function lastDshToken(instance: RepoInstanceRow): string {
  try {
    const text = readFileSync(join(instance.data_dir, 'dsh-web.log'), 'utf8')
    const matches = [...text.matchAll(/token=([A-Za-z0-9_-]+)/g)]
    return matches.at(-1)?.[1] ?? ''
  } catch {
    return ''
  }
}

export async function dshCookie(instance: RepoInstanceRow): Promise<string> {
  const cached = cookieCache.get(instance.repo_id)
  if (cached !== undefined && Date.now() - cached.at < 5 * 60_000) return cached.cookie
  const token = lastDshToken(instance)
  if (token === '') throw new Error('DSH token 还没有写入日志')
  const response = await fetch(`http://127.0.0.1:${instance.dsh_port}/?token=${encodeURIComponent(token)}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const cookie = cookies.map((entry) => entry.split(';')[0]).join('; ')
  if (cookie === '') throw new Error(`DSH 没有返回会话 cookie（HTTP ${response.status}）`)
  cookieCache.set(instance.repo_id, { cookie, at: Date.now() })
  return cookie
}

export function workspacePrefix(repoId: string): string {
  return `/repos/${repoId}/workspace/app/`
}

export function rewriteWorkspaceHtml(html: string, repo: RepoRow, prefix: string): string {
  const title = `Fledge · ${repo.upstream_name || repo.name}`
  let next = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '')
  if (/<title>.*?<\/title>/i.test(next)) next = next.replace(/<title>.*?<\/title>/i, `<title>${title.replace(/[<>&]/g, '')}</title>`)
  else next = next.replace(/<head([^>]*)>/i, `<head$1><title>${title.replace(/[<>&]/g, '')}</title>`)
  if (/<base\s+href=/i.test(next)) next = next.replace(/<base\s+href=["'][^"']*["'][^>]*>/i, `<base href="${prefix}">`)
  else next = next.replace(/<head([^>]*)>/i, `<head$1><base href="${prefix}">`)
  const injected = `<link rel="stylesheet" href="/assets/workspace-brand.css"><script src="/assets/workspace-brand.js" defer></script>`
  if (/<\/head>/i.test(next)) next = next.replace(/<\/head>/i, `${injected}</head>`)
  const repoName = repo.upstream_owner ? `${repo.upstream_owner}/${repo.upstream_name}` : repo.name
  next = next.replace(/<body([^>]*)>/i, `<body$1 data-fledge-repo="${repoName.replace(/["<>&]/g, '')}">`)
  return next
}

function filteredResponseHeaders(headers: http.IncomingHttpHeaders, html: boolean): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (['set-cookie', 'content-security-policy', 'x-frame-options', 'content-encoding', 'transfer-encoding', 'connection'].includes(lower)) continue
    if (html && lower === 'content-length') continue
    out[lower] = value
  }
  return out
}

function rewriteLocation(location: string, prefix: string): string {
  try {
    const url = new URL(location, 'http://fledge.local')
    if (url.origin !== 'http://fledge.local') return location
    return `${prefix.replace(/\/$/, '')}${url.pathname}${url.search}${url.hash}`
  } catch {
    return location
  }
}

export async function proxyWorkspaceHttp(request: FastifyRequest, reply: FastifyReply, instance: RepoInstanceRow, repo: RepoRow, subpath: string): Promise<void> {
  const prefix = workspacePrefix(repo.id)
  const cookie = await dshCookie(instance)
  const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (['host', 'cookie', 'content-length', 'connection', 'accept-encoding', 'origin', 'referer'].includes(lower)) continue
    headers[lower] = Array.isArray(value) ? value.join(', ') : value
  }
  const upstreamOrigin = `http://127.0.0.1:${instance.dsh_port}`
  headers.cookie = cookie
  headers.origin = upstreamOrigin
  headers.referer = `${upstreamOrigin}/`
  headers['accept-encoding'] = 'identity'
  if (raw !== undefined && raw.length > 0) headers['content-length'] = String(raw.length)
  const path = `/${subpath}`
  reply.hijack()
  const upstream = http.request({ host: '127.0.0.1', port: instance.dsh_port, method: request.method, path, headers }, (response) => {
    const contentType = String(response.headers['content-type'] ?? '')
    const html = contentType.includes('text/html')
    const responseHeaders = filteredResponseHeaders(response.headers, html)
    if (typeof response.headers.location === 'string') responseHeaders.location = rewriteLocation(response.headers.location, prefix)
    if (html) {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      response.on('end', () => {
        const body = Buffer.from(rewriteWorkspaceHtml(Buffer.concat(chunks).toString('utf8'), repo, prefix))
        reply.raw.writeHead(response.statusCode ?? 502, { ...responseHeaders, 'content-length': String(body.length), 'cache-control': 'no-store' })
        reply.raw.end(body)
      })
      response.on('error', () => {
        try { reply.raw.destroy() } catch {}
      })
      return
    }
    reply.raw.writeHead(response.statusCode ?? 502, responseHeaders)
    response.pipe(reply.raw)
  })
  upstream.on('error', (error) => {
    log.warn('workspace proxy failed', { repo: repo.id, error: String(error) })
    try {
      if (!reply.raw.headersSent) reply.raw.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      reply.raw.end('Workspace proxy error')
    } catch {}
  })
  if (raw !== undefined && raw.length > 0) upstream.write(raw)
  upstream.end()
}

export function proxyWorkspaceUpgrade(request: http.IncomingMessage, socket: net.Socket, head: Buffer, instance: RepoInstanceRow, subpath: string, cookie: string): void {
  const upstream = net.connect(instance.dsh_port, '127.0.0.1', () => {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (['host', 'cookie', 'origin', 'referer'].includes(lower)) continue
      headers[lower] = Array.isArray(value) ? value.join(', ') : value
    }
    headers.host = `127.0.0.1:${instance.dsh_port}`
    headers.cookie = cookie
    headers.origin = `http://127.0.0.1:${instance.dsh_port}`
    headers.referer = `http://127.0.0.1:${instance.dsh_port}/`
    const lines = [
      `${request.method ?? 'GET'} /${subpath} HTTP/1.1`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ]
    upstream.write(lines.join('\r\n'))
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
}
