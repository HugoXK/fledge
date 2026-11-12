// The one definition of an issue body's hash, shared by the gate that reads a
// verdict and the tool a verdict writer records with (#324).
//
// A verdict names a 12-hex sha256 of the issue body. Two forms exist on the
// board: the raw body (whitespace included) and the body with trailing
// whitespace stripped, which is what several published verdicts were written
// over. Before this module the gate compared the raw form only, so a CHANGES
// verdict written over the trimmed form read as `no-pass` — the card looked
// unblocked while a live refusal was standing.
//
// The tolerance is exactly trailing whitespace and nothing else: no leading
// whitespace, no CRLF conversion, no Unicode normalisation. Any other byte
// difference stays a material edit, which is why `stale-pass` still exists.

import { createHash } from 'node:crypto'

// sha256 over the whole decoded body, first 12 hex — the published convention.
export function hashBody(body) {
  return createHash('sha256').update(Buffer.from(String(body ?? ''), 'utf8')).digest('hex').slice(0, 12)
}

// `rstrip`: trailing whitespace, which is the form the verdicts now on the board
// were written over. It deliberately leaves every other byte alone — a leading
// space, a CRLF conversion or a re-wrap is still a material edit.
export function rstripBody(body) {
  return String(body ?? '').replace(/\s+$/u, '')
}

export function bodyHashes(body) {
  const raw = hashBody(body)
  const trimmed = hashBody(rstripBody(body))
  return { raw, trimmed, differ: raw !== trimmed }
}

// Which form a verdict's hash names, if either. `raw` wins when the two forms
// are equal, so a body with no trailing whitespace never prints a suffix.
export function matchBodyHash(body, hash) {
  const forms = bodyHashes(body)
  const named = String(hash ?? '')
  if (named === forms.raw) return { form: 'raw', hash: forms.raw }
  if (named === forms.trimmed) return { form: 'trimmed', hash: forms.trimmed }
  return null
}

// Printed next to a hash, only when the trimmed form is the one that matched.
export function trimmedSuffix(form) {
  return form === 'trimmed' ? ' (trimmed)' : ''
}
