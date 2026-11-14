#!/usr/bin/env node
// One verification command for a release (issue #280).
//
//   METRICS_TOKEN=… node scripts/verify-release.mjs --version 0.3.2 --base-url https://fledge.example
//   node scripts/verify-release.mjs --version 0.3.2 --fixtures status.json --json
//
// Reads the chain back from the API — plan, release branch, pull request,
// annotated tag, image digest, SBOM, provenance attestation, GitHub Release and
// the running `/healthz` — and exits non-zero when any link is missing or
// disagrees. `--local-image-digest` adds the one link the API cannot answer: the
// image this host is about to run, read locally by the operator (#462). It
// writes nothing: no deploy, no tag, no merge, no comment. The token is read
// from the environment and used only as a request header; it never appears in an
// argument or in the output.
//
// Exit codes: 0 the chain is complete, 1 a link is missing or disagrees,
// 2 the command could not read its input (never a green verdict).

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { evaluateReleaseStatus } from './lib/release-status.mjs'
import { assessDeploymentDrift } from './lib/deployment-drift.mjs'

const VERSION = /^\d+\.\d+\.\d+$/

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return ''
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${name} needs a value`)
  }
  return value
}

class UsageError extends Error {}

function has(name) {
  return process.argv.includes(name)
}

function readJsonFile(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { ok: false, reason: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function readPackageVersion(path) {
  const file = readJsonFile(path)
  if (!file.ok) return { version: '', reason: file.reason }
  const version = String(file.value?.version ?? '')
  return VERSION.test(version) ? { version, reason: '' } : { version: '', reason: `${path} has no readable version` }
}

// The release body is the durable record the publish job writes; the three lines
// are the only place the digest, the SBOM and the attestation are readable
// without a registry credential.
export function publishedChainFromBody(body) {
  const text = String(body ?? '')
  const image = /^Image:\s*(\S+)@(sha256:[0-9a-f]{64})\s*$/m.exec(text)
  const sbom = /^SBOM:\s*(\S+)\s*$/m.exec(text)
  const attestation = /^Attestation:\s*(sha256:[0-9a-f]{64})\s*$/m.exec(text)
  return {
    image: image === null ? null : { tag: image[1] ?? '', digest: image[2] ?? '' },
    sbom: sbom === null ? null : { present: true, name: sbom[1] ?? '' },
    attestation: attestation === null ? null : { present: true, subjectDigest: attestation[1] ?? '' },
  }
}

function apiClient(repo, token, fetchImpl) {
  return async (path) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` },
    })
    const text = await response.text()
    let payload = null
    if (text !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = null
      }
    }
    return { status: Number(response.status ?? 0), payload }
  }
}

// The plan is not stored anywhere durable; the release pull request body is what
// the plan wrote (`at the plan's base main <sha>`), and its `created_at` is when
// that plan reached the repository. A body without the line is reported, never
// guessed.
function planFromPull(pull) {
  const body = String(pull?.body ?? '')
  const match = /at the plan's base `main` `([0-9a-f]{40})`/.exec(body)
  if (match === null) return null
  return { version: String(pull?.__version ?? ''), mainSha: match[1] ?? '', plannedAt: String(pull?.created_at ?? '') }
}

async function collect({ version, repo, token, baseUrl, packageVersion, fetchImpl, metricsToken = '', localImageDigest = '' }) {
  const api = apiClient(repo, token, fetchImpl)
  const owner = String(repo).split('/')[0] ?? ''
  const branchName = `release/v${version}`

  const pullList = await api(`/pulls?head=${owner}:${encodeURIComponent(branchName)}&state=all&per_page=10`)
  const pulls = Array.isArray(pullList.payload) ? pullList.payload : []
  const releasePull = pulls.find((entry) => String(entry?.title ?? '') === `release: v${version}`) ?? null

  const branchAnswer = await api(`/branches/${encodeURIComponent(branchName)}`)
  const branch =
    branchAnswer.status === 404
      ? { name: branchName, tip: String(releasePull?.head?.sha ?? ''), deleted: true }
      : branchAnswer.status === 200 && branchAnswer.payload !== null
        ? { name: branchName, tip: String(branchAnswer.payload?.commit?.sha ?? ''), deleted: false }
        : null

  const refAnswer = await api(`/git/ref/tags/v${version}`)
  let tag = null
  if (refAnswer.status === 200 && refAnswer.payload !== null) {
    const objectType = String(refAnswer.payload?.object?.type ?? '')
    const objectSha = String(refAnswer.payload?.object?.sha ?? '')
    if (objectType === 'tag') {
      const annotated = await api(`/git/tags/${objectSha}`)
      tag = {
        name: `v${version}`,
        objectSha,
        objectType,
        targetSha: String(annotated.payload?.object?.sha ?? ''),
      }
    } else {
      // An unannotated tag is reported as such: the release tag is an annotated
      // object, so its absence of a tag object is the finding.
      tag = { name: `v${version}`, objectSha, objectType, targetSha: objectSha }
    }
  }

  const releaseAnswer = await api(`/releases/tags/v${version}`)
  const releasePayload = releaseAnswer.status === 200 ? releaseAnswer.payload : null
  const chain = publishedChainFromBody(releasePayload?.body)
  const release =
    releasePayload === null
      ? null
      : {
          url: String(releasePayload?.html_url ?? ''),
          tagName: String(releasePayload?.tag_name ?? ''),
          publishedAt: String(releasePayload?.published_at ?? ''),
          draft: releasePayload?.draft === true,
        }

  let healthz = null
  if (baseUrl !== '') {
    try {
      // #236: `/healthz` serves `commit`/`builtAt` only on the METRICS_TOKEN
      // bearer, so the running-instance link needs the same credential the
      // /metrics scrape uses. Without it the probe still answers 200 but carries
      // no commit, and this comparison would read "mismatch" on a healthy deploy.
      const response = await fetchImpl(`${baseUrl}/healthz`, {
        signal: AbortSignal.timeout(10_000),
        headers: metricsToken === '' ? {} : { authorization: `Bearer ${metricsToken}` },
      })
      if (response.ok) {
        const payload = await response.json()
        healthz = { version: String(payload?.version ?? ''), commit: String(payload?.commit ?? '') }
      }
    } catch {
      healthz = null
    }
  }

  const planned = planFromPull(releasePull === null ? null : { ...releasePull, __version: version })
  return {
    version,
    packageVersion,
    checkedAt: new Date().toISOString(),
    baseUrl,
    plan: planned,
    branch,
    pull:
      releasePull === null
        ? null
        : {
            number: Number(releasePull?.number ?? 0),
            state: String(releasePull?.merged_at ?? '').length > 0 ? 'merged' : String(releasePull?.state ?? ''),
            headSha: String(releasePull?.head?.sha ?? ''),
            mergeCommitSha: String(releasePull?.merge_commit_sha ?? ''),
            mergedAt: String(releasePull?.merged_at ?? ''),
            base: String(releasePull?.base?.ref ?? ''),
          },
    tag,
    image: chain.image,
    sbom: chain.sbom,
    attestation: chain.attestation,
    release,
    healthz,
    localImageDigest,
  }
}

function printStatus(status) {
  const verdict = status.ok ? 'release-status: ok' : 'release-status: not released'
  const lines = [`${verdict} — v${status.version}${status.checkedAt === '' ? '' : ` (checked ${status.checkedAt})`}`]
  for (const entry of status.links) {
    lines.push(`${entry.id.padEnd(12)} ${entry.state.padEnd(9)} ${entry.detail}`)
  }
  for (const problem of status.problems) lines.push(`problem: ${problem}`)
  return lines.join('\n')
}

function repoFromEnvironment() {
  const repo = String(process.env.GITHUB_REPOSITORY ?? '')
  return /^[^/\s]+\/[^/\s]+$/.test(repo) ? repo : ''
}

async function main() {
  if (has('--help')) {
    console.log('node scripts/verify-release.mjs --version X.Y.Z [--base-url URL] [--fixtures FILE] [--deployment FILE] [--local-image-digest sha256:…] [--write FILE] [--json]')
    return 0
  }
  const fixtures = argument('--fixtures')
  const wanted = argument('--version')
  const baseUrl = argument('--base-url').replace(/\/$/, '')
  const deploymentPath = argument('--deployment')
  const write = argument('--write')
  const localDigest = argument('--local-image-digest')
  const json = has('--json')
  const packagePath = argument('--package')

  const local = readPackageVersion(packagePath === '' ? new URL('../package.json', import.meta.url) : packagePath)
  // A named `--package` is the tree that will actually run, so an unreadable one
  // is exit 2 rather than a skipped link: the start hook must not pass a host it
  // could not read.
  if (packagePath !== '' && local.version === '') throw new UsageError(local.reason || `${packagePath} has no readable version`)
  const version = wanted === '' ? local.version : wanted
  if (!VERSION.test(version)) {
    throw new UsageError(wanted === '' ? `no --version and ${local.reason || 'no readable package.json'}` : `"${wanted}" is not an X.Y.Z version`)
  }

  let input
  if (fixtures !== '') {
    const file = readJsonFile(fixtures)
    if (!file.ok) throw new UsageError(file.reason)
    const payload = file.value ?? {}
    // A recorded chain carries the digest the release step compared; the flag
    // overrides it, so a replay can still be asked about another image. The same
    // holds for the tree: `--package` names the one that will run, so it beats
    // the version the record was written with — that is how the start hook
    // notices an upgrade the release step never recorded.
    input = {
      ...payload,
      version,
      packageVersion: packagePath === '' ? String(payload.packageVersion ?? local.version) : local.version,
      baseUrl: baseUrl === '' ? String(payload.baseUrl ?? '') : baseUrl,
      localImageDigest: localDigest === '' ? String(payload.localImageDigest ?? '') : localDigest,
    }
  } else {
    const repo = argument('--repo') || repoFromEnvironment()
    const token = String(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '')
    if (repo === '') throw new UsageError('no repository: set GITHUB_REPOSITORY or pass --repo owner/name')
    if (token === '') throw new UsageError('no token: set GITHUB_TOKEN or pass --fixtures to replay a recorded chain')
    input = await collect({
      version,
      repo,
      token,
      baseUrl,
      packageVersion: local.version,
      fetchImpl: fetch,
      metricsToken: String(process.env.METRICS_TOKEN ?? ''),
      localImageDigest: localDigest,
    })
  }

  let status = evaluateReleaseStatus(input)
  if (deploymentPath !== '') {
    const file = readJsonFile(deploymentPath)
    if (!file.ok) throw new UsageError(file.reason)
    // The recorded deployment is compared with the tag this chain read back.
    // A failed or unreadable comparison is a red link, not a silent pass; the
    // script still writes nothing and never contacts the host.
    const drift = assessDeploymentDrift({
      deployment: file.value ?? null,
      release: { version: status.version, commit: status.targetSha, tag: `v${status.version}`, url: status.releaseUrl },
      healthz: input.healthz ?? null,
    })
    const state = drift.state === 'ok' ? 'ok' : drift.state === 'unknown' ? 'skipped' : 'mismatch'
    status = {
      ...status,
      ok: status.ok && !drift.alert,
      links: [...status.links, { id: 'deployment', state, detail: `${drift.state}: ${drift.summary}` }],
      problems: drift.alert ? [...status.problems, `deployment: ${drift.summary}`] : status.problems,
      deployment: drift,
    }
  }
  if (json) console.log(JSON.stringify(status, null, 2))
  else console.log(printStatus(status))
  if (write !== '') {
    try {
      // The file is both the snapshot the console renders and the record the
      // start hook replays (#462). Writing the verdict alone would make the
      // replay prove nothing, so the chain it was judged from is written beside
      // it; `--fixtures` reads the same fields back.
      writeFileSync(write, `${JSON.stringify({ ...input, ...status }, null, 2)}\n`)
    } catch (error) {
      throw new UsageError(`cannot write ${write}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return status.ok ? 0 : 1
}

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
  try {
    process.exitCode = await main()
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`verify-release: ${error.message}`)
      process.exitCode = 2
    } else {
      console.error(`verify-release: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 2
    }
  }
}
