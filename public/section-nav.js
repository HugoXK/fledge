// Which section the nav marks for a resting scroll position.
//
// The observer that used to answer this only fired when a section crossed the
// 20%-40% band of the viewport, so a section that the page cannot scroll into
// that band -- the last one, because the document ends -- kept the previous
// section marked while it sat plainly on screen. The rule here answers from the
// geometry instead: at the end of the document the last section is current,
// otherwise the current section is the last one whose top has passed the band.
//
// The band is scrollBandTop below: the bottom of the sticky bar, or 20% of the
// viewport when that sits lower. The bar's bottom edge is where an anchor jump
// parks its target, so the section a chip scrolls to is the one the marker
// keeps.
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

// The line sections are measured against, from the two numbers the page has:
// the viewport height and the scroll-margin-top that parks an anchor target
// under the sticky bar. The bar wins where it sits below 20% of the viewport --
// short windows and landscape phones -- because the marker must count a target
// parked exactly there; above that height, 20% keeps the reviewed band.
function scrollBandTop(viewportHeight, scrollMarginTop) {
  return Math.max(viewportHeight * 0.2, scrollMarginTop + 1)
}
