import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ci = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8')

// #574: a squash merge to main landed inside the same concurrency window as the
// merge before it, GitHub replaced the pending `main` run with the newer one and
// marked the replaced run `cancelled` before any job existed, so that commit
// carried no `ci-ok` at all. The workflow-level block is read as text, because
// this is the file a maintainer edits; a block moved into a job would not key
// the workflow's runs and must fail here instead of passing quietly.
function workflowConcurrency(text: string): { group: string; cancel: string } {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line === 'concurrency:')
  assert.notEqual(start, -1, 'ci.yml must carry a workflow-level concurrency: block')
  const block: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break
    block.push(line)
  }
  const body = block.join('\n')
  const group = /^\s+group:\s*(.+?)\s*$/m.exec(body)
  const cancel = /^\s+cancel-in-progress:\s*(.+?)\s*$/m.exec(body)
  assert.ok(group !== null, 'the concurrency block names group:')
  assert.ok(cancel !== null, 'the concurrency block names cancel-in-progress:')
  return { group: group[1]!, cancel: cancel[1]! }
}

type Value = string | boolean
type Context = Record<string, Value>

// A deliberately small GitHub-expression evaluator: string literals,
// `github.<field>` lookups, `==` / `!=`, `&&`, `||`, parentheses and
// `format('<template>', ...)`. It covers what ci.yml's concurrency expression
// uses; anything else throws, so an expression this test cannot read fails
// instead of silently interpolating to a constant and passing for the wrong
// reason.
function evaluate(source: string, context: Context): Value {
  let at = 0
  const skip = (): void => {
    while (at < source.length && /\s/.test(source[at]!)) at += 1
  }
  const peek = (text: string): boolean => {
    skip()
    return source.startsWith(text, at)
  }
  const take = (text: string): void => {
    if (!peek(text)) throw new Error(`unexpected ${JSON.stringify(source.slice(at))}`)
    at += text.length
  }
  const string = (): string => {
    skip()
    assert.equal(source[at], "'", `unexpected ${JSON.stringify(source.slice(at))}`)
    at += 1
    let out = ''
    while (at < source.length && source[at] !== "'") out += source[at++]
    assert.equal(source[at], "'", 'unterminated string literal')
    at += 1
    return out
  }
  const named = (): Value => {
    const identifier = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(at))
    if (identifier === null) throw new Error(`unexpected ${JSON.stringify(source.slice(at))}`)
    at += identifier[0].length
    if (identifier[0] === 'true') return true
    if (identifier[0] === 'false') return false
    if (identifier[0] in context) return context[identifier[0]]!
    throw new Error(`unknown expression name ${identifier[0]}`)
  }
  const primary = (): Value => {
    skip()
    if (peek('(')) {
      take('(')
      const value = orLevel()
      take(')')
      return value
    }
    if (peek("'")) return string()
    if (peek('format(')) {
      take('format(')
      const template = string()
      const args: Value[] = []
      while (peek(',')) {
        take(',')
        args.push(orLevel())
      }
      take(')')
      return template.replace(/\{(\d+)\}/g, (whole, index) => {
        const value = args[Number(index)]
        return value === undefined ? whole : String(value)
      })
    }
    return named()
  }
  // `==` binds tighter than `&&`, which binds tighter than `||`.
  const equality = (): Value => {
    const left = primary()
    skip()
    const operator = source.startsWith('==', at) ? '==' : source.startsWith('!=', at) ? '!=' : null
    if (operator === null) return left
    at += 2
    const right = primary()
    const same = String(left) === String(right)
    return operator === '==' ? same : !same
  }
  const andLevel = (): Value => {
    const left = equality()
    if (!peek('&&')) return left
    take('&&')
    const right = andLevel()
    return truthy(left) ? right : left
  }
  const orLevel = (): Value => {
    const left = andLevel()
    if (!peek('||')) return left
    take('||')
    const right = orLevel()
    return truthy(left) ? left : right
  }
  const value = orLevel()
  skip()
  assert.equal(at, source.length, `trailing input in ${JSON.stringify(source)}`)
  return value
}

function truthy(value: Value): boolean {
  return value !== false && value !== ''
}

function render(expression: string, context: Context): string {
  return expression.replace(/\$\{\{([\s\S]+?)\}\}/g, (_whole, inner: string) => String(evaluate(inner, context)))
}

const SHA_A = 'c20113dd32370993c32a034ffa78faf26e9286af'
const SHA_B = 'e7912f791241509e9165211d1963590e5f000e20'

function contextFor(event: string, ref: string, sha: string): Context {
  return {
    'github.event_name': event,
    'github.ref': ref,
    'github.sha': sha,
    'github.repository': 'HugoXK/fledge',
  }
}

test('#574: two main pushes seconds apart do not share one concurrency group', () => {
  const { group } = workflowConcurrency(ci)
  const first = render(group, contextFor('push', 'refs/heads/main', SHA_A))
  const second = render(group, contextFor('push', 'refs/heads/main', SHA_B))
  assert.notEqual(first, second, 'two commits on main must not replace each other’s pending run')
  assert.match(first, new RegExp(SHA_A), 'the push group names the commit it records')
  assert.match(second, new RegExp(SHA_B), 'the push group names the commit it records')
})

test('#574: a pull request keeps the ref-only group, so a new push still supersedes the old run', () => {
  const { group } = workflowConcurrency(ci)
  const first = render(group, contextFor('pull_request', 'refs/pull/12/merge', SHA_A))
  const second = render(group, contextFor('pull_request', 'refs/pull/12/merge', SHA_B))
  assert.equal(first, 'ci-refs/pull/12/merge')
  assert.equal(second, 'ci-refs/pull/12/merge')
})

test('#574: a merge queue entry keeps the ref-only group', () => {
  const { group } = workflowConcurrency(ci)
  const ref = 'refs/heads/gh-readonly-queue/main/pr-7-abc123'
  const first = render(group, contextFor('merge_group', ref, SHA_A))
  const second = render(group, contextFor('merge_group', ref, SHA_B))
  assert.equal(first, `ci-${ref}`)
  assert.equal(second, `ci-${ref}`)
})

test('#574: only a pull request cancels its own earlier run', () => {
  const { cancel } = workflowConcurrency(ci)
  assert.equal(render(cancel, contextFor('push', 'refs/heads/main', SHA_A)), 'false')
  assert.equal(render(cancel, contextFor('pull_request', 'refs/pull/12/merge', SHA_A)), 'true')
  assert.equal(render(cancel, contextFor('merge_group', 'refs/heads/gh-readonly-queue/main/pr-7-abc123', SHA_A)), 'false')
})
