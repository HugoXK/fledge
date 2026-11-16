// #109: the isolation boundary is proven from inside a real container that is
// started with exactly the flags the product starts, never by reading flags.
// This check needs a Docker daemon; where there is none it exits 3 with a loud
// message, because a silent pass would hide the very boundary it exists to test.
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { flybotContainerArgs } from '../src/flybot/isolation.js'

const execFileAsync = promisify(execFile)

const NO_DAEMON = 3
const BOUNDARY_BROKEN = 1

interface Options {
  docker: string
  image: string
}

function parseOptions(argv: string[]): Options {
  const options: Options = { docker: 'docker', image: 'node:22-bookworm-slim' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--docker' && value !== undefined) { options.docker = value; index += 1 }
    else if (flag === '--image' && value !== undefined) { options.image = value; index += 1 }
    else throw new Error(`unknown argument: ${flag ?? ''}`)
  }
  return options
}

function docker(options: Options, argv: string[], timeout = 120_000): Promise<string> {
  return execFileAsync(options.docker, argv, { timeout, maxBuffer: 8 * 1024 * 1024 }).then((result) => result.stdout.trim())
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

// Runs inside the probe container. It reports what the kernel says about the
// process, not what the flags intended, and it tries one thing it must not be
// able to do: reach a sibling container on another tenant's network.
const PROBE = `
const fs = require('node:fs')
const net = require('node:net')
const fact = {}
try { fs.writeFileSync('/__isolation_probe', 'x'); fact.rootWritable = true } catch (error) { fact.rootWritable = false; fact.rootError = error.code }
const status = fs.readFileSync('/proc/self/status', 'utf8')
fact.caps = (/^CapEff:\\s*([0-9a-f]+)/m.exec(status) || [])[1] || null
fact.seccomp = (/^Seccomp:\\s*(\\d+)/m.exec(status) || [])[1] || null
fact.dockerSocket = fs.existsSync('/var/run/docker.sock')
fact.dataMounts = fs.readFileSync('/proc/mounts', 'utf8').split('\\n')
  .filter((line) => line.includes(' /data ')).map((line) => line.split(' ')[1])
const sibling = process.argv[1]
const reach = (host, port, timeout) => new Promise((resolve) => {
  const socket = net.connect({ host, port })
  const done = (value) => { socket.destroy(); resolve(value) }
  socket.setTimeout(timeout, () => done(false))
  socket.once('connect', () => done(true))
  socket.once('error', () => done(false))
})
reach(sibling, Number(process.argv[2]), 1500).then((ok) => { fact.siblingReachable = ok; process.stdout.write(JSON.stringify(fact)) })
`

interface Fact {
  rootWritable: boolean
  rootError?: string
  caps: string | null
  seccomp: string | null
  dockerSocket: boolean
  dataMounts: string[]
  siblingReachable: boolean
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  try {
    await docker(options, ['info', '--format', '{{.ServerVersion}}'], 30_000)
  } catch {
    console.error(`isolation-check: no Docker daemon reachable through ${options.docker} — this check cannot pass without one`)
    process.exit(NO_DAEMON)
  }

  const tag = `${process.pid}-${Math.random().toString(16).slice(2, 8)}`
  const network = `fledge-isolation-${tag}`
  const siblingNetwork = `fledge-isolation-sibling-${tag}`
  const probe = `fledge-isolation-probe-${tag}`
  const sibling = `fledge-isolation-sibling-${tag}`
  const dataDir = mkdtempSync(join(process.cwd(), '.isolation-check-'))
  const failures: string[] = []
  try {
    await docker(options, ['network', 'create', network])
    await docker(options, ['network', 'create', siblingNetwork])
    // The sibling stands in for another tenant: its own network, its own
    // container, one open port. Nothing a job container does may reach it.
    await docker(options, [
      'run', '-d', '--name', sibling, '--network', siblingNetwork, '--entrypoint', 'node', options.image,
      '-e', 'require("node:http").createServer((q, s) => s.end("sibling")).listen(8080)',
    ])
    const siblingIp = await docker(options, ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', sibling])
    const dshPort = await freePort()
    const args = flybotContainerArgs({
      container: probe,
      network,
      dataDir,
      uid: typeof process.getuid === 'function' ? process.getuid() : 1000,
      gid: typeof process.getgid === 'function' ? process.getgid() : 1000,
      dshPort,
      memory: '512m',
      cpus: '1',
      image: options.image,
      modelKey: 'isolation-probe',
      command: `node -e '${PROBE.replace(/'/g, "'\\''")}' ${siblingIp} 8080`,
    })
    // The product starts the container detached and waits for the web port; the
    // check wants the probe's stdout, so it runs the same arguments attached.
    const output = await docker(options, ['run', '--rm', ...args.slice(2)], 180_000)
      .catch((error: { stdout?: string; stderr?: string }) => error.stdout || error.stderr || '')

    let fact: Fact | null = null
    try { fact = JSON.parse(output) as Fact } catch { fact = null }
    if (fact === null) {
      console.error(`isolation-check: probe produced no facts\n${output}`)
      process.exit(BOUNDARY_BROKEN)
    }

    const report = (ok: boolean, line: string): void => {
      console.log(`isolation-check: ${ok ? 'ok' : 'FAILED'} — ${line}`)
      if (!ok) failures.push(line)
    }
    report(fact.rootWritable === false, `root filesystem is read-only (write failed with ${fact.rootError ?? 'an error'})`)
    report(fact.caps === '0000000000000000', `every capability is dropped (CapEff ${fact.caps ?? 'unreadable'})`)
    report(fact.seccomp === '2', `a seccomp filter is loaded (Seccomp ${fact.seccomp ?? 'unreadable'})`)
    report(fact.dockerSocket === false, 'the host Docker socket is not visible inside the container')
    report(fact.dataMounts.length === 1, `exactly one host bind is mounted, the repository's own data directory (${fact.dataMounts.join(', ') || 'none'})`)
    report(fact.siblingReachable === false, 'another tenant on another Docker network is unreachable')

    if (failures.length > 0) {
      console.error(`isolation-check: ${failures.length} condition(s) failed`)
      process.exit(BOUNDARY_BROKEN)
    }
    console.log('isolation-check: boundary holds')
  } finally {
    await docker(options, ['rm', '-f', probe], 60_000).catch(() => '')
    await docker(options, ['rm', '-f', sibling], 60_000).catch(() => '')
    await docker(options, ['network', 'rm', network], 60_000).catch(() => '')
    await docker(options, ['network', 'rm', siblingNetwork], 60_000).catch(() => '')
    rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch((error: unknown) => {
  console.error(`isolation-check: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(BOUNDARY_BROKEN)
})
