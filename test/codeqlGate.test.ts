import test from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addedAlerts, alertKey, highAlerts, parseSarif, severityOf } from '../scripts/lib/codeql-alerts.mjs'
import type { CodeqlAlert } from '../scripts/lib/codeql-alerts.mjs'

interface Spec {
  rule: string
  severity: string
  path: string
  line: number
}

// A minimal SARIF document: one rule with its security-severity, one result that
// points at it. This is the shape `github/codeql-action/analyze` writes.
function sarifDocument(specs: Spec[]): string {
  const rules = specs.map((spec) => ({ id: spec.rule, properties: { 'security-severity': spec.severity } }))
  const results = specs.map((spec, index) => ({
    ruleId: spec.rule,
    ruleIndex: index,
    locations: [{ physicalLocation: { artifactLocation: { uri: spec.path }, region: { startLine: spec.line } } }],
  }))
  return JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL', rules } }, results }] })
}

const HIGH: Spec = { rule: 'js/missing-rate-limiting', severity: '8.8', path: 'src/app.ts', line: 408 }

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'codeql-gate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function runGate(sarifDir: string, baselinePath: string, extra: string[] = []) {
  const result = spawnSync(
    process.execPath,
    ['scripts/codeql-gate.mjs', '--sarif', sarifDir, '--baseline', baselinePath, ...extra],
    { encoding: 'utf8' },
  )
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('the reader takes rule, path, line and severity from the SARIF', () => {
  const alerts = parseSarif(JSON.parse(sarifDocument([HIGH, { ...HIGH, rule: 'js/http-to-file-access', severity: '5.3', path: './scripts/x.mjs', line: 47 }])))
  assert.deepEqual(alerts, [
    { ruleId: 'js/missing-rate-limiting', path: 'src/app.ts', line: 408, severity: 'high' },
    { ruleId: 'js/http-to-file-access', path: 'scripts/x.mjs', line: 47, severity: 'medium' },
  ])
  assert.equal(highAlerts(alerts).length, 1)
})

// The discriminating pair the gate exists for: a global gate cannot tell these
// two apart, a diff-scoped one must.
test('the same high result at base and head passes; a head that adds one fails', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)

  // The baseline file's shape, not the SARIF shape: ruleId/path/line/severity.
  const baseline = { recordedAtSha: 'a'.repeat(40), alerts: [{ ruleId: HIGH.rule, path: HIGH.path, line: HIGH.line, severity: 'high' }] }
  writeFileSync(baselinePath, JSON.stringify(baseline))

  writeFileSync(join(sarifDir, 'head.sarif'), sarifDocument([HIGH]))
  const same = runGate(sarifDir, baselinePath)
  assert.equal(same.code, 0, `the recorded high at the same place must pass: ${same.stderr}`)
  assert.match(same.stdout, /codeql-gate: ok \(parsed 1 result\(s\), 1 high\/critical, 0 added; all in the baseline/)

  writeFileSync(join(sarifDir, 'head.sarif'), sarifDocument([HIGH, { ...HIGH, path: 'src/app.ts', line: 9999, severity: '9.1' }]))
  const added = runGate(sarifDir, baselinePath)
  assert.equal(added.code, 1, 'a head that adds a high result must fail')
  assert.match(added.stderr, /new critical result js\/missing-rate-limiting at src\/app\.ts:9999/)
})

test('a medium result never fails the gate', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  writeFileSync(join(sarifDir, 'head.sarif'), sarifDocument([{ ...HIGH, severity: '5.3' }]))
  assert.equal(runGate(sarifDir, baselinePath).code, 0)
})

test('a gate that cannot read its SARIF fails closed', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  const missing = runGate(join(dir, 'no-results-here'), baselinePath)
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /cannot read the SARIF or the baseline/)
})

test('the recorded baseline is every open high alert at its sha and nothing is dismissed', () => {
  const baseline = JSON.parse(readFileSync('.github/agent/codeql-baseline.json', 'utf8')) as { recordedAtSha: string; alerts: CodeqlAlert[] }
  assert.match(baseline.recordedAtSha, /^[0-9a-f]{40}$/)
  const keys = baseline.alerts.map((alert) => alertKey(alert))
  // Positions follow the tree that ships this file, not a frozen sha: the gate
  // compares against the pull request's own tree, so a reviewed PR that inserts
  // before an anchor refreshes that line (see the baseline note). The pins below
  // stay exact so a silent re-label is still a failing test.
  assert.deepEqual([...keys].sort(), [
    'js/missing-rate-limiting|src/app.ts|2934',
    'js/missing-rate-limiting|src/app.ts|452',
    'js/missing-rate-limiting|src/app.ts|487',
    'js/missing-rate-limiting|src/app.ts|497',
    'js/missing-rate-limiting|src/app.ts|507',
    'js/missing-rate-limiting|src/gateway/gateway.ts|125',
    'js/missing-rate-limiting|src/gateway/gateway.ts|150',
  ])
  const dismissed = baseline.alerts.filter((alert) => /dismissed/.test((alert as { reason?: string }).reason ?? ''))
  assert.equal(dismissed.length, 3, 'the three dismissed false-positive results are recorded with their reason')
  assert.deepEqual(addedAlerts(keys, baseline.alerts).map((alert) => alertKey(alert)), [], 'the baseline must not fail its own alerts')
})

test('the CodeQL workflow runs the gate after analyze and writes the SARIF it reads', () => {
  const workflow = readFileSync('.github/workflows/codeql.yml', 'utf8')
  const analyze = workflow.indexOf('github/codeql-action/analyze@')
  const gate = workflow.indexOf('scripts/codeql-gate.mjs')
  assert.ok(analyze !== -1, 'codeql.yml must run analyze')
  assert.ok(gate > analyze, 'the gate must run after analyze, or it reads a SARIF that does not exist yet')
  assert.match(workflow.slice(analyze, gate), /output: codeql-results/, 'analyze must write its SARIF where the gate reads it')
})

// The gate's own defect, in its three shapes. A high result must be seen no
// matter how the SARIF spells it, and a SARIF with nothing in it is blind, not
// clean. Each case is written against the production shape, not a convenience.
test('a numeric security-severity is read as high, so the gate refuses it', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  const document = {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'CodeQL', rules: [{ id: 'js/missing-rate-limiting', properties: { 'security-severity': 8.8 } }] } },
      results: [{ ruleId: 'js/missing-rate-limiting', ruleIndex: 0, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/app.ts' }, region: { startLine: 432 } } }] }],
    }],
  }
  const alerts = parseSarif(document)
  assert.equal(alerts[0]?.severity, 'high', 'a numeric security-severity is a severity, not an absence')
  writeFileSync(join(sarifDir, 'head.sarif'), JSON.stringify(document))
  const run = runGate(sarifDir, baselinePath)
  assert.equal(run.code, 1, `a numeric high must fail the gate: ${run.stdout}${run.stderr}`)
  assert.match(`${run.stdout}${run.stderr}`, /parsed 1 result\(s\), 1 high\/critical/)
})

test('rules that live in tool.extensions are resolved by ruleId and ruleIndex', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  const document = {
    version: '2.1.0',
    runs: [{
      tool: {
        driver: { name: 'CodeQL', rules: [] },
        extensions: [{ name: 'codeql/javascript-queries', rules: [{ id: 'js/missing-rate-limiting', properties: { 'security-severity': '8.8' } }] }],
      },
      results: [{
        ruleId: 'js/missing-rate-limiting',
        ruleIndex: 0,
        rule: { id: 'js/missing-rate-limiting', toolComponent: { index: 1 } },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'src/app.ts' }, region: { startLine: 467 } } }],
      }],
    }],
  }
  const alerts = parseSarif(document)
  assert.equal(alerts[0]?.severity, 'high', 'a query-pack rule carried the severity all along')
  writeFileSync(join(sarifDir, 'head.sarif'), JSON.stringify(document))
  assert.equal(runGate(sarifDir, baselinePath).code, 1, 'a query-pack high must fail the gate')
})

// The gate's success state has to be reachable. A CodeQL analysis that ran and
// found nothing is clean; a gate that cannot tell that from a SARIF it never
// read stays red forever and the only way out would be keeping junk results.
test('a valid analysis that found nothing passes the gate', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  writeFileSync(join(sarifDir, 'head.sarif'), JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL', rules: [] } }, results: [] }] }))
  const run = runGate(sarifDir, baselinePath)
  assert.equal(run.code, 0, `zero results from a valid analysis is the pass state: ${run.stderr}`)
  assert.match(run.stdout, /codeql-gate: ok \(parsed 0 result\(s\), 0 high\/critical, 0 added/)
})

test('a SARIF with no analysis run fails closed and says which shape it was', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  writeFileSync(join(sarifDir, 'head.sarif'), JSON.stringify({ version: '2.1.0', runs: [] }))
  const run = runGate(sarifDir, baselinePath)
  assert.equal(run.code, 1, 'a SARIF that analysed nothing must not read as a pass')
  assert.match(run.stderr, /has no analysis run \(runs: 0\)/)
})

// The same verdict in its other two shapes: no runs key at all, and runs that is
// not a list. Both are "never analysed anything", so both name that shape rather
// than being counted as zero runs or, worse, as a pass.
test('a SARIF whose runs is missing or not a list names that shape', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))

  writeFileSync(join(sarifDir, 'head.sarif'), JSON.stringify({ version: '2.1.0' }))
  const missing = runGate(sarifDir, baselinePath)
  assert.equal(missing.code, 1, 'a document with no runs key must fail closed')
  assert.match(missing.stderr, /has no analysis run \(runs: missing or not a list\)/)

  writeFileSync(join(sarifDir, 'head.sarif'), JSON.stringify({ version: '2.1.0', runs: 'nope' }))
  const notList = runGate(sarifDir, baselinePath)
  assert.equal(notList.code, 1, 'runs that is not a list must fail closed')
  assert.match(notList.stderr, /has no analysis run \(runs: missing or not a list\)/)
})

test('a malformed JSON body fails closed as unreadable, not as empty', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  writeFileSync(join(sarifDir, 'head.sarif'), '{"version":"2.1.0","runs":[')
  const run = runGate(sarifDir, baselinePath)
  assert.equal(run.code, 1, 'an unparseable SARIF must fail closed')
  assert.match(run.stderr, /is not readable SARIF/)
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /parsed 0 result\(s\)/)
})

test('a moved line is an added result and fails until the baseline records it', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [{ ruleId: 'js/missing-rate-limiting', path: 'src/app.ts', line: 408, severity: 'high' }] }))
  writeFileSync(join(sarifDir, 'head.sarif'), sarifDocument([{ ...HIGH, line: 432 }]))
  const run = runGate(sarifDir, baselinePath)
  assert.equal(run.code, 1, 'the same rule at a new line is a new key')
  assert.match(run.stderr, /new high result js\/missing-rate-limiting at src\/app\.ts:432/)
})

// Fail closed is for security, not for every quality query: CodeQL scores only
// security queries with a CVSS value, so promoting a `note` maintainability
// finding to high would make the gate red on main for a class it exists to
// ignore.
test('a security result with no readable score is high; a quality result keeps its level', () => {
  const security = { id: 'js/missing-rate-limiting', properties: { tags: ['security'], 'security-severity': 'not-a-number' } }
  const qualityNote = { id: 'js/unneeded-defensive-code', properties: { tags: ['quality', 'maintainability'] } }
  const qualityWarning = { id: 'js/template-syntax-in-string-literal', properties: { tags: ['correctness', 'quality'] } }
  assert.equal(severityOf({ level: 'warning' }, security), 'high', 'a security query without a readable score fails closed')
  assert.equal(severityOf({ level: 'note' }, qualityNote), 'low', 'a quality note is not promoted')
  assert.equal(severityOf({ level: 'warning' }, qualityWarning), 'medium', 'a quality warning is not promoted')
  assert.equal(severityOf({ level: 'warning' }, undefined), 'high', 'an unresolved rule cannot be judged and fails closed')
})

test('a dismissed result that the baseline records is not counted as added', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  // GitHub keeps dismissed alerts out of the SARIF's suppressions, so the gate
  // cannot tell them apart from open ones: the baseline is the record that the
  // result was already reviewed and dismissed.
  writeFileSync(baselinePath, JSON.stringify({
    recordedAtSha: 'a'.repeat(40),
    alerts: [{ ruleId: 'js/missing-rate-limiting', path: 'src/gateway/gateway.ts', line: 125, severity: 'high', reason: 'alert #41, dismissed false positive' }],
  }))
  writeFileSync(join(sarifDir, 'head.sarif'), sarifDocument([{ rule: 'js/missing-rate-limiting', severity: '7.5', path: 'src/gateway/gateway.ts', line: 125 }]))
  const run = runGate(sarifDir, baselinePath)
  assert.equal(run.code, 0, `a recorded dismissed result must not fail the gate: ${run.stderr}`)
  assert.match(run.stdout, /parsed 1 result\(s\), 1 high\/critical, 0 added/)
})

// #307: these two readers describe different sets. A medium result is accepted by
// severity here, so this gate passes it — and the branch still refuses the merge
// while that result's review thread is open, because `review-gate` owns the
// blocking decision and fails on any unresolved thread (`#308`, merged). Two
// machine lines that disagree is how `#299` looked green on every required check
// and was refused by the merge API. The gate keeps its decision (an accepted
// severity is not a failure) and names every accepted result whose thread is open,
// so a maintainer reading only the CodeQL job is told why the tip will not merge.
const MEDIUM: Spec = { rule: 'js/unused-local-variable', severity: '5.3', path: 'scripts/verify-release.mjs', line: 21 }

// The thread's own shape from the GraphQL reader: `line` is null once the comment
// is outdated, exactly the state `#299`'s four threads were in when their fix
// landed, so `originalLine` is the place to compare against.
function writeThreads(dir: string, nodes: Array<Record<string, unknown>>): string {
  const path = join(dir, 'threads.json')
  writeFileSync(path, JSON.stringify(nodes))
  return path
}

test('an accepted-severity result with an open thread is named, and the gate still passes', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  writeFileSync(join(sarifDir, 'head.sarif'), sarifDocument([MEDIUM]))
  const threadsPath = writeThreads(dir, [{ isResolved: false, isOutdated: true, path: MEDIUM.path, line: null, originalLine: MEDIUM.line }])

  const run = runGate(sarifDir, baselinePath, ['--threads', threadsPath])
  const output = `${run.stdout}${run.stderr}`
  assert.equal(run.code, 0, `an accepted severity is not a gate failure: ${output}`)
  assert.match(run.stdout, /accepted-by-severity js\/unused-local-variable at scripts\/verify-release\.mjs:21/)
  assert.match(run.stdout, /review-gate will block the merge until that thread is resolved/)
  assert.match(run.stdout, /codeql-gate: ok \(parsed 1 result\(s\), 0 high\/critical, 0 added/)
})

test('the same accepted-severity result stays quiet once its thread is resolved', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  writeFileSync(join(sarifDir, 'head.sarif'), sarifDocument([MEDIUM]))
  const threadsPath = writeThreads(dir, [{ isResolved: true, isOutdated: true, path: MEDIUM.path, line: null, originalLine: MEDIUM.line }])

  const run = runGate(sarifDir, baselinePath, ['--threads', threadsPath])
  assert.equal(run.code, 0)
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /accepted-by-severity/, 'a resolved thread must not be named as blocking')
})

test('an open thread on a line this analysis did not report costs no advisory', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  writeFileSync(join(sarifDir, 'head.sarif'), sarifDocument([MEDIUM]))
  const threadsPath = writeThreads(dir, [{ isResolved: false, isOutdated: false, path: 'src/app.ts', line: 432, originalLine: 432 }])

  const run = runGate(sarifDir, baselinePath, ['--threads', threadsPath])
  assert.equal(run.code, 0)
  assert.doesNotMatch(`${run.stdout}${run.stderr}`, /accepted-by-severity/, 'an advisory names only a result this run reported')
})
