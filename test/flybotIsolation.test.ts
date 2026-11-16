import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

// #109: every per-repository FlyBot runs as a Docker container on the same host
// as every other tenant, so the run arguments are a security boundary and not
// just a convenience. These assertions are the contract the product's own run
// arguments must keep; the container-level proof — that a real container
// actually is read-only and capability-free from the inside — lives in
// `scripts/isolation-check.ts`, which runs where a Docker daemon exists and
// exits non-zero where it does not.

function sourceOf(path: string): string {
  const url = new URL(`../${path}`, import.meta.url)
  return existsSync(url) ? readFileSync(url, 'utf8') : ''
}

// The flags may live in the instance manager or in a dedicated builder module;
// either way the product starts the container with them, so both files count.
function runArgsSource(): string {
  return ['src/flybot/isolation.ts', 'src/flybot/instances.ts'].map(sourceOf).join('\n')
}

test('the job container starts with a read-only root and no host Docker socket', () => {
  const source = runArgsSource()
  assert.match(
    source,
    /'--read-only'/,
    'the container root is writable, so anything inside it can rewrite the image the next job runs from',
  )
  assert.match(
    source,
    /NARB_DISABLE_NATIVE_CACHE/,
    'the native-addon loader writes a binary into /tmp and executes it, so a noexec /tmp needs the cache disabled',
  )
  assert.match(source, /--tmpfs/, 'a read-only root must declare the writable paths explicitly instead of leaving the root writable')
  assert.doesNotMatch(
    source,
    /docker\.sock/,
    'the host Docker socket must never be mounted into a job container: it is root on the host',
  )
})

test('the job container drops every capability and runs as an unprivileged user', () => {
  const source = runArgsSource()
  assert.match(source, /'--cap-drop',\s*'ALL'/, 'capabilities are not dropped, so a breakout keeps the default capability set')
  assert.match(source, /'--security-opt',\s*'no-new-privileges'/, 'no-new-privileges is not passed')
  assert.match(source, /'--user',/, 'the container must not run as root inside its own namespace')
  assert.match(source, /'--pids-limit'/, 'a fork bomb inside one tenant must not starve the whole host')
})

test('the isolation check exists and refuses to pass without a Docker daemon', async () => {
  const script = fileURLToPath(new URL('../scripts/isolation-check.ts', import.meta.url))
  assert.equal(
    existsSync(script),
    true,
    'scripts/isolation-check.ts must exist: the boundary is proven from inside a container, not by reading flags',
  )
  const failure = await execFileAsync('npx', ['tsx', script, '--docker', '/nonexistent/docker'], { timeout: 180_000 })
    .then(() => null)
    .catch((error: { code?: number; stderr?: string; stdout?: string }) => error)
  assert.ok(failure !== null, 'the check passed with no Docker daemon, which is exactly the silent green it must not allow')
  assert.equal(failure.code, 3, 'a missing daemon is its own outcome: exit 3, never 0')
  assert.match(String(failure.stderr ?? ''), /no Docker daemon/i)
})

test('the isolation check proves the boundary inside the container', () => {
  const source = sourceOf('scripts/isolation-check.ts')
  assert.match(source, /read-only|readonly|--read-only/, 'the check does not assert a read-only root')
  assert.match(source, /CapEff/, 'the check does not read the effective capability set from inside the container')
  assert.match(source, /Seccomp/, 'the check does not assert that a seccomp filter is loaded')
  assert.match(source, /docker\.sock/, 'the check does not assert that the host Docker socket is absent')
})
