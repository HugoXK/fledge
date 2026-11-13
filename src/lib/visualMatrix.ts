export const VISUAL_WIDTHS = [360, 390, 430, 640, 768, 1024, 1280, 1440, 1920] as const

export const VISUAL_PATHS = ['/', '/dashboard', '/settings', '/admin', '/repos/new', '/console'] as const

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

export interface OverflowInput {
  scrollWidth: number
  clientWidth: number
  bad: string[]
}

export function overflowFailure(input: OverflowInput): string | null {
  if (input.scrollWidth > input.clientWidth + 1) {
    return `document scrollWidth ${String(input.scrollWidth)} exceeds ${String(input.clientWidth)}`
  }
  if (input.bad.length > 0) {
    return `element outside the viewport: ${input.bad.join(', ')}`
  }
  return null
}
