import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// #1012: `public/workspace-brand.js` is a plain browser script with no module
// exports, so this fixture is the smallest document its globals need.
// `querySelectorAll` answers the leaves its selector would reach (the header,
// aside and nav wildcards plus the brand and logo class matches), and a leaf's
// box is what decides the top-left region. `interactive` marks a leaf that sits
// in a link, which is how a repository or workspace called FlyBot appears.
type Region = 'header' | 'aside' | 'nav' | 'brand' | 'logo' | 'main'

interface FixtureLeaf {
  region: Region
  text: string
  top: number
  left: number
  interactive: boolean
  isMark: boolean
  style: { visibility: 'visible' | 'hidden' }
}

const leaf = (region: Region, text: string, top = 8, left = 8, interactive = false, isMark = region === 'brand' || region === 'logo'): FixtureLeaf => ({
  region, text, top, left, interactive, isMark, style: { visibility: 'visible' },
})

const reachedBySelector = (candidate: FixtureLeaf): boolean =>
  candidate.region !== 'main'

function runScript(leaves: FixtureLeaf[]): { appended: Array<{ id: string; innerHTML: string }>; observers: Array<() => void> } {
  const appended: Array<{ id: string; innerHTML: string }> = []
  const observers: Array<() => void> = []
  const document = {
    title: 'workspace',
    body: {
      dataset: { fledgeRepo: 'owner/flybot' },
      append: (node: { id: string; innerHTML: string }): void => { appended.push(node) },
    },
    documentElement: {},
    querySelector: (): null => null,
    querySelectorAll: (): unknown[] =>
      leaves.filter(reachedBySelector).map((candidate) => ({
        children: { length: 0 },
        textContent: candidate.text,
        style: candidate.style,
        getBoundingClientRect: () => ({ top: candidate.top, left: candidate.left }),
        // The two selectors the rule can ask about: the element itself is a control
        // (`a`, `button`, a button role) or it sits in a brand/logo container.
        closest: (selector: string): unknown => {
          if (/(^|[,\s])a\b|button/.test(selector)) return candidate.interactive ? { tagName: 'A' } : null
          if (selector.includes('brand') || selector.includes('logo')) return candidate.isMark ? { tagName: 'DIV' } : null
          return null
        },
      })),
    createElement: (): { id: string; innerHTML: string } => ({ id: '', innerHTML: '' }),
  }
  class FakeObserver {
    constructor(callback: () => void) { observers.push(callback) }
    observe(): void {}
  }
  // The script is a classic browser IIFE served as-is, so it is executed in a
  // context holding the two globals it reads rather than imported.
  const source = readFileSync(new URL('../public/workspace-brand.js', import.meta.url), 'utf8')
  runInNewContext(source, { document, MutationObserver: FakeObserver })
  return { appended, observers }
}

test('a header link called FlyBot stays visible while the vendor wordmark is hidden', () => {
  const vendor = leaf('header', 'DeepSeek', 8, 8)
  const brandVendor = leaf('brand', 'DeepSeek Harness', 8, 8)
  const repoLink = leaf('nav', 'FlyBot', 27, 8, true)
  const workspaceLink = leaf('aside', 'FlyBot', 46, 8, true)
  const named = leaf('nav', 'FlyBot repo', 27, 62, true)
  const body = leaf('main', 'FlyBot', 65, 8, true)
  const { appended, observers } = runScript([vendor, brandVendor, repoLink, workspaceLink, named, body])

  assert.equal(vendor.style.visibility, 'hidden', 'the vendor wordmark is the node the rule was written for')
  assert.equal(brandVendor.style.visibility, 'hidden', 'a wordmark inside a brand container is still hidden')
  assert.equal(named.style.visibility, 'visible', 'a longer label was never the mark')
  assert.equal(body.style.visibility, 'visible', 'outside the header, aside and nav the script never hid anything')
  assert.equal(repoLink.style.visibility, 'visible', 'a repository link called FlyBot is content, not the vendor mark')
  assert.equal(workspaceLink.style.visibility, 'visible', 'a saved workspace called FlyBot is content too')

  // The observer re-applies the rule on every DOM change, so a node it spares on
  // load has to stay visible when it runs again.
  for (const callback of observers) callback()
  assert.equal(repoLink.style.visibility, 'visible', 'the observer does not bring the rule back')

  assert.equal(appended.length, 1, 'the Fledge badge is still injected')
  assert.match(appended[0]?.innerHTML ?? '', /Fledge/)
})
