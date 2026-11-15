#!/usr/bin/env node
// Dispatch the daily release workflow from a reliable scheduler.
//
// GitHub's `schedule` event is best-effort and can arrive hours late. This
// script is the external trigger: a host cron or a Cloudflare Worker calls it
// at 14:30Z (22:30 Asia/Shanghai), and GitHub's own schedule remains the
// fallback. It only calls the workflow_dispatch endpoint; the workflow's
// `release-trigger` predicate still decides whether the slot needs filling, so
// a late schedule after this run is a no-op.
//
// The token is read from GITHUB_TOKEN, never from argv, and is never printed.
// GITHUB_REPOSITORY must be owner/name.

const WORKFLOW = 'daily-release.yml'

function fail(message) {
  process.stderr.write(`trigger-release: ${message}\n`)
  process.exit(1)
}

export async function dispatchRelease({ repo, token, fetchImpl = globalThis.fetch, ref = 'main', workflow = WORKFLOW }) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repo ?? ''))) throw new Error('GITHUB_REPOSITORY must be owner/name')
  if (typeof token !== 'string' || token === '') throw new Error('GITHUB_TOKEN is required')
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation')
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref, inputs: { dry_run: 'false' } }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`workflow dispatch answered ${String(response.status)}${text === '' ? '' : `: ${text.slice(0, 200)}`}`)
  }
  return { ok: true, at: new Date().toISOString(), repo, workflow, ref }
}

async function main() {
  const repo = String(process.env.GITHUB_REPOSITORY ?? '')
  const token = String(process.env.GITHUB_TOKEN ?? '')
  if (repo === '') fail('GITHUB_REPOSITORY is not set')
  if (token === '') fail('GITHUB_TOKEN is not set')
  try {
    const result = await dispatchRelease({ repo, token })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
