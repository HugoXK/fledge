import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

interface HeaderHarness {
  properties: Map<string, string>
  resizeListeners: Array<() => void>
  observed: number
  setHeight: (height: number) => void
}

// Runs the shipped script against a stub DOM: only the sticky-header path is
// exercised, every selector used by the other widgets returns an empty list.
function runApp(options: { resizeObserver: boolean }): HeaderHarness {
  const header = { offsetHeight: 92 }
  const properties = new Map<string, string>()
  const resizeListeners: Array<() => void> = []
  const observerCallbacks: Array<() => void> = []
  const observed: unknown[] = []
  const root = {
    dataset: { locale: 'zh' },
    style: {
      setProperty: (name: string, value: string) => { properties.set(name, value) },
    },
  }
  class StubResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe(target: unknown): void { observed.push(target); observerCallbacks.push(this.callback) }
    unobserve(): void {}
    disconnect(): void {}
  }
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const context = createContext({
    document: {
      documentElement: root,
      querySelector: (selector: string) => (selector === '.top' ? header : null),
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener: () => {},
    },
    window: {
      addEventListener: (type: string, listener: () => void) => { if (type === 'resize') resizeListeners.push(listener) },
      confirm: () => true,
    },
    localStorage: storage,
    sessionStorage: { ...storage },
    location: { pathname: '/repos/repo_1/workspace', search: '', hash: '', replace: () => {}, reload: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout,
    console,
  })
  if (options.resizeObserver) context.ResizeObserver = StubResizeObserver
  runInContext(script, context, { filename: 'public/app.js' })
  return {
    properties,
    resizeListeners,
    observed: observed.length,
    setHeight: (height: number) => {
      header.offsetHeight = height
      for (const callback of observerCallbacks) callback()
    },
  }
}

// A header whose height changes without a window resize (a web font swapping in,
// a longer nav label in the other locale, a reader text-size change) leaves a
// resize-only updater stale, and the var is what keeps anchor targets out from
// under the sticky bar.
test('a header that changes height without a window resize still updates --header-h', () => {
  const harness = runApp({ resizeObserver: true })
  assert.equal(harness.properties.get('--header-h'), '92px', 'the first render publishes the measured height')
  harness.setHeight(137)
  assert.equal(harness.properties.get('--header-h'), '137px', 'the var must follow the rendered header with no resize event')
})

// The resize trigger is replaced only when the browser can observe the element;
// without ResizeObserver the shipped fallback must still re-measure.
test('without ResizeObserver the resize fallback still re-measures the header', () => {
  const harness = runApp({ resizeObserver: false })
  assert.equal(harness.properties.get('--header-h'), '92px')
  assert.equal(harness.resizeListeners.length, 1, 'a browser without ResizeObserver must keep the resize trigger')
  harness.setHeight(150)
  const listener = harness.resizeListeners[0]
  assert.ok(listener !== undefined)
  listener()
  assert.equal(harness.properties.get('--header-h'), '150px')
})
