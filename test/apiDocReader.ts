import { readFileSync } from 'node:fs'

// The route reader both checks share: `test/apiDocRoutes.test.ts` (#1289) checks
// that `docs/api.md` carries no row the app does not serve, and
// `test/openapi.test.ts` (#1243, #1293) checks that the OpenAPI contract
// describes every route the app registers. One definition of "a route the app
// registers" keeps the two checks from disagreeing about what a route is — and
// keeps a second, weaker scanner out of the tree.

const API_DOC = readFileSync(new URL('../docs/api.md', import.meta.url), 'utf8')
const APP_SOURCE = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const VERB_FORMS = new Set(METHODS.map((method) => method.toLowerCase()))

// Comments are removed before the scan: the app's own explanations quote route
// shapes, and a commented-out registration is not a route.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

// `/repos/:id/instance` and `/repos/:repo/instance` are the same route: the
// parameter name is documentation, not contract. A trailing slash is not a
// different route either.
export function normalisePath(path: string): string {
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

  const routes = new Set<string>()
  // Both quote styles are read: a route is a route whichever quote the author
  // used, and a reader that only understands one style reports the other as
  // "not a route" (#1293).
  for (const match of text.matchAll(/app\.([A-Za-z]+)\(\s*['"]([^'"]*)['"]/g)) {
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
