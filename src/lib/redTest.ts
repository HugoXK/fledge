import { createHash } from 'node:crypto'

// #367: the red-test evidence record. The base run of the same command is kept
// on the job row so the audit reads one row — command, base sha, exit code,
// failure signature and the sha256 of the output — with no file on disk.
//
// Only a genuine test failure counts as "the intended reason" (the ruling in
// issue #367 comment 6980638616): an assertion failure or an error thrown from
// the test body. A compile or type error, a missing module, an environment or
// network error, a timeout and a skipped test are unverified, never verified.
// The order below is load-bearing: a skipped test whose output also carries
// "not ok" must classify as skipped, not as an assertion.

export type RedFailureClass = 'assertion' | 'compile' | 'environment' | 'timeout' | 'skipped' | 'passed' | 'other'

export interface BaseRun {
  command: string
  baseSha: string
  exitCode: number
  output: string
  timedOut?: boolean
  skipped?: boolean
}

export interface RedTestEvidence {
  state: 'verified' | 'unverified'
  command: string
  baseSha: string
  exitCode: number
  failureClass: RedFailureClass
  signature: string
  outputSha256: string
}

const COMPILE = [
  /\berror TS\d+/, // tsc diagnostics
  /\.(?:ts|tsx|js|mjs|cjs)\(\d+,\d+\): error/i, // tsc pretty output
  /Cannot find module/,
  /ERR_MODULE_NOT_FOUND/,
  /Failed to resolve (?:import|entry)/,
  /SyntaxError: (?:Unexpected|Invalid|Missing|Unterminated|Cannot)/,
]

const ENVIRONMENT = [
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH/,
  /EACCES|EPERM|ENOSPC|EMFILE|ENFILE/,
  /socket hang up/,
  /fetch failed/,
  /getaddrinfo/i,
  /permission denied, (?:open|mkdir|scandir)/i,
]

const TIMEOUT = [/timed out/i, /test timeout of \d+\s*ms/i, /exceeded timeout/i, /timeout \d+\s*ms exceeded/i]

const SKIPPED = [/(?:^|\n)\s*#\s*SKIP\b/i, /(?:^|\n)\s*#\s*skipped [1-9]/i, /\bskipped because\b/i]

const ASSERTION = [
  /(?:^|\n)not ok \d+ - /, // TAP failure from node:test
  /(?:^|\n)\s*✖ /, // node:test spec reporter failure
  /AssertionError/,
  /Assertion failed/,
]

function firstMatch(lines: string[], patterns: RegExp[]): string {
  for (const pattern of patterns) {
    for (const line of lines) {
      if (pattern.test(line)) return line.trim()
    }
  }
  return ''
}

export function classifyRedRun(run: BaseRun): RedFailureClass {
  const output = String(run.output ?? '')
  const lines = output.split(/\r?\n/)

  if (run.skipped === true) return 'skipped'
  if (SKIPPED.some((pattern) => pattern.test(output))) return 'skipped'
  if (run.timedOut === true) return 'timeout'
  if (TIMEOUT.some((pattern) => pattern.test(output))) return 'timeout'
  if (run.exitCode === 0) return 'passed'
  if (COMPILE.some((pattern) => pattern.test(output))) return 'compile'
  if (ENVIRONMENT.some((pattern) => pattern.test(output))) return 'environment'
  if (ASSERTION.some((pattern) => pattern.test(output))) return 'assertion'
  // A thrown error from the test body is the second half of "an assertion or a
  // thrown error": compile and environment were ruled out above, so a bare
  // stack trace here is the test failing at runtime.
  if (/(?:^|\n)\s*Error: /.test(output) && /(?:^|\n)\s*at /.test(output)) return 'assertion'
  if (firstMatch(lines, [/^Error: /]) !== '') return 'assertion'
  return 'other'
}

export function failureSignature(run: BaseRun): string {
  const output = String(run.output ?? '')
  const lines = output.split(/\r?\n/)
  const kind = classifyRedRun(run)
  if (kind === 'timeout') return 'timed out'
  if (kind === 'skipped') return firstMatch(lines, [/#\s*SKIP\b/i, /#\s*skipped [1-9]/i]) || 'skipped'
  if (kind === 'passed') return ''
  if (kind === 'compile') {
    return firstMatch(lines, [/error TS\d+/, /Cannot find module/, /ERR_MODULE_NOT_FOUND/, /Failed to resolve/]) || 'compile error'
  }
  if (kind === 'environment') {
    return firstMatch(lines, [/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EACCES|EPERM|ENOSPC|EMFILE|fetch failed|getaddrinfo/i]) || 'environment error'
  }
  if (kind === 'assertion') {
    return firstMatch(lines, [/^not ok \d+ - /, /AssertionError/, /Assertion failed/, /^Error: /]) || 'assertion failure'
  }
  return `exit ${run.exitCode}`
}

export function redTestEvidence(run: BaseRun): RedTestEvidence {
  const kind = classifyRedRun(run)
  return {
    state: kind === 'assertion' ? 'verified' : 'unverified',
    command: run.command,
    baseSha: run.baseSha,
    exitCode: run.exitCode,
    failureClass: kind,
    signature: failureSignature(run),
    outputSha256: createHash('sha256').update(String(run.output ?? ''), 'utf8').digest('hex'),
  }
}
