#!/usr/bin/env node
// Check that the release version is consistent across the repository.
//
//   node scripts/version.mjs check
//   RELEASE_TAG=v0.2.3 node scripts/version.mjs check
//
// The package version is the source of truth. The changelog's newest released
// section, the lockfile root, the Docker Compose image and an optional release
// tag must all agree with it.

import { readFileSync } from 'node:fs'

function fail(message) {
  console.error(`version: ${message}`)
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function newestReleased(changelog) {
  const sections = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((match) => match[1])
  return sections.find((value) => value !== 'Unreleased') ?? ''
}

function main() {
  if (process.argv[2] !== 'check') {
    console.error('usage: node scripts/version.mjs check')
    process.exit(1)
  }

  const version = String(readJson('package.json').version ?? '')
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json has an invalid version "${version}"`)

  const lockVersion = String(readJson('package-lock.json').version ?? '')
  if (lockVersion !== version) fail(`package-lock.json is ${lockVersion}, package.json is ${version}`)

  const changelogVersion = newestReleased(readFileSync('CHANGELOG.md', 'utf8'))
  if (changelogVersion !== version) fail(`CHANGELOG.md newest section is ${changelogVersion || 'missing'}, package.json is ${version}`)

  const compose = readFileSync('docker-compose.yml', 'utf8')
  const composeVersion = /image:\s*fledge:([^\s]+)/.exec(compose)?.[1] ?? ''
  if (composeVersion !== version) fail(`docker-compose.yml image is ${composeVersion || 'missing'}, package.json is ${version}`)

  const tag = process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME ?? ''
  if (tag.startsWith('v') && tag.slice(1) !== version) fail(`release tag ${tag} does not match package.json ${version}`)

  console.log(`version: ${version} ok${tag === '' ? '' : ` (tag ${tag})`}`)
}

main()
