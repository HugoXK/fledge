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

const APP_SOURCE = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')

// Comments are removed before the scan: a commented-out registration is not a
// route, and this file's own explanations quote route shapes.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** Every mutating route `src/app.ts` registers, as `METHOD /path`. */
export function registeredMutations(source = APP_SOURCE): string[] {
  const text = withoutComments(source)
  const pattern = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g
  const found: string[] = []
  for (const match of text.matchAll(pattern)) {
    const method = (match[1] ?? '').toUpperCase()
    if (method === 'GET') continue
    found.push(routeKey(method, match[2] ?? ''))
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
