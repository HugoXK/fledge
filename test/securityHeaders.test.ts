import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// #1009: the shipped nginx sample is a copy-paste console front end. A
// self-hoster who keeps the default BASE_URL gets no HSTS from the app
// (`src/app.ts` sends it only for an https base), so the TLS server block in
// the sample has to carry it — and the three headers the app already sends
// have to cover the responses nginx generates on its own (the 80→443 301 and a
// 502 while the app is down). A plain `add_header` is not applied to 4xx/5xx,
// hence `always`; and nginx stops inheriting the server set on a path the
// moment that location declares any `add_header` of its own.
const root = fileURLToPath(new URL('..', import.meta.url))
const script = join(root, 'scripts/check-nginx-config.sh')
const contract = join(root, 'scripts/check-deploy-samples.sh')
const sample = join(root, 'deploy/nginx.conf.example')

const HEADERS = ['Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options']

interface Block {
  start: number
  lines: string[]
}

/** Split the sample into its top-level `server { ... }` blocks. */
function serverBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let current: Block | undefined
  let depth = 0
  text.split('\n').forEach((line, index) => {
    if (current === undefined) {
      if (/^server\s*\{/.test(line)) {
        current = { start: index + 1, lines: [line] }
        depth = 1
      }
      return
    }
    current.lines.push(line)
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (depth === 0) {
      blocks.push(current)
      current = undefined
    }
  })
  return blocks
}

function hasHeaderAtServerLevel(block: Block, name: string): boolean {
  // Two leading spaces is the sample's server level; location bodies indent
  // four. The trailing `always` is the part that covers nginx's own 4xx/5xx.
  return block.lines.some((line) => line.startsWith(`  add_header ${name} `) && /[ \t]always;[ \t]*$/.test(line))
}

/** Run the nginx check with a stub that accepts any config it is handed. */
function runCheck(file?: string): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    const bin = join(dir, 'nginx')
    writeFileSync(bin, '#!/usr/bin/env bash\nexit 0\n')
    chmodSync(bin, 0o755)
    const args = [script, ...(file === undefined ? [] : ['--sample', file])]
    const result = spawnSync('bash', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Copy the shipped sample, apply `edit`, and return the copy's path. */
function editedSample(dir: string, edit: (text: string) => string): string {
  const text = edit(readFileSync(sample, 'utf8'))
  const path = join(dir, 'edited-nginx.conf')
  copyFileSync(sample, path)
  writeFileSync(path, text)
  return path
}

test('every server block ships the four security headers with always', () => {
  const blocks = serverBlocks(readFileSync(sample, 'utf8'))
  assert.equal(blocks.length, 2, 'the sample ships the TLS server and the 80→443 redirect server')
  for (const name of HEADERS) {
    for (const block of blocks) {
      assert.ok(
        hasHeaderAtServerLevel(block, name),
        `server block opened at line ${String(block.start)} must carry \`add_header ${name} ... always;\` at server level`,
      )
    }
  }
})

test('the shipped sample passes the header check', () => {
  const run = runCheck()
  assert.equal(run.status, 0, `the shipped sample must pass the check; stdout: ${run.stdout} stderr: ${run.stderr}`)
  assert.match(run.stdout, /nginx: deploy\/nginx\.conf\.example parsed/)
})

test('a sample missing one header is refused and the header is named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    const path = editedSample(dir, (text) =>
      text
        .split('\n')
        .filter((line) => !line.startsWith('  add_header X-Frame-Options '))
        .join('\n'),
    )
    const run = runCheck(path)
    assert.equal(run.status, 1, 'a sample without the framing header must not pass the check')
    assert.match(run.stdout, /X-Frame-Options/, 'the failure must name the header that is missing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a header without always is refused, because 4xx/5xx would drop it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    const path = editedSample(dir, (text) =>
      text.replace(/^(  add_header Strict-Transport-Security .*) always;\s*$/gm, '$1;'),
    )
    const run = runCheck(path)
    assert.equal(run.status, 1, 'a sample whose HSTS lost `always` must not pass the check')
    assert.match(run.stdout, /Strict-Transport-Security/, 'the failure must name the header that lost `always`')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The shipped values, reused inside a location that has to repeat the set. */
const HEADER_VALUES: Record<string, string> = {
  'Strict-Transport-Security': '"max-age=31536000; includeSubDomains"',
  'X-Content-Type-Options': '"nosniff"',
  'Referrer-Policy': '"strict-origin-when-cross-origin"',
  'X-Frame-Options': '"DENY"',
}

test('a location that declares its own header is refused and the location is named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    // #1097: nginx stops inheriting the server-level set on a location the
    // moment that location declares any `add_header`, so this copy serves every
    // response from `/` without the four headers — and used to pass the gate.
    const path = editedSample(dir, (text) =>
      text.replace(/^( {2}location \/ \{)$/m, '$1\n    add_header Cache-Control "no-store" always;'),
    )
    const run = runCheck(path)
    assert.equal(run.status, 1, 'a location that declares its own add_header must not pass the check')
    assert.match(run.stdout, /location block opened at line \d+/, 'the failure must name the location block')
    for (const name of ['Strict-Transport-Security', 'X-Frame-Options']) {
      assert.match(run.stdout, new RegExp(name), `the failure must name a header the location stopped inheriting: ${name}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a location that repeats all four headers with always is accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    const repeat = HEADERS.map((name) => `    add_header ${name} ${HEADER_VALUES[name] ?? '""'} always;`).join('\n')
    const path = editedSample(dir, (text) => text.replace(/^( {2}location \/ \{)$/m, `$1\n${repeat}`))
    const run = runCheck(path)
    assert.equal(
      run.status,
      0,
      `a location that repeats the set with always must pass; stdout: ${run.stdout} stderr: ${run.stderr}`,
    )
    assert.match(run.stdout, /nginx: .* parsed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a location that repeats the set without always is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    const repeat = HEADERS.map((name) => `    add_header ${name} ${HEADER_VALUES[name] ?? '""'};`).join('\n')
    const path = editedSample(dir, (text) => text.replace(/^( {2}location \/ \{)$/m, `$1\n${repeat}`))
    const run = runCheck(path)
    assert.equal(run.status, 1, 'a location-level set without `always` is dropped on 4xx/5xx and must be refused')
    assert.match(run.stdout, /location block opened at line \d+/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a one-liner location that declares its own header is refused and named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    // #1097 review: the first rule saw a location only when its line carried
    // `{` and a header only when the header line started with the directive, so
    // this legal one-liner shadowed the whole server set and passed.
    const path = editedSample(dir, (text) =>
      text.replace(
        /^( {2}location \/ \{)$/m,
        '  location = /health { add_header Cache-Control "no-store" always; }\n$1',
      ),
    )
    const run = runCheck(path)
    assert.equal(run.status, 1, 'a one-liner location that declares its own add_header must not pass the check')
    assert.match(run.stdout, /location block opened at line \d+/, 'the failure must name the location block')
    for (const name of ['Strict-Transport-Security', 'X-Frame-Options']) {
      assert.match(run.stdout, new RegExp(name), `the failure must name a header the one-liner stopped inheriting: ${name}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the one-liner shape is accepted once it repeats the set with always', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    const repeat = HEADERS.map((name) => `add_header ${name} ${HEADER_VALUES[name] ?? '""'} always;`).join(' ')
    const path = editedSample(dir, (text) =>
      text.replace(/^( {2}location \/ \{)$/m, `  location = /health { ${repeat} }\n$1`),
    )
    const run = runCheck(path)
    assert.equal(
      run.status,
      0,
      `a one-liner that repeats the set with always must pass; stdout: ${run.stdout} stderr: ${run.stderr}`,
    )
    assert.match(run.stdout, /nginx: .* parsed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a location whose brace is on the next line is still read and refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    // #1097 review: the rule depended on the `{` sharing the location's line, so
    // this shape was invisible to it.
    const path = editedSample(dir, (text) =>
      text.replace(
        /^( {2}location \/ \{)$/m,
        '  location /next\n  {\n    add_header Cache-Control "no-store" always;\n  }\n$1',
      ),
    )
    const run = runCheck(path)
    assert.equal(run.status, 1, 'a location whose brace is on the next line must still be checked')
    assert.match(run.stdout, /location block opened at line \d+/, 'the failure must name the location block')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a CRLF copy of the shipped sample passes instead of naming missing headers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    // #1097 review: the `\r` between the value and `always` made every header
    // look missing on a CRLF copy; the safe direction was right, the message was
    // not, and the contract now proves the copy parses.
    const path = editedSample(dir, (text) => text.replace(/\n/g, '\r\n'))
    const run = runCheck(path)
    assert.equal(
      run.status,
      0,
      `a CRLF copy must pass the header check; stdout: ${run.stdout} stderr: ${run.stderr}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The whole set on one line, `always` on each, for a control that must pass. */
function repeatSet(indent: string): string {
  return HEADERS.map((name) => `${indent}add_header ${name} ${HEADER_VALUES[name] ?? '""'} always;`).join(' ')
}

test('a `}` inside a regex token does not close the block, and the location is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    // #1097 audit, first hole: nginx keeps `}` inside a token, so the regex
    // `^/v}v[0-9]+` is one token and the block still opens at the `{`. The old
    // reader closed on that `}`, lost the location and let a one-header
    // location that serves only `Cache-Control` through.
    const path = editedSample(dir, (text) =>
      text.replace(/^( {2}location \/ \{)$/m, (_match: string) =>
        `  location ~ ^/v}v[0-9]+ { add_header Cache-Control "no-store" always; }\n${_match}`,
      ),
    )
    const run = runCheck(path)
    assert.equal(run.status, 1, 'a location with a brace inside its regex and one header must be refused')
    assert.match(run.stdout, /location block opened at line \d+/, 'the failure must name the location block')
    for (const name of ['Strict-Transport-Security', 'X-Frame-Options']) {
      assert.match(run.stdout, new RegExp(name), `the failure must name a header the location dropped: ${name}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a regex-quantifier brace in a location header is read as part of the token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    // Control: the same brace shape is legal nginx (`^/v[0-9]{1,3}$`) and the
    // location repeats the whole set, so the rule must not refuse a valid regex
    // for carrying a brace.
    const path = editedSample(dir, (text) =>
      text.replace(/^( {2}location \/ \{)$/m, (_match: string) =>
        `  location ~ ^/v[0-9]{1,3}$ { ${repeatSet('')} }\n${_match}`,
      ),
    )
    const run = runCheck(path)
    assert.equal(run.status, 0, `a brace inside a header token must not close the block; stdout: ${run.stdout}`)
    assert.match(run.stdout, /nginx: .* parsed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an `if` inside a location that declares its own header is refused and named', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    // #1097 audit, second hole: the header belongs to the innermost block, so an
    // `if` that declares one header was recorded against the `if` and the
    // enclosing location was judged clean, although the matched responses serve
    // only that one header.
    const path = editedSample(dir, (text) =>
      text.replace(/^( {2}location \/ \{)$/m, (_match: string) =>
        '  location /ifx { if ($always) { add_header Cache-Control "no-store" always; } }\n' + _match,
      ),
    )
    const run = runCheck(path)
    assert.equal(run.status, 1, 'an if block that declares one header must be refused')
    assert.match(run.stdout, /block opened at line \d+ inside a location/, 'the failure must name the inner block')
    for (const name of ['Strict-Transport-Security', 'X-Frame-Options']) {
      assert.match(run.stdout, new RegExp(name), `the failure must name a header the if block dropped: ${name}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an `if` that repeats the whole set with always is accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    // Control: the responses the `if` applies to carry all four, and the rest
    // inherit the server set, so this shape is what the rule should allow.
    const path = editedSample(dir, (text) =>
      text.replace(/^( {2}location \/ \{)$/m, (_match: string) =>
        `  location /ifx { if ($always) { ${repeatSet('')} } }\n${_match}`,
      ),
    )
    const run = runCheck(path)
    assert.equal(run.status, 0, `an if block that repeats the set must pass; stdout: ${run.stdout}`)
    assert.match(run.stdout, /nginx: .* parsed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a `}` with no block open is refused rather than dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    // #1097 audit: the reader used to ignore a close at depth 0, so a sample
    // nginx rejects could still look clean to the static half.
    const path = editedSample(dir, (text) => `${text}\n}\n`)
    const run = runCheck(path)
    assert.equal(run.status, 1, 'a stray `}` must fail the static half')
    assert.match(run.stdout, /unexpected close brace at line \d+/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a sample with no server block is refused instead of passing vacuously', () => {
  // #1097 test: with no server block the rule had nothing to assert, so an empty
  // file and a comment-only file both exited 0 "parsed" — a fail-open on an
  // input the gate is supposed to judge.
  for (const [shape, text] of [
    ['empty', ''],
    ['comment-only', '# a sample with no server block\n# nothing to check here\n'],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
    try {
      const path = editedSample(dir, () => text)
      const run = runCheck(path)
      assert.equal(run.status, 1, `a ${shape} sample must be refused, not passed vacuously`)
      assert.match(run.stdout, /no server block to check/, `the ${shape} refusal must name the reason`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

const STUB_REJECTS_MARKED = `#!/usr/bin/env bash
set -euo pipefail
config=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "-c" ]; then config="$argument"; fi
  previous="$argument"
done
if [ -z "$config" ]; then echo 'stub nginx: no -c argument' >&2; exit 2; fi
while IFS= read -r included; do
  if grep -q 'bogus_882_self_check' "$included"; then
    echo 'nginx: [emerg] unknown directive "bogus_882_self_check"' >&2
    exit 1
  fi
done < <(sed -n 's/^[[:space:]]*include[[:space:]]\\+\\(\\/[^;]*\\);$/\\1/p' "$config")
exit 0
`

test('the deploy-check contract proves the header check can fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'security-headers-'))
  try {
    const bin = join(dir, 'nginx')
    writeFileSync(bin, STUB_REJECTS_MARKED)
    chmodSync(bin, 0o755)
    const result = spawnSync('bash', [contract], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    })
    const stdout = result.stdout ?? ''
    assert.equal(result.status, 0, `the sample contract must pass; stdout: ${stdout} stderr: ${result.stderr ?? ''}`)
    assert.match(stdout, /security headers: negative proof — a copy missing X-Frame-Options was rejected/)
    assert.match(stdout, /security headers: negative proof — a copy whose HSTS lost `always` was rejected/)
    // #1097: the location trap needs its own proof, because neither copy above
    // can show that a header one brace deeper drops the whole set.
    assert.match(stdout, /security headers: negative proof — a location that declares its own add_header was rejected/)
    assert.match(stdout, /security headers: control — a location that repeats all four headers with always was accepted/)
    // #1097 review: the shape checks are part of the contract, so a rule that
    // reads only an indented header on its own line cannot come back.
    assert.match(stdout, /security headers: negative proof — a one-liner location that declares its own add_header was rejected/)
    assert.match(stdout, /security headers: control — a one-liner location that repeats all four headers with always was accepted/)
    assert.match(stdout, /security headers: negative proof — a location whose `\{` sits on the next line was rejected/)
    // #1097 security review: the brace-inside-a-token and the if-level shapes
    // are part of the same table, so neither can silently come back.
    assert.match(stdout, /security headers: negative proof — a location whose regex carries a `\}` and serves one header was rejected/)
    assert.match(stdout, /security headers: negative proof — an if inside a location that declares one header was rejected/)
    assert.match(stdout, /security headers: control — a brace inside a location token with the whole set was accepted/)
    assert.match(stdout, /security headers: control — an if that repeats the whole set with always was accepted/)
    // #1097 test: an empty sample used to pass with nothing asserted.
    assert.match(stdout, /security headers: negative proof — an empty and a comment-only sample were refused/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
