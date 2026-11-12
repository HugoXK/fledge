import test from 'node:test'
import assert from 'node:assert/strict'
import { runApp } from './stubDom.js'

// The harness in test/stubDom.ts runs the shipped public/app.js in a node:vm
// stub DOM (the shape #133 acceptance 5 names), so these assertions read what
// the script does — the published offset included — not whether its source
// contains a token.

// A header whose height changes without a window resize (a web font swapping in,
// a longer nav label in the other locale, a reader text-size change) leaves a
// resize-only updater stale, and the var is what keeps anchor targets out from
// under the sticky bar.
test('a header that changes height without a window resize still updates --header-h', () => {
  const harness = runApp({ resizeObserver: true, headerHeight: 92 })
  assert.equal(harness.properties.get('--header-h'), '92px', 'the first render publishes the measured height')
  harness.setHeight(137)
  assert.equal(harness.properties.get('--header-h'), '137px', 'the var must follow the rendered header with no resize event')
})

// The resize trigger is replaced only when the browser can observe the element;
// without ResizeObserver the shipped fallback must still re-measure.
test('without ResizeObserver the resize fallback still re-measures the header', () => {
  const harness = runApp({ resizeObserver: false, headerHeight: 92 })
  assert.equal(harness.properties.get('--header-h'), '92px')
  assert.equal(harness.resizeListeners.length, 1, 'a browser without ResizeObserver must keep the resize trigger')
  harness.setHeight(150)
  const listener = harness.resizeListeners[0]
  assert.ok(listener !== undefined)
  listener()
  assert.equal(harness.properties.get('--header-h'), '150px')
})
