import type { GithubClient } from '../repos/github.js'
import { composeGatePullRequest, GATE_CONTRACT_PATH, GATE_SCRIPT_PATH, RELEASE_WORKFLOW_PATH, type ComposedFile } from './compose.js'
import type { GatePlan } from './plan.js'

// #543 second slice: applying a confirmed plan is the one place Fledge writes to
// a user's repository. It re-reads the base branch first — a plan is only good
// for the SHA the human reviewed — then creates one branch, the composed files
// and exactly one pull request. Nothing here retries a partially written branch:
// the caller records the error and a fresh session starts from a fresh SHA.

const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/
const MAX_EXISTING_READS = 20

export type GateApplyClient = Pick<
  GithubClient,
  'getBranch' | 'getContentAtRef' | 'createBranch' | 'putFile' | 'createPullRequest'
>

export interface GateApplyInput {
  client: GateApplyClient
  owner: string
  name: string
  baseBranch: string
  plan: GatePlan
  planHash: string
  confirmedBy?: string
}

export type GateApplyResult =
  | {
      ok: true
      branch: string
      prUrl: string
      prNumber: number
      files: ComposedFile[]
      notes: string[]
      gaps: string[]
    }
  | {
      ok: false
      code: 'base_branch_missing' | 'stale_base_sha' | 'branch_exists' | 'no_changes' | 'compose_refused' | 'write_failed' | 'pr_failed' | 'github_unavailable'
      message: string
      branch?: string
    }

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function applyGatePlan(input: GateApplyInput): Promise<GateApplyResult> {
  const { client, owner, name, baseBranch, plan, planHash } = input

  let live: { name: string; sha: string } | null
  try {
    live = await client.getBranch(owner, name, baseBranch)
  } catch (error) {
    return { ok: false, code: 'github_unavailable', message: `The base branch could not be read: ${reason(error)}` }
  }
  if (live === null) {
    return { ok: false, code: 'base_branch_missing', message: `\`${baseBranch}\` does not exist in ${owner}/${name}.` }
  }
  if (live.sha.toLowerCase() !== plan.baseSha.toLowerCase()) {
    return {
      ok: false,
      code: 'stale_base_sha',
      message: `The plan is based on ${plan.baseSha}, but \`${baseBranch}\` is now ${live.sha}; run the onboarding analysis again instead of writing this plan.`,
    }
  }

  // The composer only needs the files it might edit or keep: the existing
  // workflows named by the analysis, plus its own three paths. Absent files are
  // simply not passed, which is how "create when missing" stays a fact of the
  // read rather than an assumption.
  const paths = new Set<string>([GATE_CONTRACT_PATH, GATE_SCRIPT_PATH, RELEASE_WORKFLOW_PATH])
  for (const path of plan.existingFiles) {
    if (WORKFLOW_PATH.test(path)) paths.add(path)
    if (paths.size >= MAX_EXISTING_READS) break
  }
  const existing: Array<{ path: string; content: string; sha?: string }> = []
  for (const path of paths) {
    let found: { type: string; sha: string; content: string } | null
    try {
      found = await client.getContentAtRef(owner, name, path, plan.baseSha)
    } catch (error) {
      return { ok: false, code: 'github_unavailable', message: `Reading ${path} at ${plan.baseSha} failed: ${reason(error)}` }
    }
    if (found === null || found.type !== 'file') continue
    existing.push({ path, content: found.content, ...(found.sha === '' ? {} : { sha: found.sha }) })
  }

  const composed = composeGatePullRequest({
    plan,
    planHash,
    baseBranch,
    existing,
    ...(input.confirmedBy === undefined ? {} : { confirmedBy: input.confirmedBy }),
  })
  if (!composed.ok) return { ok: false, code: 'compose_refused', message: composed.message }

  const writes = composed.files.filter((file) => file.mode !== 'unchanged')
  if (writes.length === 0) {
    return { ok: false, code: 'no_changes', message: 'Every gate file already matches this plan, so there is nothing to put in a pull request.' }
  }
  const updateWithoutSha = writes.find((file) => file.mode === 'update' && (file.sha === undefined || file.sha === ''))
  if (updateWithoutSha !== undefined) {
    return { ok: false, code: 'write_failed', message: `Updating ${updateWithoutSha.path} needs the blob SHA GitHub returned for it, and the read did not carry one.` }
  }

  const branch = composed.pr.branch
  let branchAlreadyThere: { name: string; sha: string } | null
  try {
    branchAlreadyThere = await client.getBranch(owner, name, branch)
  } catch (error) {
    return { ok: false, code: 'github_unavailable', message: `Checking ${branch} failed: ${reason(error)}`, branch }
  }
  if (branchAlreadyThere !== null) {
    return { ok: false, code: 'branch_exists', message: `\`${branch}\` already exists at ${branchAlreadyThere.sha}; a later gate run keeps the branch name for the same plan, so delete it or start a fresh session.`, branch }
  }

  try {
    await client.createBranch(owner, name, branch, plan.baseSha)
  } catch (error) {
    return { ok: false, code: 'write_failed', message: `Creating \`${branch}\` failed: ${reason(error)}`, branch }
  }

  for (const file of writes) {
    try {
      await client.putFile(owner, name, {
        path: file.path,
        content: file.content,
        message: `ci: ${file.mode === 'create' ? 'add' : 'update'} ${file.path} from a confirmed Fledge gate plan`,
        branch,
        ...(file.sha === undefined ? {} : { sha: file.sha }),
      })
    } catch (error) {
      return { ok: false, code: 'write_failed', message: `Writing ${file.path} on \`${branch}\` failed: ${reason(error)}`, branch }
    }
  }

  try {
    const pr = await client.createPullRequest(owner, name, {
      title: composed.pr.title,
      head: branch,
      base: composed.pr.base,
      body: composed.pr.body,
    })
    return {
      ok: true,
      branch,
      prUrl: pr.url,
      prNumber: pr.number,
      files: writes,
      notes: composed.notes,
      gaps: composed.gaps,
    }
  } catch (error) {
    return { ok: false, code: 'pr_failed', message: `The files are on \`${branch}\`, but opening the pull request failed: ${reason(error)}`, branch }
  }
}
