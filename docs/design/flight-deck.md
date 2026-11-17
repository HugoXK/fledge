# Flight deck — a designer-led console direction

Status: proposed for review, 2026-11-16
Scope: `public/app.css`, `src/views/theme.ts`, `src/views/pages.ts`,
`src/views/layout.ts`, `docs/ui.md`. Settings information architecture and the
repo/job page hierarchy are follow-up slices.

## The brief

Fledge is a self-hosted flight deck for repositories that grow themselves. The
owner connects a repository, states a goal, and a FlyBot team returns one focused
pull request. The owner reads the diff, tests, CI and cost, then merges. The
product's job is to answer **what needs me now** and keep the rest of the loop
calm and auditable.

The current console does not look designed. It reads as a generic dark SaaS
template with warm-cream accents: identical rounded cards, a serif display face
over warm charcoal, copper links, uppercase eyebrows, pill badges and one more
card for everything. This document records the review against the two skills
vendored in `.agents/skills/`, and the direction the next slice implements.

## What the skills say

`frontend-design` (Apache-2.0, `anthropics/skills`) names the tells the current
page has: warm cream + high-contrast serif + terracotta; the same rounded card
and soft shadow for every level; uppercase labels; a single strong accent repeated
on every card; decorative motion on every hover. It asks for a direction grounded
in the subject, one memorable element, restrained decoration and a review of the
plan against the generic default before building.

`web-interface-guidelines` (MIT, `vercel-labs/web-interface-guidelines`) adds the
quality floor: keyboard and focus, 44px touch targets, 16px mobile inputs, inline
errors, URL state, confirmation for destructive actions, `aria-live`, reduced
motion, no horizontal overflow, inline help first and labels for icons.

## Direction: flight deck / field log

The subject is flight and field work: a small team leaves the nest, follows a
route, returns with one result, and the owner logs the decision. The interface is
an instrument panel and a logbook, not a marketing dashboard.

- **One memorable element: the loop rail.** Connect → Goal → Work → Review →
  Merge, with the current leg marked. It is the only place that uses a strong
  filled dot and the accent glow. It is functional, not decoration.
- **Surfaces are sections, not cards.** A section is a flat band separated by a
  hairline. Only the current action and dialogs get a bordered panel. This is the
  opposite of the identical-card kit.
- **One accent, used for action.** Deep pine in light, sage in dark; brass is
  decorative and never colours a control. Status is a text label plus a small
  square, never colour alone.
- **Type carries the character.** The serif display stays for the wordmark, the
  page masthead and large numbers. Body copy is the system sans at 14px/1.55;
  data is tabular. Labels are sentence case, not all caps.
- **Logs are logs.** Recent runs read as a compact log: time, role, outcome, PR.
  Not a card grid.

## Palette

Cool mineral paper and pine, with brass as the only warm note. It is deliberately
not warm cream, not periwinkle/lime, and not "near-black + acid green".

| Role | Dark | Light |
|---|---|---|
| page | `#0b100e` | `#eef1ea` |
| panel | `#101814` | `#f8faf5` |
| text | `#e9efe9` | `#18201b` |
| interactive accent | `#8fbfa8` (sage) | `#2f6b57` (pine) |
| primary fill | `#2f6b57` (pine) | `#255746` |
| decorative brand | `#c49a5a` (brass) | `#8a5d26` |
| good / warn / danger | `#8fbfa8` / `#d6a75b` / `#e08a7e` | `#2f6b57` / `#8a5d26` / `#a83e36` |

The token names do not change, so the views keep working. The exact ratios live in
`docs/ui.md`; `test/uiTokens.test.ts`, `test/lightTheme.test.ts` and
`test/theme.test.ts` are the checks.

## Type, shape and motion

- `--display` (serif) for the wordmark, `h1`, the landing hero and large numbers.
- system sans for body and UI; `--mono` for code and tabular data.
- radius 4 / 6 / 8 / 10 / 10 / 999; cards are square, controls and the action
  panel take the small steps.
- one soft shadow, only for menus, popovers and dialogs. A section keeps a 1px
  line.
- one page-load reveal, no per-card hover lift; `prefers-reduced-motion` respected.

## What the first slice changes

1. Replace the warm palette with the flight-deck palette in both schemes and
   update `THEME_COLORS` and `docs/ui.md`.
2. Make `.card` a flat section with a top hairline; add `.action-card` for the one
   current action; keep panels for dialogs, the inbox and the landing token form.
3. Replace the uppercase/mono eyebrow with a sentence-case label and a short rule.
4. Square the primary/ghost buttons and badges; remove the hover lift.
5. Replace the dashboard's generic hero with a masthead and the loop rail.
6. Keep the Vercel quality floor: focus rings, 44px targets, 16px mobile inputs,
   `overscroll-behavior: contain` in dialogs and reduced motion.

## Follow-ups

- Settings: left rail/tabs, About out of Settings, feedback history separate
  (#547 / #860).
- Repo and job pages: one primary action, evidence behind disclosures (#865 /
  #264).
- Icons: one inline SVG set (#867); copy and tooltip density (#871).
- Visual/a11y matrix at 360/768/1280 in both schemes (#870).

## Sources

- `frontend-design`, Apache-2.0, https://github.com/anthropics/skills
- `web-interface-guidelines`, MIT, https://github.com/vercel-labs/web-interface-guidelines
