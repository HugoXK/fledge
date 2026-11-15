// #640: which files in a diff are the gate itself.
//
// The evaluators run from the base branch, so a pull request cannot change the
// code that judges it. The reviewer still has to see that the gate is in the
// diff — a T3 change to `scripts/**` or `.github/**` is where a self-serving
// edit would hide — so the changed paths are classified here and one summary
// names every gate file the pull request touches.

export const GATE_FILE_RULES = [
  { prefix: '.github/workflows/', kind: 'workflow' },
  { prefix: '.github/agent/', kind: 'gate policy or baseline' },
  { prefix: '.github/scripts/', kind: 'gate script' },
  { prefix: 'scripts/', kind: 'gate script' },
]

export function isGateFile(path) {
  const value = String(path ?? '').trim()
  if (value === '') return false
  return GATE_FILE_RULES.some((rule) => value.startsWith(rule.prefix))
}

// Sorted and de-duplicated: the diff of a rename lists the path twice and the
// summary must not read as two different files.
export function classifyGateFiles(paths) {
  const seen = new Set()
  for (const path of paths ?? []) {
    const value = String(path ?? '').trim()
    if (isGateFile(value)) seen.add(value)
  }
  return [...seen].sort()
}

export function gateSummary(files, { changed = 0, base = '' } = {}) {
  const list = Array.isArray(files) ? files : []
  const where = base === '' ? '' : ` against \`${base}\``
  if (list.length === 0) {
    return [
      '### gate-integrity',
      '',
      `No gate file is in this diff${where}${changed > 0 ? ` (${changed} path(s) read)` : ''}.`,
      'The evaluators ran from the base branch tree; the gate is not part of what this pull request changes.',
      '',
    ].join('\n')
  }
  return [
    '### gate-integrity',
    '',
    `This diff changes ${list.length} gate file(s)${where}${changed > 0 ? ` of ${changed} path(s) read` : ''} — the gate that judges this pull request is inside the pull request:`,
    '',
    ...list.map((file) => `- \`${file}\``),
    '',
    'Every evaluator ran from the base branch tree, so these edits cannot loosen their own verdict; a T3 PASS at this tip is still required.',
    '',
  ].join('\n')
}
