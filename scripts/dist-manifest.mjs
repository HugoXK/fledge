#!/usr/bin/env node
// Build provenance for the `dist` tree the CI jobs share.
//
// `restore-drill` reuses the `fledge-dist` artifact instead of running `npm ci`
// and `npm run build` a second time (#643). Reuse is only safe when the consumer
// can prove the tree it is about to run was built from the commit under test: a
// stale artifact, a partial download, an edit after the build or an artifact
// from another run must fail loudly instead of standing in for this commit. The
// build job writes the manifest; every consumer verifies it before running.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MANIFEST_NAME = 'build-manifest.json'
export const MANIFEST_FORMAT = 'fledge-build-manifest'
export const MANIFEST_VERSION = 1

// A refused artifact is a named failure, not a stack trace: the message is what
// the CI log and the test both read.
export class DistManifestError extends Error {}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Every file the build emitted, sorted, with POSIX separators so the manifest is
// the same on every platform and a diff is readable. The manifest itself is not
// an input to its own hash.
export function listDistFiles(distDir) {
  const files = []
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const rel = relative(distDir, full).split(sep).join('/')
      if (rel === MANIFEST_NAME) continue
      files.push(rel)
    }
  }
  walk(distDir)
  return files
}

export function buildManifest(distDir, commit) {
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) throw new DistManifestError(`no dist directory at ${distDir}`)
  const files = {}
  for (const rel of listDistFiles(distDir)) files[rel] = sha256File(join(distDir, rel))
  if (Object.keys(files).length === 0) throw new DistManifestError(`dist directory ${distDir} is empty, so it cannot be an artifact`)
  return { format: MANIFEST_FORMAT, version: MANIFEST_VERSION, commit, files }
}

export function writeManifest(distDir, commit) {
  const manifest = buildManifest(distDir, commit)
  writeFileSync(join(distDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`)
  return Object.keys(manifest.files).length
}

export function verifyManifest(distDir, commit) {
  if (!existsSync(distDir)) throw new DistManifestError(`no dist directory at ${distDir}: the artifact was not downloaded`)
  const manifestPath = join(distDir, MANIFEST_NAME)
  if (!existsSync(manifestPath)) {
    throw new DistManifestError(`missing manifest at ${manifestPath}: this artifact was not produced by the build job`)
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new DistManifestError(`manifest at ${manifestPath} is not JSON`)
  }
  if (manifest === null || typeof manifest !== 'object') throw new DistManifestError(`manifest at ${manifestPath} has an unknown format`)
  if (manifest.format !== MANIFEST_FORMAT || manifest.version !== MANIFEST_VERSION) {
    throw new DistManifestError(`manifest at ${manifestPath} has an unknown format`)
  }
  if (typeof manifest.commit !== 'string' || manifest.commit === '') {
    throw new DistManifestError('manifest does not name the commit it was built from')
  }
  if (manifest.commit !== commit) {
    throw new DistManifestError(`artifact was built from commit ${manifest.commit}, this run is ${commit}`)
  }
  const files = manifest.files
  if (files === null || typeof files !== 'object' || Object.keys(files).length === 0) {
    throw new DistManifestError('manifest lists no files')
  }
  for (const rel of Object.keys(files).sort()) {
    const expected = files[rel]
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new DistManifestError(`manifest entry for ${rel} is not a sha256`)
    }
    const full = join(distDir, rel)
    if (!existsSync(full)) throw new DistManifestError(`missing file ${rel}: the artifact is incomplete`)
    if (sha256File(full) !== expected) {
      throw new DistManifestError(`sha256 mismatch for ${rel}: the artifact changed after it was built`)
    }
  }
  for (const rel of listDistFiles(distDir)) {
    if (!Object.hasOwn(files, rel)) {
      throw new DistManifestError(`${rel} is not in the manifest: the artifact holds a file this build did not emit`)
    }
  }
  return Object.keys(files).length
}

const USAGE = 'usage: node scripts/dist-manifest.mjs <write|verify> [--dir <path>] [--commit <sha>]'
const FATAL = 1
const USAGE_ERROR = 2

function main(argv) {
  const command = argv[0]
  const value = (name) => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? undefined : argv[at + 1]
  }
  if (command !== 'write' && command !== 'verify') {
    console.error(USAGE)
    return USAGE_ERROR
  }
  const dir = value('dir') ?? 'dist'
  const commit = value('commit') ?? process.env.GITHUB_SHA ?? ''
  if (commit === '') {
    console.error(`${USAGE}\ndist-manifest: no commit to bind (--commit or GITHUB_SHA)`)
    return USAGE_ERROR
  }
  try {
    if (command === 'write') {
      const files = writeManifest(dir, commit)
      console.log(`dist-manifest: wrote ${MANIFEST_NAME} for commit ${commit} (${files} file(s))`)
    } else {
      const files = verifyManifest(dir, commit)
      console.log(`dist-manifest: OK (${files} file(s) from commit ${commit})`)
    }
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`dist-manifest: ${command} refused: ${message}`)
    return FATAL
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main(process.argv.slice(2))
}
