import { createHash } from 'node:crypto'

// #367: "the test is red at the base" is a claim about a different tree, and a
// red test proves nothing if it failed there for a reason the fix does not
// address — a type error, a module that does not exist yet, a network hang. The
// classifier reads the base run's own output and answers one question: did the
// test fail because an expectation was not met?
//
// Only two shapes count (`red`): an assertion failure, and an error thrown from
// the test body. Everything else is `unverified`, never a pass — a compile or
// type error, a missing module, an environment or network error, a timeout, a
// skipped test, and output this module does not recognise. A run that exits 0 at
// the base is `passed`: there was nothing to fix.
//
// The order matters: a type error's output also contains `Error:` and a stack,
// so the non-test failure shapes are ruled out before an assertion is looked for.
export type RedTestVerdict = 'red' | 'passed' | 'unverified'

export interface RedTestRun {
  command: string
  baseSha: string
  exitCode: number
  output: string
  /** The runner reported the test as skipped. */
  skipped?: boolean
  /** The runner (or this module's caller) stopped it on a wall-clock limit. */
  timedOut?: boolean
}

export interface RedTestEvidence {
  command: string
  baseSha: string
  exitCode: number
  verdict: RedTestVerdict
  /** `assertion`, `thrown`, `compile`, `missing-module`, `environment`, `timeout`, `skipped`, `flaky`, `unknown`, or `passed`. */
  signature: string
  reason: string
  /** sha256 of the base run's output; the raw text stays on the attempt row. */
  outputSha256: string
  flaky: boolean
}

interface Classification {
  verdict: RedTestVerdict
  signature: string
  reason: string
}

// #1040: the record is a claim the maintainer can accept or reject. The
// decision lives beside it, written by a person, so a page can say who answered
// and when rather than leaving the badge to look self-certified.
export interface RedTestDecision {
  decision: 'confirmed' | 'challenged'
  note: string
  /** The login of the maintainer who pressed. */
  by: string
  at: string
}

// A type error names a code (`error TS2345`) or the compiler's own exit path; it
// is not this repository's test failing.
const COMPILE = /error TS\d{4}|TSError|tsc exited \d|is not assignable to type|Cannot find name '/
// A module that does not exist yet is the classic false red: the helper the fix
// adds is imported before it is written.
const MISSING_MODULE = /Cannot find module|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|Failed to load url/
// The box, not the code: a refused connection, a DNS failure, a full disk.
const ENVIRONMENT = /ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|ENOSPC|EACCES|getaddrinfo|fetch failed|npm ERR!/
const ASSERTION = /AssertionError|ERR_ASSERTION|[Aa]ssertion failed|\bexpected\b[\s\S]{0,80}\bto (?:equal|be|deeply equal|match|include)/
// An error raised inside a test file, as opposed to one raised by the loader.
const THROWN_IN_TEST = /^\s*(?:[A-Za-z]*Error:|throw\b)[\s\S]{0,400}?\n\s+at [^\n]*\btest[\\/]/m

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function classifyRedTestRun(run: RedTestRun): Classification {
  if (run.skipped === true) return { verdict: 'unverified', signature: 'skipped', reason: 'the runner skipped the test at the base, so it proved nothing there' }
  if (run.timedOut === true) return { verdict: 'unverified', signature: 'timeout', reason: 'the base run hit a time limit instead of failing an expectation' }
  if (run.exitCode === 0) return { verdict: 'passed', signature: 'passed', reason: 'the command exited 0 at the base: the test was already green, so there is no red to explain' }
  if (COMPILE.test(run.output)) return { verdict: 'unverified', signature: 'compile', reason: 'the base run failed to compile, so no test executed' }
  if (MISSING_MODULE.test(run.output)) return { verdict: 'unverified', signature: 'missing-module', reason: 'the base run could not load a module, so no test executed' }
  if (ENVIRONMENT.test(run.output)) return { verdict: 'unverified', signature: 'environment', reason: 'the base run failed on the environment or the network, not on an expectation' }
  if (ASSERTION.test(run.output)) return { verdict: 'red', signature: 'assertion', reason: 'the test failed an assertion at the base: the intended red' }
  if (THROWN_IN_TEST.test(run.output)) return { verdict: 'red', signature: 'thrown', reason: 'the test threw from its own body at the base: the intended red' }
  return { verdict: 'unverified', signature: 'unknown', reason: 'the base run failed in a shape this classifier does not recognise, so it is not evidence of the intended red' }
}

// The record the job keeps. `repeat` is a second run of the same command at the
// same base: when the two disagree the result is not reproducible, which makes it
// `unverified` regardless of what either run said.
export function redTestEvidence(run: RedTestRun, repeat: RedTestRun | null = null, jobBaseSha: string | null = null): RedTestEvidence {
  // A run taken on another tree answers a question about that tree. It is kept
  // (with the sha it ran at) so the page can say why it proves nothing here.
  if (jobBaseSha !== null && run.baseSha !== jobBaseSha) {
    return {
      command: run.command,
      baseSha: run.baseSha,
      exitCode: run.exitCode,
      verdict: 'unverified',
      signature: 'base-mismatch',
      reason: `the base run was taken at ${run.baseSha}, not at the job's base ${jobBaseSha}, so it says nothing about this diff`,
      outputSha256: sha256(run.output),
      flaky: false,
    }
  }
  const first = classifyRedTestRun(run)
  const second = repeat === null ? null : classifyRedTestRun(repeat)
  const flaky = second !== null && (second.verdict !== first.verdict || second.signature !== first.signature)
  return {
    command: run.command,
    baseSha: run.baseSha,
    exitCode: run.exitCode,
    verdict: flaky ? 'unverified' : first.verdict,
    signature: flaky ? 'flaky' : first.signature,
    reason: flaky ? 'the same command at the same base gave two different results, so the red is not reproducible' : first.reason,
    outputSha256: sha256(run.output),
    flaky,
  }
}
