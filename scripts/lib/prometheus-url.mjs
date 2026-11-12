// The one place that decides what URL the SLO report queries and whether a
// credential travels with it. Node copies a URL it cannot use into its own error
// text (`Failed to parse URL from <input>` and `Request cannot be constructed
// from a URL that includes credentials: <url>`), which puts a password into a
// terminal, a CI log or a shell capture. So a value carrying credentials, or one
// that does not parse, is refused here — before `fetch` — and no refusal
// interpolates the value it refuses.

export const DEFAULT_URL = 'http://127.0.0.1:9090'

// A header over cleartext is acceptable only while it never leaves the host.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

// `URL.hostname` keeps the brackets on an IPv6 literal, so both forms are here.
export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname)
}

export function resolvePrometheusRequest(env = {}) {
  const raw = env.PROMETHEUS_URL ?? DEFAULT_URL
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return { refusal: 'PROMETHEUS_URL is not a valid URL; set it to an http(s) base such as http://127.0.0.1:9090' }
  }
  // `new URL()` does not throw on credentials: it fills `username` and
  // `password`. The test is on those fields, never on the character `@`, which
  // is legal in a path or a query.
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      refusal:
        'PROMETHEUS_URL carries a username or password; a URL with credentials is refused, not scrubbed — put the credential in PROMETHEUS_AUTH_HEADER',
    }
  }
  const authHeader = String(env.PROMETHEUS_AUTH_HEADER ?? '').trim()
  if (authHeader !== '' && parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    return {
      refusal:
        'PROMETHEUS_AUTH_HEADER would be sent over cleartext to a non-loopback host; use an https: PROMETHEUS_URL or drop the header',
    }
  }
  return { url: parsed.href.replace(/\/$/, ''), authHeader }
}

// The request is built here, not by the CLI, so there is one place that decides
// whether an `authorization` header is attached at all. `fetchImpl` is injected
// because the suites assert on the request object rather than a child process.
export function createPrometheusClient({ baseUrl, authHeader = '', fetchImpl }) {
  async function query(expr) {
    const url = `${baseUrl}/api/v1/query?query=${encodeURIComponent(expr)}`
    const init = authHeader === '' ? {} : { headers: { authorization: authHeader } }
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`Prometheus ${response.status}`)
    const body = await response.json()
    if (body.status !== 'success') throw new Error(body.error ?? 'Prometheus query failed')
    const value = body.data?.result?.[0]?.value?.[1]
    return value === undefined ? null : Number(value)
  }
  return { query }
}

export async function runPrometheusQueries({ env = {}, exprs, fetchImpl }) {
  const resolved = resolvePrometheusRequest(env)
  if (resolved.refusal !== undefined) return { refusal: resolved.refusal }
  const client = createPrometheusClient({ baseUrl: resolved.url, authHeader: resolved.authHeader, fetchImpl })
  const values = []
  for (const expr of exprs) values.push(await client.query(expr))
  return { values }
}
