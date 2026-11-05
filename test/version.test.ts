import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { VERSION } from '../src/version.js'

test('the runtime version matches package.json and the newest changelog section', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  assert.equal(VERSION, pkg.version)
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const newest = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((match) => match[1]).find((value) => value !== 'Unreleased')
  assert.equal(newest, VERSION)
})
