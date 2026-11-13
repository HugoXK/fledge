#!/usr/bin/env node
// The manifest next to a backup copy records what that file was when the backup
// finished: byte size, sha256, schema version and per-table row counts. The
// restore drill uses it to separate "this file is not the database it claims to
// be" (an interrupted or truncated backup) from "the live instance has written
// since" (normal drift). It describes bytes and counts, never row data.
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename } from 'node:path'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite')

export function manifestPath(copyPath) {
  return `${copyPath}.json`
}

// Streamed, so the hash costs the same memory whatever the file's size:
// readFileSync refused anything above 2 GiB and buffered the whole file below it.
export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

// The same facts the drill reads back from a restored copy: schema version and
// one row count per user table, so a count difference can name the table.
export function databaseFacts(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = {}
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    for (const row of names) {
      const table = String(row.name)
      const quoted = table.replaceAll('"', '""')
      tables[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${quoted}"`).all()[0]?.n ?? 0)
    }
    const schemaVersion = Number(db.prepare('PRAGMA user_version').all()[0]?.user_version ?? 0)
    return { tables, schemaVersion }
  } finally {
    db.close()
  }
}

export async function writeManifest(copyPath, options = {}) {
  // An encrypted copy cannot be opened as SQLite, so the caller passes the facts
  // it collected from the verified plaintext before encrypting it.
  const facts = options.facts ?? databaseFacts(copyPath)
  const manifest = {
    copy: basename(copyPath),
    createdAt: new Date().toISOString(),
    size: statSync(copyPath).size,
    sha256: await sha256File(copyPath),
    schemaVersion: facts.schemaVersion,
    tables: facts.tables,
    ...(options.encryption === undefined ? {} : { encryption: options.encryption }),
  }
  const target = manifestPath(copyPath)
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  // writeFileSync only applies the mode when it creates the file.
  chmodSync(target, 0o600)
  return target
}

// null for a copy written before manifests existed (or by an older tool): the
// drill reports that as a warning and never fails on it.
export function readManifest(copyPath) {
  const path = manifestPath(copyPath)
  if (!existsSync(path)) return null
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const usable = typeof manifest === 'object' && manifest !== null
    && typeof manifest.size === 'number'
    && typeof manifest.sha256 === 'string'
    && typeof manifest.schemaVersion === 'number'
    && typeof manifest.tables === 'object' && manifest.tables !== null
    && (manifest.encryption === undefined || (
      typeof manifest.encryption === 'object' && manifest.encryption !== null
      && typeof manifest.encryption.format === 'string'
      && typeof manifest.encryption.keyId === 'string'
      && typeof manifest.encryption.keyVersion === 'number'
      // Optional: copies written before the derivation was recorded have no `kdf`,
      // and the field is new information, never a requirement to read the copy.
      // When present it must be one of the two derivations the code implements, so
      // a manifest cannot vouch for a `kdf` its own type never allows.
      && (manifest.encryption.kdf === undefined || manifest.encryption.kdf === 'raw' || manifest.encryption.kdf === 'scrypt')
    ))
  if (!usable) throw new Error(`not a backup manifest: ${path}`)
  // A manifest describes exactly one file: a copy renamed away from its manifest
  // is not the copy that manifest vouches for.
  if (manifest.copy !== basename(copyPath)) throw new Error(`the manifest describes ${String(manifest.copy)}, not ${basename(copyPath)}`)
  return manifest
}
