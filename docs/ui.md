# UI tokens

The console is server-rendered HTML styled by one stylesheet, `public/app.css`.
This page is the contract for its design tokens: every colour, space, radius,
font size and duration is named in the `:root` block and used through `var()`.
Components, states and responsive rules are documented with the issues that add
them; this page only fixes the names and the values.

## Token table

| Group | Token | Value | Used for |
|---|---|---|---|
| Surface | `--bg` | `#07090d` | page background |
| Surface | `--bg-soft` | `#0a0e14` | alternate page background |
| Surface | `--panel` | `#0d1118` | cards |
| Surface | `--panel-2` | `#111722` | raised panel, lightest surface |
| Surface | `--surface-sunken` | `#090e14` | inset blocks (lists, forms) |
| Surface | `--surface-inset` | `#080d13` | inline code, chips, option rows |
| Surface | `--surface-raised` | `#0b121b` | bubbles, tooltips |
| Surface | `--field` | `#080c12` | input, textarea, select |
| Surface | `--track` | `#060a10` | progress track |
| Surface | `--paper` | `#ffffff` | the white workspace iframe |
| Surface | `--raised-top` | `#101722` | gradient start of a raised card |
| Surface | `--raised-bottom` | `#0a0e15` | gradient end of a raised card |
| Line | `--line` | `#1c232d` | default border and divider |
| Line | `--line-strong` | `#2a3545` | emphasised border |
| Line | `--row-line` | `#18202a` | table row divider |
| Line | `--scroll-track` | `#5b6779` | `.table-scroll` scrollbar track, 641-960px only (3.3:1 on `--panel`) |
| Line | `--scroll-thumb` | `#c8d2de` | `.table-scroll` scrollbar thumb, 641-960px only (3.7:1 on `--scroll-track`) |
| Text | `--text` | `#f2f5f9` | body copy and headings |
| Text | `--muted` | `#98a2b3` | secondary copy |
| Text | `--muted-2` | `#8b96a6` | 10-13px meta text: `.fine`, `<small>`, `.count`, `.foot`, table headers |
| Text | `--lede-ink` | `#b9c6d4` | landing page lede |
| Text | `--tip-ink` | `#dbe6f3` | tooltip body |
| Accent | `--accent` | `#7b95ff` | links, focus ring, selected state |
| Accent | `--accent-strong` | `#4c66f5` | primary button fill |
| Accent | `--accent-hover` | `#5f78ff` | primary button hover |
| Accent | `--accent-ink` | `#ffffff` | text on the primary fill |
| Accent | `--brand` | `#b8f34a` | brand mark, highlight |
| Accent | `--brand-2` | `#6ee7a8` | brand mark gradient end |
| Accent | `--good` | `#67e8c7` | success |
| Accent | `--warn` | `#f0c674` | warning |
| Accent | `--danger` | `#ff8a8a` | error |
| Accent | `--mint` | `#67e8c7` | feature accent |
| Accent | `--blue` | `#7b95ff` | feature accent |
| Accent | `--violet` | `#b69cff` | feature accent |
| Accent | `--mark-ink` | `#07101f` | letter inside the brand mark |
| Accent | `--badge-bg` | `#1a222b` | neutral badge fill |
| Accent | `--badge-ink` | `#aab7c4` | neutral badge text |
| Spacing | `--space-1` | `4px` | tightest gap |
| Spacing | `--space-2` | `8px` | inline gap, chip padding |
| Spacing | `--space-3` | `12px` | list row gap |
| Spacing | `--space-4` | `16px` | card padding |
| Spacing | `--space-5` | `24px` | section gap |
| Spacing | `--space-6` | `32px` | block gap |
| Spacing | `--space-7` | `48px` | page section |
| Spacing | `--space-8` | `64px` | hero spacing |
| Type | `--text-xs` | `11px` | eyebrow, table header, badge |
| Type | `--text-sm` | `12.5px` | `.fine`, meta lines |
| Type | `--text-md` | `14px` | table cell, list item |
| Type | `--text-lg` | `16px` | card heading |
| Type | `--text-xl` | `19px` | section heading |
| Type | `--text-2xl` | `32px` | page heading |
| Radius | `--radius-xs` | `6px` | small chips and inline code |
| Radius | `--radius-sm` | `8px` | controls, inputs and small panels |
| Radius | `--radius-md` | `12px` | rows, inputs and inset blocks |
| Radius | `--radius-lg` | `18px` | feature and hero panels |
| Radius | `--radius` | `16px` | the card shell |
| Radius | `--radius-pill` | `999px` | badges, pills and the meter |
| Motion | `--motion-fast` | `120ms` | hover, colour change |
| Motion | `--motion-base` | `180ms` | layout and opacity change |
| Motion | `--ease` | `cubic-bezier(0.2, 0.7, 0.3, 1)` | standard easing |
| Motion | `--shadow` | `0 24px 80px rgba(0, 0, 0, 0.38)` | raised card shadow |
| Layout | `--touch` | `44px` | minimum height for a tappable control |
| Layout | `--content` | `1180px` | content max width |
| Layout | `--mono` | `ui-monospace, …` | code and numeric columns |
| Layout | `--page-pad` | `clamp(16px, 4vw, 32px)` | page and header horizontal padding |
| Layout | `--section-gap` | `clamp(24px, 4vw, 48px)` | page and section rhythm |
| Layout | `--card-pad` | `clamp(18px, 2.4vw, 28px)` | card padding |

## Naming rules (命名规则)

- `--<group>-<step>` for a scale (`--space-3`, `--text-lg`, `--radius-md`) and
  `--<role>` for a single value (`--bg`, `--accent`, `--touch`).
- A token names a role, never a colour or a size: `--danger`, not `--red-2`;
  `--space-4`, not `--margin-16`.
- Steps increase with size and stay monotonic, so a component can move one step
  without inventing a value.
- A colour that only exists to give a tint to a surface is a surface token
  (`--surface-*`), not a `rgba()` literal repeated in a rule.
- No new token without a row in this table. Test `test/uiTokens.test.ts` fails
  when a token exists in `:root` and this page does not name it.

## Chinese typography (中文排版)

The console renders both locales from one stylesheet, so a heading rule tuned for
Latin is used for Chinese too. Latin heading tracking is negative — `h1` at
`-0.02em`, `.brand` at `-0.03em`, `.workspace-user h1` and `.stat strong` at
`-0.045em` — which tightens a Latin word and sets a Chinese heading as a solid
block, because a Chinese glyph is square and already carries its own side
bearing. The base stack is Latin-first, so a Chinese run inside an English
sentence falls through two Latin faces before it reaches a CJK one and is set in
two faces on one line.

`public/app.css` keys a `:lang(zh)` block off `<html lang="zh-CN">`, which
`src/views/layout.ts` already renders. The rules:

- Every heading rule that carries negative tracking has a `:lang(zh)`
  counterpart whose `letter-spacing` is `0`; the Latin rules keep theirs.
- `h1`, `.hero-copy h1` and `.stat strong` get a taller Chinese `line-height`
  (`1.18`, `1.14`, `1.15`). A Chinese rule never declares a different
  `font-size`, so the locale changes the texture, never the scale.
- `html:lang(zh) body` sets a CJK-first `font-family` and nothing else: the base
  rule at `:215` is the `font` shorthand, so re-declaring `font` there would
  reset the size and the line-height this block exists to protect.
- Nothing is downloaded: the stack names faces the platform already has, so the
  CSP and the request count are unchanged.

`test/chineseTypography.test.ts` computes those relationships from
`test/cssRules.ts`'s `parseRules` — coverage, scale equality, line-height, the
stack — and pins the precondition that a Chinese render declares
`<html lang="zh-CN"`, without which no `:lang(zh)` rule can match. The 360/768
overflow half belongs to the visual matrix (`## Visual matrix (多设备视觉矩阵)`),
not to a second harness.

## Surfaces, radii and accents (#229)

The templates carry no layout of their own. `src/views/pages.ts` used to hold 25
inline `style="` attributes — 13 of them `flex:1`, the rest four different
spacing values, one 90px width and one right alignment — which is how the same
card ended up with a 10px corner in one view and a 12px corner in another. Three
rules replace them:

- **One spacing vocabulary.** A view asks for `.grow`, `.mt-12`, `.mt-14`,
  `.mt-16`, `.mt-24`, `.mb-6`, `.mb-12`, `.more-note`, `.text-right` or `.w-90`,
  declared once in `public/app.css`. A view that needs a fifth offset adds it
  there, not in an attribute. The only inline style left in a view is the quota
  meter's fill width, which is data (`used / initial`), not layout.
- **One radius scale.** Every `border-radius` in the stylesheet is one of the six
  Radius rows above; raw pixel corners are gone. `50%` stays legal for a circle.
- **One interactive accent.** `--accent`, `--accent-strong`, `--accent-hover` and
  `--accent-ink` are the only colours an interactive control may use — buttons,
  links, the current nav item, focus rings, selected chips, pills and badges.
  `--brand`, `--brand-2` and `--mint` are decoration only: the wordmark gradient
  and the meter's fill. A coloured panel never stands for something clickable.
- **One calm surface.** Cards use `--panel` and a 1px border; the page uses one
  background. Gradients are reserved for the wordmark and the meter, not for
  every card, so the content, not the chrome, carries the hierarchy.

`test/uiSurfaces.test.ts` pins all three, including the count (`pages.ts` may
carry exactly one `style="`).

## Contrast (对比度)

Text must reach WCAG 2.1 AA — 4.5:1 — on every surface it can be painted on,
because most of the console's meta text is 10-13px. `test/uiTokens.test.ts`
computes the ratios from `:root` instead of trusting the palette:

- `--muted-2` was `#6f7a8a`: 4.58 on `--bg`, 4.45 on `--bg-soft`, 4.35 on
  `--panel` and **4.13 on `--panel-2`** — below AA on the surface it most often
  lands on. It is now `#8b96a6`: 6.65 / 6.46 / 6.31 / 5.99, measured against
  `--bg`, `--bg-soft`, `--panel` and `--panel-2` in that order, so the next
  reader can re-derive each ratio from the token; it is still dimmer than
  `--muted` (`#98a2b3`, 6.97–7.74 on the same surfaces), so the hierarchy is
  unchanged.
- `--accent-ink` on `--accent-strong` is 4.64:1 — the primary button passes
  without changing the brand fill.
- A new text colour is added together with a row in the test's contrast list, so
  the ratio is checked in CI rather than in a browser.

## Light theme (浅色主题)

The console ships two palettes over one token set. A component asks for
`var(--panel)` and `var(--text)`; it never tests the scheme, and no view gained a
branch for it (#467). The token table above lists the dark palette, which is the
default; the light palette redefines the same colour names:

| Group | Token | Dark | Light | Light ratio |
|---|---|---|---|---|
| Surface | `--bg` | `#07090d` | `#f4f6f9` | `--text` 16.8:1 |
| Surface | `--bg-soft` | `#0a0e14` | `#eef1f6` | `--muted-2` 5.2:1 |
| Surface | `--panel` | `#0d1118` | `#ffffff` | `--muted-2` 6.1:1 |
| Surface | `--panel-2` | `#111722` | `#f7f9fc` | `--muted-2` 5.8:1 |
| Surface | `--surface-inset` | `#080d13` | `#e9edf3` | `--text` 14.6:1 |
| Surface | `--field` | `#080c12` | `#ffffff` | `--text` 17.4:1 |
| Line | `--line` | `#1c232d` | `#dbe1e9` | 1px divider, non-text |
| Line | `--scroll-track` | `#5b6779` | `#828c9a` | 3.4:1 on `--panel`, 3.3:1 on `--scroll-thumb` |
| Line | `--scroll-thumb` | `#c8d2de` | `#333c48` | 11.2:1 on `--panel` |
| Text | `--text` | `#f2f5f9` | `#10161f` | 16.8:1 on `--bg` |
| Text | `--muted` | `#98a2b3` | `#47515f` | 8.1:1 on `--panel` |
| Text | `--muted-2` | `#8b96a6` | `#59636f` | 6.1:1 on `--panel`, 5.8:1 on `--panel-2` |
| Accent | `--accent` | `#7b95ff` | `#2b4fd0` | 6.7:1 on `--panel` |
| Accent | `--accent-ink` | `#ffffff` | `#ffffff` | 8.8:1 on `--accent-strong` |
| Accent | `--brand` | `#b8f34a` | `#3f7a12` | 5.2:1 on `--panel` |
| Accent | `--good` / `--mint` | `#67e8c7` | `#0a6e55` | 6.2:1 on `--panel` |
| Accent | `--warn` | `#f0c674` | `#7a5200` | 6.9:1 on `--panel` |
| Accent | `--danger` | `#ff8a8a` | `#b3261e` | 6.5:1 on `--panel` |
| Accent | `--badge-ink` on `--badge-bg` | `#aab7c4` / `#1a222b` | `#414d5c` / `#e7ecf3` | 7.3:1 |

How it is selected:

- The system preference works with JavaScript off:
  `@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { … } }`.
  The dark palette is plain `:root`, so the stylesheet paints the right theme on
  the first frame — no class is added after load and there is no flash.
- An explicit choice wins over the system: `:root[data-theme="light"]` and
  `:root[data-theme="dark"]` re-declare the colours and pin `color-scheme`.
  `:root` carries `color-scheme: light dark`, so form controls, scrollbars and
  the selection colour follow the palette instead of the operating system.
  `::selection` uses `var(--text)`, which is dark ink on the pale tint in the
  light palette.
- `--paper` and `--accent-ink` stay `#ffffff` in both palettes by contract: they
  paint the white iframe and the primary button's fill.
- The light declarations appear twice (media query and attribute selector)
  because the two cannot share a declaration block; both are kept in step by
  `test/lightTheme.test.ts`, which reads each block out of the stylesheet,
  rejects a missing or extra colour token, and recomputes every ratio above with
  the same WCAG formula as `test/uiTokens.test.ts`.
- `--shadow` softens to `rgba(15, 23, 42, 0.14)`; it is a shadow, not text, so it
  carries no contrast requirement.

## Console states (控制台状态)

Every list, panel and stream in the console renders through `renderState` in
`src/views/states.ts`, so the five states cannot drift apart again. The markup
and the accessibility contract are fixed:

| State | Marker | Role | What it must carry |
|---|---|---|---|
| loading | `aria-busy="true"` | `status` | skeleton lines, never a spinner with no text |
| empty | `data-state="empty"` | `status` | a sentence and the next step as a link |
| error | `data-state="error"` | `alert` | the reason and a `Try again` action |
| success | `data-state="success"` | `status` | the result and where to go next |
| disabled | `aria-disabled="true"` | `data-state="disabled"` | the reason, and no working control |

- The icon is one inline `<svg>` per state from a literal map in
  `src/views/states.ts`: all five share one `viewBox`, `stroke="currentColor"`
  follows the state's own colour rule, and `aria-hidden="true"` plus
  `focusable="false"` keep the `<strong>` title the only announcement. The size
  comes from `.state-icon svg` in the stylesheet, never from an attribute, and no
  icon package, remote asset or CSP entry is involved.
- `stateCell(colspan, …)` is the table form; a table that still renders a bare
  `<td colspan class="muted">` is a leftover, not a style choice.
- The empty state's action comes from the page that renders it: a repository
  page offers that repository's own `Run now`, the dashboard offers
  `Add repository`, Settings offers `Add provider`. No page inherits another
  page's empty action, and a region blocked by config names the blocker instead
  of sending the user somewhere else.
- A control that cannot act uses `aria-disabled="true"` and the shared inert
  style, so a disabled link looks inert like a disabled button.
- The three live streams (notifications, questions, chief) announce
  `connecting`, `lost` and `recovered` in an `aria-live="polite"` status node
  (`[data-inbox-status]`, `[data-chief-status]`), instead of stopping silently.
- Evidence for this change: at its base `eef9cfa7`, `test/uiStates.test.ts` fails
  the icon group as `not ok 8/9/10` (8 pass / 3 fail) until the SVG map replaces
  the glyphs, and every assertion passes at the tip. The icons have their own
  captures, `docs/images/ui-v2/476-before-*.jpg` and `476-after-*.jpg` at 1280,
  768 and 360, Chinese and English on one page. The older `#453` table-overflow
  counts belong to the table work above and are not repeated here.

## Review trend numbers (审核趋势)

The repository's **Delivery** section renders one card, `#review-trend`, with two
fixed windows — 7 and 30 days — over the reviews this repository already
recorded. No new table, job or model call is involved: the read model
(`Store.reviewTrend`) reads `jobs`, `work_items` and the audit row the job
service writes when a review finishes, because a work item's *current* state
moves on with the next fix and is not a review outcome.

| Cell | Meaning | When it is `—` |
|---|---|---|
| Reviews | completed review jobs with a score, terminated inside the window | no such review |
| Average score | mean of those scores, one decimal | no scored review |
| Changes requested | `changes_requested outcomes / outcomes recorded`, `x% (a/b)` | no outcome recorded in the window |
| PR→review | median `review finished_at − work item created_at` for reviews linked to a PR | no linked PR review |
| PR→merge | median `merged_at − created_at` for work items merged in the window | no merge |
| Model | the model each review ran, `label ×n` | no recorded model |

Rules the card follows, because a reader cannot tell a confident zero from an
unknown one:

- A window with no sample shows `—` in every cell and adds a
  `data-trend-empty="<window>"` sentence. It never shows `0`, `0%` or `NaN`.
- A rate is `—` when no outcome was recorded, and it always prints its own
  denominator, so `50% (1/2)` cannot be misread as a percentage of all reviews.
- Fewer than 5 completed reviews in the window renders the number **and** a
  `data-trend-small-sample="1"` badge (`Small sample n=<n>`); the page never
  smooths a single review into a trend, and never hides it either.
- Every cell is scoped to one repository and its owner: another user's
  repository, or another repository of the same owner, is not counted.

## Visual matrix (多设备视觉矩阵)

`npm run visual:matrix` boots a throwaway app on `127.0.0.1:18180` with the
development login, a temporary SQLite database and the mock runner. It captures
the landing page first, in a signed-out context, because `/` answers 302 to
`/dashboard` for a visitor with a session: capturing it after the development
login photographed the dashboard twice. It then signs in and renders the
dashboard, settings, admin, add-repository and workspace surfaces at
360/390/430/640/768/1024/1280/1440/1920 in both languages, fails when the
document or an element leaves the viewport, and writes full-page screenshots
under `visual-matrix/` (ignored by git). CI uploads that directory as the
`visual-matrix` artifact. The matrix does not contact GitHub, SMTP or a FlyBot
instance.

On `/settings` it also checks the `#tokens` anchor — the target the zero-token
empty state links to. A page without that element is a failure
(`the page has no #tokens anchor to scroll to`), not a skipped measurement, and
a section that starts under the sticky header fails separately. `test/pages.test.ts`
pins the same rule for every in-page link the page renders.

## Owner search (#362)
`/search` searches only the signed-in owner's rows — repositories, jobs, work items
and audit — 20 per section with the cap stated. The route validates every filter and
the query is anchored on the user id, so it cannot return another user's row, an
email or a token column, and `%`/`_` match as text. A repository filter narrows the
three sections that own one; audit rows carry none, so that section says so. Rows
link to the existing pages; an empty result uses the shared empty state.

## Table header and density (#473)
A table taller than the window keeps its column names. Above 641px `.table-scroll`
is a bounded scrollport — `overflow-y: auto` with
`max-height: calc(100dvh - var(--header-h) - var(--space-7))`, and the same bound
minus `var(--subnav-h)` on a repository page — and every `thead th` inside it is
`position: sticky; top: 0` on `--panel`, so rows scroll under an opaque header
instead of replacing it. The pair is one contract: a sticky header in an
unbounded scroller does nothing, and a bound that ignores the subnav parks the
header under it; `test/density.test.ts` asserts both.

Density is a saved preference, not a client-side class flip: `/density/compact`
and `/density/comfortable` set the `fledge_density` cookie and redirect through
`safeLocalPath`, an unknown mode is a 404, and `<html data-density>` carries the
value (comfortable when nothing is saved). Compact trims only the cell padding —
a control inside a cell keeps its box. Below 641px the tables are the card stack
(#130), the `thead` is hidden and the 44px touch floor is untouched, so neither
the bound nor the density rules apply in that band.
