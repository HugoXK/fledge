#!/usr/bin/env node
// Open the mechanical daily release pull request (issue #187).
//
// This is the one release step that cannot run in Actions: a pull request opened
// with `GITHUB_TOKEN` starts no `pull_request` workflow, so the release pull
// request would never get a `ci-ok`, and a required check that never runs never
// turns green. `#80`'s workflow pushes `release/v<next>`; this tool verifies that
// branch and opens exactly one pull request from it.
//
// It writes one endpoint only — `POST /pulls` — and reads the branch contents
// through the API. It never clones, never runs git, never runs the branch's own
// copies of the check scripts (that would execute the change under test), and
// carries no tag route at all: tagging stays in the daily-release workflow.
//
//   node scripts/release-open.mjs --artifact plan.json --version 0.4.0 --sha <branch tip>
//
// `GITHUB_TOKEN` is read from the environment and used only as a request header;
// it never appears in an argument. `GITHUB_REPOSITORY` (or `--repo`) names the
// repository.
//
// In Actions the token is the repository secret `RELEASE_OPEN_TOKEN` — a team
// account, never the Reviewer's account named by
// `.github/agent/review-policy.json` `requiredPass`. The tool reads `GET /user`
// and refuses when the credential belongs to that account, so the identity is a
// fact the run records, not a claim the workflow makes. A missing token is the
// `blocked` state (exit 0): the night reports it and opens nothing.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isMechanicalPath } from './lib/mechanical-release.mjs'

// The five paths the mechanical release diff is limited to; the materialised tree
// holds exactly these and nothing else, so the number of content reads is bounded.
export const SURFACE_PATHS = ['CHANGELOG.md', 'changelog.d', 'docker-compose.yml', 'package-lock.json', 'package.json']

const VERSION = /^\d+\.\d+\.\d+$/
const SHA = /^[0-9a-f]{40}$/
const RELEASE_TITLE = /^release: v/
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const COMPARE_FILE_LIMIT = 300

export function releaseBranch(version) {
  return `release/v${version}`
}

export function exitCodeFor(result) {
  // `blocked` is the unconfigured-credential state, not a failure of the night:
  // the run is green, the summary and #80 say what is missing. A `refused`
  // decision is a red run, because the branch was ready and the tool declined.
  return result?.status === 'refused' ? 1 : 0
}

function realAdapter() {
  return {
    readFile: (path) => readFileSync(path, 'utf8'),
    listDir: (path) => readdirSync(path).sort(),
    exec: (file, args, options) => {
      const result = spawnSync(file, args, { cwd: options.cwd, env: options.env, encoding: 'utf8' })
      return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    },
  }
}

function headerOf(headers, name) {
  if (headers === null || headers === undefined) return ''
  if (typeof headers.get === 'function') return String(headers.get(name) ?? '')
  const wanted = String(name).toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(Array.isArray(value) ? value.join(', ') : value)
  }
  return ''
}

function messageOf(payload) {
  if (payload !== null && typeof payload === 'object') {
    const message = payload.message ?? payload.error
    if (typeof message === 'string' && message !== '') return message
  }
  return ''
}

async function request(api, method, url, body) {
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${api.token}` }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await api.fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  return { status: Number(response.status ?? 0), payload, headers: response.headers }
}

async function apiCall(api, method, path, body) {
  return request(api, method, `https://api.github.com/repos/${api.repo}${path}`, body)
}

async function apiRoot(api, method, path) {
  return request(api, method, `https://api.github.com${path}`)
}

// The identity the policy reserves for review. A read failure yields no reserved
// login — the policy file ships beside this script, and the workflow refuses a
// missing token before this is reached — but an account the API names as the
// reviewer is refused below, so the two credentials can never be the same one.
function reservedOpenerLogins() {
  try {
    const policy = JSON.parse(readFileSync(new URL('../.github/agent/review-policy.json', import.meta.url), 'utf8'))
    const login = typeof policy?.requiredPass === 'string' ? policy.requiredPass.trim() : ''
    return login === '' ? [] : [login]
  } catch {
    return []
  }
}

async function contentFile(api, branch, path) {
  const answer = await apiCall(api, 'GET', `/contents/${path}?ref=${encodeURIComponent(branch)}`)
  if (answer.status !== 200) {
    return { ok: false, reason: `GET /contents/${path} answered ${answer.status}${messageOf(answer.payload) === '' ? '' : `: ${messageOf(answer.payload)}`}` }
  }
  const encoded = String(answer.payload?.content ?? '').replace(/\n/g, '')
  if (encoded === '' || answer.payload?.encoding !== 'base64') {
    return { ok: false, reason: `GET /contents/${path} answered no base64 content` }
  }
  return { ok: true, body: Buffer.from(encoded, 'base64') }
}

// Materialise the release surface from the branch through the API. The branch's
// other files are not needed: the two checks read only these paths.
async function materialise(api, branch, tree) {
  const fetched = []
  for (const path of SURFACE_PATHS) {
    if (path === 'changelog.d') continue
    const file = await contentFile(api, branch, path)
    if (!file.ok) return { ok: false, reason: file.reason, fetched }
    writeFileSync(join(tree, path), file.body)
    fetched.push(path)
  }
  const listing = await apiCall(api, 'GET', `/contents/changelog.d?ref=${encodeURIComponent(branch)}`)
  if (listing.status !== 200) {
    return { ok: false, reason: `GET /contents/changelog.d answered ${listing.status}${messageOf(listing.payload) === '' ? '' : `: ${messageOf(listing.payload)}`}`, fetched }
  }
  const entries = Array.isArray(listing.payload) ? listing.payload : []
  if (entries.length === 0) return { ok: false, reason: 'the branch holds no changelog.d entries', fetched }
  mkdirSync(join(tree, 'changelog.d'), { recursive: true })
  for (const entry of entries) {
    const name = String(entry?.name ?? '')
    if (name === '' || entry?.type !== 'file' || !name.endsWith('.md')) {
      return { ok: false, reason: `changelog.d holds an entry the release surface does not allow: ${name || '(unnamed)'}`, fetched }
    }
    const file = await contentFile(api, branch, `changelog.d/${name}`)
    if (!file.ok) return { ok: false, reason: file.reason, fetched }
    writeFileSync(join(tree, 'changelog.d', name), file.body)
    fetched.push(`changelog.d/${name}`)
  }
  return { ok: true, fetched }
}

function renderBody({ repo, version, plan, mainSha, branch }) {
  const total = Number(plan?.total ?? 0)
  const features = Number(plan?.features ?? 0)
  const fragments = Number(plan?.fragments ?? 0)
  const lastTag = String(plan?.lastTag ?? '')
  return [
    'Written-by: HugoXK',
    'No-issue: mechanical daily minor release',
    '',
    `Release v${version}, opened from \`${branch}\` at the plan's base \`main\` \`${mainSha}\`.`,
    '',
    `- merged pull requests${lastTag === '' ? '' : ` since \`${lastTag}\``}: **${total}** (need 10)`,
    `- features: **${features}** (need 5)`,
    `- changelog fragments: **${fragments}** (need 1)`,
    `- compare: https://github.com/${repo}/compare/${mainSha}...${branch}`,
    '',
    'Ran:',
    '- `node scripts/version.mjs check` in the materialised release tree — pass',
    '- `node scripts/changelog.mjs check` in the materialised release tree — pass',
    "Not run: this pull request's own checks; they start with this pull request, which is why it is opened by a real identity rather than by `GITHUB_TOKEN`.",
  ].join('\n')
}

/**
 * Verify the release branch and open exactly one pull request for it.
 *
 * Precedence, in this order: the credential (`2a`), then an open pull request on
 * this branch (reuse, conflict), then the plan's decision, then the write
 * preconditions (branch, temp-tree checks, exact surface, diff, main).
 */
export async function runReleaseOpen(options) {
  const {
    artifact,
    version,
    sha,
    repo = process.env.GITHUB_REPOSITORY ?? '',
    token = process.env.GITHUB_TOKEN ?? '',
    fetch: fetchImpl = globalThis.fetch,
    adapter = realAdapter(),
  } = options ?? {}

  const refuse = (reason, extra = {}) => ({ status: 'refused', reason, ...extra })

  if (typeof fetchImpl !== 'function') return refuse('no fetch implementation to call the API with')
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repo))) return refuse(`the repository "${String(repo)}" is not owner/name`)
  if (typeof token !== 'string' || token === '') {
    return { status: 'blocked', reason: 'RELEASE_OPEN_TOKEN is not set, so no release pull request was opened; add the repository secret' }
  }

  const plan = artifact?.plan ?? {}
  const wanted = String(version ?? plan.nextVersion ?? '')
  if (!VERSION.test(wanted)) return refuse(`"${wanted}" is not a release version (x.y.z)`)
  if (plan.nextVersion !== undefined && String(plan.nextVersion) !== wanted) {
    return refuse(`the artifact plans v${String(plan.nextVersion)}, not v${wanted}`)
  }
  if (!SHA.test(String(sha ?? ''))) return refuse(`"${String(sha)}" is not a commit sha`)
  const branch = releaseBranch(wanted)
  const api = { repo, token, fetch: fetchImpl }

  // (2a) What the credential can be trusted to prove: it can push, so the pull
  // request it opens will start the gated workflows. Kind and breadth are outside
  // this tool's reach; the JSON records what was observed.
  const repository = await apiCall(api, 'GET', '')
  if (repository.status === 404) return refuse(`this credential cannot see ${repo}`)
  if (repository.status !== 200) return refuse(`GET /repos/${repo} answered ${repository.status}${messageOf(repository.payload) === '' ? '' : `: ${messageOf(repository.payload)}`}`)
  const permissions = repository.payload?.permissions ?? {}
  const scopes = headerOf(repository.headers, 'x-oauth-scopes')
  if (permissions.push !== true) {
    return refuse(`the credential cannot push to ${repo} (permissions.push is ${String(permissions.push)}); nothing was written`, { permissions, scopes })
  }

  // (2b) Who this credential is. The reviewer account may post the PASS but may
  // not open the release pull request: one account holding both would let the
  // same identity author and approve the same tip.
  const who = await apiRoot(api, 'GET', '/user')
  if (who.status === 401) return refuse('the credential is not accepted by GET /user; nothing was written', { permissions, scopes })
  if (who.status !== 200) {
    return refuse(`GET /user answered ${who.status}${messageOf(who.payload) === '' ? '' : `: ${messageOf(who.payload)}`}; the credential's identity is unreadable, so nothing was written`, { permissions, scopes })
  }
  const login = String(who.payload?.login ?? '')
  if (login === '') return refuse(`GET /user did not name the credential's account; nothing was written`, { permissions, scopes })
  if (reservedOpenerLogins().includes(login)) {
    return refuse(`the credential belongs to ${login}, the review account; the release pull request must be opened by the team account, so nothing was written`, { permissions, scopes })
  }

  const open = await apiCall(api, 'GET', '/pulls?state=open&per_page=100')
  if (open.status !== 200) return refuse(`GET /pulls answered ${open.status}${messageOf(open.payload) === '' ? '' : `: ${messageOf(open.payload)}`}`, { permissions, scopes })
  const openPrs = Array.isArray(open.payload) ? open.payload : []
  const sameBranch = openPrs.filter((pr) => String(pr?.head?.ref ?? '') === branch)
  const sameTitle = (pr) => String(pr?.title ?? '') === `release: v${wanted}`
  const reuse = sameBranch.find((pr) => String(pr?.head?.sha ?? '') === sha && sameTitle(pr))
  if (reuse !== undefined) {
    // (a) Reuse, never duplicate: even a plan that says `open-release-pr` is the
    // state this branch exists to reuse.
    return { status: 'reused', reason: `pull request #${String(reuse.number)} already has ${branch} at ${sha}`, pr: Number(reuse.number), identity: login, permissions, scopes }
  }
  const conflicting = sameBranch[0]
  if (conflicting !== undefined) {
    const other = String(conflicting?.head?.sha ?? 'unknown')
    const why = other !== sha ? `at ${other}, not ${sha}` : `titled "${String(conflicting?.title ?? '')}" instead of "release: v${wanted}"`
    return refuse(`open pull request #${String(conflicting?.number)} holds ${branch} ${why}; nothing was written`, { permissions, scopes })
  }
  const otherVersion = openPrs.find((pr) => RELEASE_TITLE.test(String(pr?.title ?? '')) && String(pr?.head?.ref ?? '') !== branch)
  if (otherVersion !== undefined) {
    return refuse(`open pull request #${String(otherVersion.number)} "${String(otherVersion.title)}" on ${String(otherVersion?.head?.ref)} holds another release version; nothing was written`, { permissions, scopes })
  }
  if (plan.shouldRelease !== true) {
    return refuse(`the plan does not release tonight: ${String(plan.reason ?? 'no reason recorded')}; nothing was written`, { permissions, scopes })
  }

  // (d) Write preconditions, in the order the issue names.
  const ref = await apiCall(api, 'GET', `/git/ref/heads/${branch}`)
  if (ref.status === 404) return refuse(`branch ${branch} does not exist; the release workflow must push it first`, { permissions, scopes })
  if (ref.status !== 200) return refuse(`GET /git/ref/heads/${branch} answered ${ref.status}${messageOf(ref.payload) === '' ? '' : `: ${messageOf(ref.payload)}`}`, { permissions, scopes })
  const branchSha = String(ref.payload?.object?.sha ?? '')
  if (branchSha !== sha) return refuse(`branch ${branch} is at ${branchSha === '' ? '(unreadable)' : branchSha}, not ${sha}; nothing was written`, { permissions, scopes })

  const tree = mkdtempSync(join(tmpdir(), 'fledge-release-open-'))
  try {
    const materialised = await materialise(api, branch, tree)
    if (!materialised.ok) return refuse(materialised.reason, { permissions, scopes, fetched: materialised.fetched })

    // The checks that run are this tool's own checkout, with `cwd` in the materialised
    // tree, so the branch's copies can never execute here. `scripts/version.mjs:46`
    // reads RELEASE_TAG then GITHUB_REF_NAME, so the child environment is fixed and
    // nothing is inherited: an inherited tag variable would decide a verdict about a
    // branch it does not describe.
    const checks = []
    for (const script of ['version.mjs', 'changelog.mjs']) {
      const result = adapter.exec(process.execPath, [join(SCRIPT_DIR, script), 'check'], { cwd: tree, env: { PATH: process.env.PATH } })
      const output = `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`.trim()
      checks.push({ script: `scripts/${script}`, code: Number(result.code ?? 1), output })
      if (Number(result.code ?? 1) !== 0) {
        return refuse(`node scripts/${script} check failed in the materialised tree: ${output === '' ? 'no output' : output}`, { permissions, scopes, checks, fetched: materialised.fetched })
      }
    }

    const expected = [...SURFACE_PATHS].sort()
    const entries = adapter.listDir(tree)
    if (entries.join('\n') !== expected.join('\n')) {
      return refuse(`the materialised tree holds ${entries.join(', ') === '' ? '(nothing)' : entries.join(', ')}, not exactly ${expected.join(', ')}`, { permissions, scopes, checks, fetched: materialised.fetched })
    }
    const packageVersion = String(JSON.parse(adapter.readFile(join(tree, 'package.json')))?.version ?? '')
    if (packageVersion !== wanted) {
      return refuse(`the branch's package.json is ${packageVersion === '' ? '(unreadable)' : packageVersion}, not ${wanted}; nothing was written`, { permissions, scopes, checks, fetched: materialised.fetched })
    }

    const compare = await apiCall(api, 'GET', `/compare/main...${branch}`)
    if (compare.status !== 200) return refuse(`GET /compare/main...${branch} answered ${compare.status}${messageOf(compare.payload) === '' ? '' : `: ${messageOf(compare.payload)}`}`, { permissions, scopes, checks })
    const files = Array.isArray(compare.payload?.files) ? compare.payload.files : []
    if (files.length === 0) return refuse(`the branch has no diff against main to judge`, { permissions, scopes, checks })
    if (files.length >= COMPARE_FILE_LIMIT) return refuse(`the compare answered ${files.length} files, its limit; the whole diff cannot be judged`, { permissions, scopes, checks })
    const names = files.map((file) => String(file?.filename ?? ''))
    const outside = names.filter((name) => name === '' || !isMechanicalPath(name))
    if (outside.length > 0) {
      return refuse(`${outside.length} path(s) outside the release surface: ${outside.slice(0, 5).join(', ')}; nothing was written`, { permissions, scopes, checks })
    }

    const mainRef = await apiCall(api, 'GET', '/git/ref/heads/main')
    if (mainRef.status !== 200) return refuse(`GET /git/ref/heads/main answered ${mainRef.status}${messageOf(mainRef.payload) === '' ? '' : `: ${messageOf(mainRef.payload)}`}`, { permissions, scopes, checks })
    const liveMain = String(mainRef.payload?.object?.sha ?? '')
    const plannedMain = String(artifact?.mainSha ?? '')
    if (plannedMain === '' || liveMain !== plannedMain) {
      return refuse(`main moved: the plan was made at ${plannedMain === '' ? '(no mainSha in the artifact)' : plannedMain}, main is ${liveMain === '' ? '(unreadable)' : liveMain}; nothing was written`, { permissions, scopes, checks })
    }

    const created = await apiCall(api, 'POST', '/pulls', {
      title: `release: v${wanted}`,
      head: branch,
      base: 'main',
      maintainer_can_modify: true,
      body: renderBody({ repo, version: wanted, plan, mainSha: liveMain, branch }),
    })
    if (created.status !== 201) {
      return refuse(`POST /pulls answered ${created.status}${messageOf(created.payload) === '' ? '' : `: ${messageOf(created.payload)}`}`, { permissions, scopes, checks })
    }
    const number = Number(created.payload?.number ?? 0)
    if (number === 0) return refuse('POST /pulls answered no pull request number', { permissions, scopes, checks })
    const readback = await apiCall(api, 'GET', `/pulls/${number}`)
    if (readback.status !== 200 || readback.payload?.maintainer_can_modify !== true) {
      return refuse(`pull request #${number} came back with maintainer_can_modify ${String(readback.payload?.maintainer_can_modify)}; it must stay editable by maintainers`, { permissions, scopes, checks, pr: number })
    }
    return {
      status: 'opened',
      reason: `opened pull request #${number} for ${branch} at ${sha}`,
      pr: number,
      identity: login,
      url: String(created.payload?.html_url ?? ''),
      branch,
      sha,
      mainSha: liveMain,
      files: names,
      fetched: materialised.fetched,
      checks,
      permissions,
      scopes,
    }
  } finally {
    rmSync(tree, { recursive: true, force: true })
  }
}

function parseArgs(argv) {
  const args = { artifact: '', version: '', sha: '', repo: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!['--artifact', '--version', '--sha', '--repo'].includes(flag)) return { error: `unknown argument ${String(flag)}` }
    if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` }
    args[flag.slice(2)] = value
    index += 1
  }
  if (args.artifact === '') return { error: '--artifact is required' }
  if (args.version === '') return { error: '--version is required' }
  if (args.sha === '') return { error: '--sha is required' }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.error !== undefined) {
    console.error(`release-open: ${args.error}`)
    process.exitCode = 2
    return
  }
  let artifact
  try {
    artifact = JSON.parse(readFileSync(args.artifact, 'utf8'))
  } catch (error) {
    console.error(`release-open: cannot read ${args.artifact}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }
  const result = await runReleaseOpen({ artifact, version: args.version, sha: args.sha, repo: args.repo === '' ? undefined : args.repo })
  console.log(JSON.stringify(result, null, 2))
  if (result.status === 'refused') console.error(`release-open: ${result.reason}`)
  process.exitCode = exitCodeFor(result)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
