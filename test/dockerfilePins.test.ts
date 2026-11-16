import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// A base image may only enter this image by digest. `node:22-alpine` moves under
// the tag, so a build that resolved a different toolchain than the reviewed one
// produces an image with no diff to explain it. The pin is asserted here rather
// than trusted, because a later edit that drops `@sha256:` would still build.

const DIGEST = /@sha256:[0-9a-f]{64}$/

interface FromLine {
  line: number
  image: string
  stage: string | null
}

function fromLines(dockerfile: string): FromLine[] {
  return dockerfile.split('\n').flatMap((text, index) => {
    const match = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(text.trim())
    if (match?.[1] === undefined) return []
    return [{ line: index + 1, image: match[1], stage: match[2] ?? null }]
  })
}

function assertPinned(dockerfile: string): FromLine[] {
  const lines = fromLines(dockerfile)
  assert.ok(lines.length > 0, 'the Dockerfile must declare at least one FROM line')
  for (const item of lines) {
    if (!DIGEST.test(item.image)) {
      throw new Error(
        `Dockerfile:${item.line}: ${item.image} is not pinned by digest; every FROM needs @sha256:<64 lowercase hex>`,
      )
    }
  }
  return lines
}

test('a FROM that names only a tag is rejected', () => {
  assert.throws(
    () => assertPinned('FROM node:22-alpine AS build\nWORKDIR /app\n'),
    /Dockerfile:1: node:22-alpine is not pinned by digest/,
  )
})

test('a truncated or upper-case digest is rejected', () => {
  assert.throws(() => assertPinned(`FROM node:22-alpine@sha256:abc AS build\n`), /not pinned by digest/)
  assert.throws(
    () => assertPinned(`FROM node:22-alpine@sha256:${'A'.repeat(64)} AS build\n`),
    /not pinned by digest/,
  )
  assert.throws(
    () => assertPinned(`FROM node:22-alpine@sha256:${'a'.repeat(63)} AS build\n`),
    /not pinned by digest/,
  )
})

test('one unpinned stage is enough to fail, and the message names its line', () => {
  const dockerfile = [
    'FROM node:22-alpine@sha256:' + 'a'.repeat(64) + ' AS build',
    'WORKDIR /app',
    'FROM node:22-alpine AS runtime',
    'WORKDIR /app',
  ].join('\n')

  assert.throws(() => assertPinned(dockerfile), /Dockerfile:3: node:22-alpine is not pinned by digest/)
})

test('both stages in the repository Dockerfile are pinned to the same digest', () => {
  const dockerfile = readFileSync(fileURLToPath(new URL('../Dockerfile', import.meta.url)), 'utf8')
  const lines = assertPinned(dockerfile)

  assert.deepEqual(
    lines.map((item) => item.stage),
    ['build', 'runtime'],
    'the Dockerfile is the build and runtime stage, and both are checked',
  )

  const digests = lines.map((item) => DIGEST.exec(item.image)?.[0])
  assert.equal(digests[0], digests[1], 'build and runtime must run the same base image, not two pins that can drift')
  assert.ok(lines.every((item) => item.image.startsWith('node:22-alpine@')), 'the readable tag stays in the reference')
})
