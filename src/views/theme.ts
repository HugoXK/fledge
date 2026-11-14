// #657: the palette is chosen by a person, not only by their operating system.
// The preference is request state like the language and the density — a cookie
// the server reads while it renders — because the palette is already painted in
// the response: a client-side flip would show the dark page first and then
// light it, which is the flash this design exists to avoid.
//
// Three choices, not two: `system` keeps the OS preference live, which is what
// most readers want and what the page did before anyone could choose. It is
// also why `system` cannot be one resolved value — the browser chrome colour is
// picked by a media query, so the document ships one `theme-color` per scheme.
import type { FastifyRequest } from 'fastify'

export type Theme = 'system' | 'light' | 'dark'

export const THEME_COOKIE = 'fledge_theme'
export const THEMES: readonly Theme[] = ['system', 'light', 'dark']

// A media query cannot read a custom property, so the two palette backgrounds
// live here as the browser-chrome colour. test/theme.test.ts keeps them equal to
// `--bg` in each palette, so the meta and the page cannot drift apart.
export const THEME_COLORS: Record<'light' | 'dark', string> = { light: '#f4f6f9', dark: '#07090d' }

export function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark'
}

// An unknown or missing cookie is the system preference: before this card the
// document followed the OS, so that is the honest default to inherit.
export function resolveTheme(request: FastifyRequest): Theme {
  const saved = request.cookies?.[THEME_COOKIE]
  return isTheme(saved) ? saved : 'system'
}

// The metas that describe the palette to the browser. `system` announces both
// schemes — `color-scheme: light dark` plus one media-scoped `theme-color` per
// scheme — and an explicit choice pins one, which is also what stops a light
// desktop from painting a dark page's scrollbars and form controls.
export function themeMeta(theme: Theme): string {
  if (theme !== 'system') {
    return `<meta name="color-scheme" content="${theme}" />
  <meta name="theme-color" content="${THEME_COLORS[theme]}" />`
  }
  return `<meta name="color-scheme" content="light dark" />
  <meta name="theme-color" content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)" />`
}

// `layout()` renders the inherited default; the response hook rewrites the
// attribute, the metas and the marked choice from the cookie, the same way
// `withDensity()` completes the `<html>` element for a page builder that has no
// request. Every page goes through the hook, so a new page cannot forget it.
export function withTheme(html: string, theme: Theme): string {
  const marked = html.replace(
    /data-theme-btn="([^"]+)" aria-current="(?:true|false)"/g,
    (_whole, value: string) => `data-theme-btn="${value}" aria-current="${value === theme ? 'true' : 'false'}"`,
  )
  if (theme === 'system') return marked
  return marked
    .replace('data-theme="system"', `data-theme="${theme}"`)
    .replace(/<meta name="color-scheme"[^>]*\/>\s*<meta name="theme-color"[^>]*\/>(?:\s*<meta name="theme-color"[^>]*\/>)?/, themeMeta(theme))
}
