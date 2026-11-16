#!/usr/bin/env node
// Print the newest development email and any approval links it contains, and
// expire the ones past the retention window.
//
// #694: the file name carries a stamp and an opaque id, never the recipient, so
// the window below can delete every `.eml` in the directory without keeping one
// account identifier alive forever. Deletion is by mtime, takes no exception,
// and happens before the newest file is read.
//
//   DATA_DIR=./data npm run mail:outbox
//   MAIL_OUTBOX_RETENTION_DAYS=14 npm run mail:outbox     # 7 by default
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 86_400_000

function retentionDays() {
  const raw = String(process.env.MAIL_OUTBOX_RETENTION_DAYS ?? '7').trim()
  const days = Number(raw)
  if (raw === '' || !Number.isFinite(days) || days < 0) {
    console.error(`MAIL_OUTBOX_RETENTION_DAYS must be a non-negative number of days, got "${raw}".`)
    process.exit(1)
  }
  return days
}

const dir = join(process.env.DATA_DIR ?? './data', 'mail-outbox')
const cutoff = Date.now() - retentionDays() * DAY_MS
let files = []
try {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.eml')) continue
    const path = join(dir, name)
    if (statSync(path).mtimeMs < cutoff) {
      unlinkSync(path)
      console.log(`expired ${name}`)
      continue
    }
    files.push(name)
  }
  files.sort()
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
