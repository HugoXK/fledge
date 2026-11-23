export const VISUAL_WIDTHS = [360, 390, 430, 640, 768, 1024, 1280, 1440, 1920] as const

export const VISUAL_PATHS = ['/', '/dashboard', '/settings', '/admin', '/repos/new', '/console'] as const

export type VisualPath = (typeof VISUAL_PATHS)[number]

/**
 * One page measured at a width the default sweep does not render.
 *
 * The sweep is cross-product: a width added to `VISUAL_WIDTHS` is rendered for
 * every path, so a narrow width that one surface needs would put every other
 * page into the failure list before anyone had measured them (#950). This is
 * the seam for a page whose narrowest layout has to be guarded now.
 */
export interface VisualNarrowCase {
  readonly path: VisualPath
  readonly width: number
}

/** `/console` is the surface #950 measured at 320; the rest of the sweep stays at 360 and up. */
export const VISUAL_NARROW_CASES: readonly VisualNarrowCase[] = [
  { path: '/console', width: 320 },
]

export function viewportHeight(width: number): number {
  if (width <= 430) return 844
  if (width <= 640) return 900
  if (width <= 960) return 1024
  return 900
}

export function pageSlug(path: string): string {
  if (path === '/') return 'landing'
  return path
    .replace(/^\/+/, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/-+$/, '')
}

export interface OverflowOffender {
  /** `tag.class` label used in the failure message; the class part is optional. */
  name: string
  /** The page opted this element out with `data-allow-overflow`. */
  waiver?: boolean
  /** A `.table-scroll` ancestor clips the element horizontally. */
  clipped?: boolean
  /** An ancestor is a horizontal scroller whose `scrollWidth` exceeds its `clientWidth`. */
  scrollerAncestor?: boolean
  /** The element is itself a horizontal scroller that overflows. */
  isScroller?: boolean
}

export interface OverflowInput {
  scrollWidth: number
  clientWidth: number
  bad: readonly OverflowOffender[]
}

/** A clipped element is only a failure when nothing can scroll it into view. */
function clippedAway(offender: OverflowOffender): boolean {
  if (offender.clipped === true) return true
  return offender.waiver === true && offender.scrollerAncestor === true && offender.isScroller !== true
}

export function overflowFailure(input: OverflowInput): string | null {
  if (input.scrollWidth > input.clientWidth + 1) {
    return `document scrollWidth ${String(input.scrollWidth)} exceeds ${String(input.clientWidth)}`
  }
  const outside = input.bad.filter((offender) => !clippedAway(offender))
  if (outside.length > 0) {
    return `element outside the viewport: ${outside.slice(0, 3).map((offender) => offender.name).join(', ')}`
  }
  return null
}

// #870: the visual job measured overflow and nothing else, and it never chose a
// colour scheme — the dark palette was photographed only when the host happened
// to prefer it. The gate renders a small cross-product on purpose and judges
// four properties of what the browser computed, so each one is a pure function
// that a broken fixture can pin in a unit test without a browser.
//
// Nine widths stay the screenshot sweep; three widths by two schemes is the
// measured gate. The two are separate on purpose: a width added to the sweep to
// photograph one surface must not silently become a gate every page has to pass.
export const GATE_WIDTHS = [360, 768, 1280] as const

export type GateWidth = (typeof GATE_WIDTHS)[number]

export const GATE_SCHEMES = ['light', 'dark'] as const

export type GateScheme = (typeof GATE_SCHEMES)[number]

/** The `--touch` floor in `public/app.css:145`; WCAG 2.5.5 asks for the same. */
export const TOUCH_FLOOR = 44

/** WCAG 2.5.8's AA minimum, the floor a documented compact control may not pass. */
export const COMPACT_FLOOR = 24

export interface TouchSample {
  /** `tag.class` label used in the failure message. */
  readonly name: string
  readonly width: number
  readonly height: number
  /** The control carries the documented compact opt-out (`data-compact-target`). */
  readonly compact?: boolean
  /** An inline marker inside a sentence, exempt under WCAG 2.5.8's inline exception. */
  readonly inline?: boolean
}

/**
 * A control below the floor is a failure, and a compact control is still held to
 * 24px. The opt-out is an attribute on the control itself, not a selector list,
 * so a new small control cannot inherit the waiver by being written the same
 * way; it has to ask for one and say why in its markup. A `summary` is a control
 * like any other: the disclosure row is held to the 44px floor, so a short one
 * is raised rather than waived.
 */
export function touchFailures(controls: readonly TouchSample[]): string[] {
  const failures: string[] = []
  for (const control of controls) {
    // WCAG 2.5.8 does not apply its minimum to a target in a sentence or block
    // of text: the info marker beside a label is read with the sentence, and
    // growing it would break the line it sits in. The opt-out is an attribute
    // on that control, and the accessible-name check still applies to it.
    if (control.inline === true) continue
    const floor = control.compact === true ? COMPACT_FLOOR : TOUCH_FLOOR
    // A fractional layout box is compared with a tolerance far below one pixel,
    // because that is what browser sub-pixel rounding actually costs: 43.99px is
    // a 44px control the browser rounded down and still passes, while 43.5px is
    // a control that lost its target and has to fail.
    if (control.width + 0.05 >= floor && control.height + 0.05 >= floor) continue
    const rounded = `${String(Math.round(control.width))}x${String(Math.round(control.height))}px`
    failures.push(
      control.compact === true
        ? `${control.name} is ${rounded}, under the ${String(COMPACT_FLOOR)}px floor even with its compact opt-out`
        : `${control.name} is ${rounded}, under the ${String(TOUCH_FLOOR)}px touch floor`,
    )
  }
  return failures
}

/** The five properties a focus ring may use; one of them has to move. */
export interface FocusStyle {
  readonly outlineWidth: string
  readonly outlineStyle: string
  readonly boxShadow: string
  readonly borderColor: string
  readonly backgroundColor: string
}

export interface FocusSample {
  readonly name: string
  readonly before: FocusStyle
  readonly after: FocusStyle
}

const FOCUS_PROPERTIES = ['outlineWidth', 'outlineStyle', 'boxShadow', 'borderColor', 'backgroundColor'] as const

/**
 * A control whose computed style is identical focused and unfocused has no
 * focus indicator. `outline: none` alone is the failure this exists for: the
 * page may draw its ring as a box-shadow (`public/app.css:750`), and the test
 * is only that something a reader can see changed.
 */
export function focusFailures(samples: readonly FocusSample[]): string[] {
  const failures: string[] = []
  for (const sample of samples) {
    const changed = FOCUS_PROPERTIES.some((property) => sample.before[property] !== sample.after[property])
    if (changed) continue
    failures.push(`${sample.name} shows no visible focus: outline, box-shadow, border and background are identical when focused`)
  }
  return failures
}

export interface NameSample {
  readonly tag: string
  /** The rendered text of the control, without markup. */
  readonly text: string
  readonly ariaLabel: string | null
  readonly title: string | null
  readonly hasSvg: boolean
}

/**
 * An icon-only `button` or link has no accessible name unless it says one. The
 * check is on the computed inputs, not on the markup: `aria-label=""` and an
 * empty `title` are as absent as no attribute at all, while any rendered text —
 * a visible word or a screen-reader-only span — is a name.
 */
export function nameFailures(items: readonly NameSample[]): string[] {
  const failures: string[] = []
  for (const item of items) {
    if (item.tag !== 'button' && item.tag !== 'a') continue
    if (item.text.trim() !== '') continue
    if ((item.ariaLabel ?? '').trim() !== '' || (item.title ?? '').trim() !== '') continue
    failures.push(`<${item.tag}> with ${item.hasSvg ? 'only an icon' : 'no text'} has no aria-label or title`)
  }
  return failures
}

/** Raw template leftovers that mean a page printed its own source. */
export const TEMPLATE_LEFTOVERS = ['{infoTip(', 'class="undefined"', '[object Object]', '${'] as const

/**
 * The scan is a membership test on the rendered document, not a parser: the
 * strings cannot legally appear in escaped output, and a hit names every one it
 * found so a page with two mistakes is one failure with two reasons.
 */
export function leftoverFailures(html: string): string[] {
  return TEMPLATE_LEFTOVERS.filter((leftover) => html.includes(leftover)).map(
    (leftover) => `rendered HTML contains raw template leftover ${leftover}`,
  )
}

// #1208: the sweep is a serial loop over independent cells, so the gate's wall
// time was the sum of every cell instead of the longest share. The partition
// below is the whole contract that makes sharding safe: the same lists build the
// workload, a share is a contiguous slice of it, and the aggregate refuses to
// read green when a share measured nothing or its results never arrived.
export const VISUAL_LOCALES = ['zh', 'en'] as const

export type VisualLocale = (typeof VISUAL_LOCALES)[number]

/** One screenshot cell: a page at a width the sweep renders. */
export interface VisualSweepCell {
  readonly kind: 'sweep'
  readonly locale: VisualLocale
  readonly width: number
  readonly path: VisualPath
}

/** A page measured below the sweep's first width (`VISUAL_NARROW_CASES`). */
export interface VisualNarrowCell {
  readonly kind: 'narrow'
  readonly locale: VisualLocale
  readonly width: number
  readonly path: VisualPath
}

/** One gate cell: a page at a gate width in a forced colour scheme. */
export interface VisualGateCell {
  readonly kind: 'gate'
  readonly locale: VisualLocale
  readonly width: GateWidth
  readonly scheme: GateScheme
  readonly path: VisualPath
}

/** The explicit-dark probe at a gate width (`checkExplicitTheme`). */
export interface VisualThemeCell {
  readonly kind: 'theme'
  readonly locale: VisualLocale
  readonly width: GateWidth
}

export type VisualCell = VisualSweepCell | VisualNarrowCell | VisualGateCell | VisualThemeCell

/**
 * The failure-message prefix for a cell, and the cell's identity in a shard's
 * result file. Every message the runner pushes for a cell starts with exactly
 * this string, so a failure raised inside a share is readable in the aggregate
 * without translation and a result can be matched to what it claims to measure.
 */
export function cellLabel(cell: VisualCell): string {
  switch (cell.kind) {
    case 'sweep':
    case 'narrow':
      return `${cell.locale} ${String(cell.width)}px ${cell.path}`
    case 'gate':
      return `${cell.locale} width=${String(cell.width)} scheme=${cell.scheme} ${cell.path}`
    case 'theme':
      return `${cell.locale} width=${String(cell.width)} scheme=explicit-dark /dashboard`
  }
}

/**
 * The full workload in the order the serial runner visited it: the signed-out
 * landing page, the signed-in sweep, the narrow cases, then the gate pass and
 * the explicit-theme probe. Built from the exported lists, never a second copy
 * of them, so a width or path added to the matrix joins the partition.
 */
export function visualWorkload(): readonly VisualCell[] {
  const cells: VisualCell[] = []
  const signedIn = VISUAL_PATHS.filter((path) => path !== '/')
  for (const locale of VISUAL_LOCALES) {
    for (const width of VISUAL_WIDTHS) cells.push({ kind: 'sweep', locale, width, path: '/' })
    for (const width of VISUAL_WIDTHS) {
      for (const path of signedIn) cells.push({ kind: 'sweep', locale, width, path })
    }
    for (const narrow of VISUAL_NARROW_CASES) {
      cells.push({ kind: 'narrow', locale, width: narrow.width, path: narrow.path })
    }
    for (const width of GATE_WIDTHS) {
      for (const scheme of GATE_SCHEMES) {
        for (const path of VISUAL_PATHS) cells.push({ kind: 'gate', locale, width, scheme, path })
      }
    }
    for (const width of GATE_WIDTHS) cells.push({ kind: 'theme', locale, width })
  }
  return cells
}

/**
 * Contiguous, balanced slices: `shares` arrays covering `cells` in order, sizes
 * within one of each other. Contiguous on purpose — the runner keeps one browser
 * context per locale and mode, so a slice that hops between locales would pay
 * the context setup on every cell.
 */
export function partitionWorkload(cells: readonly VisualCell[], shares: number): VisualCell[][] {
  if (!Number.isInteger(shares) || shares < 1) {
    throw new RangeError(`the sweep needs at least one share, got ${String(shares)}`)
  }
  const base = Math.floor(cells.length / shares)
  const remainder = cells.length % shares
  const parts: VisualCell[][] = []
  let start = 0
  for (let index = 0; index < shares; index += 1) {
    const size = base + (index < remainder ? 1 : 0)
    parts.push(cells.slice(start, start + size))
    start += size
  }
  return parts
}

/** What one share wrote: the cells it measured and the failures it raised. */
export interface VisualShardResult {
  readonly share: number
  readonly cells: readonly string[]
  readonly failures: readonly string[]
}

/**
 * The aggregate's guard. Returns every reason the split must not read green:
 * a share with no cells, a result that never arrived, a cell missing from a
 * share that ran, a cell measured twice, and every share failure verbatim so a
 * failing cell in share 2 reaches the job output instead of only its artifact.
 */
export function shardFailures(
  cells: readonly VisualCell[],
  shares: number,
  results: readonly (VisualShardResult | null)[],
): string[] {
  const failures: string[] = []
  if (!Number.isInteger(shares) || shares < 1) {
    return [`the sweep cannot run in ${String(shares)} shares`]
  }
  const parts = partitionWorkload(cells, shares)
  const measured = new Map<string, number>()
  for (const result of results) {
    for (const label of result?.cells ?? []) measured.set(label, (measured.get(label) ?? 0) + 1)
  }
  parts.forEach((part, index) => {
    const name = `share ${String(index + 1)}/${String(shares)}`
    if (part.length === 0) {
      failures.push(`${name} was assigned no cells: a share that measures nothing must not read green`)
      return
    }
    const expected = part.map(cellLabel)
    const result = results[index] ?? null
    if (result === null) {
      failures.push(`${name} reported no result: its ${String(expected.length)} cell(s) were never measured`)
      return
    }
    const reported = new Set(result.cells)
    for (const label of expected) {
      if (!reported.has(label)) failures.push(`${name} did not report ${label}: the cell was never measured`)
    }
    for (const label of result.cells) {
      if (!expected.includes(label)) failures.push(`${name} reported ${label}, which it was not assigned`)
    }
    failures.push(...result.failures)
  })
  for (const [label, count] of measured) {
    if (count > 1) failures.push(`${label} was measured ${String(count)} times: the partition must render each cell once`)
  }
  return failures
}
