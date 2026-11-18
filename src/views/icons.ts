// #867: a control used to show one typed glyph — `×` on the two close buttons,
// `!` on an info tip, `✓` on a finished setup step. A glyph is drawn by whatever
// face the platform picks, so the same button is a different weight and baseline
// on macOS and Windows, and a Chinese reader sees Latin punctuation inside a
// Chinese sentence. A drawn mark is the same shape everywhere and inherits the
// colour the button already has.
//
// The state icons in `states.js` and the star in `layout.js` were already drawn;
// this module is where the remaining UI marks live, so the next component does
// not type one again. Folding those two sets in is a separate change with its own
// test risk and is not part of this slice.
//
// A literal map: the only value that reaches the markup is the name in this
// union, so nothing user-controlled is interpolated into the SVG.
const ICON_SPEC = {
  close: '<path d="M6 6l12 12" /><path d="M18 6 6 18" />',
  // Same circled exclamation the error state uses, at the size a 15px tip needs.
  info: '<circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><path d="M12 7.4h.01" />',
  check: '<path d="m5 12.5 4.5 4.5L19 7" />',
} as const

export type IconName = keyof typeof ICON_SPEC

const ICON_ATTRS = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"'

// `size` is the square the mark occupies, in px. The viewBox is always the 24px
// grid the other drawn marks use, and the colour is always `currentColor`, so no
// icon adds a colour literal to the stylesheet.
export function icon(name: IconName, size: number): string {
  return `<svg class="icon icon-${name}" viewBox="0 0 24 24" width="${size}" height="${size}" ${ICON_ATTRS}>${ICON_SPEC[name]}</svg>`
}
