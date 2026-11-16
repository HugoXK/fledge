import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DESTRUCTIVE_ROUTES,
  EXPENSIVE_ROUTES,
  ORDINARY_ROUTES,
  classifiedRoutes,
  routeClassOf,
  routeKey,
} from '../src/lib/routeClasses.js'

// #708: this file is the enforcement the card asks for. It reads the route
// registrations out of `src/app.ts` — not a list, not a count, not a number
// anyone wrote down — and compares them with the class table. A route whose
// class nobody declared fails here and is named, so "somebody will notice" is
// replaced by a red test on the day the route is added.
//
// Two directions, because a table can rot either way: a route registered and
// left unclassified is the defect the card describes, and a class left behind
// for a route that no longer exists would keep the sweep looking complete.
//
// The reader understands every registration form the file uses: `app.all` is one
// registration but four mutating routes, so it is expanded, and a form the reader
// does not know is refused loudly instead of being skipped.

const APP_SOURCE = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')

// Comments are removed before the scan: a commented-out registration is not a
// route, and this file's own explanations quote route shapes.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// The registration forms this reader understands. `all` is the one that carries
// more than a single method, and a form outside this set is refused rather than
// skipped: an unread form is an unclassified route, which is the defect the sweep
// exists to catch.
const ROUTE_FORMS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all'])
// `app.all` answers every method. Only the methods that can change state are
// swept; a GET through the same registration is a read and stays out.
const ALL_MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const

/** Every mutating route `src/app.ts` registers, as `METHOD /path`. */
export function registeredMutations(source = APP_SOURCE): string[] {
  const text = withoutComments(source)
  // `app.route({ method, url })` keeps the method in an object, which this
  // reader cannot read. Refuse it: a skipped registration is an unclassified
  // mutating route passing a green sweep.
  if (/app\.route\s*\(/.test(text)) throw new Error('the sweep cannot read app.route(...); teach registeredMutations or register with a verb')
  // A registration quoted with double quotes is a route too. The pattern below
  // reads single quotes because that is the file's style, so a double-quoted one
  // would be skipped as "not a route" — the same silent hole `app.route` had.
  const doubleQuoted = /app\.([A-Za-z]+)\(\s*"([^"]*)"/.exec(text)
  if (doubleQuoted !== null) throw new Error(`the sweep cannot read app.${doubleQuoted[1]}("${doubleQuoted[2]}"); register with single quotes or teach registeredMutations`)
  const found: string[] = []
  for (const match of text.matchAll(/app\.([A-Za-z]+)\(\s*'([^']*)'/g)) {
    const form = (match[1] ?? '').toLowerCase()
    const path = match[2] ?? ''
    if (!ROUTE_FORMS.has(form)) {
      // `app.addHook('onResponse', …)` is not a route; `app.options('/x', …)` is.
      // Refuse the second kind instead of letting it past unread.
      if (path.startsWith('/')) throw new Error(`the sweep cannot read app.${form}('${path}'); teach registeredMutations or drop the form`)
      continue
    }
    if (form === 'all') {
      for (const method of ALL_MUTATING_METHODS) found.push(routeKey(method, path))
      continue
    }
    if (form === 'get') continue
    found.push(routeKey(form.toUpperCase(), path))
  }
  return found
}

test('#708 the sweep reads the route table, not a number written down', () => {
  const routes = registeredMutations()
  // Not a pinned count: this only refuses a sweep that found nothing, which is
  // what a broken pattern or a moved file would look like.
  assert.ok(routes.length > 0, 'the sweep found no mutating route in src/app.ts; the pattern is wrong, not the code')
  assert.equal(new Set(routes).size, routes.length, 'the same mutating route is registered twice, so the sweep is ambiguous')
})

// `app.all` answers every method, so one registration can carry more than one
// mutating route. The reader has to see that form or the sweep misses them
// silently — the workspace proxy is registered that way and forwards a body.
test('#708 an app.all registration is read as every mutating method', () => {
  const read = registeredMutations("app.all('/repos/:id/workspace/app/*', async () => {})")
  assert.deepEqual(read, [
    'POST /repos/:id/workspace/app/*',
    'PUT /repos/:id/workspace/app/*',
    'PATCH /repos/:id/workspace/app/*',
    'DELETE /repos/:id/workspace/app/*',
  ])
})

// The other half of the same defect: a registration form the reader does not
// know is not "not a route" — it is a route nobody classified. Refusing it keeps
// the next `app.all` or `app.options` from passing a green sweep.
test('#708 the sweep refuses a registration form it cannot read', () => {
  assert.throws(
    () => registeredMutations("app.options('/repos/:id/settings', async () => {})"),
    /cannot read app\.options/,
  )
})

// The table is policy and the handler is what happens today. Where the two
// disagree the table must not be the lighter one: a route that takes the
// destructive window handles something irreversible, and a route that takes the
// expensive window starts work — neither can be filed under `ordinary`, which
// ADR 0022 defines as unlimited by decision.
test('#708 a route that takes a class window is not filed under a lighter class', () => {
  const text = withoutComments(APP_SOURCE)
  const matches = [...text.matchAll(/app\.([A-Za-z]+)\(\s*'([^']*)'/g)]
  const wrong: string[] = []
  matches.forEach((match, index) => {
    const form = (match[1] ?? '').toLowerCase()
    if (!ROUTE_FORMS.has(form)) return
    const path = match[2] ?? ''
    const end = index + 1 < matches.length ? (matches[index + 1]?.index ?? text.length) : text.length
    const handler = text.slice(match.index ?? 0, end)
    const methods = form === 'all' ? [...ALL_MUTATING_METHODS] : form === 'get' ? [] : [form.toUpperCase()]
    const takesDestructive = /rateLimit:\s*\w*destructive/i.test(handler) || /limits\.take\('destructive'/.test(handler)
    const takesExpensive = /rateLimit:\s*\w*expensive/i.test(handler) || /limits\.take\('expensive'/.test(handler)
    for (const method of methods) {
      const key = routeKey(method, path)
      const says = routeClassOf(method, path)
      if (takesDestructive && says !== 'destructive') wrong.push(`${key}: takes the destructive window but is ${says ?? 'unclassified'}`)
      else if (takesExpensive && says === 'ordinary') wrong.push(`${key}: takes the expensive window but is ordinary`)
    }
  })
  assert.deepEqual(wrong, [], `class lighter than the window: ${wrong.join('; ')}`)
})

// `app.route({ method, url })` carries the method in an object, so the sweep's
// shape cannot read it. Refusing it keeps the next one from being skipped.
// A double-quoted registration would never match the reader's single-quote
// pattern, so it would be skipped as if it were not a route at all. Refusing it
// is what makes the sweep complete rather than mostly complete.
test('#708 the sweep refuses a registration quoted with double quotes', () => {
  assert.throws(
    () => registeredMutations('app.post("/repos/:id/run", async () => {})'),
    /cannot read app\.post\("/,
  )
})

test('#708 the sweep refuses app.route, whose method is in an object', () => {
  assert.throws(
    () => registeredMutations("app.route({ method: 'POST', url: '/repos/:id/settings' }, async () => {})"),
    /cannot read app\.route/,
  )
  assert.equal(/app\.route\s*\(/.test(withoutComments(APP_SOURCE)), false, 'src/app.ts must register with a verb, not app.route: the sweep reads verb registrations')
})

test('#708 every mutating route in src/app.ts names a class', () => {
  const unclassified = registeredMutations().filter((key) => routeClassOf(...(key.split(' ') as [string, string])) === undefined)
  assert.deepEqual(unclassified, [], `unclassified: ${unclassified.join(', ')}`)
})

test('#708 the class table names no route that src/app.ts does not register', () => {
  const registered = new Set(registeredMutations())
  const stale = classifiedRoutes().filter((key) => !registered.has(key))
  assert.deepEqual(stale, [], `stale classification: ${stale.join(', ')}`)
})

test('#708 a route belongs to exactly one class', () => {
  const overlap = [
    ...[...DESTRUCTIVE_ROUTES].filter((key) => EXPENSIVE_ROUTES.has(key) || ORDINARY_ROUTES.has(key)),
    ...[...EXPENSIVE_ROUTES].filter((key) => ORDINARY_ROUTES.has(key)),
  ]
  assert.deepEqual(overlap, [], `a route is in two classes: ${overlap.join(', ')}`)
})
