// Shared wiring for the two gate CLIs (scripts/review-gate.mjs and
// scripts/gate-repair.mjs): one API client, one event reader, one policy loader,
// one pull-request resolver. Both run in Actions with the same environment.
import { readFileSync } from 'node:fs'

export function readEvent(eventPath) {
  if (eventPath === '') return {}
  try {
    return JSON.parse(readFileSync(eventPath, 'utf8'))
  } catch {
    return {}
  }
}

export function arg(argv, name, fallback) {
  const index = argv.indexOf(name)
  if (index === -1) return fallback
  return argv[index + 1] ?? fallback
}

// `--pr` wins (the issue_comment job passes the event's issue number); otherwise
// the pull_request, merge_group or GITHUB_REF shape decides, in that order.
export function pullRequestNumber(ev, override) {
  return Number(
    override ?? ev.pull_request?.number ?? /pr-(\d+)-/.exec(ev.merge_group?.head_ref ?? '')?.[1] ?? /refs\/pull\/(\d+)\//.exec(process.env.GITHUB_REF ?? '')?.[1] ?? '0',
  )
}

// `init` carries a method for the one write the repair step performs. A 202/204
// answers no body, so the body is parsed only when there is one.
export function apiClient({ token, base, userAgent }) {
  return async function api(path, init = {}) {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': userAgent,
      },
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) throw new Error(`GitHub ${response.status} ${path}: ${text.slice(0, 200)}`)
    return text === '' ? null : JSON.parse(text)
  }
}

// The policy is always read from the base ref, never from the pull request tree.
// With no event file (local run) the working tree's copy is used instead.
export async function loadPolicy({ api, repo, ev, eventPath, localPolicy }) {
  if (eventPath === '') return localPolicy
  const baseRef = String(ev.pull_request?.base?.ref ?? ev.merge_group?.base_ref ?? 'main').replace(/^refs\/heads\//, '')
  const file = await api(`/repos/${repo}/contents/.github/agent/review-policy.json?ref=${encodeURIComponent(baseRef)}`)
  if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error('unexpected policy response')
  return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
}
