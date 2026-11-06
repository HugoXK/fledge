# UI foundation

The console is server-rendered HTML plus one stylesheet (`public/app.css`) and a
few small scripts. There is no front-end framework and no build step for the UI.
This page is the inventory: use a component that is listed here, and add a row
when you add a component, so the next change reuses it instead of inventing a
third variant.

## Design tokens

All colour, spacing, radius, type and motion values live in the `:root` block of
`public/app.css`. A literal colour outside that block fails
`test/uiTokens.test.ts`; so does an inline `style="…"` in a template, except a
custom property (`style="--meter: 42%"`) that carries a server-computed value.

| Group | Tokens | Notes |
|---|---|---|
| Surface | `--bg`, `--bg-soft`, `--panel`, `--panel-2`, `--surface-sunken`, `--surface-inset`, `--surface-raised`, `--field`, `--track`, `--paper` | `--panel-2` is the lightest surface; text must clear 4.5:1 on it. |
| Line | `--line`, `--line-strong`, `--row-line` | |
| Text | `--text`, `--muted`, `--muted-2`, `--lede-ink`, `--tip-ink` | `--muted-2` carries `.fine`, `<small>`, `.count`, `.foot` and table headers. |
| Accent | `--accent`, `--accent-strong`, `--accent-hover`, `--accent-ink`, `--brand`, `--brand-2`, `--good`, `--warn`, `--danger`, `--mint`, `--blue`, `--violet` | |
| Spacing | `--space-1` … `--space-8` (4, 8, 12, 16, 24, 32, 48, 64px) | One 4px scale; use the shell helpers `.mt-*`/`.mb-*` for one-off margins. |
| Type | `--text-xs` … `--text-2xl` | Size only; weight and line-height stay with the component. |
| Radius | `--radius-sm` (8), `--radius-md` (12), `--radius-lg` (18) | `--radius` stays for older cards. |
| Motion | `--motion-fast` (120ms), `--motion-base` (180ms), `--ease` | Every animation is disabled by `prefers-reduced-motion`. |
| Interaction | `--touch` (44px) | Minimum height for anything a thumb taps. |
| Layout | `--content` (1180px), `--shadow`, `--mono` | |

## Component inventory

| Component | Class | Used on |
|---|---|---|
| App shell | `.top`, `.top-inner`, `.brand`, `.mark`, `.nav`, `.account`, `.lang`, `.wrap`, `.foot` | every page |
| Skip link | `.skip-link` | every page, first tab stop |
| Card | `.card`, `.card.narrow`, `.cols`, `.grid3` | every page |
| Button | `.btn`, `.btn-small`, `.btn-ghost`, `.btn-danger`, `.link` | forms and row actions |
| Badge / pill | `.badge` (+ `.good` `.bad` `.busy` `.kind`), `.pill` (+ `.pill-warn` `.pill-danger`) | tables, headers |
| Table | `.table-scroll` + `table` (+ `.job-table`), cells carry `data-label` | dashboard, repo, job, admin |
| List | `.list`, `.list-row`, `.list-main`, `.list-title` | job lists, evidence |
| Form | `.form`, `.row`, `.check`, `.grow`, `.field-xs`, `input`, `select`, `textarea` | settings, dashboard, repo |
| Banner | `.banner` (+ `.ok` `.bad`), `.preview-banner` | layout notice/error |
| Meter | `.meter` + `span[style="--meter: …"]` | quota card |
| Tooltip | `.info-tip[data-tip]` | long hints; opens on hover or focus, `display:none` while closed so it cannot widen the page |
| Pager | `.pager`, `.pager-info` | list pages |
| Skeleton | `.skeleton` (+ `.wide`) | loading state |
| Busy button | `.btn.is-busy` + `aria-busy="true"` | any submit; the label comes from `data-pending-label` |

## States

Every page that can fail has one of five states. They share one shape —
`.state` plus a modifier — with an icon, a heading, a sentence and the next
action. A state without a next action is a dead end and is not accepted.

| State | Class | Use |
|---|---|---|
| Loading | `.state.loading`, `.skeleton`, `aria-busy="true"` | a queued/running job, a poll or SSE fetch in flight |
| Empty | `.state.empty` | no repositories, no jobs, no open questions |
| Error | `.state.error`, `.banner.bad` | bridge down, 401 re-authorize, 402 quota |
| Success | `.state.success`, `.banner.ok` | notice after a write, PR ready |
| Disabled | `.state.disabled`, `:disabled`, `.btn:disabled` | plan not approved, quota at zero, not a maintainer |

Streaming areas announce themselves: `#inbox` and `#team-questions` are
`aria-live="polite"`, and `#team-live` toggles `aria-busy` while `public/team.js`
polls or fetches.

## Responsive tiers

| Width | Layout |
|---|---|
| ≥1280 | Two/three column cards, full table, nav on one row |
| 768–1279 | One column; nav moves under the brand and scrolls horizontally by itself |
| ≤767 | Same as above plus stacked forms; the page action (`.workspace-actions`) sticks to the bottom of the viewport at ≥44px tall |
| ≤640 | Cards replace table rows (`thead` hidden, each `td` labelled by `data-label`); buttons and inputs stretch to the column; `.wrap` reserves bottom padding for the sticky action |

The acceptance bar is `document.documentElement.scrollWidth === innerWidth` at
360, 768 and 1280 on `/`, `/dashboard`, `/repos/:id` and `/repos/:id/jobs/:id`.

## Accessibility

- Contrast: every text token pair in `test/uiTokens.test.ts` is computed, not
  eyeballed; AA needs 4.5:1 and `--muted-2` is sized for small text.
- Focus: `:focus-visible` draws a 2px accent outline; the skip link is the first
  tab stop; the active nav link carries `aria-current="page"` as well as colour.
- Keyboard: the dashboard path is skip link → brand → nav → language → account →
  primary action, all reachable and all with a visible ring.
- Motion: `prefers-reduced-motion: reduce` removes transitions and animations.
- Language: every string goes through `t('中文', 'English')`, and the language
  switch keeps the current path.

## Screenshots

`scripts/ui-screenshot.mjs` drives a local Chromium over the DevTools protocol
(no extra npm dependency) and writes one PNG per page and width, printing
`scrollWidth`/`innerWidth` for each:

```sh
npm run dev
node scripts/ui-screenshot.mjs --out docs/images/ui --pages /,/dashboard --widths 1280,768,360
```

Add `--jpeg --quality 78` when the shots go into a pull request: a full-page PNG
of the dashboard is about 350KB, the JPEG about 40KB.

Pass `--login /auth/dev` to reach pages behind the development login. Visual
regression in CI (Playwright + axe) is tracked separately; this script is the
manual before/after evidence for a UI pull request.
