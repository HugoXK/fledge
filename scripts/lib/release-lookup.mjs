// One answer for the one fact both release workflows read: does this tag
// already have a GitHub Release? (#909)
//
// `gh` exits non-zero for "not found" (404), "forbidden" (403), a server error
// (5xx) and a dead network alike, so the exit status alone cannot say whether
// the release is absent or the read is unreadable. Reading every failure as
// "absent" is what let a 403 republish a tag's image: `release.yml` recorded
// `published=false` and every writer ran. The scheduled job made the opposite
// call on the same fact with a `grep` on `gh`'s message, so the two disagreed.
//
// This module is the single rule, executed by the suite instead of grepped out
// of YAML:
//
//   present    the read succeeded — the release exists;
//   absent     the API answered 404 — the one answer that means "not made yet";
//   unreadable everything else (403, 5xx, no HTTP status at all) — the caller
//              must refuse instead of writing.
//
// The status is parsed as a number (`(HTTP 404)`, `HTTP/2.0 404`, `HTTP 404:`),
// never inferred from prose: a message that says "not found" without a 404 is
// unreadable, so a reworded `gh` message cannot turn an unreadable read into a
// publish.
export const RELEASE_LOOKUP_PRESENT = 'present'
export const RELEASE_LOOKUP_ABSENT = 'absent'
export const RELEASE_LOOKUP_UNREADABLE = 'unreadable'

function readHttpStatus(text) {
  if (typeof text !== 'string' || text === '') return null
  // `gh api --include` prints the status line first; `gh api` and `gh release
  // view` report the failure as `gh: <message> (HTTP <code>)`.
  const statusLine = /^HTTP\/[\d.]+ (\d{3})\b/m.exec(text)
  if (statusLine !== null) return Number(statusLine[1])
  const parenthesised = /\(HTTP (\d{3})\)/.exec(text)
  if (parenthesised !== null) return Number(parenthesised[1])
  const prefixed = /HTTP (\d{3}):/.exec(text)
  if (prefixed !== null) return Number(prefixed[1])
  return null
}

export function classifyReleaseLookup({ status, stdout = '', stderr = '' } = {}) {
  if (status === 0) {
    return { state: RELEASE_LOOKUP_PRESENT, httpStatus: 200, reason: 'the release lookup succeeded' }
  }
  const httpStatus = readHttpStatus(stderr) ?? readHttpStatus(stdout)
  if (httpStatus === 404) {
    return {
      state: RELEASE_LOOKUP_ABSENT,
      httpStatus,
      reason: 'the API answered 404: this tag has no GitHub Release yet',
    }
  }
  if (httpStatus !== null) {
    return {
      state: RELEASE_LOOKUP_UNREADABLE,
      httpStatus,
      reason: `the release lookup failed with HTTP ${String(httpStatus)}; it is unreadable, not absent`,
    }
  }
  const exit = typeof status === 'number' ? String(status) : 'none'
  return {
    state: RELEASE_LOOKUP_UNREADABLE,
    httpStatus: null,
    reason: `the release lookup failed (exit ${exit}) without an HTTP status; it is unreadable, not absent`,
  }
}
