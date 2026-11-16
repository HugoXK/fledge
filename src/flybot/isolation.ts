// #109: a per-repository FlyBot is a container on a host shared with every other
// tenant, so its `docker run` arguments are a security boundary. They live here,
// in one function, so the isolation check can start a container with exactly the
// flags the product starts and prove the boundary from the inside.

import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export interface FlybotContainerInput {
  container: string
  network: string
  dataDir: string
  uid: number
  gid: number
  dshPort: number
  memory: string
  cpus: string
  image: string
  modelKey: string
  /** Overrides the entrypoint command; the isolation check runs a probe instead. */
  command?: string
}

// A read-only root has to name its writable paths. `/tmp` is the process temp
// directory; `noexec` would block the native-addon loader, which copies a binary
// into the temp directory and executes it, so the loader's cache is disabled in
// the environment below instead of leaving `/tmp` executable.
const TMPFS = '/tmp:rw,noexec,nosuid,size=64m'

// The data directory is the one host path a tenant container sees, so it is
// checked before it becomes a mount. A relative path is resolved by the Docker
// daemon against its own working directory, so it can point at another tenant's
// tree, and a missing one is created by Docker as root, so neither may reach
// `docker run` as written.
function checkedMountSource(dataDir: string): string {
  if (!isAbsolute(dataDir)) {
    throw new Error(`FlyBot data directory must be absolute, got "${dataDir}"`)
  }
  let stat
  try {
    stat = statSync(dataDir)
  } catch {
    throw new Error(`FlyBot data directory does not exist: ${dataDir}`)
  }
  if (!stat.isDirectory()) throw new Error(`FlyBot data directory is not a directory: ${dataDir}`)
  return dataDir
}

// The arguments themselves are the boundary, so they are checked once more after
// they are built: a later edit that adds a bind, a capability, a writable root, a
// root user or the host Docker socket fails here in `npm test` instead of only in
// the container-level check, which needs a daemon.
const DATA_MOUNT = '/data'

export function assertContainerBoundary(args: string[], dataDir: string): string[] {
  if (!args.includes('--read-only')) {
    throw new Error('FlyBot container arguments must start from a read-only root')
  }
  if (!args.includes('--cap-drop') || args[args.indexOf('--cap-drop') + 1] !== 'ALL') {
    throw new Error('FlyBot container arguments must drop every capability')
  }
  if (!args.includes('--user')) throw new Error('FlyBot container arguments must name an unprivileged user')
  const binds: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ''
    if (argument === '--cap-add') throw new Error('FlyBot container arguments must not add a capability')
    if (argument === '--user') {
      const user = (args[index + 1] ?? '').split(':')[0]
      if (user === '' || user === '0' || user === 'root') {
        throw new Error(`FlyBot container must run as an unprivileged user, got "${user}"`)
      }
    }
    if (argument === '--security-opt' && args[index + 1] !== 'no-new-privileges') {
      throw new Error(`FlyBot container must keep no-new-privileges, got "${args[index + 1] ?? ''}"`)
    }
    if (argument === '-v') binds.push(args[index + 1] ?? '')
  }
  if (binds.length !== 1) {
    throw new Error(`FlyBot container must mount exactly one host path, got ${binds.length}`)
  }
  const [source, target] = (binds[0] ?? '').split(':')
  if (source !== dataDir || target !== DATA_MOUNT) {
    throw new Error(`FlyBot container must mount the repository data directory at ${DATA_MOUNT}, got "${binds[0] ?? ''}"`)
  }
  if (args.some((argument) => argument.includes('docker.sock'))) {
    throw new Error('FlyBot container arguments must never name the host Docker socket')
  }
  return args
}

// No process inside the container may raise its own limits or gain privileges:
// no capability survives, and the setuid bit cannot add one back.
export function flybotContainerArgs(input: FlybotContainerInput): string[] {
  const dataDir = checkedMountSource(input.dataDir)
  if (!Number.isInteger(input.uid) || input.uid === 0) {
    throw new Error(`FlyBot container must run as a non-root uid, got "${input.uid}"`)
  }
  if (!Number.isInteger(input.gid) || input.gid === 0) {
    throw new Error(`FlyBot container must run as a non-root gid, got "${input.gid}"`)
  }
  return assertContainerBoundary([
    'run', '-d',
    '--name', input.container,
    '--network', input.network,
    '-p', `127.0.0.1:${input.dshPort}:3081`,
    '-v', `${dataDir}:/data`,
    '--user', `${input.uid}:${input.gid}`,
    '--memory', input.memory,
    '--cpus', input.cpus,
    '--pids-limit', '512',
    '--read-only',
    '--tmpfs', TMPFS,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--restart', 'no',
    '--entrypoint', '/bin/sh',
    '-e', 'HOME=/data',
    '-e', 'DSH_HOME=/data',
    // A hidden constraint, not a preference: the loader writes its native
    // binary into `os.tmpdir()` and `require()`s it, so a `noexec` /tmp makes the
    // web profile fail to start. Disabling the cache loads the binary in place.
    '-e', 'NARB_DISABLE_NATIVE_CACHE=1',
    '-e', 'NPM_CONFIG_REGISTRY=https://registry.npmmirror.com',
    '-e', 'npm_config_registry=https://registry.npmmirror.com',
    '-e', `FLEDGE_MODEL_KEY=${input.modelKey}`,
    input.image,
    '-c', input.command ?? 'node /opt/flybot/docker/entrypoint.mjs >> /data/dsh-web.log 2>&1 & exec node /data/tcp-proxy.mjs',
  ], dataDir)
}
