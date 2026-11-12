// Which section the nav marks for a resting scroll position.
//
// The observer that used to answer this only fired when a section crossed the
// 20%-40% band of the viewport, so a section that the page cannot scroll into
// that band -- the last one, because the document ends -- kept the previous
// section marked while it sat plainly on screen. The rule here answers from the
// geometry instead: at the end of the document the last section is current,
// otherwise the current section is the last one whose top has passed the
// band's top edge.
//
// Pure on purpose: the caller passes the geometry, so test/sectionNav.test.ts
// pins the rule at the viewport heights it was measured at, without a browser.
function currentSection(state) {
  const tops = state.tops || []
  if (tops.length === 0) return null
  const tolerance = state.tolerance === undefined ? 2 : state.tolerance
  const maxScroll = Math.max(0, (state.scrollHeight || 0) - (state.viewportHeight || 0))
  if (maxScroll > 0 && (state.scrollY || 0) >= maxScroll - tolerance) return tops[tops.length - 1].id
  let active = tops[0].id
  for (const entry of tops) {
    if (entry.top <= state.bandTop) active = entry.id
  }
  return active
}
