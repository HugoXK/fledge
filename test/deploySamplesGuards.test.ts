import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// #1122: the sample contract runs under `set -uo pipefail` and eight guards used
// to pipe the captured output into `grep -q`:
//
//   if ! printf '%s\n' "$output" | grep -q 'X-Frame-Options'; then … exit 1
//
// `grep -q` exits at the first match, so `printf` is killed by SIGPIPE and exits
// 141; `pipefail` makes the pipeline 141, and the leading `!` reads that as "the
// text was not found". A rejection that did name the header is then reported as
// one that did not, and a correct contract exits 1. The table in the card has it
// 40/40 at a 166914-byte payload.
//
// These tests take each guard's own condition text out of the script and run it
// under the same `set -uo pipefail` with a payload larger than a pipe buffer, so
// a regression back to the pipeline form fails here even if the message strings
// stay identical. The marker for every guard is present (or absent) at once, so
// the assertion does not have to know which guard looks for which text.
const root = fileURLToPath(new URL('..', import.meta.url))
const contractPath = join(root, 'scripts/check-deploy-samples.sh')
const contract = readFileSync(contractPath, 'utf8')

/** Every guard whose condition decides by reading the captured `$output`. */
function outputGuards(text: string): { line: number; condition: string }[] {
  const guards: { line: number; condition: string }[] = []
  text.split('\n').forEach((line, index) => {
    const match = /^if ! (.+); then$/.exec(line)
    const condition = match?.[1]
    if (condition && condition.includes('"$output"')) {
      guards.push({ line: index + 1, condition })
    }
  })
  return guards
}

const MARKERS = [
  'X-Frame-Options',
  'Strict-Transport-Security',
  'location block opened at line',
  'inside a location',
  'no server block to check',
]

/** Larger than a 64 KiB pipe buffer, so a producer that is not read to the end takes SIGPIPE. */
const FILLER_LINES = 4000

function payload(header: string[] | null): string {
  const filler = Array.from({ length: FILLER_LINES }, (_, index) => `stub line ${index} ${'x'.repeat(40)}`)
  return [...(header ?? []), ...filler].join('\n')
}

/** Run one guard's condition under the contract's own shell options. */
function decide(condition: string, text: string, dir: string, name: string): { status: number | null; stderr: string } {
  const payloadPath = join(dir, `${name}.txt`)
  writeFileSync(payloadPath, text)
  const probe = [
    'set -uo pipefail',
    'output="$(cat "$1")"',
    `if ${condition}; then exit 0; else exit 1; fi`,
  ].join('\n')
  const result = spawnSync('bash', ['-c', probe, 'probe', payloadPath], { encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr ?? '' }
}

test('#1122: every guard reads the output without a producer it can outrun', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-guards-'))
  try {
    const guards = outputGuards(contract)
    assert.equal(guards.length, 8, 'the contract decides by reading output in exactly eight guards')

    const present = payload(MARKERS)
    const absent = payload(null)
    assert.ok(present.length > 166_914, 'the positive payload must exceed the size the card measured the inversion at')

    for (const guard of guards) {
      const found = decide(guard.condition, present, dir, `present-${guard.line}`)
      assert.equal(
        found.status,
        0,
        `line ${guard.line}: a guard must find its text in a large payload that contains every marker; ` +
          `exit ${found.status} means the producer was killed before it was read (${guard.condition})`,
      )
      const missing = decide(guard.condition, absent, dir, `absent-${guard.line}`)
      assert.notEqual(
        missing.status,
        0,
        `line ${guard.line}: a guard must not report text that the payload does not carry (${guard.condition})`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#1122: no guard pipes the captured output into a reader that can stop early', () => {
  const pipeGuards = contract
    .split('\n')
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter((entry) => /\$output.*\|.*\bgrep\b/.test(entry.text))
  assert.deepEqual(
    pipeGuards.map((entry) => entry.line),
    [],
    'a guard that pipes $output into grep can be inverted by SIGPIPE under pipefail',
  )
})
