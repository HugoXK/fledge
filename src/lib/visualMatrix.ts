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
