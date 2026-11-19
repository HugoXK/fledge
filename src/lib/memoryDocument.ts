// #1070: a merged repository document can own one project-memory entry. The
// proof is four facts read from GitHub, and each failing fact is its own refusal
// because each one tells the maintainer something different to fix: a PR that
// never merged, a PR based on another branch, a merge commit that never reached
// the default branch, and a document whose blob moved after the merge.
//
// This module is the half that needs no network: it decides from an already-read
// proof, so the ordering and the priority of the refusals are pinned by a test
// without a stub API. The route in `src/app.ts` reads the four facts and hands
// them here; the store (`src/db.ts`) keeps the promotion and refuses the rewrite.

export type DocumentRefusal =
  | 'document_pr_invalid'
  | 'document_path_invalid'
  | 'document_not_merged'
  | 'document_base_not_default'
  | 'document_not_on_default'
  | 'document_blob_missing'
  | 'document_blob_moved'

export interface DocumentProof {
  path: string
  pr: number
  /** The PR's own `merged` flag. A closed-but-unmerged PR proves nothing. */
  merged: boolean
  /** The PR's base branch. */
  base: string
  /** The repository's default branch, as the repository row records it. */
  defaultBranch: string
  /** The PR's merge commit; empty when GitHub reports none. */
  mergeCommitSha: string
  /** Whether the merge commit is an ancestor of the live default branch. */
  ancestor: boolean
  /** Blob SHA of the path at the merge commit; null when the path is absent. */
  mergeBlobSha: string | null
  /** Blob SHA of the path on the live default branch; null when absent. */
  liveBlobSha: string | null
}

export const DOCUMENT_PATH_MAX = 300

// A path, not a reference: no scheme, no leading slash, no `..` segment and no
// query. Anything that could address something other than one file in the
// repository is refused before a request is made with it.
export function isDocumentPath(path: string): boolean {
  if (path.length === 0 || path.length > DOCUMENT_PATH_MAX) return false
  if (path.startsWith('/') || path.endsWith('/')) return false
  if (/[\\?#\s]/.test(path)) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

export function documentRefusal(proof: DocumentProof): DocumentRefusal | null {
  if (!Number.isInteger(proof.pr) || proof.pr <= 0) return 'document_pr_invalid'
  if (!isDocumentPath(proof.path)) return 'document_path_invalid'
  if (!proof.merged) return 'document_not_merged'
  if (proof.base !== proof.defaultBranch) return 'document_base_not_default'
  if (proof.mergeCommitSha === '' || !proof.ancestor) return 'document_not_on_default'
  if (proof.mergeBlobSha === null || proof.liveBlobSha === null) return 'document_blob_missing'
  if (proof.mergeBlobSha !== proof.liveBlobSha) return 'document_blob_moved'
  return null
}

export interface DocumentLink {
  path: string
  pr: number
}

// The compare endpoint answers `ahead` when the first ref is an ancestor of the
// second and `identical` when they are the same commit. Anything else — `behind`,
// `diverged` or an unknown status — does not prove the merge commit is on the
// default branch.
export function isAncestorStatus(status: string): boolean {
  return status === 'ahead' || status === 'identical'
}
