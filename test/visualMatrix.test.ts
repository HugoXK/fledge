import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as visualMatrix from '../src/lib/visualMatrix.js'
import {
  GATE_SCHEMES,
  GATE_WIDTHS,
  VISUAL_LOCALES,
  VISUAL_NARROW_CASES,
  VISUAL_PATHS,
  VISUAL_WIDTHS,
  cellLabel,
  overflowFailure,
  pageSlug,
  viewportHeight,
  visualWorkload,
} from '../src/lib/visualMatrix.js'

test('the matrix covers phones, tablets and desktop widths', () => {
  assert.deepEqual([...VISUAL_WIDTHS], [360, 390, 430, 640, 768, 1024, 1280, 1440, 1920])
  assert.ok(VISUAL_WIDTHS.includes(768))
  assert.ok(VISUAL_WIDTHS.includes(1920))
})

test('the matrix covers the owner, operator and account surfaces', () => {
  for (const path of ['/', '/dashboard', '/settings', '/admin', '/repos/new', '/console']) {
    assert.ok((VISUAL_PATHS as readonly string[]).includes(path), `the matrix is missing ${path}`)
  }
})

test('the viewport height follows the width band', () => {
  assert.equal(viewportHeight(360), 844)
  assert.equal(viewportHeight(768), 1024)
  assert.equal(viewportHeight(1280), 900)
})

// #950: the sweep starts at 360, so a 320-only overflow reached `main` as a
// clean run — the width was never rendered. The fix is a case, not a wider
// cross-product: 320 in `VISUAL_WIDTHS` would put every page nobody measured
// into the failure list. Read through the module object so this file still
// loads on a tree that has no such export.
test('the matrix renders the console at 320, below the sweep that starts at 360', () => {
  const cases = (visualMatrix as unknown as { VISUAL_NARROW_CASES?: readonly { path: string; width: number }[] }).VISUAL_NARROW_CASES
  assert.ok(cases !== undefined, 'the matrix needs a narrow-case list; without one the 320 row cannot exist')
  assert.ok(
    cases.some((entry) => entry.path === '/console' && entry.width === 320),
    'the console has to be measured at 320, the reflow baseline WCAG 1.4.10 names',
  )
  assert.equal(viewportHeight(320), 844, 'a narrow case keeps the phone viewport height')
  assert.ok(!(VISUAL_WIDTHS as readonly number[]).includes(320), '320 stays outside the cross-product so no unmeasured page is swept into it')
})

test('the runner turns a narrow case into a failure, not a screenshot', () => {
  const workload = visualWorkload()
  const narrow = workload.filter((cell) => cell.kind === 'narrow')
  assert.equal(
    narrow.length,
    VISUAL_NARROW_CASES.length * VISUAL_LOCALES.length,
    'every narrow case is measured in both locales',
  )
  for (const locale of VISUAL_LOCALES) {
    const consoleNarrow = narrow.find((cell) => cell.locale === locale && cell.path === '/console' && cell.width === 320)
    assert.ok(consoleNarrow !== undefined, `the ${locale} pass has to measure /console at 320`)
    assert.equal(cellLabel(consoleNarrow), `${locale} 320px /console`, 'a narrow case reports locale, width and path like every other row')
  }
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  assert.match(
    script,
    /await checkPage\(page, cell\.locale, cell\.width, cell\.path\)/,
    'a narrow case goes through the same overflow walk as every other row, so its failure is a failure and not a screenshot',
  )
})

// The narrow band is the spacing half of the same fix. It is CSS text, so the
// contract kept here is the one that matters: a band below the first swept
// width exists and it tightens the four boxes that made the row too wide.
test('the phone header a 320 case renders is the tight band, below every swept width', () => {
  const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
  const start = css.indexOf('@media (max-width: 359px)')
  assert.ok(start !== -1, 'the header needs a band below 360 where the row has to fit without its spacing')
  const body = css.slice(start, css.indexOf('\n}', start))
  for (const selector of ['.top-inner', '.lang', '.account', '.account-exit']) {
    assert.match(body, new RegExp(`${selector.replace('.', '\\.')}\\s*\\{`), `the 359 band must tighten ${selector}`)
  }
  assert.match(body, /\.top-inner\s*\{[^}]*padding:\s*0 6px/, 'the row keeps its side padding but halves it')
  assert.match(body, /\.account-exit\s*\{[^}]*padding:\s*0;/, 'the sign-out button loses the side padding its min-width already covers')
})

test('the slug names a stable screenshot file', () => {
  assert.equal(pageSlug('/'), 'landing')
  assert.equal(pageSlug('/admin/metrics'), 'admin-metrics')
  assert.equal(pageSlug('/repos/new'), 'repos-new')
})

test('overflow is named by its width or its element', () => {
  assert.equal(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [] }), null)
  assert.match(overflowFailure({ scrollWidth: 392, clientWidth: 390, bad: [] }) ?? '', /scrollWidth/)
  assert.match(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [{ name: 'div.card' }] }) ?? '', /div\.card/)
})

// #453 review: two defects the matrix could not have caught. It signed in before
// visiting `/`, which answers 302 to /dashboard once a session exists, so the
// "landing" screenshot was a second copy of the dashboard; and its `#tokens`
// guard skipped the assertion when the anchor was missing, so it passed on a
// page that had no anchor and no link target. Both are structural, so they are
// pinned here rather than only in the browser job.
test('the matrix captures the landing page signed out, before the development login', () => {
  const workload = visualWorkload()
  const landing = workload.filter((cell) => cell.kind === 'sweep' && cell.path === '/')
  assert.equal(landing.length, VISUAL_WIDTHS.length * VISUAL_LOCALES.length, 'every width is captured for the landing page')
  const signedInSweep = workload.filter((cell) => cell.kind === 'sweep' && cell.path !== '/')
  assert.equal(
    signedInSweep.length,
    (VISUAL_PATHS.length - 1) * VISUAL_WIDTHS.length * VISUAL_LOCALES.length,
    'the signed-in sweep covers every path except the landing page, at every width',
  )
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  assert.match(script, /const signedIn = cell\.path !== '\/'/, 'the landing page is the one cell that stays signed out')
  assert.match(
    script,
    /if \(options\.signedIn\) await page\.goto\(`\$\{base\}\/auth\/dev`/,
    'the development login runs only for a signed-in cell, and before the page it measures',
  )
  assert.match(
    script,
    /next=\$\{options\.signedIn \? '\/dashboard' : '\/'\}/,
    'the landing cell lands on /, and the signed-in cells land on the dashboard',
  )
})

test('a missing #tokens anchor fails the matrix instead of skipping the assertion', () => {
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  assert.match(
    script,
    /positions\.target === null\) \{\s*failures\.push\(`[^`]*no #tokens anchor/,
    'a settings page without the anchor must be a failure, not a skipped measurement',
  )
})

// #521: `data-allow-overflow` used to be honoured on the attribute alone, so any
// element could leave the matrix by carrying it. The waiver now needs an ancestor
// that is a horizontal scroller with `scrollWidth > clientWidth`, and an element
// that is itself that scroller gets no waiver. The `.table-scroll` exemption had
// no case of its own either, so it is pinned here next to the new rule.
test("a chip's overflow waiver needs a horizontal scroller ancestor", () => {
  const chip = { name: 'a.user-nav-link', waiver: true, scrollerAncestor: true, isScroller: false }
  assert.equal(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [chip] }), null)

  const noScroller = { name: 'a.user-nav-link', waiver: true, scrollerAncestor: false, isScroller: false }
  assert.match(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [noScroller] }) ?? '', /a\.user-nav-link/)

  const scrollerItself = { name: 'div.section-nav', waiver: true, scrollerAncestor: true, isScroller: true }
  assert.match(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [scrollerItself] }) ?? '', /div\.section-nav/)

  const unwaived = { name: 'div.wide-card', scrollerAncestor: true, isScroller: false }
  assert.match(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [unwaived] }) ?? '', /div\.wide-card/)
})

test('an element clipped by a .table-scroll ancestor is not an overflow failure', () => {
  const cell = { name: 'td', clipped: true }
  assert.equal(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [cell] }), null)
  assert.match(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [{ name: 'td' }] }) ?? '', /td/)
  assert.match(overflowFailure({ scrollWidth: 392, clientWidth: 390, bad: [cell] }) ?? '', /scrollWidth/)
})

// The rule above is only reachable when the browser pass reports the ancestry, so
// the script side is pinned too: no attribute-only shortcut, and both flags read.
test('the matrix walk reports ancestry instead of trusting the attribute', () => {
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(script, /getAttribute\('data-allow-overflow'\) !== null\) continue/)
  assert.match(script, /waiver: element\.hasAttribute\('data-allow-overflow'\)/)
  assert.match(script, /let scrollerAncestor = false/)
})

// #557: `clipped: scroll !== null && scroll !== element` waived every descendant of
// any `.table-scroll` div, so an inert box that merely carried the class name hid
// real overflow inside it. The ancestor now has to prove it scrolls.
test('a .table-scroll ancestor waives only when it can actually scroll', () => {
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  const start = script.indexOf('for (const element of document.querySelectorAll')
  const end = script.indexOf('return { scrollWidth', start)
  assert.ok(start > 0 && end > start, 'the walk must still measure the page')
  const walk = script.slice(start, end)
  assert.doesNotMatch(
    walk,
    /clipped:\s*scroll !== null && scroll !== element/,
    'the class name alone must not waive: the ancestor has to prove it scrolls',
  )
  assert.match(
    walk,
    /scroll\.scrollWidth\s*>\s*scroll\.clientWidth/,
    'the clipping ancestor must overflow its own box before it can hide anything',
  )
  assert.match(
    walk,
    /overflowX === 'auto'|overflowX === 'scroll'/,
    'and it must be a real scroller, not an inert box carrying the class',
  )
})

// #870: the visual job measured overflow and nothing else — no touch floor, no
// focus ring, no accessible name, no raw-template scan — and it never chose a
// colour scheme, so the dark palette was photographed only when the host
// happened to prefer it. The four gates live as pure functions so a broken
// fixture can pin each one here, where a browser is not needed.
//
// The module is read through an object rather than a named import: on a tree
// that has not added the gate yet, this file must still load, and the missing
// export has to read as an assertion failure rather than a module-load error.
type GateModule = {
  GATE_WIDTHS?: readonly number[]
  GATE_SCHEMES?: readonly string[]
  touchFailures?: (controls: readonly {
    name: string
    width: number
    height: number
    compact?: boolean
    inline?: boolean
    disclosure?: boolean
  }[]) => string[]
  focusFailures?: (samples: readonly {
    name: string
    before: Record<string, string>
    after: Record<string, string>
  }[]) => string[]
  nameFailures?: (items: readonly {
    tag: string
    text: string
    ariaLabel: string | null
    title: string | null
    hasSvg: boolean
  }[]) => string[]
  leftoverFailures?: (html: string) => string[]
}
const gate = visualMatrix as unknown as GateModule

test('the gate matrix is three widths by two schemes, not nine widths by host preference', () => {
  assert.deepEqual([...(gate.GATE_WIDTHS ?? [])], [360, 768, 1280])
  assert.deepEqual([...(gate.GATE_SCHEMES ?? [])], ['light', 'dark'])
})

test('the touch gate fails a 24px control and names the 44px floor', () => {
  assert.equal(typeof gate.touchFailures, 'function', 'the matrix needs a touch-target checker; without one a control can shrink to any size')
  const failures = gate.touchFailures?.([{ name: 'button.banner-dismiss', width: 24, height: 24 }]) ?? []
  assert.equal(failures.length, 1)
  assert.match(failures[0] ?? '', /button\.banner-dismiss/)
  assert.match(failures[0] ?? '', /44/)
})

test('a compact control is still held to the 24px WCAG floor', () => {
  assert.equal(typeof gate.touchFailures, 'function', 'the matrix needs a touch-target checker')
  const below = gate.touchFailures?.([{ name: 'button.banner-dismiss', width: 23, height: 24, compact: true }]) ?? []
  assert.equal(below.length, 1, 'a compact opt-out must not waive the 24px minimum')
  assert.equal((gate.touchFailures?.([{ name: 'button.banner-dismiss', width: 24, height: 24, compact: true }]) ?? []).length, 0)
})

test('a control that lost half a pixel fails the touch floor', () => {
  assert.equal(typeof gate.touchFailures, 'function', 'the matrix needs a touch-target checker')
  assert.equal(
    (gate.touchFailures?.([{ name: 'input', width: 736, height: 43.5 }]) ?? []).length,
    1,
    'a control that lost half a pixel is still below the floor',
  )
  // The 0.35px slack #1095 shipped is gone: a control laid out at 43.6875px is
  // now a failure again, and the fix belongs in the control, not in the gate.
  assert.equal(
    (gate.touchFailures?.([{ name: 'input', width: 736, height: 43.6875 }]) ?? []).length,
    1,
    '43.6875px is under the floor now that the tolerance is 0.05px again',
  )
})

test('the focus gate fails a control whose focused style is identical', () => {
  assert.equal(typeof gate.focusFailures, 'function', 'the matrix needs a focus-visibility checker; without one a removed ring ships unseen')
  const resting = {
    outlineWidth: '0px',
    outlineStyle: 'none',
    boxShadow: 'none',
    borderColor: 'rgb(34, 48, 40)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
  }
  const ringed = { ...resting, boxShadow: 'rgb(143, 191, 168) 0px 0px 0px 2px' }
  assert.equal((gate.focusFailures?.([{ name: 'button.banner-dismiss', before: resting, after: resting }]) ?? []).length, 1)
  assert.equal((gate.focusFailures?.([{ name: 'button.banner-dismiss', before: resting, after: ringed }]) ?? []).length, 0)
})

test('the name gate fails an icon-only control without a label', () => {
  assert.equal(typeof gate.nameFailures, 'function', 'the matrix needs an accessible-name checker; without one an unlabelled icon button ships')
  const unlabelled = { tag: 'button', text: '', ariaLabel: null, title: null, hasSvg: true }
  assert.equal((gate.nameFailures?.([unlabelled]) ?? []).length, 1)
  assert.equal((gate.nameFailures?.([{ ...unlabelled, ariaLabel: 'Close' }]) ?? []).length, 0)
  assert.equal((gate.nameFailures?.([{ ...unlabelled, text: 'Close', hasSvg: false }]) ?? []).length, 0)
})

test('the leftover gate names every raw-template hit it finds', () => {
  assert.equal(typeof gate.leftoverFailures, 'function', 'the matrix needs a raw-template scan; without one a page prints its own source')
  const hits = gate.leftoverFailures?.('<p class="undefined">{infoTip(</p>') ?? []
  assert.equal(hits.length, 2, 'both the undefined class and the unrendered helper have to be reported')
  assert.equal((gate.leftoverFailures?.('<p class="fine">clean</p>') ?? []).length, 0)
  assert.equal((gate.leftoverFailures?.('<p>${name}</p>') ?? []).length, 1)
})

test('the runner drives the gate from the two constants and chooses a scheme per context', () => {
  const gate = visualWorkload().filter((cell) => cell.kind === 'gate')
  assert.equal(
    gate.length,
    GATE_WIDTHS.length * GATE_SCHEMES.length * VISUAL_PATHS.length * VISUAL_LOCALES.length,
    'the gate workload is the gate widths by schemes by every swept path, in both locales',
  )
  for (const path of VISUAL_PATHS) {
    assert.ok(gate.some((cell) => cell.path === path), `every swept path has to go through the gate: ${path}`)
  }
  for (const width of GATE_WIDTHS) {
    for (const scheme of GATE_SCHEMES) {
      assert.ok(
        gate.some((cell) => cell.width === width && cell.scheme === scheme),
        `the gate has to measure ${String(width)} in ${scheme}`,
      )
    }
  }
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  assert.match(
    script,
    /scheme: cell\.kind === 'gate' \? cell\.scheme : undefined/,
    'each gate context has to ask the browser for the scheme it measures',
  )
  assert.match(
    script,
    /await checkGatePage\(page, cell\.locale, cell\.width, cell\.scheme, cell\.path\)/,
    'a gate cell is measured by the gate check, not the screenshot walk',
  )
  assert.match(script, /data-compact-target/, 'the script has to read the documented compact opt-out')
})

test('the runner exercises an explicit theme against a host preference that disagrees', () => {
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  assert.match(script, /fledge_theme/, 'the explicit-theme pass has to set the saved preference cookie')
  assert.match(script, /data-theme/, 'the pass has to read the rendered attribute, not assume it')
  assert.match(script, /colorScheme: 'light'/, 'the host preference has to disagree with the explicit choice for the check to mean anything')
})

test('an inline marker is exempt from the touch floor; a disclosure row is not', () => {
  assert.equal(typeof gate.touchFailures, 'function', 'the matrix needs a touch-target checker')
  assert.equal((gate.touchFailures?.([{ name: 'button.info-tip', width: 15, height: 15, inline: true }]) ?? []).length, 0)
  assert.equal((gate.touchFailures?.([{ name: 'button.info-tip', width: 15, height: 15 }]) ?? []).length, 1)
  // A `summary` is a control in the same list, so the 44px floor applies to it
  // exactly as to a button: a named category never lowers a floor, only the
  // per-element attributes do.
  assert.equal((gate.touchFailures?.([{ name: 'summary', width: 572, height: 24 }]) ?? []).length, 1)
  assert.equal((gate.touchFailures?.([{ name: 'summary', width: 572, height: 44 }]) ?? []).length, 0)
  const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
  assert.ok(
    css.includes('summary { min-height: var(--touch); }'),
    'the disclosure row carries the same --touch floor the gate measures it against, on the element selector so every row moves',
  )
})

test('the inline exemption is an attribute on the marker, not a selector that swallows every small control', () => {
  const pages = readFileSync(new URL('../src/views/pages.ts', import.meta.url), 'utf8')
  assert.match(pages, /class="info-tip" data-inline-target/, 'the info marker has to carry the documented inline opt-out')
  assert.equal((pages.match(/data-inline-target/g) ?? []).length, 1, 'one inline marker, one opt-out; a second one needs its own reason')
})

test('the gate skips a control a closed disclosure keeps out of the rendering', () => {
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  assert.match(script, /checkVisibility/, 'a control inside a closed <details> keeps a non-zero rect in Chromium; the walk has to ask whether it renders')
})

// #1025: the doc quotes one failure message as its example, so the checker has
// to be able to print exactly that one. The classification of the control comes
// from the markup the walk reads — the two documented opt-ins live on the
// element — never from the example sentence.
test('the doc quotes a failure message the checker really emits', () => {
  const doc = readFileSync(new URL('../docs/ui.md', import.meta.url), 'utf8')
  const start = doc.indexOf('Since #870 the job also runs a measured gate')
  const end = doc.indexOf('## Owner search (#362)')
  assert.ok(start >= 0 && end > start, 'the measured-gate section has to exist between the sweep paragraph and the owner-search section')
  // The doc is wrapped prose, so its line breaks are joined before the example
  // is read: the message the checker prints is one line, and the example has to
  // be that line, not a sentence that only reads like one after reflowing.
  const section = doc.slice(start, end).replace(/\s+/g, ' ')
  const quoted = /`(en width=\d+ scheme=(?:light|dark) [^`]+)`/.exec(section)
  assert.ok(quoted !== null, 'the measured-gate section has to quote one real failure message')
  const line = (quoted[1] ?? '').trim()
  const message = line.slice(line.indexOf(': ') + 2)
  const sample = /^(\S+) is (\d+)x(\d+)px, under the (\d+)px (.+)$/.exec(message)
  assert.ok(sample !== null, `the quoted line has to keep the shape the checker prints, not ${JSON.stringify(message)}`)
  const name = sample[1] ?? ''
  const layout = readFileSync(new URL('../src/views/layout.ts', import.meta.url), 'utf8')
  const pages = readFileSync(new URL('../src/views/pages.ts', import.meta.url), 'utf8')
  const compact = layout.includes('data-compact-target') && name.includes('banner-dismiss')
  const inline = pages.includes('data-inline-target') && name.includes('info-tip')
  const failures = gate.touchFailures?.([{ name, width: Number(sample[2]), height: Number(sample[3]), compact, inline }]) ?? []
  assert.deepEqual(failures, [message], 'the quoted example has to be a message this checker emits for that control; an example that passes teaches a reader a sentence no run prints')
})

// #1025: half a pixel of slack passed a 43.5px control against a floor the doc
// calls 44px. The tolerance is browser sub-pixel rounding, nothing more.
test('the touch floor tolerance absorbs rounding and nothing more', () => {
  assert.equal(typeof gate.touchFailures, 'function', 'the matrix needs a touch-target checker')
  assert.equal(
    (gate.touchFailures?.([{ name: 'button.banner-dismiss', width: 23.5, height: 23.5, compact: true }]) ?? []).length,
    1,
    'a compact control at 23.5px is under the 24px floor; half a pixel of slack must not pass it',
  )
  assert.equal(
    (gate.touchFailures?.([{ name: 'summary', width: 572, height: 43.5 }]) ?? []).length,
    1,
    'a 43.5px control is half a pixel under the 44px floor the doc states',
  )
  assert.equal(
    (gate.touchFailures?.([{ name: 'summary', width: 572, height: 43.99 }]) ?? []).length,
    0,
    'a browser rounding a 44px box down to 43.99px is exactly what the tolerance is for',
  )
})

// #1025: the doc said both opt-ins were counted once. The inline count existed;
// the compact one did not, so pin it the same way.
test('the compact exemption is pinned once, like the inline one', () => {
  const layout = readFileSync(new URL('../src/views/layout.ts', import.meta.url), 'utf8')
  assert.match(layout, /class="banner-dismiss" data-dismiss data-compact-target/, 'the banner dismiss has to carry the documented compact opt-out')
  assert.equal((layout.match(/data-compact-target/g) ?? []).length, 1, 'one compact control, one opt-out; a second one needs its own reason')
})

// #1025: coverage honesty is a claim like any other, so the limits the gate does
// not close are asserted instead of trusted to survive the next edit.
test('the doc names each limit the gate does not close', () => {
  const doc = readFileSync(new URL('../docs/ui.md', import.meta.url), 'utf8')
  const start = doc.indexOf('Since #870 the job also runs a measured gate')
  const end = doc.indexOf('## Owner search (#362)')
  const section = doc.slice(start, end)
  for (const [needle, why] of [
    ['`<dialog>`', 'the walk never opens a dialog, so the controls inside one are unmeasured'],
    ['`<details>`', 'a closed disclosure keeps its controls out of the rendering the walk collects'],
    ['outside `.section-nav`', 'the selector omits every other link on the page'],
    ['bounded budget', 'the tab walk stops after a bounded number of presses'],
  ] as const) {
    assert.ok(section.includes(needle), `the measured-gate section has to name the limit: ${why}`)
  }
})
