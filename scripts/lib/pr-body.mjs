// The pull request body rules, free of the GitHub API so the suite can call
// them directly. scripts/pr-lint.mjs is the only caller in the workflow.
//
// Two lists, two meanings:
//   policy.authors  — who may be *named* as a pull request's author (this file)
//   policy.writers  — who may *author a verdict* (scripts/lib/review-gate.mjs)
// Adding a name to `authors` grants attribution only: the gate never reads it,
// so naming a bot in a body cannot widen who may author a conclusion. When a
// base branch predates the split, `authors` falls back to `writers`, so a pull
// request cannot widen its own rules by adding the key.

export function firstLine(body) {
  return (
    String(body ?? '')
      .split(/\r?\n/)
      .find((line) => line.trim() !== '') ?? ''
  )
}

const RAN = /(^|\n)[ \t]*Ran[^\n:]*[:：]/
const NOT_RUN = /(^|\n)[ \t]*Not run[^\n:]*[:：]/i
const RAN_HEADING = /^[ \t]*#{1,6}[ \t]+Ran\b[^\n]*/im
const NOT_RUN_HEADING = /^[ \t]*#{1,6}[ \t]+Not run\b[^\n]*/im

export function hasRanSection(body) {
  return RAN.test(String(body ?? ''))
}

export function hasNotRunSection(body) {
  return NOT_RUN.test(String(body ?? ''))
}

export function ranHeading(body) {
  return RAN_HEADING.exec(String(body ?? ''))?.[0]?.trim() ?? null
}

export function notRunHeading(body) {
  return NOT_RUN_HEADING.exec(String(body ?? ''))?.[0]?.trim() ?? null
}

export function attributionList(policy) {
  // The key's presence decides, not its length: an empty `authors` list means
  // no body may name an author, and falling back to `writers` there would
  // silently widen the rule this file exists to keep narrow.
  if (Array.isArray(policy?.authors)) {
    return { name: 'authors', names: policy.authors.map((name) => String(name)) }
  }
  const writers = Array.isArray(policy?.writers) ? policy.writers : []
  return { name: 'writers', names: writers.map((name) => String(name)) }
}

export function checkAttribution(body, policy) {
  const writer = /^\s*Written-by:\s*(.+)$/im.exec(String(body ?? ''))?.[1]?.trim() ?? ''
  if (writer === '') return null
  const { name, names } = attributionList(policy)
  if (names.map((entry) => entry.toLowerCase()).includes(writer.toLowerCase())) return null
  return `Written-by "${writer}" is not in the ${name} list of .github/agent/review-policy.json`
}

// The three body checks plus attribution, in the order pr-lint reports them.
// A `Ran:` heading is rejected as a heading rather than reported as a missing
// section: the check reads a line that starts with `Ran:`, which is also the
// shape the review gate requires of a verdict body.
export function checkBody(body, policy) {
  const text = String(body ?? '')
  const errors = []
  if (!/^Written-by:\s*\S+/.test(firstLine(text).trim())) {
    errors.push('the PR body must start with "Written-by: <name>"')
  }
  if (!hasRanSection(text)) {
    const heading = ranHeading(text)
    errors.push(
      heading === null
        ? 'the PR body needs a "Ran:" section'
        : `the PR body has a "${heading}" heading; "Ran:" must start a line, not a heading`,
    )
  }
  if (!hasNotRunSection(text)) {
    const heading = notRunHeading(text)
    errors.push(
      heading === null
        ? 'the PR body needs a "Not run:" section'
        : `the PR body has a "${heading}" heading; "Not run:" must start a line, not a heading`,
    )
  }
  const attribution = checkAttribution(text, policy)
  if (attribution !== null) errors.push(attribution)
  return errors
}
