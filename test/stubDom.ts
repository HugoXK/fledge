import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

// Runs the shipped public/app.js against a stub DOM, so a test can press the
// menu toggle, the keyboard and the breakpoint change and read what the script
// did instead of grepping its source. Only the header, the nav toggle, the nav
// panel and one [data-auto-group] form are stubbed; every other selector the
// script uses returns nothing, the way a page without those widgets behaves.

export type Listener = (event: StubEvent) => void

export interface StubEvent {
  key?: string
  target?: unknown
}

interface StubNode {
  attributes: Map<string, string>
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
  addEventListener: (type: string, listener: Listener) => void
  dispatch: (type: string, event?: StubEvent) => void
  focus?: () => void
  offsetHeight?: number
}

function node(initial: Record<string, string> = {}): StubNode {
  const attributes = new Map(Object.entries(initial))
  const listeners = new Map<string, Listener[]>()
  return {
    attributes,
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => { attributes.set(name, String(value)) },
    removeAttribute: (name) => { attributes.delete(name) },
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener])
    },
    dispatch: (type, event = {}) => {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
  }
}

export interface NavHarness {
  properties: Map<string, string>
  resizeListeners: Array<() => void>
  observed: number
  setHeight: (height: number) => void
  ariaExpanded: () => string | null
  navOpen: () => string | null
  clickToggle: () => void
  pressEscape: () => void
  clickPanelLink: () => void
  changeMedia: () => void
  focused: () => number
  autoSelectDisabled: () => boolean
}

export interface RunAppOptions {
  resizeObserver?: boolean
  media?: 'modern' | 'legacy' | 'none'
  headerHeight?: number
}

export function runApp(options: RunAppOptions = {}): NavHarness {
  const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  const mediaMode = options.media ?? 'modern'

  const header = node()
  let headerHeight = options.headerHeight ?? 65
  Object.defineProperty(header, 'offsetHeight', { get: () => headerHeight })
  const toggle = node({ 'aria-expanded': 'false' })
  const panel = node()

  const properties = new Map<string, string>()
  const resizeListeners: Array<() => void> = []
  const observerCallbacks: Array<() => void> = []
  const observed: unknown[] = []
  const mediaListeners: Array<() => void> = []
  const keydownListeners: Array<Listener> = []
  let focusCalls = 0
  toggle.focus = () => { focusCalls += 1 }
  const autoSelect = { disabled: false }

  const root = {
    dataset: { locale: 'zh' },
    style: {
      setProperty: (name: string, value: string) => { properties.set(name, value) },
    },
  }

  class StubResizeObserver {
    private readonly callback: () => void
    constructor(callback: () => void) { this.callback = callback }
    observe(target: unknown): void { observed.push(target); observerCallbacks.push(this.callback) }
    unobserve(): void {}
    disconnect(): void {}
  }

  // #133's panel handler narrows with `instanceof Element` before closest('a');
  // the link is the element on the other side of that check.
  class StubElement {
    closest: (selector: string) => unknown = () => null
  }
  const makeLink = (): unknown => {
    const link = new StubElement()
    link.closest = () => new StubElement()
    return link
  }

  // [data-auto-group]: the script disables the interval select while the auto
  // toggle is off, so a wired group is observable as disabled === true.
  const autoToggle = {
    checked: false,
    addEventListener: (_type: string, _listener: Listener) => {},
  }
  const autoGroup = {
    querySelector: (selector: string): unknown => {
      if (selector === 'input[name="auto"]') return autoToggle
      if (selector === 'select[name="interval"]') return autoSelect
      return null
    },
  }

  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
  const mediaResult = mediaMode === 'legacy'
    ? { addListener: (listener: () => void) => { mediaListeners.push(listener) } }
    : mediaMode === 'none'
      ? {}
      : { addEventListener: (type: string, listener: () => void) => { if (type === 'change') mediaListeners.push(listener) } }

  const context = createContext({
    document: {
      documentElement: root,
      querySelector: (selector: string) => {
        if (selector === '.top') return header
        if (selector === '[data-nav-toggle]') return toggle
        return null
      },
      querySelectorAll: (selector: string) => (selector === '[data-auto-group]' ? [autoGroup] : []),
      getElementById: (id: string) => (id === 'main-nav' ? panel : null),
      addEventListener: (type: string, listener: Listener) => {
        if (type === 'keydown') keydownListeners.push(listener)
      },
    },
    window: {
      addEventListener: (type: string, listener: () => void) => { if (type === 'resize') resizeListeners.push(listener) },
      matchMedia: () => mediaResult,
      confirm: () => true,
    },
    Element: StubElement,
    localStorage: storage,
    sessionStorage: { ...storage },
    location: { pathname: '/dashboard', search: '', hash: '', replace: () => {}, reload: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout,
    console,
  })
  if (options.resizeObserver !== false) context.ResizeObserver = StubResizeObserver
  runInContext(script, context, { filename: 'public/app.js' })

  return {
    properties,
    resizeListeners,
    observed: observed.length,
    setHeight: (height: number) => {
      headerHeight = height
      for (const callback of observerCallbacks) callback()
    },
    ariaExpanded: () => toggle.getAttribute('aria-expanded'),
    navOpen: () => header.getAttribute('data-nav-open'),
    clickToggle: () => toggle.dispatch('click'),
    pressEscape: () => { for (const listener of keydownListeners) listener({ key: 'Escape' }) },
    clickPanelLink: () => panel.dispatch('click', { target: makeLink() }),
    changeMedia: () => { for (const listener of mediaListeners) listener() },
    focused: () => focusCalls,
    autoSelectDisabled: () => autoSelect.disabled,
  }
}

// #234's repository tabs. repoTabs.js ships to the browser, so the only way to
// see what a deep link does is to run it: the stub below is the markup it
// queries — `.repo-page`, `#repo-tabs` with one link per section, the six
// `.repo-section` nodes and the ids inside them — plus a `location.hash` a test
// can change, which fires the script's own `hashchange` listener.
export interface RepoTabsHarness {
  active: () => string | null
  current: () => string | null
  tabbed: () => boolean
  scrolled: () => string[]
  hash: (value: string) => void
}

export interface RepoTabsOptions {
  sections?: Array<{ id: string; inner?: string[] }>
  hash?: string
}

interface StubEl {
  id: string
  classList: {
    add: (name: string) => void
    remove: (name: string) => void
    toggle: (name: string, force?: boolean) => void
    contains: (name: string) => boolean
  }
  querySelectorAll: (selector: string) => StubEl[]
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
  scrollIntoView: (options?: { block?: string }) => void
}

export function runRepoTabs(options: RepoTabsOptions = {}): RepoTabsHarness {
  const script = readFileSync(new URL('../public/repoTabs.js', import.meta.url), 'utf8')
  const spec = options.sections ?? [
    { id: 'overview', inner: ['inbox', 'chief'] },
    { id: 'delivery', inner: ['jobs'] },
    { id: 'work', inner: ['board'] },
    { id: 'team', inner: ['role'] },
    { id: 'settings', inner: ['repo-settings', 'connection', 'goal-settings'] },
    { id: 'danger' },
  ]
  const scrolled: string[] = []

  const element = (id: string, inner: string[] = []): StubEl => {
    const classes = new Set<string>()
    const attributes = new Map<string, string>()
    const children = inner.map((childId) => element(childId))
    return {
      id,
      classList: {
        add: (name) => { classes.add(name) },
        remove: (name) => { classes.delete(name) },
        toggle: (name, force) => {
          const on = force ?? !classes.has(name)
          if (on) classes.add(name)
          else classes.delete(name)
        },
        contains: (name) => classes.has(name),
      },
      querySelectorAll: (selector) => (selector === '[id]' ? children : []),
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => { attributes.set(name, String(value)) },
      removeAttribute: (name) => { attributes.delete(name) },
      scrollIntoView: () => { scrolled.push(id) },
    }
  }

  const sections = spec.map((section) => element(section.id, section.inner ?? []))
  const page = element('repo-page')
  const byId = new Map<string, StubEl>([[page.id, page]])
  const collect = (node: StubEl): void => {
    byId.set(node.id, node)
    for (const child of node.querySelectorAll('[id]')) collect(child)
  }
  for (const section of sections) collect(section)
  page.querySelectorAll = (selector) => (selector === '.repo-section' ? sections : [])

  const links = sections.map((section) => element(`repo-tab-${section.id}`))
  links.forEach((link, index) => link.setAttribute('href', `#${sections[index]!.id}`))
  const nav = element('repo-tabs')
  nav.querySelectorAll = (selector) => (selector === 'a[href^="#"]' ? links : [])
  byId.set(nav.id, nav)

  let hash = options.hash ?? ''
  const hashListeners: Array<() => void> = []
  const context = createContext({
    document: {
      querySelector: (selector: string) => (selector === '.repo-page' ? page : null),
      getElementById: (id: string) => byId.get(id) ?? null,
    },
    window: {
      location: { get hash() { return hash } },
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'hashchange') hashListeners.push(listener)
      },
    },
  })
  runInContext(script, context, { filename: 'public/repoTabs.js' })

  const active = (): string | null => sections.find((section) => section.classList.contains('is-active'))?.id ?? null
  return {
    active,
    current: () => links.find((link) => link.getAttribute('aria-current') === 'page')?.getAttribute('href') ?? null,
    tabbed: () => page.classList.contains('is-tabbed'),
    scrolled: () => [...scrolled],
    hash: (value: string) => {
      hash = value
      for (const listener of hashListeners) listener()
    },
  }
}
