import type { RepoRow } from '../db.js'

export interface PrRef {
  owner: string
  name: string
  number: number
}

export type PrUrlResult = { ok: true; ref: PrRef } | { ok: false; reason: string }

// Only an absolute http(s) URL has an origin we can compare. Everything else is
// treated as "not recorded", not as a wildcard.
function originOf(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  return `${url.protocol}//${url.host}`
}

// The web host behind an API base: drop the `api.` label and ignore any path,
// so `https://api.github.com` and `https://api.ghe.example.com/api/v3` map to
// the hosts a browser would use. The API base is the fallback only for rows
// written before the html_url columns existed.
function webOriginOf(apiBase: string): string | undefined {
  const origin = originOf(apiBase)
  if (origin === undefined) return undefined
  const url = new URL(origin)
  const host = url.host.startsWith('api.') ? url.host.slice('api.'.length) : url.host
  return `${url.protocol}//${host}`
}

// The origin a pull request for this repository must live on. Recorded
// html_url first (upstream, then fork), otherwise derived from the API base;
// undefined means "cannot tell", which callers must treat as a refusal.
export function prOrigin(repo: Pick<RepoRow, 'upstream_html_url' | 'fork_html_url'>, apiBase: string): string | undefined {
  for (const recorded of [repo.upstream_html_url, repo.fork_html_url]) {
    if (recorded === null || recorded === '') continue
    const origin = originOf(recorded)
    if (origin !== undefined) return origin
  }
  return webOriginOf(apiBase)
}

// A pull request or issue URL is accepted only when its scheme+host is the
// repository's own origin and its path names this repository's owner/name and a
// number. Both kinds share this one definition; the merge path only takes pull
// requests, while a job callback may report either.
function parseRepoResourceUrl(repo: RepoRow, value: string, apiBase: string, kind: 'pull' | 'issues'): PrUrlResult {
  const owner = repo.upstream_owner || repo.owner
  const name = repo.upstream_name || repo.name
  const what = kind === 'pull' ? 'pull request' : 'issue'
  const expected = prOrigin(repo, apiBase)
  if (expected === undefined) {
    return { ok: false, reason: `cannot determine the expected origin for ${owner}/${name}: no recorded html_url and API base ${apiBase} is not a URL` }
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: `${what} URL ${value} is not a valid URL` }
  }
  // WHATWG keeps `user:pass@` outside `host`, so `https://x@github.example/...`
  // compares equal to the repository origin while the URL still reads like a
  // different host. A job callback has no reason to carry credentials.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: `${what} URL ${value} carries credentials` }
  }
  const actual = `${url.protocol}//${url.host}`
  if (actual !== expected) {
    return { ok: false, reason: `${what} host ${actual} is not ${expected}` }
  }
  const prefix = `/${owner}/${name}/${kind}/`
  if (!url.pathname.startsWith(prefix)) {
    return { ok: false, reason: `${what} URL ${url.pathname} does not belong to repository ${owner}/${name}` }
  }
  const match = /^(\d+)\/?$/.exec(url.pathname.slice(prefix.length))
  if (match === null) {
    return { ok: false, reason: `${what} URL ${url.pathname} is not ${owner}/${name}/${kind}/<number>` }
  }
  return { ok: true, ref: { owner, name, number: Number(match[1]) } }
}

// The single definition used by the merge path and by head resolution.
export function parsePrUrl(repo: RepoRow, prUrl: string, apiBase: string): PrUrlResult {
  return parseRepoResourceUrl(repo, prUrl, apiBase, 'pull')
}

// A callback also reports the issue a job opened; it shares the origin rule.
export function parseIssueUrl(repo: RepoRow, issueUrl: string, apiBase: string): PrUrlResult {
  return parseRepoResourceUrl(repo, issueUrl, apiBase, 'issues')
}
