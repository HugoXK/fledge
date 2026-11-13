import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseRules, type StyleRule } from './cssRules.js'

// #486: `input:focus, textarea:focus, select:focus` replaces the focus outline
// with a box-shadow ring. A forced-colours theme paints no shadow and forces
// border-color to a system colour, so a field takes focus with nothing on
// screen to say so. A fallback for that has to win the cascade against the
// rule that hides it: existing is not enough, and this file rejects a
// `@media (forced-colors: active)` rule that loses.
//
// Selectors are matched by their parsed text and the cascade is read from the
// `parseRules` order (a rule's array index is its source position, so "later"
// is one index comparison). No assertion greps a literal that a deleted block
// would leave behind.

const source = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const rules = parseRules(source)

const NONE = /^(?:none|0)(?:\s*!important)?$/i

type RuleRef = { rule: StyleRule; index: number }

function lastDeclaration(rule: StyleRule, property: string): string | null {
  let value: string | null = null
  for (const declaration of rule.declarations) {
    if (declaration.property === property) value = declaration.value
  }
  return value
}

function hidesOutline(rule: StyleRule): boolean {
  const outline = lastDeclaration(rule, 'outline')
  return outline !== null && NONE.test(outline.trim())
}

function restoresOutline(rule: StyleRule): boolean {
  const outline = lastDeclaration(rule, 'outline')
  return outline !== null && !NONE.test(outline.trim())
}

function isForcedColors(rule: StyleRule): boolean {
  const media = rule.media ?? ''
  return /forced-colors/i.test(media) && /active/i.test(media)
}

function declaresImportant(rule: StyleRule): boolean {
  const outline = lastDeclaration(rule, 'outline') ?? ''
  return /!\s*important/i.test(outline)
}

// The two shapes the card pins: `!important` wins wherever it sits, and the
// same selector at the same specificity wins by source order. `*:focus-visible`
// fits neither — it is 0,1,0 against the offending 0,1,1 — so a rule that only
// looks like a restore cannot satisfy this.
function winsCascade(candidate: RuleRef, offending: RuleRef, selector: string): boolean {
  if (declaresImportant(candidate.rule)) return true
  return candidate.rule.selectors.includes(selector) && candidate.index > offending.index
}

// The shadow is exactly what the colour mode drops, so a restore that leans on
// it is not a restore.
function leansOnShadow(rule: StyleRule): boolean {
  const shadow = lastDeclaration(rule, 'box-shadow')
  return shadow !== null && !NONE.test(shadow.trim())
}

const referencing: RuleRef[] = rules.map((rule, index) => ({ rule, index }))
const offending: RuleRef[] = referencing.filter(({ rule }) => rule.selectors.some((selector) => selector.includes(':focus')) && hidesOutline(rule))

test('every form focus selector hidden by outline: none has a winning forced-colours restore', () => {
  // Guard against a vacuous pass: deleting the hiding rule instead of adding a
  // fallback would empty `offending`, and the console must still have a focus
  // style at all.
  if (offending.length === 0) {
    const general = referencing.find(({ rule }) => rule.selectors.includes('*:focus-visible'))
    assert.ok(general !== undefined, 'no rule hides a form focus outline, and the sheet has no *:focus-visible rule either: the console has no focus style at all')
    assert.ok(restoresOutline(general.rule), 'no rule hides a form focus outline, and *:focus-visible no longer declares one either: the console has no focus style at all')
    return
  }

  for (const offendingRule of offending) {
    const focusSelectors = offendingRule.rule.selectors.filter((selector) => selector.includes(':focus'))
    for (const selector of focusSelectors) {
      const forced = referencing.filter((candidate) => isForcedColors(candidate.rule) && restoresOutline(candidate.rule))
      const winning = forced.filter((candidate) => winsCascade(candidate, offendingRule, selector))
      assert.ok(
        winning.length > 0,
        `${selector} is hidden in forced-colors mode and no winning (forced-colors: active) rule restores an outline for it`,
      )
      assert.ok(
        winning.some((candidate) => !leansOnShadow(candidate.rule)),
        `${selector} is restored in forced-colors mode by a rule that leans on box-shadow, which that mode does not paint`,
      )
    }
  }
})
