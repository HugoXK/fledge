// #1333: the size ratchet's ceiling map is a property of the base branch, not of
// the pull request. A tip that grows a file can otherwise edit
// `scripts/lib/arch-grandfather.json` in the same diff and describe its own
// limit, which is the one thing the gate exists to refuse.
//
// This module is the decision only; reading `git show <base>:<path>` lives in
// `scripts/arch-boundaries.mjs`, so the rule is testable without a repository.

/**
 * Chooses the ledger a run is judged against.
 *
 * - A named base ref wins and must be readable: when the base has no ledger file
 *   the run fails closed rather than falling back to the head, because a missing
 *   file at the base is indistinguishable from a tip that deleted it.
 * - With no base ref (a local `npm run arch:check` on a working tree) the head
 *   file is used and the caller says so in its report line.
 */
export function selectLedger({ baseRef, baseContent, headContent, strict = true }) {
  const named = baseRef !== null && baseRef !== undefined && baseRef !== ''
  if (named && (baseContent === null || baseContent === undefined) && !strict) {
    return headContent === null || headContent === undefined
      ? { ledger: {}, source: 'head (no ledger)' }
      : { ledger: JSON.parse(headContent), source: 'head' }
  }
  if (named) {
    if (baseContent === null || baseContent === undefined) {
      throw new Error(
        `arch: ${baseRef} has no scripts/lib/arch-grandfather.json; refusing to read the ceiling from the pull request head`,
      )
    }
    return { ledger: JSON.parse(baseContent), source: `base:${baseRef}` }
  }
  if (headContent === null || headContent === undefined) return { ledger: {}, source: 'head (no ledger)' }
  return { ledger: JSON.parse(headContent), source: 'head' }
}

/**
 * One violation as the gate prints it. A growth refusal names the ledger that
 * judged it and the entry the tip claims, because "above its recorded 10" means
 * nothing when the tip wrote that 10 itself (#1333).
 */
export function violationLine(violation, { ledgerSource, headLedger = {} }) {
  const source = violation.rule === 'grandfathered-growth' && String(ledgerSource).startsWith('base:')
    ? ` [ceiling from ${ledgerSource}, head entry ${String(headLedger[violation.file] ?? 'none')}]`
    : ''
  return `${violation.file}:${String(violation.line)} ${violation.rule}: ${violation.reason}${source}`
}
