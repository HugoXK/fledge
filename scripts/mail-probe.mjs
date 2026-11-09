#!/usr/bin/env node
// Send one probe mail over the configured transport and report transport, host
// and elapsed time. Never prints the recipient address or a credential.
import { loadConfig } from '../dist/config.js'
import { probeMail } from '../dist/lib/mailProbe.js'

const args = process.argv.slice(2)
const toIndex = args.indexOf('--to')
const to = toIndex === -1 ? '' : String(args[toIndex + 1] ?? '')
if (to === '') {
  console.error('usage: npm run mail:probe -- --to <address>')
  process.exit(1)
}

let config
try {
  config = loadConfig()
} catch (error) {
  console.error(`mail:probe: configuration is invalid: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const result = await probeMail(config, to)
console.log(result.summary)
process.exit(result.ok ? 0 : 1)
