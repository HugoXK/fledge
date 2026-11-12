#!/usr/bin/env node
// Print the newest development email and any approval links it contains.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.env.DATA_DIR ?? './data', 'mail-outbox')
let files = []
try {
  files = readdirSync(dir).filter((name) => name.endsWith('.eml')).sort()
} catch {
  console.error(`No outbox at ${dir}. Start with MAIL_TRANSPORT=console and log in once.`)
  process.exit(1)
}
if (files.length === 0) {
  console.error(`Outbox ${dir} is empty.`)
  process.exit(1)
}
const latest = join(dir, files.at(-1))
const text = readFileSync(latest, 'utf8')
console.log(`# ${latest}\n`)
console.log(text)
const links = [...text.matchAll(/https?:\/\/[^\s]+\/approve\/[A-Za-z0-9_-]+/g)].map((match) => match[0])
if (links.length > 0) {
  console.log('\nApproval links:')
  for (const link of links) console.log(`- ${link}`)
}
