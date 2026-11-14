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
| Line | `--field-line` | `#5a6680` | input, textarea, select resting boundary (3.40:1 on `--field`) |
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

## Email shell (#468)

Every transactional email is rendered through `emailShell()` in
`src/email/templates.ts`, so job, digest, approval, quota, trial and test mail
share one frame instead of each builder carrying its own markup:

- **One table measure.** The card is a `role="presentation"` table at
  `width:100%;max-width:640px;box-sizing:border-box`, inside a fluid outer table
  with `width="100%"`. Outlook drops `max-width` from a `<div>`, so the 640px
  measure lives on the table; a 360px client narrows it instead of scrolling
  horizontally.
- **Inline styles only.** There is no `<style>` block, `<link>`, `@import`, web
  font or remote image. The head carries the dark-mode pair
  `<meta name="color-scheme" content="light dark">` and
  `<meta name="supported-color-schemes" content="light dark">`; the shell does
  not add a `prefers-color-scheme` media query, because that would need the
  forbidden `<style>` block.
- **One wordmark and footer.** The card opens with the `Fledge` wordmark and
  closes with the FlyBot line plus docs (`https://fledge-docs.hugoxk.online/docs/`)
  and status (`https://hugoxk.online/status/`) links.
- **Text parity.** Every builder returns a `text` part beside the HTML; it keeps
  the same job, repository, PR, issue, score and link facts in a plain readable
  form rather than a stripped summary.
- **Failure stays loud.** The job-failure and digest failure headings keep the
  `#b42318` red banner, and the subject lines keep their `[Fledge] 任务失败` /
  `[失败 N]` marker. The shell never owns the subject, so the marker cannot drift.
- **Escaped values.** Every interpolated user, repository, URL, summary and error
  value passes through `escapeHtml` before it enters the shell; `test/emailShell.test.ts`
  pins the shell contract, the mobile width discipline, text parity, the failure
  banner and that escaping.

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
- The resting field boundary is non-text, so it answers a different rule:
  WCAG 2.2 1.4.11 asks 3:1 for the visual information that identifies a
  control, and a fill is not that information — `--field` is 1.04:1 against
  `--panel` in dark and 1.00:1 in light, so the hairline was the only edge a
  field had. `--field-line` carries it: `#5a6680` in dark (3.40 on `--field`,
  3.28 on `--panel`, 3.12 on `--panel-2`) and `#7c8794` in light (3.65 on
  `--field` and `--panel`, 3.46 on `--panel-2`, 3.37 on `--bg`). `--line`
  stays the surface divider so cards, tables and panels do not move (#596).
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
| Line | `--field-line` | `#5a6680` | `#7c8794` | 3.65:1 on `--field`, 3.46:1 on `--panel-2` |
| Line | `--scroll-track` | `#5b6779` | `#828c9a` | 3.4:1 on `--panel`, 3.3:1 on `--scroll-thumb` |
| Line | `--scroll-thumb` | `#c8d2de` | `#333c48` | 11.2:1 on `--panel` |
| Surface | `--header-bg` | `rgba(7, 9, 13, 0.78)` | `rgba(244, 246, 249, 0.86)` | translucent sticky row; its ink is `--text`/`--muted` at the ratios above |
| Surface | `--chip-bg` | `rgba(255, 255, 255, 0.02)` | `rgba(16, 22, 31, 0.04)` | translucent account pill; its ink is `--muted`/`--muted-2` |
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
- **The reader can choose** (#657). The preference is the `fledge_theme` cookie,
  saved by `GET /theme/system|light|dark` (an unknown mode is a 404 and `next` is
  same-origin only), so the server renders the palette on the first frame — no
  class is added after load and there is no flash. `data-theme` on `<html>` is
  always present: `system` inherits, `light` and `dark` override.
- `system` is announced as **two** `<meta name="theme-color">` tags, one per
  `(prefers-color-scheme: …)` value, plus `color-scheme: light dark`; an explicit
  choice pins one colour and its scheme. A media query cannot read a custom
  property, so the two colours are the palette's `--bg` values in
  `src/views/theme.ts`, and `test/theme.test.ts` keeps them equal to the
  stylesheet's `--bg`.
- The control is three links at the end of `#main-nav`, one per choice, with the
  current one marked `aria-current="true"`. Inside the compact header that
  element is the panel, so the 360px row gains no child and cannot overflow
  (#133); above 960px the links sit in the row, and between 961px and the sheet's
  1180px content width the account's display name steps aside instead of the row
  wrapping. Every choice keeps the 44px touch floor. Signed-out pages honour the
  saved palette but do not show the control, because their header has no panel to
  put it in.

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
- Evidence for this change: at the tree it was cut from, `5d848df8`, and again
  at the merged base `d63753ba`, `test/uiStates.test.ts` runs 14 assertions and
  fails only the three added here — `not ok 12/13/14` (11 pass / 3 fail) —
  because `/search` still wrote the literal `0` in `src/views/pages.ts` (2929 at
  `d63753ba`, 2908 at `5d848df8`) and `.state-icon` still carried the dead font
  declarations in `public/app.css` (743-746 at `d63753ba`, 737-741 before the
  fold); all 14 pass at the tip. The icon group's reds belong to the SVG set in
  `#502`: the 11-assertion file dropped
  onto `6271f9ec`, before that set, is 8 pass / 3 fail (`not ok 8/9/10`), and
  11 pass / 0 fail at `eef9cfa`, where the set landed. The icons have their own
  captures, `docs/images/ui-v2/476-before-*.jpg` and `476-after-*.jpg` at 1280,
  768 and 360, Chinese and English on one page.

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
360/390/430/640/768/1024/1280/1440/1920 in both languages. It fails when the
document leaves the viewport, or when an element does and nothing can scroll it
into view. An element is waived only on evidence: a `.table-scroll` ancestor, or
any ancestor whose computed `overflow-x` is `auto`/`scroll`, counts only while it
really scrolls (`scrollWidth` above `clientWidth` by more than a rounding pixel);
a box that merely carries the class waives nothing, an element that is itself the
overflowing scroller is never waived, and anything else that has to overflow needs
`data-allow-overflow` next to such a scrolling ancestor. It writes full-page
screenshots under `visual-matrix/` (ignored by git).
CI uploads that directory as the `visual-matrix` artifact. The matrix does not
contact GitHub, SMTP or a FlyBot instance.

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
