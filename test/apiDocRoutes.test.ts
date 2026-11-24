import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #1289: `docs/api.md` is the reference an integrator follows, so a row for a
// route the app does not serve is worse than a missing row — the reader posts
// there and gets a 404. The document was carrying
// `| POST | /settings/model | ... |`, which no `app.post(...)` registration in
// `src/app.ts` answers.
//
// This checker reads the two things that can disagree — the `| METHOD | path |`
// rows of the document and the `app.<verb>('...')` registrations of the app —
// and names every row that has no registration. It reads the registrations out
// of the source on purpose: importing a route list would let the document agree
// with itself instead of with the server.
//
// The second half is the part that keeps a fix honest: the same checker, run on
// a fixture table, still reports a fake route and still resolves a known-good
// one. A "fix" that empties the table or deletes the checker passes the first
// half and fails here.

const API_DOC = readFileSync(new URL('../docs/api.md', import.meta.url), 'utf8')
const APP_SOURCE = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const VERB_FORMS = new Set(METHODS.map((method) => method.toLowerCase()))

// Comments are removed before the scan: this file's own explanations quote route
// shapes, and a commented-out registration is not a route.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// `/repos/:id/instance` and `/repos/:repo/instance` are the same route: the
// parameter name is documentation, not contract. A trailing slash is not a
// different route either.
function normalisePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '')
  const segments = trimmed
    .split('/')
    .map((segment) => (segment.startsWith(':') ? ':' : segment))
  return segments.join('/') || '/'
}

/** Every route `src/app.ts` registers, as `METHOD /normalised/path`. */
export function registeredRoutes(source = APP_SOURCE): Set<string> {
  const text = withoutComments(source)
  // `app.route({ method, url })` keeps the method in an object, which this
  // reader cannot read; refuse it instead of skipping a route silently.
  if (/app\.route\s*\(/.test(text)) throw new Error('the checker cannot read app.route(...); teach registeredRoutes or register with a verb')
  // The reader below reads single quotes because that is the file's style, so a
  // double-quoted registration would look like "not a route".
  const doubleQuoted = /app\.([A-Za-z]+)\(\s*"/.exec(text)
  if (doubleQuoted !== null) throw new Error(`the checker cannot read app.${doubleQuoted[1]}("..."); register with single quotes or teach registeredRoutes`)

  const routes = new Set<string>()
  for (const match of text.matchAll(/app\.([A-Za-z]+)\(\s*'([^']*)'/g)) {
    const form = (match[1] ?? '').toLowerCase()
    const path = match[2] ?? ''
    if (form === 'all') {
      // `app.all` answers every method, so a document row for any of them is served.
      for (const method of METHODS) routes.add(`${method} ${normalisePath(path)}`)
      continue
    }
    if (!VERB_FORMS.has(form)) {
      // `app.addHook('onResponse', …)` is not a route; a route-shaped form this
      // reader does not know is refused rather than skipped.
      if (path.startsWith('/')) throw new Error(`the checker cannot read app.${form}('${path}'); teach registeredRoutes or drop the form`)
      continue
    }
    routes.add(`${form.toUpperCase()} ${normalisePath(path)}`)
  }
  return routes
}

/** The `| METHOD | \`path\` |` rows of the endpoint table. */
export function documentedRoutes(markdown = API_DOC): Array<{ method: string; path: string }> {
  const rows: Array<{ method: string; path: string }> = []
  for (const line of markdown.split('\n')) {
    const match = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`\s*\|/.exec(line)
    if (match === null) continue
    rows.push({ method: match[1] as string, path: (match[2] as string).trim() })
  }
  return rows
}

/** One line per row the app does not serve: `undocumented-route: METHOD path`. */
export function undocumentedRoutes(markdown = API_DOC, source = APP_SOURCE): string[] {
  const registered = registeredRoutes(source)
  return documentedRoutes(markdown)
    .filter((row) => !registered.has(`${row.method} ${normalisePath(row.path)}`))
    .map((row) => `undocumented-route: ${row.method} ${row.path}`)
}

test('#1289 every route in the API table is declared by the app', () => {
  const undocumented = undocumentedRoutes()
  assert.deepEqual(undocumented, [], `${undocumented.length} table row(s) name a route src/app.ts does not register: ${undocumented.join(', ')}`)
})

// The table can rot the other way too: a checker that reads an empty document
// finds no bad row and looks green. The floor is not a pinned count — it is the
// order of magnitude of the current table, so truncating it to nothing fails.
test('#1289 the table the checker reads is the real endpoint table', () => {
  const rows = documentedRoutes()
  assert.ok(rows.length >= 60, `the endpoint table has ${rows.length} method row(s); the checker is reading the wrong document or the table was emptied`)
})

test('#1289 the checker reports an unmatched row and still resolves a served one', () => {
  const fixtureTable = [
    '| Method | Path | Auth | Description |',
    '| --- | --- | --- | --- |',
    '| POST | `/repos/:id/instance` | owner + CSRF | Start the instance |',
    '| POST | `/fixture/nowhere` | approved | No handler serves this |',
  ].join('\n')
  const fixtureSource = "app.post('/repos/:id/instance', async () => {})"
  assert.deepEqual(undocumentedRoutes(fixtureTable, fixtureSource), ['undocumented-route: POST /fixture/nowhere'])
})
