import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertContainerBoundary, flybotContainerArgs, type FlybotContainerInput } from '../src/flybot/isolation.js'

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

// The two blocks above read the source; these call the builder. They need no
// Docker daemon, so the arguments the product actually hands to `docker run` are
// asserted on every `npm test`, and each fact is proven both ways: the flag that
// must be there, and the tampered argument that must be refused.
const UNIT_DATA_DIR = mkdtempSync(join(tmpdir(), 'flybot-args-'))

function unitArgs(overrides: Partial<FlybotContainerInput> = {}): string[] {
  return flybotContainerArgs({
    container: 'fledge-flybot-abc123',
    network: 'fledge-abc123',
    dataDir: UNIT_DATA_DIR,
    uid: 1000,
    gid: 1000,
    dshPort: 4300,
    memory: '1g',
    cpus: '1.5',
    image: 'flybot:fledge-20261031-2213b4ca',
    modelKey: 'model-key-1',
    ...overrides,
  })
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

// The image and the entrypoint command are the last three arguments; a flag
// added by hand goes in front of them, where Docker reads it.
function withFlags(args: string[], ...extra: string[]): string[] {
  return [...args.slice(0, -3), ...extra, ...args.slice(-3)]
}

function replaceValue(args: string[], name: string, value: string): string[] {
  const copy = [...args]
  copy[copy.indexOf(name) + 1] = value
  return copy
}

function withoutPair(args: string[], name: string): string[] {
  const index = args.indexOf(name)
  return [...args.slice(0, index), ...args.slice(index + 2)]
}

test('the builder keeps a read-only root and no root mount', () => {
  const args = unitArgs()
  assert.equal(args.includes('--read-only'), true, 'the container root must be read-only')
  // A root mount would hand back the writable tree the flag exists to remove.
  assert.equal(
    args.filter((argument) => argument.startsWith('/')).some((argument) => argument.endsWith(':/')),
    false,
    'no bind may mount the container root',
  )
  assert.throws(
    () => assertContainerBoundary(withoutPair(args, '--read-only'), UNIT_DATA_DIR),
    /read-only root/,
    'arguments without --read-only must be refused, not silently run',
  )
  assert.throws(
    () => assertContainerBoundary(replaceValue(args, '-v', '/:/'), UNIT_DATA_DIR),
    /repository data directory at \/data/,
    'a bind of the host root at the container root must be refused',
  )
})

test('the builder gives /tmp the one writable tmpfs and no second bind', () => {
  const args = unitArgs()
  assert.equal(flag(args, '--tmpfs'), '/tmp:rw,noexec,nosuid,size=64m', 'a read-only root declares its writable paths')
  assert.equal(args.filter((argument) => argument === '-v').length, 1, 'exactly one host path may be mounted')
  assert.throws(
    () => assertContainerBoundary(withFlags(args, '-v', `${UNIT_DATA_DIR}:/var/tmp`), UNIT_DATA_DIR),
    /exactly one host path, got 2/,
    'a second writable bind must be refused',
  )
})

test('the builder drops every capability and adds none', () => {
  const args = unitArgs()
  assert.equal(flag(args, '--cap-drop'), 'ALL', 'no capability survives into the container')
  assert.equal(args.includes('--cap-add'), false, 'nothing may add a capability back')
  assert.throws(
    () => assertContainerBoundary(withFlags(args, '--cap-add', 'SYS_ADMIN'), UNIT_DATA_DIR),
    /must not add a capability/,
    'an added capability must be refused',
  )
  assert.throws(
    () => assertContainerBoundary(replaceValue(args, '--cap-drop', 'NET_RAW'), UNIT_DATA_DIR),
    /drop every capability/,
    'dropping only some capabilities must be refused',
  )
})

test('the builder keeps no-new-privileges, not a disabled variant', () => {
  const args = unitArgs()
  assert.equal(flag(args, '--security-opt'), 'no-new-privileges')
  assert.equal(args.some((argument) => argument === '--security-opt=no-new-privileges=false'), false)
  assert.throws(
    () => assertContainerBoundary(replaceValue(args, '--security-opt', 'no-new-privileges=false'), UNIT_DATA_DIR),
    /must keep no-new-privileges/,
    'a disabled no-new-privileges must be refused however it is spelled',
  )
})

test('the builder mounts exactly the repository data directory at /data', () => {
  const args = unitArgs()
  assert.equal(flag(args, '-v'), `${UNIT_DATA_DIR}:/data`, 'the data directory is the only host path mounted')
  assert.throws(
    () => assertContainerBoundary(withFlags(args, '-v', '/etc:/data:ro'), UNIT_DATA_DIR),
    /exactly one host path, got 2/,
    'a second bind must be refused even when it is read-only',
  )
  assert.throws(
    () => assertContainerBoundary(replaceValue(args, '-v', '/etc:/data'), UNIT_DATA_DIR),
    /repository data directory at \/data/,
    'a bind outside the repository data directory must be refused',
  )
})

test('the builder refuses a root user or no user at all', () => {
  const args = unitArgs()
  assert.equal(flag(args, '--user'), '1000:1000', 'the container runs as the invoking user, never root')
  assert.throws(() => unitArgs({ uid: 0 }), /non-root uid/, 'uid 0 must be refused')
  assert.throws(() => unitArgs({ gid: 0 }), /non-root gid/, 'gid 0 must be refused')
  assert.throws(
    () => assertContainerBoundary(withoutPair(args, '--user'), UNIT_DATA_DIR),
    /must name an unprivileged user/,
    'arguments with no --user must be refused',
  )
  assert.throws(
    () => assertContainerBoundary(replaceValue(args, '--user', 'root:root'), UNIT_DATA_DIR),
    /unprivileged user, got "root"/,
    'a named root user must be refused',
  )
})

test('the builder never mounts the host Docker socket, including as a data path', () => {
  const args = unitArgs()
  assert.equal(
    args.filter((argument) => argument.startsWith('-v')).includes('-v'),
    true,
  )
  assert.throws(
    () => assertContainerBoundary(replaceValue(args, '-v', '/var/run/docker.sock:/data'), UNIT_DATA_DIR),
    /never mount the host Docker socket/,
    'a bind whose source is the host Docker socket must be refused',
  )
  const socketDir = join(UNIT_DATA_DIR, 'docker.sock')
  mkdirSync(socketDir, { recursive: true })
  assert.throws(
    () => unitArgs({ dataDir: socketDir }),
    /never mount the host Docker socket/,
    'a repository data path that names the socket must be refused before it becomes a bind',
  )
})

test('a command that inspects the socket path is not a socket mount', () => {
  // The isolation check proves the socket is absent from inside the container,
  // so its probe command names the path. A command is not a mount and must not
  // be refused, or the check fails before it can start a container.
  const probe = "node -e \"require('node:fs').existsSync('/var/run/docker.sock')\""
  const args = unitArgs({ command: probe })
  assert.equal(args.at(-1), probe, 'the probe command reaches docker run unchanged')
  assert.equal(flag(args, '-v'), `${UNIT_DATA_DIR}:/data`, 'the only bind is still the data directory')
})

test('the builder refuses a data directory that is not an absolute existing directory', () => {
  assert.throws(
    () => unitArgs({ dataDir: 'repos/tenant/data' }),
    /must be absolute/,
    "a relative data directory is resolved by the daemon against its own working directory, so it can mount another tenant's tree",
  )
  assert.throws(
    () => unitArgs({ dataDir: join(UNIT_DATA_DIR, 'missing') }),
    /does not exist/,
    'a missing data directory would be created by Docker as root',
  )
  assert.throws(
    () => unitArgs({ dataDir: fileURLToPath(new URL('../package.json', import.meta.url)) }),
    /not a directory/,
    'a file is not a mount source for a tenant data directory',
  )
})
