// Shared by the two stylesheet tests: `test/jobTableCards.test.ts` (the job
// table that #116 converted) and `test/tableCards.test.ts` (the tables that
// reuse its mechanism). Reading the stylesheet instead of a browser keeps the
// assertion deterministic, and the numbers come from the real media query.

export type Declaration = { property: string; value: string }
export type StyleRule = {
  selectors: string[]
  declarations: Declaration[]
  media: string | null
  // The `@supports` condition a rule sits under, without the at-rule keyword,
  // e.g. `(padding: env(safe-area-inset-top))`; null when it is unconditional.
  supports: string | null
}

// A browser without `env()` never parses an `@supports (…env(…)…)` block: that
// is the reader the sheet's fallback has to serve. A modern browser parses it
// and applies those declarations after the fallback, so the two resolve into
// one effective rule. `legacy` and `modern` model those two readers.
export type StylesheetView = 'legacy' | 'modern'

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

export function declarationsOf(body: string): Declaration[] {
  const declarations: Declaration[] = []
  for (const part of body.split(';')) {
    const separator = part.indexOf(':')
    if (separator === -1) continue
    const property = part.slice(0, separator).trim().toLowerCase()
    const value = part.slice(separator + 1).trim()
    if (property === '') continue
    declarations.push({ property, value })
  }
  return declarations
}

export function parseRules(
  source: string,
  view: StylesheetView = 'modern',
  media: string | null = null,
  supports: string | null = null,
): StyleRule[] {
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
      const body = css.slice(index + 1, end - 1)
      const head = prelude.trim()
      if (head.startsWith('@')) {
        const atRule = head.slice(1).trim()
        if (atRule.startsWith('media')) {
          rules.push(...parseRules(body, view, atRule.slice('media'.length).trim(), supports))
        } else if (atRule.startsWith('supports')) {
          if (view === 'modern') {
            const condition = atRule.slice('supports'.length).trim()
            for (const nested of parseRules(body, view, media, condition)) {
              // The block we just parsed follows its fallback in the sheet, so a
              // modern browser applies it to the same element after it: one
              // effective rule whose last declaration wins. Keeping that shape
              // means a per-rule caller reads the winning value, as it did when
              // both declarations lived in one block.
              let target: StyleRule | undefined
              for (let candidate = rules.length - 1; candidate >= 0; candidate -= 1) {
                const rule = rules[candidate]
                if (rule === undefined || rule.supports !== null || rule.media !== media) continue
                if (rule.selectors.join(',') === nested.selectors.join(',')) {
                  target = rule
                  break
                }
              }
              if (target === undefined) rules.push(nested)
              else {
                target.declarations.push(...nested.declarations)
                target.supports = condition
              }
            }
          }
          // A legacy browser drops the whole block; its fallback stays visible.
        }
        prelude = ''
        index = end
        continue
      }
      const selectors = head.split(',').map((selector) => selector.trim()).filter((selector) => selector !== '')
      rules.push({ selectors, declarations: declarationsOf(body), media, supports })
      prelude = ''
      index = end
      continue
    }
    if (character === ';') {
      prelude = ''
      index += 1
      continue
    }
    prelude += character
    index += 1
  }
  return rules
}

export function conditionHolds(condition: string, width: number): boolean {
  const parts = condition.split(/\s+and\s+/).map((part) => part.trim()).filter((part) => part !== '')
  for (const part of parts) {
    const max = /^\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(part)
    if (max !== null) {
      if (!(width <= Number(max[1]))) return false
      continue
    }
    const min = /^\(\s*min-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(part)
    if (min !== null) {
      if (!(width >= Number(min[1]))) return false
      continue
    }
    if (/^\(\s*(min|max)-width\s*:/.test(part)) return false
  }
  return true
}

export function appliesAt(rule: StyleRule, width: number): boolean {
  return rule.media === null || conditionHolds(rule.media, width)
}

export function declarationsFor(rules: StyleRule[], selector: string, width: number): Declaration[] {
  const matched: Declaration[] = []
  for (const rule of rules) {
    if (!appliesAt(rule, width)) continue
    if (!rule.selectors.includes(selector)) continue
    matched.push(...rule.declarations)
  }
  return matched
}

export function lastValue(rules: StyleRule[], selector: string, property: string, width: number): string | null {
  let value: string | null = null
  for (const declaration of declarationsFor(rules, selector, width)) {
    if (declaration.property === property) value = declaration.value
  }
  return value
}

export function pxValue(value: string | null): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '0') return 0
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(trimmed)
  return match === null ? null : Number(match[1])
}
