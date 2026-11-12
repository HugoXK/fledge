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

// The gate is a CLI, so its environment is its input: `env` replaces the
// inherited one wholesale, which is how a test can say "this run has a pull
// request and no token" without depending on the machine it runs on.
function runGate(sarifDir: string, baselinePath: string, extra: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    ['scripts/codeql-gate.mjs', '--sarif', sarifDir, '--baseline', baselinePath, ...extra],
    { encoding: 'utf8', env: { ...process.env, ...env } },
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
  // #251 moved these five route registrations: one import line at `:40` and
  // five lines inside the webhook path. #357 adds one line above the webhook
  // route registration, so the `:2957` pin and its baseline entry moved to
  // `:2958` together in that commit. #358 moved the two gateway registrations
  // the same way: two import lines and the `readAnswer` helper above them, 19
  // lines in total, with no new route and no change to the limiter call that
  // opens each handler; alerts #41 and #42 stay the same two dismissed results.
  // #359 then moved the webhook registration to `:2979` on its own tree, and
  // #353 (four inserts: two in the failure path, two in the retry route) plus
  // #341 (two comment lines in the retry route) took it to `:2983` on main.
  // #355 moved anchors for two reasons and its merge re-measured all of them:
  // one import line at `:27` sits above the four top-of-file route
  // registrations, so those read `:470`/`:505`/`:515`/`:525` rather than main's
  // `:469`/`:504`/`:514`/`:524`, its scope and expiry checks sit in the token
  // create route above the webhook registration, so that tree read `:2996`, and
  // its gateway rewrite adds 10 lines above both gateway registrations, which
  // read `:154`/`:179`. This branch's review-trend read model sits six lines
  // above the webhook registration, so the merged tree reads `:3002` there while
  // the four top routes stay at `:470`/`:505`/`:515`/`:525`. #362 then adds one
  // import line above those four, which read `:471`/`:506`/`:516`/`:526` here,
  // and its `/search` route sits above the webhook registration, which measures
  // `:3036` on the merged tree; the two gateway registrations do not move and
  // stay `:154`/`:179`. #416 adds a 26-line export-cap refusal helper and its two
  // call sites above the webhook registration, which measures `:3062` on this
  // tree; the four top-of-file registrations and the two gateway registrations
  // do not move. Every number above was read from the tree that ships
  // this file, never added to a base: no result was added or dismissed, and the
  // two gateway alerts (#41, #42, both dismissed false positive) are the same
  // two.
  assert.deepEqual([...keys].sort(), [
    'js/missing-rate-limiting|src/app.ts|3062',
    'js/missing-rate-limiting|src/app.ts|471',
    'js/missing-rate-limiting|src/app.ts|506',
    'js/missing-rate-limiting|src/app.ts|516',
    'js/missing-rate-limiting|src/app.ts|526',
    'js/missing-rate-limiting|src/gateway/gateway.ts|154',
    'js/missing-rate-limiting|src/gateway/gateway.ts|179',
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

// #342: the same blindness one level down. `runs` is a list with a slot in it and
// nothing in the slot, so it is not the "no analysis run" shape the refusal above
// names, and the reader — which reaches for `run?.tool` — reads it as zero
// results. A gate that maps "a run slot with no run in it" to "found nothing"
// hands a green verdict to a document no analysis produces, which is the failure
// mode the three refusals exist to prevent.
//
// The plain-object predicate is the whole acceptance here: JavaScript calls an
// array an object, so a guard written as `entry !== null && typeof entry ===
// 'object'` satisfies the null fixture and still passes `[]`. The two fixtures
// below are therefore a pair — null alone does not separate a correct guard from
// a passing one, and the array is what does. A string, a number and a boolean are
// the rest of the family and are refused for the same reason, with no "an empty
// array is fine" carve-out.
test('a run slot that is not a plain JSON object is refused by name', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))

  for (const run of ['null', '[]', '"x"', '42', 'true']) {
    writeFileSync(join(sarifDir, 'head.sarif'), `{"version":"2.1.0","runs":[${run}]}`)
    const refused = runGate(sarifDir, baselinePath)
    const output = `${refused.stdout}${refused.stderr}`
    assert.equal(refused.code, 1, `a run slot holding ${run} must fail closed`)
    assert.match(
      refused.stderr,
      /is not readable SARIF: run 0 is not an object/,
      `a run slot holding ${run} is refused by name, with the file and the index`,
    )
    assert.doesNotMatch(output, /parsed 0 result\(s\)/, `a run slot holding ${run} must not read as a clean analysis`)
    assert.doesNotMatch(output, /TypeError/, `a run slot holding ${run} must be a refusal, not a crash`)
  }

  // The index is the slot's own, not always 0: a real run in front of the bad
  // slot must not shift the message onto the run that was fine.
  writeFileSync(join(sarifDir, 'head.sarif'), '{"version":"2.1.0","runs":[{"results":[]},null]}')
  const shifted = runGate(sarifDir, baselinePath)
  assert.equal(shifted.code, 1, 'a bad slot after a good one still fails closed')
  assert.match(shifted.stderr, /is not readable SARIF: run 1 is not an object/)

  // And the guard must not widen past its purpose: a real analysis that
  // legitimately found nothing keeps its pass.
  writeFileSync(join(sarifDir, 'head.sarif'), JSON.stringify({ version: '2.1.0', runs: [{ results: [] }] }))
  const empty = runGate(sarifDir, baselinePath)
  assert.equal(empty.code, 0, `an analysis that found nothing is still the pass state: ${empty.stderr}`)
  assert.match(empty.stdout, /codeql-gate: ok \(parsed 0 result\(s\), 0 high\/critical, 0 added/)
})

// #385: one level below the slot. `results` is the list the reader iterates, and
// `run?.results ?? []` turned three shapes into three wrong verdicts: `null` read
// as a clean analysis, a number crashed the gate with a raw TypeError, and a
// string was iterated per character into a high finding with an empty rule id.
// A `results` value that is present and is not a list is refused by name at the
// level that reads it, so the verdict is a refusal even when a caller reaches
// `parseSarif` without the CLI's per-file loop.
test('a run whose results is null is refused, not read as a clean analysis', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))

  writeFileSync(join(sarifDir, 'head.sarif'), '{"version":"2.1.0","runs":[{"results":null}]}')
  const run = runGate(sarifDir, baselinePath)
  const output = `${run.stdout}${run.stderr}`
  assert.equal(run.code, 1, 'a run with a null results list carries no verdict, so it must fail closed')
  assert.match(run.stderr, /is not readable SARIF: run 0 results is not a list \(found null\)/)
  assert.doesNotMatch(output, /parsed 0 result\(s\)/, 'a null results list must not be reported as a clean analysis')
  assert.doesNotMatch(output, /TypeError/)
  // The refusal belongs to the reader, so a caller that skips the gate's loop
  // gets the same named error instead of an empty alert list.
  assert.throws(() => parseSarif({ runs: [{ results: null }] }), /run 0 results is not a list \(found null\)/)

  // The run index is the offending run's own: a good run in front of the bad
  // one must not shift the message onto the run that was fine.
  writeFileSync(join(sarifDir, 'head.sarif'), '{"version":"2.1.0","runs":[{"results":[]},{"results":null}]}')
  const shifted = runGate(sarifDir, baselinePath)
  assert.equal(shifted.code, 1, 'a bad results list after a good run still fails closed')
  assert.match(shifted.stderr, /is not readable SARIF: run 1 results is not a list \(found null\)/)
})

test('a run whose results is a number is refused by name instead of crashing', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))

  writeFileSync(join(sarifDir, 'head.sarif'), '{"version":"2.1.0","runs":[{"results":42}]}')
  const run = runGate(sarifDir, baselinePath)
  const output = `${run.stdout}${run.stderr}`
  assert.equal(run.code, 1, 'a number is not a result list, so it must fail closed')
  assert.match(run.stderr, /is not readable SARIF: run 0 results is not a list \(found number\)/)
  assert.doesNotMatch(output, /TypeError/, 'a refusal, not a crash: the same standard as the slot guard')
  assert.doesNotMatch(output, /parsed 0 result\(s\)/)
})

test('a run whose results is a string is refused instead of inventing a finding', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))

  writeFileSync(join(sarifDir, 'head.sarif'), '{"version":"2.1.0","runs":[{"results":"x"}]}')
  const run = runGate(sarifDir, baselinePath)
  const output = `${run.stdout}${run.stderr}`
  assert.equal(run.code, 1, 'a string is not a result list, so it must fail closed')
  assert.match(run.stderr, /is not readable SARIF: run 0 results is not a list \(found string\)/)
  // Iterating the string per character is how the gate invented `new high result
  // at :0`; a gate that invents a finding is one refactor away from inventing an
  // approval, so that line must not exist.
  assert.doesNotMatch(output, /new high result/, 'a string must not be flattened into a fabricated finding')
})

test('a run with an empty results list or no results key still passes', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))

  // Both shapes are a real analysis that legitimately found nothing: the empty
  // list says so explicitly, and some producers omit `results` when there are
  // none. Refusing either would turn a quiet night into a red one, which is the
  // blindness this gate exists to avoid in the other direction.
  for (const document of [
    '{"version":"2.1.0","runs":[{"results":[]}]}',
    '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"CodeQL","rules":[]}}}]}',
  ]) {
    writeFileSync(join(sarifDir, 'head.sarif'), document)
    const run = runGate(sarifDir, baselinePath)
    assert.equal(run.code, 0, `a zero-result analysis is the pass state: ${run.stderr}`)
    assert.match(run.stdout, /codeql-gate: ok \(parsed 0 result\(s\), 0 high\/critical, 0 added/)
  }
})

// #297: the three shapes that are not a SARIF document at all. A top-level
// array, a string and a number are not plain objects either, yet each already
// fails closed with the missing-or-not-a-list form rather than a crash, so the
// null guard must not reach them or re-word a working refusal.
test('a SARIF whose document is not an object keeps the missing-shape refusal', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))

  for (const document of ['[]', '"x"', '42']) {
    writeFileSync(join(sarifDir, 'head.sarif'), document)
    const run = runGate(sarifDir, baselinePath)
    assert.equal(run.code, 1, `a document that is ${document} must fail closed`)
    assert.match(
      run.stderr,
      /has no analysis run \(runs: missing or not a list\)/,
      `a document that is ${document} names the shape it was`,
    )
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /TypeError/, `a document that is ${document} must not crash`)
  }
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

// #297: `JSON.parse('null')` returns `null`, and reading `runs` off a null
// document throws `TypeError: Cannot read properties of null (reading 'runs')`,
// which is a crash with a stack trace rather than a refusal. Without a shape it
// has nothing to say about runs, so it is refused as unreadable, exactly like a
// body that would not parse. The predicate is `document === null` and no wider
// plain-object test: the three shapes pinned above keep their own message.
test('a SARIF whose document is JSON null is refused by name, not with a TypeError', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  writeFileSync(join(sarifDir, 'head.sarif'), 'null')
  const run = runGate(sarifDir, baselinePath)
  const output = `${run.stdout}${run.stderr}`
  assert.equal(run.code, 1, 'a null SARIF must fail closed')
  assert.match(run.stderr, /is not readable SARIF/, 'a null document is refused by name')
  assert.doesNotMatch(output, /TypeError/, 'a refusal must not be a crash')
  assert.doesNotMatch(output, /\n\s+at /, 'a refusal is one message, not a stack trace')
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

// The advisory above is only worth anything if the gate can actually read the
// threads in Actions, and the two ways it can end up with none are not the same
// verdict. A push to `main` has no pull request: nothing to read, and silence is
// the truth. A pull request run that has no token (a step inherits no
// `GITHUB_TOKEN`; it is not a default environment variable) has a thread list it
// cannot see, and staying silent there is the bug this pair pins: green job,
// green check, and a merge the author is never told about.
function writeEvent(dir: string, payload: Record<string, unknown>): string {
  const path = join(dir, 'event.json')
  writeFileSync(path, JSON.stringify(payload))
  return path
}

test('a pull request run with no token says it cannot read the threads, and the job stays green', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  writeFileSync(join(sarifDir, 'head.sarif'), sarifDocument([MEDIUM]))
  const eventPath = writeEvent(dir, { pull_request: { number: 323, base: { ref: 'main' } } })

  const run = runGate(sarifDir, baselinePath, [], {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: 'HugoXK/fledge',
    GITHUB_REF: 'refs/pull/323/merge',
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
  })
  const output = `${run.stdout}${run.stderr}`
  assert.equal(run.code, 0, `a token this step was never given is not a gate failure: ${output}`)
  assert.match(
    run.stderr,
    /codeql-gate: cannot read the review threads, so accepted-severity results are not named here/,
    'a pull request whose threads could not be read must say so, not print a clean ok',
  )
  assert.match(run.stderr, /#323/, 'the line names the pull request whose threads it could not read')
  assert.match(run.stdout, /codeql-gate: ok \(parsed 1 result\(s\), 0 high\/critical, 0 added/)
})

test('a run with no pull request has nothing to read and stays quiet', (t) => {
  const dir = tempDir(t)
  const baselinePath = join(dir, 'baseline.json')
  const sarifDir = join(dir, 'results')
  mkdirSync(sarifDir)
  writeFileSync(baselinePath, JSON.stringify({ recordedAtSha: 'a'.repeat(40), alerts: [] }))
  writeFileSync(join(sarifDir, 'head.sarif'), sarifDocument([MEDIUM]))

  // Exactly the scheduled-and-push shape: no event payload, `GITHUB_REF` on main,
  // and no token to read anything with.
  const run = runGate(sarifDir, baselinePath, [], {
    GITHUB_EVENT_PATH: '',
    GITHUB_REPOSITORY: 'HugoXK/fledge',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_TOKEN: '',
    GH_TOKEN: '',
  })
  const output = `${run.stdout}${run.stderr}`
  assert.equal(run.code, 0)
  assert.doesNotMatch(
    output,
    /cannot read the review threads/,
    'no pull request is nothing to read, not a read this gate failed at',
  )
  assert.match(run.stdout, /codeql-gate: ok \(/)
})

test('the CodeQL job hands the gate a token, because a step has none by default', () => {
  const workflow = readFileSync('.github/workflows/codeql.yml', 'utf8')
  const step = workflow.slice(workflow.indexOf('Fail on a new high or critical CodeQL result'))
  assert.ok(step !== '', 'codeql.yml must still run the gate step')
  const beforeRun = step.slice(0, step.indexOf('run:'))
  assert.match(
    beforeRun,
    /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/,
    'the gate step must map GITHUB_TOKEN itself: `pull-requests: read` grants the permission but hands the process no credential',
  )
})
