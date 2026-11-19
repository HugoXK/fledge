import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #966 visual matrix: the DeepWiki launcher measured 36x44 at width=360 on six
// pages. `min-height: var(--touch)` was there, but at that width the media query
// hides the label and drops the padding to `var(--space-2)`, so the width came
// from an 18px glyph plus 16px of padding and 2px of border — 36px, under the
// 44px floor #132 set. This file pins the box floor the stylesheet has to
// declare, the way test/touchFloor.test.ts pins the rules in public/app.css; the
// visual matrix is what proves the pixels.

const sheet = readFileSync(new URL('../public/fledge-deepwiki.css', import.meta.url), 'utf8')
const appSheet = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')

type Declaration = { property: string; value: string }
type StyleRule = { selectors: string[]; declarations: Declaration[]; media: string | null }

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function parseRules(source: string, media: string | null = null): StyleRule[] {
  const css = stripComments(source)
  const rules: StyleRule[] = []
  let index = 0
  let prelude = ''
  while (index < css.length) {
    const character = css[index] ?? ''
    if (character === '{') {
      let depth = 1
      let end = index + 1
      while (end < css.length && depth > 0) {
        if (css[end] === '{') depth += 1
        else if (css[end] === '}') depth -= 1
        end += 1
      }
      const head = prelude.trim()
      const body = css.slice(index + 1, end - 1)
      if (head.startsWith('@media')) rules.push(...parseRules(body, head.slice('@media'.length).trim()))
      else if (!head.startsWith('@')) rules.push({ selectors: head.split(',').map((s) => s.trim()).filter(Boolean), declarations: declarationsOf(body), media })
      prelude = ''
      index = end
      continue
    }
    prelude += character
    index += 1
  }
  return rules
}

function declarationsOf(body: string): Declaration[] {
  const declarations: Declaration[] = []
  for (const part of body.split(';')) {
    const separator = part.indexOf(':')
    if (separator === -1) continue
    const property = part.slice(0, separator).trim().toLowerCase()
    const value = part.slice(separator + 1).trim()
    if (property !== '' && value !== '') declarations.push({ property, value })
  }
  return declarations
}

// The cascade at width 360: every rule whose media query matches 360, in source
// order, so a later override wins exactly like it would in the browser.
function declaredAt360(selector: string, property: string): string | undefined {
  let value: string | undefined
  for (const rule of parseRules(sheet)) {
    if (rule.selectors.includes(selector) === false) continue
    if (rule.media !== null) {
      const max = /max-width:\s*(\d+)px/.exec(rule.media)
      if (max !== null && 360 > Number(max[1])) continue
    }
    for (const declaration of rule.declarations) if (declaration.property === property) value = declaration.value
  }
  return value
}

function pixels(value: string): number {
  const resolved = value.trim().replace(/var\(--touch\)/g, (() => {
    const token = /--touch:\s*([^;]+);/.exec(appSheet)
    return token?.[1]?.trim() ?? '0px'
  })())
  const match = /^(\d+(?:\.\d+)?)px$/.exec(resolved)
  assert.ok(match, `the floor has to resolve to pixels, not ${value}`)
  return Number(match?.[1] ?? '0')
}

test('the DeepWiki launcher clears the 44px touch floor at the phone width', () => {
  const token = /--touch:\s*([^;]+);/.exec(stripComments(appSheet))?.[1]?.trim()
  assert.ok(token !== undefined, 'public/app.css has to keep the --touch token')
  assert.equal(token, '44px', 'the touch floor token is 44px')

  for (const pair of [['min-width', '.fdw-launcher'], ['min-height', '.fdw-launcher']] as const) {
    const [property, selector] = pair
    const declared = declaredAt360(selector, property)
    assert.ok(declared !== undefined, `${selector} has to declare ${property} for the phone width`)
    assert.ok(pixels(declared!) >= 44, `${selector} ${property} is ${declared} at width 360, under the 44px floor`)
  }
})
