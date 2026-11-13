// #390: the triage report is the triage work type's whole output. It is parsed
// strictly, because the alternative is a free-text summary a maintainer has to
// read and a scheduler cannot act on: a malformed report fails the job as
// `TRIAGE_UNVERIFIED` instead of quietly becoming an empty board.
//
// Shape the agent is asked for in `src/jobs/flybot.ts`:
//
//   {
//     "items": [
//       { "issue": 12, "url": "https://github.com/o/r/issues/12",
//         "title": "...", "priority": 30, "duplicateOf": null }
//     ],
//     "next": { "issue": 12, "url": "...", "title": "..." }
//   }
//
// `items` is ranked highest first, and `duplicateOf` names the issue that stays
// open — the duplicate is linked, not duplicated. An issue URL must carry a host
// (`https://` alone is refused), and a title longer than `TRIAGE_TITLE_MAX` is
// refused rather than shortened, so the board never shows a cut title as the real one.

export const TRIAGE_MAX_ITEMS = 50
export const TRIAGE_TITLE_MAX = 200
const PRIORITIES = new Set([0, 10, 20, 30])

export interface TriageItem {
  issue: number
  url: string
  title: string
  priority: number
  duplicateOf: number | null
}

export interface TriageNext {
  issue: number
  url: string
  title: string
}

export interface TriageReport {
  schema_version: 1
  items: TriageItem[]
  next: TriageNext | null
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function parseIssueUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text.startsWith('https://') || text.length > 500) return null
  // `https://` alone is not a link: without a host there is nothing to open, and
  // a scheme-only string used to become a work item whose URL went nowhere.
  let host = ''
  try {
    host = new URL(text).host
  } catch {
    return null
  }
  return host === '' ? null : text
}

function cleanTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  // #390 review: an over-long title is refused, not shortened. A cut title reads
  // like the issue's real one, and the whole report fails closed as
  // `TRIAGE_UNVERIFIED` rather than carrying data that was silently lost.
  return text.length > TRIAGE_TITLE_MAX ? null : text
}

function parseItem(value: unknown): TriageItem | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const issue = positiveInteger(raw.issue)
  const url = parseIssueUrl(raw.url)
  const title = cleanTitle(raw.title)
  const priority = typeof raw.priority === 'number' && PRIORITIES.has(raw.priority) ? raw.priority : null
  if (issue === null || url === null || title === null || priority === null) return null
  const duplicate = raw.duplicateOf === undefined || raw.duplicateOf === null ? null : positiveInteger(raw.duplicateOf)
  // A duplicate link that cannot be read is a malformed report, not a null link:
  // dropping it silently would claim the two issues are unrelated.
  if (raw.duplicateOf !== undefined && raw.duplicateOf !== null && duplicate === null) return null
  if (duplicate !== null && duplicate === issue) return null
  return { issue, url, title, priority, duplicateOf: duplicate }
}

/**
 * Parse one triage report, or `null` when it cannot be trusted. The report must
 * be an object with an `items` array (possibly empty, for an empty board) and a
 * `next` field that is either the first item or `null`.
 */
export function parseTriage(value: unknown): TriageReport | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.items)) return null
  if (raw.items.length > TRIAGE_MAX_ITEMS) return null
  const items: TriageItem[] = []
  const seen = new Set<number>()
  for (const entry of raw.items) {
    const item = parseItem(entry)
    if (item === null) return null
    // One issue is one row: a repeated number would make the ranking ambiguous.
    if (seen.has(item.issue)) return null
    seen.add(item.issue)
    items.push(item)
  }
  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1]!
    const current = items[index]!
    if (current.priority > previous.priority) return null
  }
  for (const item of items) {
    if (item.duplicateOf !== null && !seen.has(item.duplicateOf)) return null
  }
  let next: TriageNext | null = null
  if (raw.next !== undefined && raw.next !== null) {
    if (typeof raw.next !== 'object' || Array.isArray(raw.next)) return null
    const rawNext = raw.next as Record<string, unknown>
    const issue = positiveInteger(rawNext.issue)
    const url = parseIssueUrl(rawNext.url)
    const title = cleanTitle(rawNext.title)
    if (issue === null || url === null || title === null) return null
    const item = items.find((entry) => entry.issue === issue)
    // The proposed next item must be one of the ranked rows and must not itself
    // be a duplicate, so the scheduler cannot start on a row triage just folded.
    if (item === undefined || item.duplicateOf !== null) return null
    if (items.length > 0 && items[0]!.issue !== issue) return null
    // The proposal is that row, so it carries the row's own link and title
    // rather than a second copy the scheduler could read differently.
    next = { issue, url: item.url, title: item.title }
  }
  return { schema_version: 1, items, next }
}

export function parseTriageJson(value: string | null): TriageReport | null {
  if (value === null || value === '') return null
  try {
    return parseTriage(JSON.parse(value))
  } catch {
    return null
  }
}

/** One line for the job page and the carry-over block: what the board says. */
export function triageSummaryLine(report: TriageReport): string {
  const duplicates = report.items.filter((item) => item.duplicateOf !== null).length
  const next = report.next === null ? 'no proposal' : `next #${report.next.issue}`
  return `${report.items.length} open, ${duplicates} duplicate(s), ${next}`
}
