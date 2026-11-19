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
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
