import test from 'node:test'
import assert from 'node:assert/strict'
import { documentedRoutes, registeredRoutes, undocumentedRoutes } from './apiDocReader.js'

// #1289: `docs/api.md` is the reference an integrator follows, so a row for a
// route the app does not serve is worse than a missing row — the reader posts
// there and gets a 404. The document was carrying
// `| POST | /settings/model | ... |`, which no `app.post(...)` registration in
// `src/app.ts` answers.
//
// This checker reads the two things that can disagree — the `| METHOD | path |`
// rows of the document and the `app.<verb>(...)` registrations of the app — and
// names every row that has no registration. It reads the registrations out of
// the source on purpose: importing a route list would let the document agree
// with itself instead of with the server. The reader itself lives in
// `test/apiDocReader.ts` so the contract check (#1243, #1293) uses the same one.
//
// The second half is the part that keeps a fix honest: the same checker, run on
// a fixture table, still reports a fake route and still resolves a known-good
// one. A "fix" that empties the table or deletes the checker passes the first
// half and fails here.

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

// #1293: a reader that understands one quote style reads the other as "not a
// route", so a double-quoted registration would make the checker green on a
// document that omits it. The reader sees the route whichever quote was used.
test('#1289 the reader sees a registration in either quote style', () => {
  const routes = registeredRoutes(['app.get("/api/v1/quoted", async () => {})', "app.post('/api/v1/single', async () => {})"].join('\n'))
  assert.deepEqual([...routes].sort(), ['GET /api/v1/quoted', 'POST /api/v1/single'])
})
