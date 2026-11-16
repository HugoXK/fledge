// #109: a per-repository FlyBot is a container on a host shared with every other
// tenant, so its `docker run` arguments are a security boundary. They live here,
// in one function, so the isolation check can start a container with exactly the
// flags the product starts and prove the boundary from the inside.

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

// No process inside the container may raise its own limits or gain privileges:
// no capability survives, and the setuid bit cannot add one back.
export function flybotContainerArgs(input: FlybotContainerInput): string[] {
  return [
    'run', '-d',
    '--name', input.container,
    '--network', input.network,
    '-p', `127.0.0.1:${input.dshPort}:3081`,
    '-v', `${input.dataDir}:/data`,
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
  ]
}
