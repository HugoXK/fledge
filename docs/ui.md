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
| Radius | `--radius-sm` | `8px` | inputs, chips |
| Radius | `--radius-md` | `12px` | cards, inset blocks |
| Radius | `--radius-lg` | `18px` | large cards |
| Radius | `--radius` | `16px` | legacy card radius |
| Motion | `--motion-fast` | `120ms` | hover, colour change |
| Motion | `--motion-base` | `180ms` | layout and opacity change |
| Motion | `--ease` | `cubic-bezier(0.2, 0.7, 0.3, 1)` | standard easing |
| Motion | `--shadow` | `0 24px 80px rgba(0, 0, 0, 0.38)` | raised card shadow |
| Layout | `--touch` | `44px` | minimum height for a tappable control |
| Layout | `--content` | `1180px` | content max width |
| Layout | `--mono` | `ui-monospace, …` | code and numeric columns |

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
- Evidence for the change: `test/uiStates.test.ts` (7 assertions; 6 of them red
  on the base commit with only the renderer added), plus before/after captures
  under `docs/images/ui-v2/69-*.jpg` at 1280 and 360 in both languages.
