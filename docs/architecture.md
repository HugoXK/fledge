# Architecture

## Principles

0. **Approval is scoped.** A Fledge approval grants Fledge only. The console is
   a focused workspace; it never issues permissions or sessions for other
   products, and the shared Portal is only a footer link.

1. **A human merges.** Fledge opens one focused pull request per job. It never
   pushes the default branch, force-pushes, or merges.
2. **The platform is not a code runner.** It orchestrates a FlyBot agent; the
   agent works in its own workspace. Fledge never executes a user repository.
3. **Least privilege.** A user supplies a fine-grained GitHub token per
   repository. A job gets a scoped credential URL and a job-scoped model token,
   both revocable and expiring.
4. **Meter what is spent.** Platform-funded model calls pass through a gateway
   that records real cost per user and per job.
5. **Every state change is auditable.** Approval, repo changes, job transitions,
   token creation/revocation and quota edits write to `audit_log`.
6. **One version source.** `/healthz` and the release tooling read `package.json`
   through `src/version.ts`; a release bumps that file and `CHANGELOG.md`
   together.

## UI

The console is server-rendered from `src/views/` and styled by `public/app.css`;
its design tokens are documented in [docs/ui.md](ui.md), and the visual direction is recorded in [design/flight-deck.md](design/flight-deck.md). One colour pair leaves
the stylesheet: `src/views/theme.ts` renders the `theme-color` meta tags, so its
`THEME_COLORS` are the palette's two `--bg` values and `test/theme.test.ts`
fails when they drift from `public/app.css`.

The console serves two surfaces with different jobs (#235). `/dashboard` is the
owner's home: one next action, the first-run checklist, cost and status.
`/console` is the operator workspace: every repository, the job queue, quota and
the inbox. Both URLs are kept, neither is re-gated, and the boundary is recorded
in [0020](decisions/0020-owner-and-operator-surfaces.md). On the repository page
the settings card keeps the loop controls inline — goal, target branch, role,
auto-iterate, enabled, discovery interval, reviewer, auto-merge, plan-first — and
puts the operator policy in one closed
`<details data-advanced="repo-settings">` inside the same form: allowed and
forbidden paths, merge method, team stage gate, branch protection, the monthly
and per-job budgets with spend, the available models and providers, and the
per-bot model assignment. `<details>` still submits its inputs, so
`POST /repos/:id/settings` and every authorization check behind it are unchanged;
the per-bot model restart stays its own form and therefore outside the settings
form.

Page messages are not per-page markup. `notificationStack` in
`src/views/layout.ts` renders every `notice`/`error` a route hands the layout as
one `section.banner-stack` with a single `aria-live="polite"` region inside it,
ordered by severity where the message is built — `banner bad` first, then the
`warn` variant, then `banner ok`/plain `banner` — and de-duplicated by key, so
one event that reaches the page on two paths prints once. A page that used to
render its own ad-hoc banner hands its messages to the layout as
`notifications` instead, so a page cannot classify the same event a second time
outside the region; an entry may carry already-escaped `html` when it needs a
list or a button the plain-text builder cannot express. A message that belongs
to a form or a control — the release card, the settings provider/email/token
forms, the schedule cron error, the danger card's stale-confirmation step —
keeps its place next to that form. Each message carries
its own `data-dismiss` control, and `public/app.js` hides that node (`hidden`)
without deleting it or touching any other message, so an announcement is not cut
off mid-read and a reload starts from the server's answer again. The inbox
(`inboxSection`) stays a separate card with its own region and is never folded
into the stack. `test/notificationStack.test.ts` pins the order, the single
region, the dismiss behaviour and the inbox's separation.

Delivery is one-shot as well. A redirect does not carry the sentence in the
address bar: `readRedirectMessage` in `src/lib/flash.ts` moves a local
`notice`/`error` into a `fledge_flash` cookie, strips it (with a refusal `code`)
from the `Location`, and the first HTML response consumes and clears the cookie.
The cookie keeps the message's key beside its text, so a refusal carries its code
as the event id; the message is read in `onRequest` and never from the query, so
a hand-typed `notice`/`error` parameter has no renderer left to reach. The
redirect interceptor is one `onSend` seam rather than a change at every redirect
site. The cookie keeps a second, separate slot for a release outcome
(`refused`, `tagged`, `retagged`, `checked`), so the repository page renders
that sentence inside its release card once and a reload no longer repeats it;
those parameters are read only on `release=1`, because the same names are plain
form errors on other pages. `test/flash.test.ts` pins the cookie shape, its caps and the local-only
rewrite; `test/oneShotNotice.test.ts` pins redirect → cookie → first page →
reload.

A refusal that belongs to one field goes one step further (#471). The redirect
carries the field key beside the sentence — `?error=…&field=interval` — and
`readRedirectMessage` strips the sentence into the flash while leaving `field` in
the `Location`, because the key is not a message. The page reads it only while an
error is in flight, so a hand-typed `?field=` marks nothing, and
`repoPage` renders the detail with `fieldErrorHtml`/`fieldErrorAttrs` in
`src/views/pages.ts`: the message sits under its control, the control carries
`aria-invalid="true"` and an `aria-describedby` that names the message element,
and the first invalid control the form does not disable takes `autofocus` plus a
`data-field-error-focus` hook that `public/app.js` focuses on `load` — a disabled
control cannot take focus, so it is marked but never claimed as the landing. The
banner keeps only the summary, so the sentence a reader hears once is not
repeated.
Server validation stays authoritative: the refusal is reachable only by a
crafted POST, and a stored cadence the form still carries is accepted so a legacy
row does not become unsavable. `test/inlineValidation.test.ts` pins the refusal,
the marking, the single sentence and the legacy-row path.

Every list, panel and live stream renders its non-data states through
`renderState`/`stateCell` in `src/views/states.ts` — loading, empty, error,
success and disabled — so the aria contract (`status`, `alert`, `aria-busy`,
`aria-disabled`) is decided once instead of per page. The stream status lines
(`[data-inbox-status]`, `[data-chief-status]`) are `aria-live="polite"` regions:
a dropped stream reports `lost` and `recovered` instead of going quiet. Each
state's icon is an inline `<svg>` from a literal map in the same file, on one
`viewBox`, `aria-hidden` and inheriting `currentColor`, so the five states share
a geometry instead of five font glyphs. The state contract and its evidence are
in [docs/ui.md](ui.md). No page composes a state by hand: `/search` used to, and
its own empty state carried a text `0` where the icon belongs, so
`test/uiStates.test.ts` renders that page's two empty branches and asserts the
shared `<svg>` in the slot with no bare glyph beside it.

The console renders UTC and says so: every timestamp goes through
`humanTimeShort` in `src/lib/time.ts`, which prints the UTC wall clock with an
explicit `UTC` suffix. The digest is scheduled in `DIGEST_TIMEZONE` and
`/settings` names that zone, so an unlabelled timestamp beside it would read as
a second clock that disagrees.

`/settings` and `/admin` carry a sticky section nav: one chip per `.card[id]`, in
the order the page draws the cards, so the marker can always name the section on
screen. `test/sectionNav.test.ts` asserts that mapping in both directions, which
is how a card added without a chip fails the suite instead of quietly leaving
the previous chip marked. The marker seeds with the first chip, then takes the
last target whose top has passed the reading band; between cards it stays on the
last one that passed. `/admin`'s top card has no `id` on purpose — it is the page
header, not a section — so at the top of that page nothing has passed and
`#release`, the first chip, is marked. That fallback is the accepted state, not a
defect.

`/settings` also carries a Feedback card and an About card. The feedback form
posts to `/feedback`, stores a `feedback` row and mails the address in
`FEEDBACK_EMAIL` (falling back to `ADMIN_EMAIL`); the About card and the footer
link to the public GitHub repository with a Star call-to-action. An unexpected
HTTP 5xx creates an `error_reports` row with a random `ref` before the error page
is rendered; the page shows the data scope, requires the consent checkbox, then
offers one POST to `/errors/:ref/report`, which claims the row atomically and
mails the same address. The error row keeps only the method, the matched route
pattern (so a capability in the path, such as an approval token, is never
stored), status, error name, redacted message, redacted stack, version, commit,
the signed-in login and the consent version/time — never the query, body,
headers, cookies or a token.
Both routes carry a route-level limiter, and a 4xx never offers the report button.

The feedback lifecycle is one triage row per ref (`feedback_triage`) plus
`feedback_events`. New reports are sent to the server FlyBot's Lead through a
connected repo (`FLEDGE_LEAD_REPO_ID`) or a direct bridge; the packet carries a
per-ref signed token, not the raw stack. The Lead reads and writes through
`GET`/`POST /api/feedback/:ref` and `/triage`; the read response carries a
sanitized issue draft, every transition appends an event, and the signed-in
reporter sees in-app/mail updates plus a Settings history row. Delivery is a
bounded outbox: a failure is retried with backoff up to five attempts and the
row records the last error/next attempt; a delivered row is never resent. A `fixed_version` at or
below the running `VERSION` sends the fixed notice once; the startup scan then
marks the record `released` and sends the “now live” notice once. Fledge never
creates the public issue: the Lead does, sanitized, and records its URL.

The dashboard's Repositories card owns the full content row; its Add repository
button sits in the card header and opens a native `<dialog>` with the GitHub App
and fine-grained token options. `#add-repo` remains the deep link used by the
empty state, the next action, the setup checklist and the `POST /repos` error, so
the dialog is opened by the hash as well as the button. The dialog lives outside
the secondary disclosure; a `<noscript>` rule renders it inline when JavaScript is
unavailable, and the token form keeps its CSRF field and `type="password"`.

The admin backup card has two read-only sources: `readBackupStatus()` lists the
plaintext copies in `config.backup.dir` and counts the encrypted copies beside
them, and `readRestoreDrill()` reads `<dataDir>/backup-drill.json`. The card
never opens the database or a copy. It hashes only the newest plaintext copy
under the 4 MiB cap, gives a row only to a copy that differs or whose manifest
cannot be read, and reports the drill record rather than a fixed "none
recorded". `scripts/restore-drill.mjs --status-file` is the writer.

## Components

```
                    ┌──────────────────────────────────────┐
 Browser ──cookie──►│ Fledge (Fastify)                     │
                    │  auth · approval · repos · jobs      │
                    │  OpenAI-compatible gateway · admin   │
                    └───────┬───────────────┬──────────────┘
                            │               │
                 SQLite (WAL)│               │ HTTPS
                            │               ├──► api.github.com
                            │               ├──► SMTP (operator-configured)
                            │               └──► model provider / router
                            │
                            └── job queue ──► FlyBot bridge ──► FlyBot agent
                                                   │
                                                   ├─ GET /api/jobs/:id/credential
                                                   └─ POST /api/jobs/:id/callback
```

### Fledge

- **Fastify** HTTP server, server-rendered HTML, no frontend build step.
- **Bilingual UI** in Chinese and English. The locale is stored in the
  `fledge_lang` cookie, and the header switch shares the `hugoxk-lang`
  preference with the rest of the platform.
- **First-run checklist** (`src/views/checklist.ts`): `/dashboard` shows five
  steps — repository, role, model provider, instance, first job — and every
  step's state is read from the database on the request, so a cookie, a second
  browser or a cleared store cannot change which step is next. The pure state
  machine decides the single primary action; a step whose prerequisite is
  missing states the reason instead of offering a control. The model-provider
  step is optional while the platform model is configured
  (`PLATFORM_LLM_BASE_URL` and `PLATFORM_LLM_KEY`) and the account's platform
  quota is not exhausted: it reads as satisfied by the platform quota, keeps the
  own-provider link as an optional upgrade, and does not block the instance or
  the first job. Once the quota is exhausted or the platform model is not
  configured, the same step becomes required again; the answer is derived from
  the rows and config on every request, so no skip cookie or second store is
  needed. The step is completed by a repository selection (or the legacy
  user-level model), not by a provider row: a provider that no repository has
  selected links to the repository picker instead of claiming the step is done.
  The quota next action is shown only while no usable own model exists. The
  model row prints the remaining balance. Below `PLATFORM_QUOTA_COMFORT_CNY`
  (default 50) it warns that the balance may not cover the first run and
  recommends an own model now (Settings → Model, or the repository picker when a
  provider is already configured); at or above it it only names the balance and
  keeps the own-model link as a later option. The checklist reads the account's
  unfiltered job count, so a
  `status`/`repo`/`kind`/`priority` filter on the recent-jobs table cannot bring
  the checklist back after the first job. Once a job exists the checklist is
  replaced by a first-run summary
  whose outcome is the first job's own status, read all-time (not a
  window-scoped count), in four shapes: the
  job's PR link when it opened one, "finished" with a link to Recent jobs when it
  succeeded without a PR, "running" while it is queued or running, and the retry
  path on the repository page when it failed.
- **Next action** (`src/views/pages.ts`, `nextActionFor`): `/dashboard` opens
  with one server-derived action instead of a wall of equal cards. The order is
  the order a person would take them — an open question only they can answer, an
  exhausted platform quota when no usable own model exists, the most urgent
  alert (stalled or slow job, stale
  PR, invalid credential, repository budget), the account's newest failed job,
  the unfinished first-run step — and when none applies, an all-clear that names
  the known next scheduled automatic run (a repository the scheduler has never
  run is not a known time and never shadows one), or says that no repository runs
  automatically. Every source is one the route already loads, so the block cannot
  disagree with the sections below it.
- **Work-loop rail** (`src/views/pages.ts`, `loopStage`): the same header draws the
  five steps Connect → Goal → Work → Review → Merge and marks one of them current.
  Only a real position can be marked: an open question or a failed job is Work, an
  alert is Review, an unfinished first run or an exhausted quota is Connect. The
  all-clear is a state, not a step, so it never marks Merge: an account whose goal
  is written stands at Goal, and an account without one gets a rail with no step
  current rather than progress it did not make.
- **One next-run rule** (`src/lib/nextRun.ts`, `nextRun`): the all-clear card and
  the repository page's next-run line print one answer per repository, and which
  rule answers is decided by the repository, never by the surface. A repository
  that has saved no schedule row is answered by the interval rule, which copies
  the worker's due rule — `max(15, min(intervalMinutes, workCooldownMinutes))`
  after the last run (`src/jobs/service.ts`, `workDue`) — instead of the discovery
  interval. It also answers why a run will not start now: a disabled repository, a
  FlyBot instance that is not ready, auto-iteration switched off, an active job,
  no open work, or a repository the scheduler has never run. A repository that has
  a schedule row is answered by the planner (`src/schedules/next.ts`, `nextTime`)
  because that row owns its cadence; the dashboard route passes the instant with
  the repository's facts and both surfaces render it through `plannedNextLine`, so
  the card cannot fall back to the interval rule for a scheduled repository and
  disagree with the page below it. The daily digest is the third surface: `buildDigest`
  calls `nextRunFor` (`src/lib/nextRunFor.ts`), which makes the same row-vs-interval
  choice and delegates the instant to `nextTime`/`dueAfterMs`, so the email prints
  the same state and time as the page. The digest owns only its Chinese wording; it
  does not import `src/views/**`. A disabled repository is answered by `enabled`
  before either rule: the worker only considers `enabled = 1 AND
  auto_iterate = 1` (`src/db.ts`, `listAutoRepos`) and a manual start on a paused
  repository is refused with `REPO_DISABLED`, so the page route withholds a saved
  row's answer and `nextRunFor` answers `disabled` before the row — no surface
  names a run for a paused repository. The page keeps the `disabled` sentence with
  or without a schedule row, and the dashboard never names a paused repository
  while an enabled one has a next run. The dashboard route passes open work, the
  active job and instance readiness per repository because those live outside
  `RepoRow`; the surfaces therefore print one string, and
  the wording says "next run", never an estimate. The newest job is read on its own, not
  from the job-table slice: the table is paged and filtered, and `?jobsPage=2` or
  `?status=` must not change the sentence the page opens with. The first-run
  checklist becomes the detail of the same action and does not render a second
  primary button for that step; the quota, delivery, repository table and
  recent-job sections move into one `<details>` that starts collapsed, and it
  renders open whenever the next action points inside it — the add-repository
  form, the inbox or the attention table — because a browser does not open
  `<details>` for an in-page anchor, so that link is never hidden behind a tap.
  The job table's own pager and filter form target `#jobs`, which is inside the
  same element, so a page loaded with `?jobsPage=2` or an active
  `repo`/`status`/`kind` filter also renders the disclosure open; otherwise Next
  and Apply would land on a hidden table. A failed job whose message the
  platform only writes in Chinese is named by its failure class on a page in the
  other language, and the raw sentence stays on the job page.
- **The header names the cadence it prints** (`src/views/pages.ts`, repository
  header): the interval pill reads "Discovery every" / 发现间隔 — the word the
  Add-repository and settings forms already use — and prints
  `max(60, interval_minutes)`, the floor `discoverDue` applies
  (`MIN_DISCOVERY_INTERVAL_MINUTES`), so a 30-minute legacy row cannot advertise
  a cadence discovery never runs at. It used to read "Auto every" beside the
  automatic-work switch and read as the work interval; work starts from ready
  items after the short cooldown (`workDue`), and a repository with a saved
  schedule row is still answered by that row in the pill to its right
  (`data-next-source="schedule"`). "Automatic work" stays its own on/off answer,
  so enabling work never requires choosing an interval.
- **Queue position** (`src/lib/queueRank.ts`, `rankQueued`): a queued job shows
  its place in the queue with the length (`#3/7`) and the priority it competes
  on, computed with the claimer's two keys only — `priority DESC, created_at ASC`
  (`src/db.ts`, `claimQueuedJob`); the id comparison inside its per-repo
  `NOT EXISTS` is not an instance key, so rows equal on both keys share a
  position instead of inventing a third one. Position and total are
  instance-wide counts, because they describe the real line. The job page's
  ahead-list names only the viewer's own queued jobs (the per-user read is
  filtered to `queued` and re-sorted, so a running job is not a neighbour), and
  jobs owned by anyone else are one sentence with a number and no identifier:
  no repository, account, priority class or arrival time. The number is the
  ordering, not a promise — the claimer also refuses a job while its repository
  has a running or earlier queued job. The rank renders inside the existing job
  cell on the dashboard, repository and team console tables; the admin
  recent-jobs table deliberately keeps its four columns and shows no position,
  because a queue place read from an operator slice would read as the admin's
  own.
- **Shell** (`src/views/layout.ts`, `public/app.css`): the main nav marks the
  current page with `aria-current="page"` on the one link whose own target is the
  route, derived from the route and overridable with `active`; a nested route
  inside a section keeps the highlight and announces the generic
  `aria-current="true"`, never `page`. The sticky header owns `--header-h` (re-declared
  per breakpoint); `[id] { scroll-margin-top }` and the workspace frame's height
  both follow it, so an anchor is never hidden under the header when it wraps
  and the frame's bottom lands at the viewport bottom. The shell's controls keep
  a 44px touch target. Below 641px the header is one **fixed** 64px row and the
  navigation collapses behind a `data-nav-toggle` button that publishes
  `aria-expanded`; the open menu is an absolutely positioned panel, so it
  overlays the page and `--header-h` keeps the collapsed height while it is
  open. The toggle itself is hidden outside the phone band by a base rule, so
  the desktop header never shows a control whose panel does not exist there.
  Every destination the wide header lists is still rendered in the panel,
  so a phone loses no route. The theme control is one 44px icon summary in the
  header, not a text group: its `<details>` menu carries the three choices, is
  available signed-out, and on a phone is pinned under the header so it cannot
  overflow either edge. Below 420px the row also drops the wordmark (the
  mark and its own `aria-label` stay) and tightens its padding and gaps: at a
  360px viewport with a classic 15px scrollbar the row has 301px of usable
  width, and the wordmark is the one child that can leave without taking a
  route or a 44px target with it. The same floor covers the controls inside
  `main` and in the footer: it is the `--touch` token, applied by container
  (`td .link`, `button.link`, `.foot a`, `label.check`) rather than to `.link`,
  because a link inside a sentence is exempt and must keep its line box; a link
  that is the whole paragraph is a target, so the template marks it
  (`.fine-link`) and the class carries the floor. Text fields, selects and
  textareas are 16px below 641px, the size below which iOS zooms a focused
  field.
- **Asset URLs carry a content version** (`src/lib/assetVersion.ts`): the host
  serves `/assets/` with a four-hour freshness lifetime and the page sets no
  cache directive of its own, so every asset URL is emitted as
  `?v=<first 12 hex of the file's sha256>` — the four in `src/views/layout.ts`,
  the six in `src/views/pages.ts` (`repoPage`, `teamPage`,
  `applicationStatusPage`) and the two `rewriteWorkspaceHtml` injects into the
  proxied workspace page. The digest is memoised per path and is the file's own
  bytes, never the commit: `/healthz` withholds `config.build.commit` behind
  `diagnosticsAccess` (#236, #466) and an asset URL is public. A deploy that
  changes a file therefore changes its URL, so a browser cannot serve the old
  copy inside the lifetime whatever header the host sends.
- **Repository page tabs** (`src/views/pages.ts` `repoPage`, `public/repoTabs.js`):
  `/repos/:id` renders six sections — Overview, Delivery, Work, Team, Settings,
  Danger — behind a sticky subnav. The sections are a regroup of the cards the
  page already renders: nothing new is computed, no route is added, and the ten
  ids the page published before (`#inbox`, `#chief`, `#role`, `#board`, `#work`,
  `#delivery`, `#repo-settings`, `#connection`, `#jobs`, `#danger`) are still on
  or inside a section, so an old link lands where it used to. `#overview`,
  `#team` and `#settings` are the anchors this adds. The markup ships all six
  sections expanded, and `public/repoTabs.js` collapses them and moves
  `aria-current="page"` as the hash changes — an inner anchor such as `#board`
  opens the section that holds it — so a reader without the script still gets
  the whole page. The bar sticks at `var(--header-h)` and scrolls horizontally
  in the phone band; the tab is a 44px `--touch` target and the current tab
  paints with `--accent-strong`, the one interactive accent. Above the tabs, the
  header separates the title and target branch, a status strip (automatic work,
  discovery interval, next run, schedule console, FlyBot, GitHub credential) and
  a facts line (upstream/fork, permission, role, reviewer); the run/plan/review
  actions stay in the header and every existing anchor is unchanged. The Danger
  section also carries the recent-auth preflight: a stale `recent_auth_at` renders
  a **Confirm with GitHub** link whose return target is `/repos/:id#danger`; the
  stale POST refusal uses the same anchor, so the form is on screen after
  re-authentication instead of the page top.
- **Dashboard job filters** (`src/lib/jobFilters.ts`): `/dashboard` accepts
  `repo`, `status` and `kind` as GET parameters and applies them in SQL, so the
  count, the page and the pagination links describe the same list; a value the
  account cannot use is dropped rather than turned into an error page, and the
  filter lives in the URL rather than in a client store. Every control that
  rebuilds that URL keeps the state it is not changing: the 7/30-day window,
  both "Clear filters" links and both pagers read the keys from one helper, so
  the filter survives a window switch and a page click, and the window survives
  a filter and a clear. The admin search page (`/admin/search`) uses one toolbar
  with a `Jobs` / `Audit` switch (`view=jobs|audit`): the active tab owns the
  only filter form, so there is one Query field and paging or export cannot drop
  the other tab's unrelated keys. The job fields still come from
  `JOB_FILTER_STATUSES` and `JOB_FILTER_KINDS` and the same label helpers, so
  every kind a job can have is selectable there and both locales read the
  console's words rather than the stored code; option values stay the codes, so
  the query, totals and CSV export are unchanged. Audit details render
  `key=value` pairs as chips, link `job_*`, `repo_*` and `usr_*` ids to their
  pages, and collapse long free text behind a details control instead of
  truncating one raw line. A second hand-written list in a view is how `scope`
  and `verify` went missing from a form once already.
- **Admin CSV exports**: both `/admin/export/jobs.csv` and
  `/admin/export/audit.csv` write one `admin.jobs_export` / `admin.audit_export`
  row once the body is known — `filters=` echoes the allow-listed codes and ISO
  dates verbatim, `q` and `action` are recorded only as `<length>ch#<8 hex>`,
  `scope=all|users:<n>` names the visibility list the query actually used,
  `rows=` is the data-line count, and `sha256=` is the digest of the exact body
  sent, so a file found elsewhere can be matched to its row. The read is paged
  at 500 rows, so no store call materialises the 5000-row cap, and
  `/admin/search` renders the newest completed export for the viewer's scope
  above each table.
- **Redirect targets**: every `next=` / `returnTo` value goes through one helper
  that returns a path on this site or the fallback. It validates the parsed
  result, not the input, so a value that is a plain path before parsing and
  `//host` after it (`/..//evil.com`) cannot become a protocol-relative
  `Location`. `/lang/:locale` is the public entry point; the OAuth `next` and the
  form `returnTo` values share the same rule.
- **Sign-in round trip**: an unauthenticated `GET`/`HEAD` of an HTML page
  (`/apply`, `/apply/status`, `/dashboard`, `/console`, `/settings`, `/admin`,
  `/pending`) is answered with a 302 to `/auth/github?next=<the page>` instead of
  the 401 error page; `/auth/github` stores that checked path in the OAuth
  `state` and the callback returns there. `/api/*`, `/v1/*` and non-GET requests
  keep the 401, so a machine client keeps its status code and a form post keeps
  its body.
- **SQLite** via Node's built-in `node:sqlite` (WAL, foreign keys). The database
  file is the only state; the mail outbox is a development artifact.
- **Sessions** are random 32-byte tokens, stored as SHA-256 hashes; the cookie is
  HttpOnly/SameSite=Lax.
- **Job terminal transitions** are conditional writes (`UPDATE … WHERE status IN
  ('queued','running')`) inside a `BEGIN IMMEDIATE` transaction; the row that wins
  stores a fingerprint of the reported result, so a replayed callback is a no-op
  and a contradicting one is a conflict. Side effects run only in the winning
  branch (`docs/decisions/0004`).
- **OAuth**: GitHub OAuth App with `state` stored server-side for 10 minutes.
- **Token login**: one exported predicate, `tokenLoginEnabled = !oauthConfigured ||
  allowTokenLoginOnly`, decides both the `POST /auth/token` guard and the landing
  page's token form, so the page cannot hide a route that still answers.
- **Applications**: a new user starts as `onboarding`. Submitting the signed
  disclaimer and information-security agreement moves them to `pending` and
  emails the administrator. The status page shows the live queue position and
  rejects a second submission. Approvals create two single-use random tokens
  (approve/reject), stored as hashes, valid for 7 days.
- **Roles**: platform roles are `user`, `admin` and super admin (`superadmin`). The
  primary `GITHUB_ADMIN_LOGIN` is promoted to owner on startup. Admins get the
  normal product UI plus a scoped management page for themselves and normal
  users; the super admin sees everyone, can set admins and is the only role that can
  set unlimited quota. The owner can toggle a normal-user preview cookie that
  renders the simple UI while advanced routes stay blocked. An admin can open a
  read-only support view for a visible user and that user's jobs; it never
  mutates data or triggers work.
- **Dispatch leases and queue mode**: every running job records `lease_owner`
  and `lease_until`; the terminal transition clears them. `Store.claimQueuedJob`
  atomically claims one queued row per repository, and `expiredLeaseJobs` is the
  recovery query. `QUEUE_DISPATCH=false` keeps the inline path; setting it to
  `true` makes `enqueue` store the callback secret and job token encrypted
  (`callback_secret_enc`, `platform_token_enc`) and lets the tick's worker loop
  claim and dispatch the job. A running job renews its five-minute lease every
  minute, and the tick reaper fails a job whose worker stops renewing instead of
  waiting for the 90-minute job timeout. Each dispatch also records one
  `job_attempts` row (worker, attempt number, lease epoch, dispatch id, status,
  error, timestamps) in the same transaction that marks the job running; the
  job's `lease_epoch` is the fence, so a worker whose lease was taken over
  cannot finalise the attempt it lost — its late report is refused and recorded
  on that attempt's row. The three recovery sweeps (stall, timeout, expired
  lease) close the attempt as `reaped`, a terminal outcome that is visible
  instead of a silent reset to `queued`, and a retry continues the chain as
  attempt N+1 with `retry_of` pointing at the attempt it continues. Queue
  admission rejects a new job when the global or per-user cap is reached. A partial unique index
  (`jobs_one_active_per_repo`) makes the one-active-job-per-repository rule a
  database invariant, not only a read-time check; a database written before the
  index existed is deduped when it opens — keep a running job (else the oldest
  queued one) and fail the rest with `JOB_DUPLICATE_ACTIVE_SUPERSEDED` and an
  audit row, so a duplicate row cannot turn startup into a boot failure. A
  demoted row that was running a work item resets that item to `triaged` in the
  same transaction (a legal `in_progress -> triaged` edge in
  `WORK_ITEM_TRANSITIONS`) and its audit row names the item id, because the item
  would otherwise stay `in_progress` behind a job that can never finish. The
  lease and queue columns are schema version 34; `jobs.lease_epoch` and the
  `job_attempts` table are schema version 46.
- **Queue tickets**: every job carries a `queue_seq` taken inside its insert, so
  two jobs created at the same instant cannot be handed the same one, and the
  queue is ordered by priority, then `queue_seq`, then `id` — never by a clock
  that can tie. A priority change moves the row to the tail of its new level,
  because that is a new arrival; saving the same value again is not a move and
  keeps the ticket. `0` marks a row written before the column existed, and it is
  backfilled in `created_at` order when the database opens, which is the order
  those rows were already ranked by. A running job is never preempted.
- **Priority ladder**: `P0`–`P3` is the closed set a person sees; the integer
  column stays the storage form the ticket orders by, so `P0` maps to `30`
  (ongoing damage, credential exposure or an outage), `P1` to `20` (the core goal
  is blocked), `P2` to `10` (ordinary work, the default) and `P3` to `0`
  (non-core polish). Rows written before the ladder, and work-item priorities on
  a 0–100 scale, read as the nearest level rather than as an invalid value.
  Raising a job to `P0` or `P1` is a claim, so the save carries a reason and
  evidence a second person can check — a link, a commit or ticket sha, or a
  measurement with a unit; adjectives alone are refused. The no-op rule and the
  tail-ticket rule above still decide where the row sits. The dashboard and the
  admin job search filter by level (`P0`–`P3`), and the clause is a half-open
  rank range, so a row written before the ladder still appears under the level
  the console prints for it.
- **Task relations are explicit**: `task_relations` joins two jobs of one
  repository as `same_problem`, `related` or `recurrence`, with the reason and
  the checkable evidence the claim rests on. Both ends must be jobs of the same
  repository, so a relation cannot cross a project boundary, and a task cannot
  be related to itself. A repeated save is one row. Nothing derives a relation
  from a title or an embedding: similar tasks stay separate until a person links
  them, and a relation never moves, merges or suppresses work. The decision record
  for the ladder and the relation table is
  `docs/decisions/0018-priority-ladder-and-relations.md`.
- **One bounded next-task decision**: after a job is verified the follow-up is a
  single decision — `new`, `supplement`, `related` or `recurrence` — carrying a
  reason and checkable evidence. `new` creates one separate task, `supplement`
  appends to an existing task without a second execution, and `related` /
  `recurrence` create the task and the explicit relation that says why. `new`
  aimed at an existing task is contradictory and is repaired once into
  `related`. When the decision step is unavailable the framework default is a
  separate task at `P2`. A related task whose target is still running leaves one
  coordination notice, which that job takes at its next progress heartbeat that
  carries a checkpoint, and only once — a heartbeat without a checkpoint is
  progress, not a checkpoint, so it takes nothing. The running job keeps its
  claim. The console offers the decision where a
  `verify` or `review` run ends, at `POST /repos/:id/jobs/:jobId/decision`, and
  preselects the framework default, so the undecided case is still one ordinary
  `P2` task rather than an open-ended chain.
- **No worker process**: a 60-second tick chooses the next job for a due repo.
  With open work it follows up the highest-priority item (or reviews its PR when
  a maintainer reviewer is due); with no open work it **stays idle** unless the
  discovery interval is due, in which case it may run one `discover` job that
  creates at most one concrete issue and never a PR. The latest three run digests
  and open work items are carried
  into the goal as bounded data. Work sessions use a short global cooldown
  (`WORK_SESSION_COOLDOWN_MINUTES`, default 15 minutes); the per-repository
  interval is only an upper bound on the idle check, with a 60-minute floor for
  discovery, not a reason to produce. A **successful** work job is not a
  throttle: the next open item is due on the next tick, because a role that
  finished is the user's cue that the next item starts (#801). The cooldown
  still applies after a run that did not succeed, and
  a run backs off after two unproductive (failed, zero-output or meta) runs and
  is skipped while another job for that repository is active. The global
  concurrency cap is 2. Review cadence is from every 6 hours to every 30 days.
  Jobs that exceed the timeout are failed.
- **One answer for "why did this not start"** (#807 review, #938, #942):
  `Store.automationDispatchBlocker` is the single predicate behind both the
  dispatcher's refusal and the `automation_idle_with_work` alert, so the console
  cannot report a repository idle after the dispatcher has already named a
  reason. It answers `user_not_ready`, `instance_not_ready` or `quota`. The quota
  member arrived last: it applies only when the platform pays for the run
  (`Store.platformFundedFor`, the same rule the refusal reads — a user's own
  model or a repository's own model selection means the platform pays nothing),
  and it asks `quotaExhausted` in `src/gateway/quota.ts`, which `quotaView` also
  reads, so the refusal and the alert cannot disagree on the arithmetic either.
  A caller that passes no quota rate keeps the older two-reason answer rather
  than refusing work it cannot see; `alerts()` passes the rate its callers
  already carry.
- **Schedule expressions** (#544, first slice): `src/schedules/next.ts` is the
  one planner a preview and the worker will share. A schedule is either a
  five-field cron expression (numeric values, `*`, ranges, lists and steps; no
  seconds field, names or extensions) or a fixed interval between one minute and
  30 days. The cron form names an IANA timezone; a fixed UTC offset is refused.
  The interval form has no timezone and fires on whole multiples of its length
  from the epoch, so every gap is exactly that length whatever the poll cadence.
  Both forms take an optional `[start_at, end_at)` window. An occurrence that
  falls exactly on `start_at` is inside the window and is the next run, while an
  instant equal to the caller's `from` is not, so a caller that passes the instant
  it dispatched is handed the following occurrence.
  `nextTime` is where DST is decided once: a local time that does not exist in
  the spring-forward gap is skipped rather than shifted, and a local time that
  occurs twice in the fall-back hour fires once, at the earlier instant, so a
  poll inside the repeated hour does not run it a second time.
  The preview is the planner's first consumer (#544, second slice): `/schedule`
  and `GET /api/schedule/preview` walk the next N instants, show the wall clock in
  the schedule's zone, and mark a local time the spring-forward gap removed as
  skipped rather than shifting it. Because the interval form has no timezone, an
  interval that arrives with one is refused by name instead of being accepted and
  shown as if a zone applied. A preview stores nothing and creates no job. Each
  refusal is authored in both Chinese and English where the planner raises it,
  The console page leads with a human mode picker (#675): every N
  minutes/hours, every day at a time, weekdays at a time, weekly on a weekday,
  monthly on a day, and an advanced cron mode. `src/schedules/preview.ts` builds
  the same `cron`/`every` planner input from those fields, so the page and the
  JSON API agree, and a mode ignores stale legacy fields. Weekday and
  day-of-month are selects; time is a native `time` input; the timezone is a
  select and defaults to `Asia/Shanghai` when omitted. The start/end/from window
  is optional and lives under an advanced disclosure, so a reader who only wants
  "weekdays at 09:30" never types cron or an ISO offset.
  Layered budgets beyond a schedule's own daily run limit and event
  subscriptions are not built yet (the misfire policy and the notification
  outbox are, see the slices below).
- **The tick consumes the planner** (#544, third slice): a `schedules` row — at
  most one per repository — makes `nextTime` the only rule for when a work run is
  due, and `repos.interval_minutes` stops deciding for that repository. A
  repository without a row keeps the interval path untouched, so nothing changes
  for a repository that has not opted in. `src/schedules/tick.ts` (`planTick`)
  answers the tick's question: which logical instant is due now, how many were
  passed over, and when is the next one. Boundaries are part of that answer:
  `start_at` is inclusive, the caller's `from` is exclusive, and `end_at` is
  exclusive. `last_occurrence_at` is the high water mark in epoch milliseconds and
  never moves backwards, so one instant is dispatched once; `timing_revision`
  moves only when a field that changes *when* the schedule fires changes (the
  expression, the interval, the zone or the window), never for a display edit.
  A due instant that cannot run is recorded with a reason (`active-job`, `idle`,
  `not-due`, a dispatch refusal) and is not made up later.
  A decided instant now has a row of its own (`schedule_occurrences`, fourth
  slice): `timing_revision` copies the schedule's revision at decision time, and
  `UNIQUE(schedule_id, logical_time, timing_revision)` makes that instant under
  that plan one decision. A second tick that reaches the same instant inserts
  nothing and reads the row that already exists, so a later report cannot turn a
  recorded skip into a run; an edit that re-times the schedule re-keys the same
  wall clock as a new decision and leaves the old one readable. `missed` counts
  the instants passed over on the way to the decided one, so a year of missed
  hourly instants stays one row rather than 9k. The row carries the job it
  dispatched, the lag and the reason it skipped; the audit line stays for
  operators and names the row.
  The row also freezes what the decision was taken under (`snapshot_json`,
  written by `src/schedules/snapshot.ts`): the schedule's configuration (kind,
  expression or interval, zone, window, misfire, grace, daily budget, status and
  timing revision) and the repository's authorization (owner, installation,
  permission and role). A later edit to the schedule, or a re-check that changes
  the repository's permission, cannot rewrite what a past instant ran as. A row
  written before the column existed, or one whose snapshot cannot be read,
  answers null and is reported as unknown rather than back-filled from the live
  schedule.
  The lease (slice 3B-B2) answers the second worker: a dispatch claims the row
  before it creates the job, and `lease_token` is compared at settle, so only the
  holder's result lands. A live lease is refused (`leased`), a lapsed one is
  recovered under the **same occurrence id** — which is why the id is not derived
  from the attempt — and a row whose holder never came back is marked `expired` by
  a sweep that runs at the top of every tick pass, which frees it for the next
  claim. `attempts` counts claims and is never compared. A settled row
  (`dispatched` / `skipped`) holds no lease and is never claimable again, so a
  late worker cannot turn a recorded skip into a run. A worker that gives up
  before deciding (quota) releases its lease instead of waiting for it to lapse.
  The misfire policy (slice 5) decides what a passed-over window means, and it is
  stored on the row rather than chosen by the worker. `misfire: 'skip'` is the
  default: the newest due instant is dispatched and the ones before it are
  counted. `misfire: 'once'` makes up the **oldest** passed instant instead — the
  run keeps the logical time it was scheduled for, which is what a budget or a
  report later reads — and the later instants become `skipped` rows with
  `misfire-once`, so nothing in the window is silently dropped. `grace_ms` bounds
  how late a due instant may still be dispatched; one older than the bound becomes
  a `skipped` row with `grace-exceeded` and is never dispatched. Either way the
  high water mark moves to the last instant the decision covered, in the same
  transaction as the rows (`recordScheduleDecisions`), so the next tick starts
  after the window instead of re-deciding it and two workers cannot both write a
  catch-up. A null `grace_ms` means no bound, which is exactly the behaviour every
  schedule had before the column existed, and the console form carries both
  fields so a maintainer sets the policy rather than a migration.
  Reviews keep their own cadence (`review_interval_minutes`): this switches the work loop
  only.
- **The console reads the planner** (#544, the console slice): `/repos/:id/schedule`
  is the page a maintainer reads and the only product write that creates a
  `schedules` row — before it, `saveSchedule` had no caller outside tests, so
  neither the schedule nor the lease above could be felt. It shows the stored
  schedule, the next run from `nextTime`, the newest decided instant with its
  state, reason, `missed` and `attempts`, whether a live lease holds it, and the
  last instant whose job succeeded. A value nobody recorded prints `unknown`: a
  schedule with no occurrence row has not run, so it is not a zero. The delivery
  fact is read from the outbox (`notification_outbox.job_id`, below) for the job
  the newest decided instant dispatched: a job that queued a send reports that
  send's state, and a finished job that queued none prints `none` — a run with
  nothing to deliver — rather than the `unknown` of a page that did not look. A
  job queues its notifications only when it ends (`succeeded`/`failed`), so a
  run whose job is still queued or running prints `unknown` too: the empty read
  is a value nobody knows yet, and a missing value is never printed as a
  definite none. Only a decided instant answers: `skipped` queued nothing by
  definition, while `claimed` (a worker holds it, `job_id` still NULL until the
  job starts) and `expired` (a lease that lapsed before anyone settled it) have
  not decided yet and print `unknown`. The outbox's own
  `unknown` (a send that may have crossed the external boundary) is printed as
  `unconfirmed`, so it is never confused with "nobody read the outbox". The eight facts render through `.schedule-facts`,
  a two-column grid with muted labels that stacks to one column below 640px, so
  the console does not fall back to the browser's default definition-list text.
  `src/schedules/console.ts` is that view model. The
  repository page passes the planner's answer for a scheduled repository and keeps
  the legacy interval line only for one without a row, so the page prints one
  number instead of a second, weaker one; the comment that claimed the interval
  rule restates the worker's formula is gone with the citation it rested on.
  Saving is audited as `schedule.saved` and deleting the row as
  `schedule.removed`, each naming the repository and what changed.
- **The schedule run budget** (#544, slice 6): a `schedules` row may carry
  `daily_runs`, the most instants it may dispatch in one logical UTC day. The
  window is the day of the **instant being decided** (`src/schedules/budget.ts`,
  `utcDayStart`/`utcDayEnd`, half-open), never the day the dispatch happens, so a
  late or recovered run stays in the day it was scheduled for and crossing
  midnight grants no fresh allowance. Before a due instant is dispatched the tick
  counts the schedule's `dispatched` occurrences in that window
  (`countScheduleDispatchesBetween`); at the limit the instant becomes a
  `skipped` row with `budget-exceeded` and the high water mark still moves past
  it, so the instant is decided once instead of being re-decided every tick. A
  `claimed` row has not dispatched yet and a `skipped` one did not run, so
  neither is charged. Null is unbounded, which is what every schedule written
  before the column had; `0` is refused at save time because a schedule that must
  not run is deleted or its window closed. This is the run-count layer only: the
  cost layer stays where it is — `repos.monthly_budget_cny` / `job_budget_cny`
  for a repository and the account quota for a user — so the two are counted
  separately. The console prints the limit, today's used count and what is left,
  and a value nobody read prints `unknown` rather than zero. One process ticks, so
  the count and the claim are sequential in one pass and the claim's own
  transaction still makes the instant single-dispatch; a distributed worker
  (`#387`) must move the count inside that claim, or two workers could each spend
  the last slot.
- **The notification outbox** (#544, slice 7): the notifications it covers are
  durable rows (`notification_outbox`), and a send that reports on a job carries
  its `job_id` (nullable, indexed) so the schedule console can name a run's
  delivery without parsing the idempotency key; a row written before the column
  existed keeps NULL and is never retro-attached to a run. A notification is a
  row instead of a call whose failure lived only in a log line — the digests,
  question mails, ops alerts and per-job/PR webhooks are queued with an
  idempotency key, so a replayed callback or a second tick
  keeps one row rather than sending twice. Per-job success/failure mail and the
  transactional approval, quota, trial and feedback mail still send inline in
  this slice; they are not queued rows yet. A tick pass sweeps lapsed `sending`
  leases into `unknown`, then attempts the due `pending`/`retry` rows one at a
  time.
  The states are deliberately not interchangeable: a 429/5xx webhook or a 4xx
  SMTP greeting is `retry` with exponential backoff (one minute, doubling,
  capped at an hour); a 4xx webhook answer or a 5xx SMTP rejection is `dead`; a
  timeout or reset that may have happened after the request left the process is
  `unknown`, and `unknown` is never resent automatically because the destination
  may already have it; a missing address, a revoked account, a switched-off
  webhook or a destination the safety rule refuses is `blocked`, so a human
  fixes the cause first. Email is resolved again at delivery (`notifyEmail` of
  the current account), which is why a queued message cannot follow an address
  the user has since changed or a revoked account. The one human action is an
  explicit resend from `/admin/notifications`, which reuses the row's
  idempotency key, keeps the attempt count readable, and is audited as
  `notification.resend`; a delivered row is not reopened. The console names
  every state and prints the last error and the delivery time, and it shows the
  address masked and never the mail or webhook body. `unknown` keeps a longer
  retention window than the other states, because it is the only one whose
  duplicate risk a human still has to judge.
- **Upstream/fork onboarding**: the user submits the upstream repository. Fledge
  reads it with the user's token, checks for a same-name fork, creates one when
  needed, and stores both sides. Iteration jobs push to the fork and open the PR
  against the upstream; issues are created on the upstream. If the token user
  owns the upstream, no fork is created and the branch/PR stay in that repo.
- **Repository role**: each user-repository connection stores `repo_role` as
  `maintainer` or `developer`. Fledge derives the allowed roles from the user's
  GitHub permission on that repository: `admin`/`maintain` may choose either,
  and every other permission can only choose `developer`. The user must choose
  explicitly; the platform never auto-selects and an admin cannot assign the
  role. A user can be a maintainer in one repository and a developer in another.
  Maintainer enables review/triage maintenance actions and the opt-in
  auto-merge switch; developer runs iterate/plan jobs only. There is no separate
  owner or viewer role. The scheduler re-checks a stale role before review or
  auto-merge and downgrades it when the GitHub permission is lost.
- **Target branch**: each repository stores a `target_branch` that defaults to
  the upstream default but can be `develop` or a release branch. Jobs snapshot
  it as `base_branch`; the agent still creates a new head branch and opens the
  PR against that base. Follow-ups keep the existing PR base. Invalid target branch names are rejected when
  saved; if a verified branch disappears later, the job fails clearly instead
  of silently falling back to the repository default.
- **Reviewer role**: a maintainer with GitHub admin/maintain permission on the
  upstream can enable a scheduled reviewer. Review jobs list every open upstream
  PR, score each one, and post a COMMENT review; they never merge or modify
  code. A developer cannot run review jobs even when GitHub grants write access.
- **Starting a triage job**: triage is repository-scoped, not issue-scoped, so a
  person starts one from the repository page (`POST /repos/:id/triage`, behind
  `ownedRepo` and the CSRF guard) rather than from `/admin`: an operator-only
  start would leave the repository's own owner unable to triage it, and a
  maintainer or developer role is enough. The control accepts one optional input,
  an issue URL that focuses the board, and the route binds it to the repository
  with `parseIssueUrl` before anything is enqueued, so a foreign host or a
  foreign repository is refused with a visible error and no job row instead of
  being caught only when the callback's board comes back. Because the goal is
  read by the agent as instructions, the route names the issue by the canonical
  URL the parser rebuilds from the checked owner, name and number, never by the
  pasted string: a query string or fragment on the link cannot reach the prompt.
  The duplicate rule is
  the existing `jobs_one_active_per_repo` index: a start while a job is queued or
  running is refused with `JOB_ACTIVE`, while a start after the previous one
  finished is allowed because triage only reads.
- **Work items and gates**: each repository has work items with a
  triage-to-merge state machine (`proposed → triaged → assigned → in_progress →
  pr_ready → in_review → changes_requested → approved → merged/closed`, plus the
  direct `assigned → pr_ready` edge a job takes when it reports its pull request
  while the row still reads `assigned`). Jobs
  link to a work item, and issue/PR/review webhooks keep state and PR outcome in
  sync. Issue labels map `priority:high|medium|low` (or `p0`–`p3`) to work-item
  priority, and an `agent-ready` label moves a proposed item to triaged. A
  repository can require a plan before code; a maintainer approves or
  rejects it with allowed/forbidden path constraints, and execution is blocked
  until approval. An answerless plan does not wait forever: one reminder is sent
  `PLAN_REMINDER_DAYS` before the deadline, and at `PLAN_EXPIRY_DAYS` (default 7)
  the tick closes the work item into the existing `closed` state with
  `closed_reason = 'plan_expired'` and an audit row. No state or transition was
  added for this: expiry reuses `closed`, the reason column carries the meaning,
  and `closed -> triaged` is the reopening path. A work item already in a
  terminal state (`merged` or `closed`) is left exactly as it is: the expiry is
  still recorded in the audit row and in the `plan_expired:<job>` settings key,
  but no "已过期关闭" notice is sent for an item the pass did not end (#408).
  Iterate jobs preflight the target branch, record the base SHA,
  warn when the fork is behind, and add the temporal delta line described below. An open work item changes what the next
  scheduled run continues; it never blocks a due repository (#219). Work-item
  states do not gate the scheduler; see "Scheduled work, continuity and work
  items" below.
- **Auto-merge switch**: off by default. Only a maintainer can enable it. When
  it is on, Fledge (not the agent) verifies the PR is open and mergeable, every
  check run is green, the combined commit status is not failing, and no current
  review requests changes, and the branch protection rule confirms the required
  checks and approvals before it performs a squash merge. It also refuses when
  the linked work item is `changes_requested` or the newest succeeded review job
  for that PR has a score below `AUTO_MERGE_MIN_REVIEW_SCORE` (default 80). A
  manual maintainer merge may override the review-score gate, and the override
  is audited as `job.merge_review_override`. The row names the decision it
  overturned — the review job, its score, the model that answered and the tip
  that review covered — so a reader can tell which review a merge went past; a
  decision that recorded no revision leaves that field unknown rather than
  borrowing the merge tip. The agent prompt always forbids
  merging. The switch is stored on the repository and included in the job
  payload for reporting. A stale or downgraded role blocks the merge.
  A merge also needs the newest `iterate` job for that pull request to have
  succeeded: a queued, running, failed, cancelled or paused follow-up on the
  same PR holds it back, so an older succeeded job cannot merge work that is
  still in flight or that failed afterwards. A pull request that is already
  merged is never a candidate, so the bulk merge does not re-check it on every
  pass.

### Public API v1

`/api/v1/*` is the token-authenticated read surface for a control room or an
editor. `GET /api/v1/jobs` answers the caller's own jobs through the `jobs:read`
scope, newest first, keyed by `(created_at, rowid)` rather than an offset, so a
job created between two requests cannot shift a row across pages. The item
mapper is the boundary: the row also holds a callback hash, a platform token
hash and a callback secret, and none of them is in the response. See
`docs/api.md` for the contract.

### Model gateway

`/v1/*` is OpenAI-compatible and authenticated with `flg_` tokens. A token
carries a `scope` and an `expires_at`, and the scope is its whole capability:
`gateway` reaches the model routes and `jobs:read` reaches `GET /api/v1/jobs`,
with no substitution between them. A personal token always gets a finite
lifetime (30/90/365 days, default `PAT_EXPIRY_DAYS` 90) and only an admin may
create an operator token without one. Exactly one function decides what a token
is — `authenticateApiToken` in `src/lib/apiToken.ts`, which the gateway and the
public read API both call — and it answers `401 invalid_api_key` for an unknown,
revoked, expired or non-approved token and `403 insufficient_scope` for a live
token outside the required scope, decided before `last_used_at` is written;
neither refusal echoes the token. The settings page offers both scopes, lists
each token's scope, expiry and last use, and revoke stays one click.

- If the user has an own model configured, Fledge proxies to it and does **not**
  meter platform quota.
- Otherwise it proxies to `PLATFORM_LLM_BASE_URL` with `PLATFORM_LLM_KEY`, reads
  `x-litellm-response-cost` (or prices `usage` from that model's entry in
  `PLATFORM_LLM_PRICE_TABLE`), and records the cost in `quota_ledger` +
  `users.quota_used_usd`. The row carries the model, currency, the price snapshot
  it was charged at and `cost_known`; a request that cannot be priced is stored
  as `cost_known = 0` with a `request.cost_unknown` audit entry instead of a
  zero cost, so spend stays a lower bound rather than a claim of "free" (#636).
  `users.quota_used_usd`, `jobs.cost_usd` and the CNY budgets are USD columns:
  only rows billed in USD reach them, and a row in another currency is reported
  by `Store.costByCurrency()` in its own bucket instead of being converted. A
  row with no currency is the pre-#636 legacy shape and is the USD bucket, not a
  second one: the label is resolved before the grouping, so an upgraded instance
  shows one `USD` row (#702).
  `src/metrics/cost.ts` holds the price table, the cache-token rule and the
  unknown-vs-zero decision; the gateway only reads its answer.
- At zero it returns HTTP 402 with `code: FLEDGE_QUOTA_EXHAUSTED` and a settings
  link.
- Streaming is passed through; `stream_options.include_usage` is added so the
  final usage chunk can be metered.
- A repository that selected several models falls back on a transient refusal:
  the `is_default` model first, then the rest in the selection query's order
  (`ORDER BY mp.created_at ASC, pm.created_at ASC`, `src/db.ts`), the same order
  the per-instance picker walks; there is no order column. The job row records
  the model that answered and the attempts of the **last chat call** —
  `recordModel` rewrites `jobs.model_json` on every call. The fallback a job made
  is recorded beside that, as `fallback: { from, to, status }`, and the first one
  is kept: a later call cannot erase it or replace it, whether that call answers on
  the primary or falls back again to a different pair. The job page states that
  pair on the `data-model` line unless the line's own `tried` clause already names
  the same model; the pull-request automation comment states only the last call.

The operator chooses the upstream through `PLATFORM_LLM_BASE_URL`; keep the
real endpoint and key out of git and out of public documentation.

### Repository rules and skills

A repository can add `.fledge/rules.md`, `.fledge/review.md`, `.fledge/develop.md` and text skills under `.agents/skills/`. Fledge reads them from the default branch at the job's fixed commit, records the commit and file hashes in `job_contexts`/`job_context_files`, and injects the effective rule text into the bridge prompt. For the three rule files the effective layer is repository file first, then a maintainer-owned console override in `repo_rule_overrides`, then the implicit built-in behaviour; each job records that layer per path in its context. The full text of a skill is read on demand with the job callback secret from `GET /api/jobs/:id/context?path=...`; the endpoint only serves files recorded for that job and only while it is queued or running. A PR that changes a rule or skill file blocks auto-merge until a maintainer acknowledges that head SHA. The set is bounded before it can reach a prompt: 32 KiB per rule file, 32 KiB per skill file, 32 skills, 256 KiB for the whole set, and 16000 bytes for the assembled rule text the bridge prompt carries. A set that crosses any ceiling is refused as a whole rather than truncated, because a job that ran on half its rules would silently lose the other half; the refusal names the file that crossed the limit and the byte count it reached, and the prompt is sent whole or not at all. Details and limits: [rules.md](rules.md).

### Per-repository FlyBot instances

Each hosted repository gets its own FlyBot container and its own team. The user
directory contains the per-repo data; a container has a private network, a
private bridge, a model proxy and a fixed FlyBot release image. A repository
team is one Chief plus Lead, Product, Test, Security, Reviewer and two Devs;
the Reviewer is scoped to upstream/all PRs or self-review based on the user's
upstream permission. Deleting or stopping a repository stops only that
container. The shared operator FlyBot is never used for user jobs.

Provisioning writes a versioned team playbook into every role and records the
version and a goal fingerprint in `team_json` (`playbook`, `playbookHash`). It
defines the hierarchy (Chief -> Lead -> Product/Test/Security/Reviewer/Dev), the
Lead as the single job owner, the one-issue/one-PR rule, the handoff protocol,
the progress heartbeat, and the current repository goal with role-specific
guidance for it. Saving a new goal refreshes the playbook; older instances are
also refreshed on the next job before dispatch. Iterate jobs go to the Chief,
which must pass the job block to the Lead verbatim; review jobs go to the
Reviewer only when the repository has enabled it. The Lead delegates to the
member whose scope fits and posts the final callback exactly once.

The admin page is ordered by the admin's work: Pending, Users, Jobs, Audit,
Release and Backups. The release facts and the release chain share one `Release`
section, and the section nav is a sticky underline tab row rather than a wall of
pill links. An empty release chain says it is expected and keeps the operator
command under a disclosure with a `<DATA_DIR>` placeholder, never the real host
path. The page owns the Users section at `/admin#users`; `/admin/users` is an
admin-only redirect to that section for older links and bookmarks, while
`/admin/users/:id` remains the read-only support view.

For a superadmin, the Release card also carries the one-click preview
(`src/lib/releaseDispatch.ts`): the current `main`, latest tag, commit/fix/
feature/fragment counts, computed next version, `ci-ok`, any open release PR and
the exact reason the action is blocked. `POST /admin/release` requires superadmin,
CSRF, a recent GitHub re-authentication, the destructive rate-limit class and an
audit row; it re-reads the preview and then dispatches the existing
`daily-release.yml` with `dry_run=false`. It never creates a tag, merges a pull
request or deploys a host. The server-side `RELEASE_DISPATCH_TOKEN` is repo-scoped
and never rendered or logged; an empty value disables the action instead of
failing the page. Release remains separate from deploy: production may already
run `main`, and the next infra update installs the version-bump commit after the
release PR merges.

The admin page is a hub, not an approvals-only page. Its primary sections are
Pending, Users, Jobs, Audit, Release and Backups; Product metrics, Webhook
deliveries, Deployments, Audit and jobs search and Preview trials are module
tiles at the bottom. Metrics and webhooks remain superadmin-only; the other
three are available to admins. The opening paragraph always names the role and
the audit logging, and carries no tool links.

### Team console and live events

The team console is admin-only. `GET /api/repos/:id/team/events` streams
Server-Sent Events: a full snapshot when the DSH revision, role activity,
questions, jobs or quota changes, plus a heartbeat. The browser uses
`EventSource` and falls back to the existing 5-second JSON poll on error.
Questions render inline with their options and a custom field;
`POST /api/repos/:id/team/answer` sends the DSH `answer-question` payload.
Normal users can talk to the Chief from the repository page without opening the
team console. Fledge sends the message and reads the Chief session transcript
from the DSH session export, keeping only human/Chief text, dropping Fledge job
prompts and masking tokens. `GET /api/repos/:id/chief/events` polls the Chief
session-turn signature and pushes new snapshots over SSE, with a 5-second JSON
polling fallback. The Chief remains responsible for routing work inside the
team, and every message is audited.
The same open questions are collected server-side from every ready instance and
shown as a Fledge inbox on `/console`, `/dashboard` and the repository page, so a
human can see and answer FlyBot's pending questions without opening the team
console. The inbox form posts to `POST /repos/:id/team/answer`, which uses the
same DSH call, marks the matching question notifications read and invalidates
the short-lived inbox cache.
`POST /api/repos/:id/team/stop` first tries DSH `stop-member-work` when the role
is in a room, otherwise it sends a stop message that takes effect at the next
safe point. The workspace shell uses the form equivalent
`POST /repos/:id/team/stop`, with the same authorization, audit and honest
hard-stop/request reporting. The UI reports the difference honestly; it never
claims a turn was paused when only a request was delivered. Every answer,
guidance and stop is written to the audit log.

The native DSH UI is exposed through the owner-accessible workspace; the Fledge
team console remains superadmin-only. The workspace uses a per-repository
authenticated path and a Fledge shell around the native UI (branded "Powered by
FlyBot"), with a short-lived ticket and server-side cookie injection so the raw
DSH token never reaches the browser.

### GitHub App onboarding and webhooks

The optional GitHub App removes the PAT from the common path. Fledge generates a
short-lived App JWT, exchanges it for an installation token, lists the
installation repositories and stores only `repos.installation_id`; `repoGithubToken()` prefers a user OAuth token authorized with `repo` scope for human attribution and otherwise uses a fresh installation
token when that column is set and falls back to the encrypted PAT otherwise. The
installation callback binds the installation to the logged-in user (verified
through the user's OAuth token or an individual account match). GitHub webhooks
are verified with `X-Hub-Signature-256` before parsing; verified events are
recorded in `events` for the follow-up loop. PAT onboarding stays available.

The JWT corrects `iat`/`exp` for the process clock's offset from GitHub's `Date`
header — the same measurement `/readyz` reports as `clock.skewSeconds` +
`clock.state` and `/metrics` as `fledge_clock_skew_seconds`. The offset is used,
not only surfaced (#758): a reading is `ok` for 15 minutes and inside 120 seconds,
`fail` above 120 seconds, and `unknown` when nothing was measured inside the
window. While it is `fail`, `/readyz` answers 503 and `Jobs.enqueue` refuses with
`CLOCK_SKEW` before any job row is written, so no run stores a time from a clock
nobody can trust; the JWT signs only in `ok` and otherwise raises
`CLOCK_SKEW_EXCEEDED` (`fail`) or `CLOCK_SKEW_UNVERIFIED` (`unknown`) instead of
signing from a stale or zero correction. A failed measurement reports `null` and
no series rather than a zero that would read as aligned, and it never replaces
the last reading that really was measured.

### Inbound email replies

When `INBOUND_EMAIL_SECRET` is set, the daily digest gets a
`Reply-To: <local>+<token>@<domain>` address and a reply hint. The inbound
endpoint verifies the shared secret, resolves the token to a user + repository,
checks that the sender is the user's notification email, strips quoted lines and
sends the remaining text to the Lead as guidance. Tokens live in `settings` with
a 7-day expiry. Cloudflare Email Routing + an Email Worker can post to the
endpoint; IMAP polling is not required.

### Job model token lifecycle

The bridge binds a job-scoped model token on `/run`. Fledge clears it on job
finish via `POST /job-done` (bridge token auth), and the model proxy retries
once with the instance token on a 401/403 from the gateway. This keeps per-job
cost attribution while avoiding a stale/revoked job token breaking later Chief
greetings, memory reviews or guidance turns.

### Dashboard lists and onboarding

The dashboard paginates repositories and jobs at ten per page; a repository page
and the team console paginate their job tables at ten per page, with the page
number clamped to the available pages. The shared job table is one markup for
every width: it lays out as a table from 641px up and, below 641px, each row
becomes a card whose cells carry their column name in a `data-label` attribute
(`public/app.css`, the `max-width: 640px` block). The cells therefore never sit
behind a horizontal scroll on a phone, and a new column must emit `data-label`
in `jobRows` to stay readable there. The rest of the data tables reuse the same
block through one class, `table-cards`: the `/admin` users and audit tables, the
dashboard repository table, the repository page's delivery and work-item tables,
and the support view's repository and job tables. Adding the class and a
`data-label` per cell is the whole change; a table must not grow a second card
mechanism. The delivery board is a compact summary of state links with counts
and shares, not a carded table; it wraps above the work-item list and each state
link filters the list. A share needs a denominator: with no work items at all
each state shows `—` rather than a confident `0%`. Above 640px the scroller is also bounded vertically
(`100dvh` minus `--header-h` and `--space-7`, and minus the repository
subnav's `--subnav-h` on a repository page) and its `thead th` is sticky on an
opaque `--panel`, so column names stay above the rows they label; the two rules
are one contract and `test/density.test.ts` asserts both. The row density is a
saved preference: `/density/:mode` writes the `fledge_density` cookie the way
`/lang/:locale` writes the language one, `<html data-density>` carries it (the
response hook fills it in from the cookie, so no page builder has to remember),
and `<html data-density="compact">` trims only the cell box. Below 641px the
bounded scroller and the density do not apply: the tables are the card stack and
the 44px touch floor stays.

The palette is request state for the same reason. `/theme/:mode` writes the
`fledge_theme` cookie the way `/density/:mode` writes the density one, the
response hook rewrites `<html data-theme>` and the `<head>` metas from it, and a
page builder therefore renders the inherited `system` default and nothing else.
The three choices are `system` (inherit the operating system), `light` and `dark`,
and `system` ships two media-scoped `theme-color` metas plus
`color-scheme: light dark` rather than one resolved colour, because the browser
chrome colour is chosen by a media query the server cannot evaluate. An explicit
choice pins one meta and one scheme. `src/views/theme.ts` owns the type, the
cookie name and the rewrite; `test/theme.test.ts` asserts the route, both
attribute states, the meta shapes, the 44px control and the two palette tokens
the sticky header and the account pill used to hardcode. Signed-out pages honour
the saved palette but render no control: the chooser rides inside `#main-nav`, so
below 961px the compact header's panel carries it and the phone row gains no
child. Between 641px and 960px a wide data table can still be wider than its
`.table-scroll` box, so that band draws an always-present classic scrollbar — an explicit track
plus `scrollbar-width`/`scrollbar-color` for Firefox — instead of relying on a
thumb that is 1.5:1 on the panel. The band has its own
`(min-width: 641px) and (max-width: 960px)` block in `public/app.css`; the cards
below 641px and the table above 960px are unchanged. The band's column control is
built by the script from the table itself: every `table-priority` carries an `id`
and an `aria-label`, the button points at that id with `aria-controls`, and its
label repeats the table's name (`Show all columns — Users` / `显示全部列（用户）`),
so the three controls on `/admin` are not announced identically. A new priority
table must bring both attributes; without them the control is created unnamed and
the association is lost. Add repository presents two explicit
alternatives: the GitHub App installation path (recommended) and a collapsed
fine-grained token form; users pick one, not both. The App repository picker
carries the same task template, goal, auto-iterate interval and reviewer
settings as the token form, so both paths configure repositories identically.
Long help text is shown through compact `!` info icons on hover/focus.

### Team observation and effectiveness

`teamState` now exposes each role's current tool/step, start time and last
activity, plus a recent active/ended timeline. The team console renders the
tool, elapsed time, a stale warning when an active job has no role activity for
five minutes, and a recent-activity list; SSE updates it every second. When a
job finishes, Fledge captures a per-role call snapshot into
`jobs.team_stats_json`. The admin metrics page aggregates those snapshots into
jobs with stats, average participating roles, Lead-only jobs and calls per role,
and the job page shows the same per-role table.

### Delivery metrics, job timeline and learning ledger

`jobs` remains the source of truth. Every lifecycle transition now also writes a
`job_events` row (`job.enqueued`, `job.running`, `job.progress`, `job.succeeded`,
`job.failed`, `job.merged`, `job.postmortem_failed`, `job.after_commit_failed`,
`stage.missing`, `team.role`),
so a job can be
replayed without reading DSH memory. `team.role` events persist the per-role
calls, tool and last activity that used to exist only in the final
`team_stats_json` snapshot.

Once a job is bound, every log line it writes carries the job id under one key,
`trace`, as that job's `job_…` id: the service lines, the bridge handoff in
`src/jobs/flybot.ts`, the mock runner and the gateway usage line. The binding
starts when the job row is inserted, so the dispatch preflight lines before it —
`team playbook not refreshed`, the team-session refresh warning, the bot-model
warning and their queued twins — name the repo and the error but no job, even
though an id has already been allocated for the attempt. A runner receives the
bound logger on `RunnerContext.log` instead of rebuilding the field, and the
gateway only adds it when the call was made with a job token — a user's own
request has no job in scope. The job page prints the same value next to the
timeline as the token to search, and it is the `job_events.job_id` of that job,
so one search returns the whole job. Pass-level lines (a scheduler pass, the
shutdown check) have no job in scope and deliberately carry no `trace`.

The repository page adds a compact delivery board grouped by work-item state; each state tile links to a filtered work-item list (`?workState=`) and shows its share of the total, or `—` while the board has no items and there is nothing to divide by. The work-item rows keep their actions behind one disclosure, and the create form is a header button and dialog. The dashboard has two scopes. `/dashboard?window=7|30` shows the signed-in
user's own delivery metrics: jobs, success rate, PRs, merged PRs, cost, open
work items and the last job. `/admin/metrics` shows the global window with the
product funnel, delivery efficiency (success and merge rate, median job and
merge duration, review duration and score), cost by repository and by model,
daily trend buckets, and current alerts. Alerts are localized, sorted by severity, and link to the affected repository or job; the dashboard shows the same alerts scoped to the signed-in user. Missing values render as `—`, never as a confident zero.

The repository page's Delivery section also carries `#review-trend`, one row per
fixed window (7 and 30 days). `Store.reviewTrend(repoId, sinceIso)` is a read
model over rows the platform already stores — completed review jobs for the
score, the recorded model and the PR link, `work_items` for when the pull request
was opened and merged, and the `work_item.review_outcome` audit row for the
outcome. The audit row, not the work item's state, is the outcome: a review that
asks for changes moves the item to `changes_requested` and the next fix moves it
on, so the current state would lose exactly the rework the trend is meant to
show. There is no new table and no new job; the route computes the two cut-offs
and the store returns one window each. A window with no review renders `—` in
every cell with an empty-window sentence, the changes-requested rate prints its
own denominator (`50% (1/2)`) or `—` when no review recorded an outcome, and
fewer than `REVIEW_TREND_SMALL_SAMPLE` (5) reviews are shown with a
`Small sample n=<n>` badge rather than smoothed into a trend. What each cell
means is fixed in [ui.md](ui.md).

The identity of a decision travels with it. The `work_item.review_outcome` row
names the review job, the score, the model that answered and the tip that review
covered (`formatReviewOutcomeDetail`/`parseReviewOutcomeDetail`, in `src/db.ts`
beside the trend that reads them). A row written before those fields existed
still parses, with the newer fields unknown, and the page says `revision not
recorded` rather than printing a hash or an id that belongs to nothing. The
PR→first-decision median takes one sample per work item, at its first successful
review, so a PR reviewed four times is one first decision and not four; the
override rate is `overrides / recorded changes-requested decisions` in the same
window, its numerator being merges that named such a decision and went ahead.
A threshold-only block is derived at merge time and has no decision row: its
override is audited on the job page but has no denominator here, and the card
says so rather than folding it into a rate it cannot explain.

`GET /api/read/metrics` exposes the same read model as JSON for an external
control room: a normal user gets `personal`, a super admin gets the global sections.
The route is read-only and session-scoped.

The evolution ledger is intentionally separate from the job path. It adds
`artifact_versions`, `evaluations` and `promotions`: an artifact candidate, its
held-out evidence, and a human-approved decision. AgentDescent is an offline
engine behind this ledger; it never runs a user repository, never receives a
GitHub token and cannot change the evaluator, CI or merge gate. See
[decisions/0003](decisions/0003-agentdescent-evolution.md). The read-only
`scripts/evolution-shadow.ts` exporter turns recent jobs into one dataset with a
manifest. The manifest records the `ds_` id, the selection (`days` and the
applied `limit`), the repositories, `rowCount`, the effective
`trainRows`/`holdoutRows`, the `split.train`/`split.holdout` job-id arrays, the
holdout's protected entries, and a `window` that is provenance only: nominal
`from`/`to` bounds plus `oldestRowAt`/`newestRowAt`, the real coverage of the
rows that were written. The bounds are anchored on `newestRowAt` unless the
caller passes an explicit `now`, while the exporter's SQL bound is the
wall-clock `now - days`; they are the requested extent, not a claim that the
rows reach it. `--limit` truncates to the newest N inside `--days`, so
`oldestRowAt`/`newestRowAt`, not the window bound, say how far the export
actually reaches.

`contentHash` is sha256 over the selection, the split and the canonical, redacted
rows; the window, the id and the hash itself are outside the hashed object. `id`
is `ds_` plus the first 16 hex characters of that hash, so the same rows and
parameters produce the same hash twice. `--verify <file>` recomputes the split
from the records, the hash and the id, and refuses with `SPLIT_MISMATCH`,
`MANIFEST_MISMATCH`, `CONTENT_HASH_MISMATCH`, `DATASET_ID_MISMATCH` or
`MALFORMED_DATASET`; a moved job id fails even if someone recomputes the hash.

The split is repository-disjoint first: the newest 20% of rows by time only
chooses which repositories are held out, and every row of a repository named in
that tail moves to the holdout — so the holdout share can exceed 20%, and a
holdout row can be older than a train row. `#426`–`#432` read the split from the
manifest rather than assuming its size. The exporter refuses with
`NO_TRAINING_ROWS` and writes nothing when the split would hold out every row,
for example with a single consented repository. Every exported string passes
through `redact()`, and the exporter reads only repositories that opted in
through the audited `evolution.consent` command; consent is off by default.
`--report` prints the baseline and the manifest's own split counts; the export
does not write to the database.

The ledger's shape is the table that already existed, extended rather than
replaced: `artifact_versions` gains `kind`, `scope`, `repo_id`, `parent_id` (the
lineage edge), `base_version`, `frozen` and `paths_json`, and one new table
`artifact_pointers` holds what `dev` and `stable` point at, because a pointer is
not a version. A candidate write is a compare-and-swap against the head of its
own lineage, so a candidate built on a stale version is refused rather than
re-based; a candidate naming a frozen path is refused before it is stored and
the refusal is audited (`evolution.candidate.refused`); and a rollback moves the
pointer, which keeps both versions readable. The eligible artifacts, in risk
order, and the frozen paths are data in `src/lib/evolution/artifacts.ts`, so the
set is reviewed as a list rather than inferred from branches; the frozen set
includes the stage gate (`src/lib/stages.ts`) and the merge gate
(`src/jobs/service.ts`), and a candidate path is normalised before it is matched
so `./src/auth/session.ts` and `src/jobs/../auth/session.ts` cannot walk around
it. The migration fills one `stable` pointer per promoted artifact rather than
one for the whole table.

### Failure categories and recovery guidance

A failed job carries a stable category derived from its error (`quota`,
`credential`, `stage_evidence`, `stalled`, `timeout`, `bridge`, `review`,
`workflow`, `github`, `model`, `unknown`). The job page renders the category and
a concrete next step: re-authorize GitHub, open Settings, refresh the repository
or retry. The raw error stays available under "Technical detail" for operators.
The admin metrics page aggregates the same categories for the selected window.
The classifier lives in `src/lib/failure.ts`; it does not change job state or
hide the original error. A dispatch that never reached the bridge is stored as a
`FlyBot bridge ...` error by `src/jobs/flybot.ts`, so it lands in `bridge` rather
than `unknown`: that message is the only place the failing component is known,
and it keeps the transport cause inside it. Because the preserved cause can
itself name a timeout, the `bridge` pattern is matched before `timeout` — a
dispatch that the bridge did not answer is an instance problem, not a task that
ran too long. The bridge URL is stored by origin and path only, so a token in
its query or userinfo never reaches the job row or the job page.

A failure also carries a stable **code** in `jobs.error_code`, written by the job
service where the failure happens. Ten codes are written to a row today:
`JOB_STALLED`, `JOB_LEASE_EXPIRED`, `JOB_TIMEOUT`, `QUOTA_EXHAUSTED`,
`STAGE_EVIDENCE_MISSING`, `BRIDGE_ERROR`, `REPO_DISABLED`,
`PROVIDER_BUDGET_EXCEEDED`, `PROVIDER_RATE_LIMITED` and
`PROVIDER_CALL_NEVER_STARTED`. Three more are in the vocabulary but have no
writer: `REPO_CREDENTIAL_INVALID`, `JOB_BUDGET_EXCEEDED` and `DUPLICATE_WORK`
name refusals that stop an enqueue before a job row exists, so they travel on the
redirect instead (below) and are reserved for a row if one of them ever finishes
a job.

A provider refusal is not a bridge outage and not a stall, and it is stored as
neither. `/run` answers a refused send with `502 {error, detail}`, where `detail`
is the DSH answer to the send (a used-up budget, a zero remaining rate limit);
the runner keeps that text in the dispatch error and the service stores it with
the provider code instead of `BRIDGE_ERROR`, which is a transient category. The
retry policy refuses `PROVIDER_*` as well: retrying against the same exhausted
budget only burns the slot. When the send was accepted and the session still
never called the model, nothing about the provider reaches Fledge — the DSH
`state` surface carries per-session call counters but no error text — so the
stall sweep reads `state` once with a 5s bound before it fails a silent job: a
role session whose turn ended with zero model calls is reported as
`PROVIDER_CALL_NEVER_STARTED`, and anything else stays `JOB_STALLED`. A failed
state read changes nothing; the job keeps the heartbeat sentence.

The code, not the text, decides the sentence a reader sees: `failureSentence`
(`src/lib/failure.ts`) builds it in the reader's language for the job-page
summary, the dashboard summary and the notification list, and the category above
is the code's kind. The regex classifier stays only for rows written before the
column existed. `localizeMessage`'s exact-match dictionary remains the fallback
for a message no code covers — which is why a new failure adds a code rather than
a dictionary row.

A refusal carries its code too. The job service answers an enqueue it will not
start with one of the codes in `ENQUEUE_REFUSAL_CODES`, and the route puts that
code on the redirect with the payload after a colon. Every code in that tuple has
a sentence in `REFUSAL_SENTENCES`, in both languages, and the table is typed
`Record<EnqueueRefusalCode, [string, string]>`: a new return that is not declared
fails typecheck, and a declared code with no sentence fails it too. The banner
asks the sentence table first and ignores the service's payload except for the
placeholders the sentence declares — the code's own parameter where it has one
(`BRANCH_MISSING:main`, `JOB_LIMIT:2`, `BOT_MODEL_ASSIGNMENT_FAILED:chief, lead`)
or `{detail}` for the duplicate-work refusal, which names the pull request that
already covers the issue (`DUPLICATE_WORK:<url>`). That is why
`INSTANCE_NOT_READY` and `PREFLIGHT_FAILED` can no longer put an exception's
host, port, error class or status in the URL or the banner: their entries have a
fixed sentence, and the upstream text stays only in the audit row and the job
row. A work-type mismatch has its own code (`WORK_TYPE_MISMATCH`, with
`<kind>/<type>` as the detail) rather than reusing `UNKNOWN_WORK_TYPE`.

A refusal that names a pull request (`DUPLICATE_WORK` for work in
flight, `ALREADY_FIXED` for a fix that landed) renders that value as a link, so the
maintainer opens the pull request the refusal came from instead of copying a URL out
of the sentence; the anchor is built only for a `github.com` pull request URL,
because the banner value arrives as a query parameter and any other value stays
escaped text. A value that is not a code still goes through the dictionary, and only a bare code with neither a sentence nor a text
renders a sentence naming the code, so an unknown value cannot leak. The raw text
stays in `jobs.error`, under "Technical detail"
and in the notification row, for operators and for the API, and "Technical
detail" prints it as written rather than translating it. The choice is
recorded in `docs/decisions/0009-job-failure-codes.md`.

### Postmortems and recurrence

A failed, stalled (a failed job with `JOB_STALLED`) or cancelled job writes one
`postmortems` row from the same guarded terminal transition that writes its
`job.*` event, so a replayed callback cannot create a second write-up and a
succeeded, queued, running or paused job writes none. `src/lib/postmortem.ts`
derives the category from the existing failure classifier and records evidence
from fields that already exist: the error and code, the last heartbeat, the job
stage, the repository instance's status and last error, and the `job_events`
timeline. A suspected cause is stated only when an error or code exists. A row
with neither is `unverified` with a null cause; it is not guessed.

The management cancel path commits the job, its receipt and its audit row in one
transaction. The postmortem write opens a transaction of its own, so on that path
it runs as an after-commit step, once the receipt transaction has returned
(#616): a cancel whose transaction rolls back writes no postmortem, and a
committed cancel can no longer lose the row to a nested `BEGIN`.

A postmortem write that still fails leaves a durable trace instead of only a log
line (#666): `job.postmortem_failed` in the job timeline, naming the job and the
error class, so a missing row is findable and repairable. The after-commit step
itself is guarded at both call sites — `cancelJob`'s direct path as well as the
management receipt path: a callback that throws cannot turn a command whose
transaction has committed into an error for the caller, and the escape is
recorded as the `management.command.after_commit_failed` audit action on that
path and as `job.after_commit_failed` in the job timeline on the other. A trace
that cannot be written is logged and never fails the command it describes.

The recurrence key is a hash of the category and the stable error code, or of a
normalised error sentence when no code exists (job ids, URLs and numbers are
removed so two sightings of one cause land on one key). `postmortem_recurrences`
holds one ledger row per key with the count, first/last seen and the affected
repositories. A second sighting increments the count and emits one `ops`
notification plus a `postmortem_escalated` event; later sightings keep counting
without escalating again.

A preventive action is `test`, `guard`, `doc` or `config` plus a reference to the
PR, issue or test that prevents the cause. `Store.linkPreventiveAction` records
it without closing the postmortem; `Store.verifyPreventiveAction` refuses unless
a linked action exists and, when the action lands, marks it verified, sets
`status = 'closed'` and stamps `closed_at`. The repository page lists open
postmortems and the recurrence ledger; the job page links the one postmortem for
that job (`#postmortems`), never a duplicate.

### Enforcement: path guard, evidence verification and merge readiness

Plan path constraints are now enforced, not only included in the prompt. After a
successful iterate callback and again before merge, Fledge reads the pull
request's changed files and matches them against the job's allowed and denied
paths (deny wins; an empty allow list means no allow restriction). A violation is
stored on the job, notified, audited and blocks the merge. The delivery list
shows the changed files that caused the block.

The changed-file listing is capped at 30 pages (3,000 files). Fledge keeps paging
until it has the count the pull request itself reports; when it cannot, the list
is marked incomplete and that is a refusal, not a pass: the guard is not ok, the
job page prints the examined-versus-reported counts instead of the all-clear, and
the merge is blocked with the truncation named. Guard rows written before those
counts existed keep the old sentence for them and gain the counts on the next
re-check; nothing rewrites history.

The same pass records a verification snapshot: PR state, head SHA, check runs,
combined commit status, reviews, claimed test evidence against the check runs,
and the reasons a merge is not ready. Test evidence counts only a check whose
name identifies a test job (`test`, `tests`, `spec`, `specs` and the common
runner names, matched on word boundaries) whose conclusion is `success`:
`skipped` and `neutral` are completions without a verdict, so they leave the
evidence unverified rather than contradicted, and a claim that no test check
supports blocks the merge with "Test evidence is claimed but no test check
passed." A claimed green test with a failing test check is contradicted and
blocks the merge. The job
page and the delivery list show `ready`, `blocked` or `not verified`, and
`POST /repos/:id/jobs/:jobId/recheck` refreshes it on demand. `ready` requires
both halves of the evidence: a path guard that passed and a verification
snapshot that passed. A row with only one of them reports `not verified` and
names the half that never ran, because a refused merge leaves exactly that shape
(`tryMerge` stores the guard before it verifies). Verification never
replaces the merge gate's own re-check at the tip. The evidence row inside the
card carries that combined verdict rather than the PR evidence alone, so a pull
request the path guard blocks never renders as evidence passed; the row names the
guard as the reason its claim was lowered.

### The independent adversarial review

The last gate before an automatic merge is a second read of the same change by a
model call that shares no context with the agent that wrote it
(`src/lib/adversarialReview.ts`). Fledge assembles an `AdversarialPacket` from
named fields only — base sha, tip sha, the pull-request patches, the verifier
result at the tip and the repository policy — so the author's summary and its
claimed test output are not in the request at all; a caller that still holds them
cannot pass them through. Each automatic merge attempt records one
`job.adversarial` event with the model, the prompt hash, the base and tip sha and
the evidence the reviewer saw. The job page reads the tip back beside the hash,
so a verdict cannot be read against the wrong revision; a record written before
the reader carried the tip says `revision not recorded` instead of printing a
hash with no revision.

The answer must be one of two shapes: `Concrete risk: <path>:<line>` with a
failure mode and a repro, or `No concrete risk` with the checks it ran. A bare
score is rejected as not a review. A concrete risk blocks the automatic merge
with the page naming the file and line; the next run that clears it merges
normally, and a maintainer merging by hand keeps that decision.

The pass is granted only when it read the whole change. A diff cut at
`MAX_DIFF_CHARS`, a changed-file listing the client reports incomplete, or a
changed file that arrives without a patch is a refusal that names the omission
and is recorded as `incomplete` — never a `skipped` pass with no block, and never
a `partial` outcome that still merges (#556). A 100 %-similarity rename is the
one patch-less shape that is not an omission: it has no hunks to read, so it is
not withheld text, and a change that renames a file beside readable ones is
reviewed on its readable half and merges (#566). It is still not a way past the
gate: a change whose every file is a hunkless rename, or one that pairs a rename
with nothing but allowlisted assets, refuses through the nothing-readable branch
below, because a pure path move is how a change can be disabled without a diff to
read. A patch-less file inside the
binary-asset allowlist (`png`, `jpg`, `jpeg`, `gif`, `webp`, `ico`, `woff`,
`woff2`, `ttf`, `eot` under `public/` or `docs/`) is recorded as unread and may
merge, because a screenshot cannot be read by a text model and refusing it would
block a class of change this gate never judged. An unconfigured platform model or
a model error stays fail-open with a recorded reason, because a change cannot
cause it, unless the pass already knows it could not read the change: a cut diff
is refused whether or not the model answered. Fledge does not invent a risk, and
it does not treat a number as proof: the job page says which of the outcomes
happened — a refusal is reported as `incomplete` with the omission it found, not
as a risk at a file and line — with the model and the prompt hash.
A review job still runs in its own Reviewer session for the normal score; this
pass is deliberately a separate context, not a second report from the same one.

### Retry policy and capacity

`src/lib/retry.ts` classifies transient failures (bridge, model, GitHub,
timeout, stalled) separately from permanent ones (quota, credential, stage
evidence, workflow, review, path). A transient failure schedules at most two
durable retries with 1 and 2 minute delays, stored under `retry_pending:` in
settings; the scheduler releases a due retry only when the repository has no
active job and its instance is ready. A `review` job gets a narrower policy of
its own: only `bridge`, `model`, `timeout` and `stalled` are retried, at most
once per failed review, with the same 1-minute cooldown and 30-minute cap and the
same pull request and work item; a review that already recorded a
`review_score` is never retried automatically, because its verdict is already
posted. `summary` is the job's progress line, written on every running heartbeat,
not a post marker, so it does not block a retry; it and `error` pass through
`src/lib/secrets.ts` before the row is written and again when the page renders
them (`docs/decisions/0015`).

Identifier masking is the other half and lives on the sink, not in `redact()`:
`src/lib/log.ts` masks an account identifier in every line it writes — by shape in
every string value, by field name for a login the shape cannot see, and through
nested objects and arrays — while the row, the inbox and the job page keep the
real value the operator acts on (#694). `maskEmail` and `maskIp` are in
`src/lib/redact.ts` and are imported back by `src/views/pages.ts`, so a page and a
log line cannot drift onto two masks. If a review posted its comments
and then lost the terminal callback, nothing stored tells that apart from a
review that never posted; that residual case is manual. `github`, `quota`,
`credential` and `review` failures stay manual.
Permanent failures stay manual. Platform
concurrency is `PLATFORM_MAX_ACTIVE_JOBS` (default 2), not a hard-coded literal.

### Metrics, traces, shutdown and webhook replay

`/metrics` exposes Prometheus counters, gauges and histograms for HTTP, jobs,
retries, merges, path guard, evidence verification, GitHub and the bridge. The
token is read from `Authorization: Bearer <token>` only — never from the query
string — and compared in constant time. A production process refuses to start
without `METRICS_TOKEN`, and refuses a `NOTIFY_WEBHOOK_URL` that is not an
absolute `https:` URL, because that webhook carries the alert payload and its
bearer secret; the loopback fallback for an empty token is development/test
only, judged on the peer the trusted `TRUST_PROXY` hop saw. The refusal lands in
`buildApp()`, which `src/index.ts` calls unguarded. Optional OTLP/HTTP JSON
tracing is enabled with `OTEL_EXPORTER_OTLP_ENDPOINT`; HTTP requests, GitHub
calls and bridge dispatches emit spans.

Shutdown stops the scheduler, waits up to `SHUTDOWN_GRACE_SECONDS` for active
jobs, closes HTTP, flushes traces and closes SQLite. Startup removes orphan
retry/follow-up settings, orphan job events and instances.

A per-job budget is enforced according to `repos.job_budget_action` (`alert`, `pause` or `cancel`); `docs/quota.md` describes the checkpoint where a stop is applied and why an unknown cost is never compared. Open operational alerts are delivered to the repository owner in-app and via the optional notification webhook on the scheduler tick, with `OPS_ALERT_COOLDOWN_MINUTES` deduplication. GitHub calls go through a per-token budget (`GITHUB_REQUESTS_PER_MINUTE`) and
honor `Retry-After` / `X-RateLimit-Reset` before retrying. GitHub webhooks are
claimed by `X-GitHub-Delivery` in `webhook_deliveries`; a duplicate is a no-op
and a failed delivery can be retried. Opening checks or approving a review
triggers an auto-merge reconcile, and the scheduler re-checks open Fledge PRs at
most every `AUTO_MERGE_RECONCILE_MINUTES`.

### Scheduled work, continuity and work items

Work items are a tracking board, not a second scheduler lock. No work-item state
blocks a scheduled iterate job: the only blocks are an active job for the same
repository, a failing credential and a duplicate issue (#219, #238). A job that ends `failed` or
`quota_exhausted` returns its `assigned`/`in_progress` work item to `triaged` so
a later schedule can pick it up, and both edges are in `WORK_ITEM_TRANSITIONS`,
so the manual status endpoint and the work-item board offer the moves the
service itself writes.

A due repository with open work is never skipped because the item exists.
`decideNextJob()` carries the highest-priority open item into a `followup` job,
or a `review` when the item has a PR and a maintainer reviewer is due. Within
one priority the oldest item wins: the board and the scheduler use
`priority DESC, created_at ASC`, so a recently edited item cannot jump ahead of
one that has waited longer. With no
open work it returns `none` with reason `idle`: the scheduler writes
`last_status='idle'` and creates no job, issue or PR. When the repository's
discovery interval is due, it may instead run one `discover` job; that job may
create at most one concrete issue (never a PR/branch), and if it finds nothing
concrete it creates nothing. The callback refuses a discovery result that carries
a branch or pull request (`DISCOVERY_PR_FORBIDDEN`). A discovered issue does not
create a work item by default; with `AUTO_PROMOTE_DISCOVERY` enabled, a
`succeeded` discovery whose result is a concrete issue creates one `proposed`
work item through `promoteDiscoveredIssue`, deduped by issue URL and capped per
repository per UTC day: the counter is keyed `discover-promote:<repoId>:<day>`,
while the cap's value comes from the deployment-wide
`AUTO_PROMOTE_DISCOVERY_DAILY_CAP`. A result the run digest classifies as a backlog report
is not promoted, and a failed run never promotes. It never creates a branch or a
pull request. The job goal gets a bounded
`Carry-over` block with the last three run digests and up to four open items; the
block is data, not an instruction, and is capped well below the 4000-character
goal limit. Every line that names an issue or a pull request is checked once
before the block is built — at most seven reads, three digests plus four work
items, one per line because a line that names both is governed by its pull
request — so a closed issue or a merged pull request is dropped from the block
and counted instead of being carried into the next run. The block states what it
did in its header, `carry-over: 1 used, 1 dropped (closed/merged)`, with an
`, N unverified` segment when a read failed; a failed read keeps its line rather
than dropping it silently, and the job page shows the same header line. Since
#790 a carried line that names no issue and no pull request is the fourth case:
it stays in the block as context, costs no read, and is labelled
`unverified (no link)` on its own line and counted in an `, N unlinked (no link)`
header segment (the `unlinked` field of `jobs.carry_over_json`, a subset of
`used`). The continuation instruction names only a line whose artifact was
observed live and says an unlinked line is context, not a continuation
instruction, so a prose digest from an earlier run is not offered as open work.
Since
#788 each carried line also states the observation it rests on, `observed
07:12Z open`, from the read that line already spent — a failed read says
`observed unverified` and claims no time — and the per-link `{state,
observedAt}` is stored with the job in `jobs.carry_over_json`, so the page reads
the observation back instead of re-deriving it. A pull request that was closed
without merging is `closed`, not `open`, so the header's `(closed/merged)` is
true as written; a job row written before that column says the observation was
not recorded rather than borrowing a time.

Since #789 the decision that produces the run is evidence-linked too:
`decideNextJob()` is async and takes the same reader, so the chosen item's link
is read after due-ness (a held-back repository costs no read) before it can
become a `followup` or a `review`. A `closed` or `merged` answer turns the
decision into a fresh `iterate` on the repository's own goal — no goal override
and no `work_item_id` — and the stale row is marked with the state that was
observed once the run exists, so the next tick does not choose it again. An
`open` answer, a read that failed and an item that names no link all keep the
previous behaviour: a failed read saw nothing, so it is not evidence that the
work is finished.

The goal also carries one **temporal delta** line (#366), built by
`summariseDelta()` in `src/lib/temporal.ts` from two reads plus the commit
lookup that dates them, all against the previous finished run's base:
`compareCommits()`, `getCommitMeta()` for that base's `committedAt`, and then
`listMergedPullRequestsSince()` for that window. The base comes from
`store.latestFinishedBaseSha()`, one indexed question rather than a page of the
newest jobs, so a repository whose newest rows are all unfinished is not read as
a first run. A `superseded` row is never that base: `#839` sets both its `status`
and its `finished_at` on a mention-replaced job that never ran, so the query
excludes it in both directions — it is not an answer on its own, and it does not
hide a real finished run beside it, whichever of the two finished last. The line
names the short
previous base, the commit count and the merged pull requests, for example
`Since 4f2c1a9: 3 commits ahead, 2 merged PRs (#812, #815)`; a first run says
`Since: no previous run` and makes neither read. A failed compare prints
`delta unavailable (partial)` and a capped page walk prints `merged PRs partial`
— never the smaller number that happened to fit — because a delta that
understates the change is worse than one that admits it is incomplete. The
result is stored in `jobs.temporal_json` (`sinceSha`, `status`, `aheadBy`,
`mergedPrs`, `complete`), the additive column that lets a later slice compare two
deltas, and the job page shows the same line — and renders nothing for a row
whose fields are not the shape the summariser reads. The line is placed before
the 4000-character cap is applied to the goal body, so a long goal cannot squeeze
it out. Nothing reads the delta to make a decision yet; slice 1 only records and
displays it. Each finished run is classified as `pr`, `issue`, `review`, `zero`,
`meta` or `failed`. A meta issue
(`存量/盘点/清账/reconcile/inventory/backlog audit`) is closed on the tracking
board and notifies the owner instead of counting as a productive run. Two
consecutive failed, zero-output or meta iterate runs double the effective
cooldown up to a 4x cap; the manual run path and reviews bypass the backoff.

### Work types and triage

A job carries two independent values. `kind` is the pipeline that runs it
(`iterate`, `review`, `plan`, `scope`, `verify`, `discover`, `triage`);
`work_type` is the contract the work is held to and is stored on the row. The
registry in `src/lib/workTypes.ts` is the only list of work types — `iterate`,
`triage`, `dependency`, `security`, `docs`, `performance`, `accessibility`,
`migration` — and each entry declares its allowed stages, the evidence keys it
requires, a declared risk tier, whether it may open a branch and whether its
pull request may auto-merge. A work type declares no budget of its own: the
per-job cap is the repository's `repos.job_budget_cny`, enforced once at the
checkpoint described in `docs/quota.md`, and a second number shown on the
work-type card could not bind. Only `iterate` and `triage` have a handler in
this slice; a declared type with no handler is refused at enqueue exactly like
an unknown one (`UNKNOWN_WORK_TYPE` / `WORK_TYPE_MISMATCH` / `WORK_TYPE_UNSUPPORTED`), because nothing
may run under a contract that is not enforced.

Auto-merge reads the registry. The gate is still the repository's `repo_role`,
`auto_merge` setting and a green tip, plus `workTypeMayAutoMerge(job.work_type)`,
so a dependency, security or docs job cannot inherit iterate's eligibility. The
registry can only remove eligibility, never grant it.

`triage` is read-only, and that property is in the credential as well as in the
callback: a triage job's `/credential` read mints a GitHub App installation token
scoped to `contents`, `issues` and `pull_requests` **read** (`TRIAGE_TOKEN_PERMISSIONS`),
and refuses with `TRIAGE_READ_ONLY_TOKEN` when only a user token exists, because
that token cannot be narrowed. The callback refuses a result that carries a branch
or a pull request (`TRIAGE_PR_FORBIDDEN`), and a success without a valid report
fails as `TRIAGE_UNVERIFIED`. Every link on the report is checked against the
repository's own issue URL parser before anything is stored, so a board cannot
point a reader at another host. The report is a ranked list of open issues with
`duplicateOf` links, stored as `triage_json` and rendered on the job page
together with the work type's contract. Its first row is written as a work item,
which is the same path the next scheduled work session already consumes, so a
triage run proposes work without opening a branch and without a second scheduler.
The decision record is `docs/decisions/0014-work-types.md`.

The kind and the work type are checked as a pair in both directions: a `triage`
run cannot be declared as another work type, and no other kind can borrow the
triage contract, so the page can never show the iterate contract for a run that
is forbidden to write. Resume and retry read one shared rule instead of a
ternary: a row keeps its own kind when that kind's contract does not depend on
the row being re-enqueued (review, plan, triage), everything else runs as
iterate work, and a declared work type that is not what the new kind implies
travels with the re-enqueue so a contract with no handler is refused rather
than re-labelled. A failed triage row therefore comes back as `kind='triage'`.
What a triage row can never do is start itself: this slice has no route, form
or scheduler branch that enqueues `kind='triage'`, so `triage` rows come from
the service and from retry only; the console control that starts one is tracked
in #523. The report itself is strict: an issue URL must carry a host
(`https://` alone is refused) and a title over `TRIAGE_TITLE_MAX` is refused
rather than shortened, because a cut title reads like the issue's real one.
`triage` is also a filterable kind: it is in the dashboard's
`JOB_FILTER_KINDS`, offered by the dashboard, the search and the admin search
forms, and applied by `/search` as a value the user chose — a kind that matches
no job returns nothing rather than dropping the filter and answering with every
job. The dashboard applies the opposite rule to a kind no job can carry:
`parseJobFilters` drops the value, so `/dashboard?kind=<unknown>` answers with
every job. Both are intended, both are pinned end to end, and the difference is
the page's job: a search asks a question and may answer "nothing", while a
dashboard filter narrows a list that exists without the filter. `discover`
stays out of it because an account never starts a discovery run by hand. The
search form also renders a kind that is applied but not offered — `discover`, or
a token no job can have — as the selected option, so the page never claims
全部类型 / All kinds while the query narrows by something else. That option is
render-only: the list the form offers does not change, the applied value is
escaped like any other query text, and `JOB_FILTER_KINDS` keeps `discover` out.

### Platform emergency stop

The stop is one `settings` row (`platform.stop`: when, who, why), not a field on
the `Jobs` object, so a restart cannot resume scheduling from a stale in-memory
"open" and a second process reads the same answer. `enqueue()` reads the row on
every call and refuses `PLATFORM_PAUSED` before the work-type resolution and the
per-repository and per-role gates, so a stopped platform never answers with a
work-type refusal; `tickOnce()` reads it once per tick, after its cleanup (stale jobs,
expired leases, token pruning, instance health) and before anything that creates,
dispatches or merges work — the follow-up release, the due retries, the auto-merge
reconcile, the queue dispatch and both scheduling loops. The admission check is
what covers a due repository, which reaches `enqueue()` without a route.

The drain is bounded in two places: the stop request itself drains 5 active jobs
because the operator waits on it, and every following tick drains up to 25 more
before its own return, until no job is active. Running jobs with a reachable
bridge are paused so their checkpoint survives, the rest are cancelled with a
terminal reason, and every drained job loses its platform token. The pass that
empties the remainder writes `platform.drain_complete`; a pass that still leaves
work writes `platform.drain_incomplete` with the count. A resume deletes the row
and reports the repositories the tick will consider (`nextTickDue()` is a read: it
makes no bridge call and no enqueue); it does not replay the set the stop froze.

`/admin` renders the row on every request, above the panels: who stopped the
platform, when, why, and the resume action. The stop route's `?notice=` line is a
one-shot report and is gone on reload; the banner is the durable answer, so a
second admin sees the same state. A row that cannot be parsed still renders the
banner and says the record is unreadable, because that row still stops
scheduling; it never renders a blank operator or time as if they were facts.

### Team session reconciliation

A DSH restart can create new session IDs for the Chief and role bots. Fledge
reads the live DSH `state`, maps the current Chief/Lead/Product/Test/Security/
Reviewer/Dev sessions, and updates `team_json` plus `chief_session` when they
differ. The reconciliation runs after a healthy probe and immediately before job
dispatch, and it is audited as `flybot.team.sessions_refreshed`. If any role is
missing, the stored team is left untouched.

### Bot model assignment

Applying a provider model rewrites the DSH provider patch and updates every role
bot. A skipped or failed `update-bot` keeps `models_dirty=1`, records
`flybot.bot_models.failed` and returns `BOT_MODEL_ASSIGNMENT_FAILED`; Fledge does
not report a successful model switch while a bot still points at the previous
provider. Bot models are also reconciled after provisioning and before job
dispatch, and a mismatch blocks dispatch with the same code rather than starting
a job that would stall.

### Webhook delivery console

GitHub webhook deliveries are recorded in `webhook_deliveries` with a bounded
payload, repository name and installation id. A superadmin can open
`/admin/webhooks`, filter by status/event, inspect the error and retry one
failed delivery from its stored payload. Retry is CSRF-protected, audited and
does not render the raw payload in the table.

### Agent workspace

The owner-accessible workspace is path-based to avoid a wildcard certificate:
`https://fledge.hugoxk.online/repos/:id/workspace/`. The shell is Fledge-branded
and embeds an iframe on `/repos/:id/workspace/app/`. That path is a same-origin
reverse proxy to the repo's DSH web port: Fledge checks the session and repo
ownership, reads the latest DSH token from `dsh-web.log`, obtains the DSH cookie
server-side and injects it, strips `Set-Cookie`/CSP headers and CSP meta tags/`X-Frame-Options`, rewrites
the document title/base, injects `workspace-brand.js`/`.css`, and proxies
WebSocket upgrades with the same cookie. The browser sees only Fledge URLs and
the Fledge brand ("powered by FlyBot"); the raw DSH token never leaves the
server. A wildcard subdomain remains a future option if a certificate covers it.

### PR follow-up

Verified webhooks drive a small follow-up loop: a failed check run/suite or a
review requesting changes on a PR that has a Fledge job enqueues an iterate job
with the existing branch and PR URL. A `changes_requested` review also carries
the maintainer's own words from `review.body` into the goal the agent is given,
on one `Reviewer asked:` line, and the job page shows that line back so the
maintainer can see what the agent was told. The bridge prompt tells the agent to
push to the same branch and update the existing PR, never open a second PR. The
follow-up is deduped by delivery id and by repo + PR + head SHA + a fingerprint
of the reason with that instruction, and is skipped while the repository has an
active job. When the running job is a review of the same pull request and head,
updates merge into ONE parked request — one per pull request and head — and each
contributes its own trigger (kind, comment id, actor); the release pass then
queues one job whose `Reviewer asked:` line names every request, so two updates
that arrive before the agent's first model call become one job, not two. A
running review is never cancelled: an update that arrives after that point is not
injected into its current turn, it waits in the same merged request and continues
the session in the next task. A follow-up does not receive a second automation
comment; the job list labels it "Follow-up".

### Default-branch failure intake

A `workflow_run.completed` webhook is read as well, but only as intake: the
repository is resolved from the installation, and a run is considered only when
its conclusion is `failure`. A run whose `pull_requests` list is non-empty (or
whose event is a pull-request event) is recorded as `ignored` with reason
`pull_request`; a run whose `head_branch` is not one of the repository's
default-branch names is recorded as `ignored` with reason `not_default_branch`,
which is how a tag run is kept out until a later slice proves the SHA is an
ancestor. A green, cancelled or skipped run is not a failed run, so it stores
nothing.

One row per `repository + run_id + attempt` lives in `workflow_failures`: a
redelivered webhook or a restarted process cannot double-count, and a rerun of
the same run is a new attempt rather than a second row for the old one. The
repository page's delivery tab lists the recorded failures with the workflow, the
branch and event, the attempt and the run link, so a red default branch is
visible where the other work is instead of only in GitHub.

The intake also reads the failed job's log for a `queued` row. It lists the run's
jobs (`GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`, at most three pages
of 100), picks the first job whose conclusion is `failure` or `timed_out`, and
reads that job's log (`GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs`)
through the repository's token. The log is capped at 8 MiB, and a redirect to a
signed storage URL is followed without the GitHub token. The raw log is never
stored or rendered: it goes through the single redactor and is reduced to a
4,000-character excerpt before it is written to `log_excerpt`. A token, GitHub or
empty-log failure writes a redacted reason to `log_error` and keeps the intake
row. An `ignored` row never spends a request on a log nobody will analyse.

The cited-line verifier (`src/actions/evidence.ts`) is the next building block:
given the model's cited lines and the failed step's output it trims whitespace and
leading timestamps, returns the verified and unverified lines plus the verified
excerpt, and downgrades a category to `unknown` when any citation is unverified.
It is a pure function, and no model calls it in this slice.

This remains a read-only intake slice. No model is called, no run is rerun and no
issue or comment is opened: `queued` means the failure and its redacted log excerpt
are recorded for the analysis slice, and `ignored` carries the reason no action
will be taken. The classification, the one-rerun budget, reports with signature
dedupe and metrics are later slices of the same card, so a `queued` row is a
decision about visibility, not a promise of an automatic fix.

### Plan-first-lite, checkpoints and templates

A manual "plan only" job uses the same team and repository context but the
bridge gives it plan rules: inspect, propose files/steps/tests/acceptance,
risks and rollback, and never write code, branch or open a PR. The plan is
returned in `summary`; a completed plan shows an **Execute this plan** action
that enqueues an iterate job with the plan appended to the goal. This is the
safe, small step before a full pause-and-approve protocol.

Every heartbeat can carry a `checkpoint` (what is done and what is next). It is
stored on the job, shown on the job page, and appended to the goal when a failed
job is retried, so a new job can continue from the last known point instead of
starting from scratch. The add/settings goal forms also offer four task
templates (bug, tests, docs, dependency) that fill the goal text.

### Issue commands and live inbox

A collaborator can drive a work item from the issue thread with `/fledge status`,
`/fledge plan`, `/fledge approve` or `/fledge fix`. The webhook checks the author
association, dedupes by comment id, creates or reuses the work item, and replies
on the issue with the work-item/job/PR state. `plan` and `fix` reach the job
through `ManagementService` (`task.create` on the `chat` channel), so the
receipt, the revision fence and the refusal codes are the console's, not a
second copy. `/fledge approve` is maintainer-only
and approves the latest completed plan. The issue title and body are external, so
`plan` and `fix` build their goal with `untrustedIssueGoal()`
(`src/lib/untrusted.ts`): the text is fenced as `UNTRUSTED ISSUE TEXT`, a forged
fence is escaped, and the job audit records the label and a hash, never the body.
`scanUntrusted()` (`src/lib/firewall.ts`) then names the instruction-like
directives in that same text as rule ids; the job event `job.untrusted_input`
carries `blocked=<ids|none>` and the job page shows the count and the ids, while
the body stays out of the event, the log and the page.

Four verbs act on the job the work item already has: `/fledge retry`,
`/fledge pause`, `/fledge resume` and `/fledge cancel`. Retry goes through the
same `Jobs.retryJob` mapping the console's retry button uses, so the two surfaces
cannot drift, and a retried job that already carries a pull request continues it
as a `followup` on the same branch instead of opening a second one. Pause and
cancel call the existing stop paths, and the reply is built from the outcome
`pauseJob`/`cancelJob` return rather than from an assumption: it reports how many
live sessions were stopped, how many were asked to stop at the next safe point,
that no live session was reachable, or that the stop could not be delivered (no
controller in queue-dispatch mode, or a failed bridge call), so it never claims a
send that did not happen. A verb looks the job up by the work item, not through a
window of the repository's newest jobs, so an older item is still answered
truthfully. Resume creates the resumed job from the paused one. A verb with no work item, no job, or a job in a status it does not
apply to is refused in the thread and creates nothing, so a command can never
manufacture work. Each action reuses the existing audit strings (`job.retried`,
`job.paused`, `job.resumed`, `job.cancelled`) and their timeline kinds rather
than adding a second naming scheme.

### Mention triggers

`@fledge` in a comment is a second trigger on the same surface, not a second
router. `parseMentionTrigger` sits beside `parseIssueCommand`; it takes the names
from `FLEDGE_MENTION_NAMES` (default `fledge`), matches case-insensitively at a
word boundary, and reuses the command path's trusted set
(`OWNER`/`MEMBER`/`COLLABORATOR`), its created-only rule and its claim keyed by
the comment id, so a replayed delivery starts nothing. The bot's own comment is
never a trigger, and neither is an edited, deleted or closed one.

The kind of job follows the target's kind. A mention on a pull request starts a
`review` of that pull request at its head: the job reads the diff and comments
and never writes to the branch. A mention on an issue starts a follow-up for
that issue, which may cut one branch and open one pull request under the
one-issue-one-branch-one-PR rule. `Jobs.mention` decides, and the rule itself is
`src/lib/mentionGovernance.ts` so every case is a pure function.

A mention is identified by `(target kind, target number, head sha)`. The same
target at the same head never opens a second job: while one is queued or running
the mention is recorded as a `job.mention_recorded` event on that job. A newer
mention supersedes a **queued** job, because that job has not run — but only once
the replacement is admitted. The queued row is retired first, then the
replacement is enqueued, and only then do the `job.superseded` event and the one
`trigger.mention_superseded` row name both. Admission can still refuse for
reasons that have nothing to do with the slot (a full queue, a budget, a
disabled repository); on that path the row returns to `queued` and one
`trigger.mention_restored` row records that nobody was left without a job. A
**running** job is never interrupted: the mention is recorded on it and parks in
`pending_mention:<repo>`, and the newest parked mention starts after the running
job finishes. The park keeps its place across a platform stop, a full queue or an
exhausted budget — those clear themselves and the thread already promised the
mention would run — so only the target itself refusing (a draft pull request, a
closed issue) drops it. A parked mention is replayed exactly as recorded: its
comment id, actor and head SHA are the ones captured when it parked, and it is
not re-read from GitHub when the slot frees. A draft pull request or a closed
target writes `trigger.mention_ignored`;
a target the installation cannot read writes one `trigger.mention_refused` row
and starts nothing. Every accepted trigger writes `trigger.mention` with the
comment id, the head SHA, the actor and the outcome (`started`, `recorded`,
`parked`), and answers in the thread.

A review that requests changes may start a fix, and that path is budgeted —
`src/lib/revisionBudget.ts` holds the rule. The author of the review decides the
bound: a person is never counted, a third-party review bot may cause one fix per
pull request whichever head it reviewed, and the platform's own reviewer (the
installation's `<app slug>[bot]` account) may cause `max_revisions` at one head —
three by default, overridable per repository with the setting
`repo:<id>:max_revisions`. The existing fingerprint dedupe answers before the
budget, so a repeated request never spends it; the count follows the fix that
actually starts, so a request parked behind a running job counts when it is
replayed rather than when it parks, and several updates merged into one job
count once. The parked row carries the author at its top level, and the review
job's own follow-ups park as the platform reviewer, so a replayed request is
decided exactly like one that starts on arrival. When several requests merge
into one row, a person's request wins — a merged fix is never refused by a bot's
budget — and otherwise the strictest bot class present is charged, so a
third-party bot's single fix is not hidden behind the platform's larger
allowance. A refusal writes one `trigger.revision_refused` row carrying the
actor class, the head and the reason, and no job.

The inbox is also available as `GET /api/inbox/events`, a per-user SSE stream.
The server reuses the cached inbox snapshot, sends the server-rendered inbox HTML
when the question signature changes, and the browser replaces the section and
rebinds the answer forms. The page keeps a hidden empty inbox so the first new
question can appear without a reload.

### Fledge-driven delivery chain

After an iterate job succeeds with a PR, Fledge queues a Product scope job from
the work-item action, and in stage mode queues a Test verify job to the Test
session before review. The scope and verify jobs use the DSH `sessionId` of the
Product/Test bot and only produce evidence (`scope`/`acceptance`/`testPlan` or
`testRed`/`testGreen`); they never create a branch or PR. After verification (or
iteration outside stage mode), Fledge queues a review job when the repository has
an enabled reviewer and no other job is active. A successful review
moves the linked work item to `approved` (score >= 80 and no follow-ups) or
`changes_requested`; follow-ups are queued on the same branch. Plan approval
moves the work item to `assigned`, and the execute action enqueues the
implementation with the work item attached. While a plan waits, the repository
page names its deadline and the three ways out (approve, reject, or create a new
plan); once it has expired it cannot be approved again, whatever the work item's
state: the refusal reads the plan's own deadline, so reopening the item (or an
item that reached `merged` without an approval) never revives it and a new plan
is the only way back. The banner only ever names a plan whose deadline is still
ahead, so a past date is never printed in future tense. The repository work-item table shows
the stage (Scope / Implement / Review / Merge) alongside the state.

### Repository lifecycle

The repository page has an explicit lifecycle: an enabled/disabled flag, the
FlyBot instance state, and the credential state. A top banner explains when the
repository is disabled, FlyBot is stopped or the token is invalid, and disables
Run/Plan/Review until the state is fixed. A danger zone offers stop scheduling,
stop FlyBot and delete; deletion requires typing the repository name and removes
the Fledge connection, instance, jobs and tokens without touching GitHub.

The FlyBot instance card maps transport failures to a short reason (`Bridge
unreachable`, `Bridge returned 502`, `Container is not running`, `Model endpoint
unreachable`) and keeps the raw error in a technical disclosure. The page-level
message uses the same reason, never a bare `TypeError: fetch failed`, and the
card shows the last health-check time and the Start/Stop/Reinitialize action for
the current state.

### Pull-request delivery

Each repository page has a delivery list of iterate jobs with open pull requests,
with review score, cost and age; each row links to the job page's review → merge
card (below), which holds the one per-PR merge control. Merging re-checks the PR
state, checks, commit status, reviews and branch protection through the same path
as auto-merge, updates the linked work item and marks the job's PR state. A webhook updates the PR state when a PR is merged or closed. A bulk
action re-checks and merges all clean PRs, skipping blocked ones. When at least
three PRs are waiting and auto-merge is off, the page suggests enabling it.

### Job health and credential circuit breaker

Every callback records `jobs.last_callback_at`. A running job with no callback for
`JOB_STALL_MINUTES` (default 30) fails with a `stalled` message instead of holding
the repository slot until the 90-minute hard timeout. A successful job resets the
repository failure counter; three consecutive failures pause auto-iterate and
notify the owner.

An iterate preflight (and a cached check for plan/review jobs) reads the target
branch and repository contents with the repository token. A 401/403 marks `repos.credential_state =
'invalid'`, pauses auto-iterate, and notifies the owner with a re-authorize link.
The repository page shows the credential banner until a refresh or a successful
preflight clears it.

### The model router as a dependency

The shared model router serves every model call the bridge and the gateway make,
and until now it was invisible to this tree: no URL, no timeout, no probe, no
metric. `MODEL_ROUTER_URL` turns on a read of the router's `GET /healthz`, with
`MODEL_ROUTER_TIMEOUT_MS` (default 1000 ms, clamped 50–10000) bounding the read
and a two-second cache in front of it, so a public `/readyz` cannot become a way
to hammer a loopback service. With the variable unset nothing here runs: the
readiness body is byte for byte what it was and no `fledge_router_*` series
exists. Set, `/readyz` gains a `router` object beside the database, instance and
clock fields — never in place of them — carrying `state` and `latencyMs`.

`state` is `ok`, `rate-limited`, `budget-exhausted` or `unreachable`, but
readiness fails only on `unreachable` or on a router whose every reported key is
capped: the router's own `mode: rate` means at least one key is cooling, not that
none can serve, so a single-key cooldown stays a detail instead of a site
outage. Every reported key means every key the router reported; an absent alias
is not counted as free. The reading is fail-closed while the service is
fail-open — a non-200 from the router, a truncated body, a missing or unknown
`mode`, or JSON that is not an object all read as `unreachable`, never as `ok`,
and the process keeps serving.

`fledge_router_up` and the `fledge_router_probe_seconds` histogram cover the
probe, gauges carry per-key spend and cap, cooldowns and queue depth, and a probe
that cannot read an answer removes them rather than republishing the last
reading. A router with no serving key is not one repository's problem, so it
reaches the superadmin through the existing alert cooldown, event row and
`ops.alert` webhook; the series list, the router knobs and the runbook are in
[observability.md](observability.md).

### Model providers and per-bot models

Settings owns a per-user set of OpenAI-compatible providers. Each provider has
an encrypted key and an optional private/HTTP flag, and can hold multiple models
(`provider_models`). A superadmin can grant a normal user `allow_private_models`;
the user then sees the private-URL checkbox and must still pass the connection
test. A repository selects which provider models it may use and which is default
(`repo_model_selection`). Adding a model runs a 1-token test
from Fledge and is refused on failure. A provider can be edited only after every
existing model passes the new URL/key test; "Discover models" reads the
provider's `/v1/models` and bulk-adds only passing models. The instance patch groups the selected
models under their providers as DSH models, and the gateway maps an alias back
to its provider, key and underlying model. Applying a changed selection rewrites
the patch and restarts the container only when no job is active. A repository can
also assign a selected model to each DSH bot role; after the restart Fledge calls
`update-bot` with `model: <provider>/<model>` for every role, using the assigned
model or the new default, so a bot cannot keep a stale provider reference.

Provider metadata also carries a region tag, an optional data-policy URL and an
allowed flag. Region and data policy are optional advanced fields: the region is
a label used only by a repository's region constraint, and the data-policy link
is recorded for review rather than fetched.
 A repository can set a provider allowlist and a required region;
the gateway enforces both at candidate resolution, including the fallback loop,
and refuses a disallowed model with a stable code before any upstream call. With
a policy set, a call must name one of the repository's models: a call that omits
`model`, or names a model that does not resolve, is refused with
`FLEDGE_PROVIDER_POLICY_NO_MODEL` rather than reaching the caller's own model or
the platform model, which carry no provider id or region. The job row records the
answering provider id, label, region and model, keeps those values when a later
call resolves no provider, and the job page and review packet show them. The
settings form disables the checkbox of a provider whose allowed flag is off.
`repos.provider_allowlist` and `repos.required_region` are additive columns, so an
existing repository keeps the unrestricted behaviour until an owner sets a
policy.

A provider can stop offering a model it used to serve. The gateway already
treated a 404 whose body names the model as retryable so a job could finish on
another model; it now also writes `provider_models.retired_at` — the first date
that 404 was seen, never moved by a later one — and marks the attempt in the
job's `model_json` with `retired: true`. Settings shows the model with its
retirement date, the repository page marks a retired default and any per-bot
picker that points at it, and the job's model line names the reason beside the
status. An apply whose selection still holds a retired model is refused with
that model's name, so a restart cannot move a workspace onto a model its provider
no longer serves; saving the selection itself still works. Only a 404 matching the
retired-model pattern writes the column — a 429, a 5xx and any other 404 never do.

### Per-job cost, evidence and metrics

The bridge's model proxy normally uses the per-repository instance token. While
a job is running it uses that job's short-lived `flg_` token instead (the
`/run` payload carries it), so the gateway can write `job_id` into
`quota_ledger` and add `jobs.cost_usd`. A row that could not be priced is not a
zero row for this purpose: `usageCountForJob` counts only `cost_known = 1`, so
the per-job budget's unknown refusal (#357) still fires when every call a job
made was unknown. Only USD-billed rows reach `jobs.cost_usd`, and a retry names
the attempt it continues in `jobs.retry_of`, so the chain a job inherits is the
sum of every attempt rather than a fresh budget. The job page shows cost, attribution and
Team attribution is grounded in the DSH per-role call counts: the job page and the
PR automation comment use only roles with actual calls, and a claimed role with
zero calls is recorded as a `team_attribution_grounded` mismatch event.

structured evidence (`scope`, `acceptance`, `testPlan`, `testRed`, `testGreen`,
`tests`, `checks`, `files`, `risk`, `rollback`); failed jobs have a one-click
retry. A repository can set a team stage gate: `off` keeps the old behaviour,
`shadow` records missing stage evidence, and `enforced` fails an implement job
without scope, acceptance criteria, red/green tests and Dev/Test attribution,
or a review job without a Reviewer and a score. Enforced jobs never auto-merge.
Admins get a read-only `/admin/metrics` funnel:
users, approved, repos, users with jobs/PRs, success rate, job cost, attributed
vs unattributed cost, scope/verify/iterate/review counts, Lead-only and grounded
attribution events, and recent events. `/admin/search` filters jobs and audit entries by the same user
visibility as the admin page, pages each section twenty rows at a time with a pager that carries the
active filters and the other section's page number, and can export the current result as CSV. An export whose filter matches more than 5000 rows is refused with the matched count and the cap instead of being truncated, and the refusal is audited; a filter at the cap still gets the whole file.

`/admin/trials` shows every account, with the state derived at read time instead
of stored: `running` and `expiring` inside the 7-day preview, `eligible` once it
lapses, `expired` when the audit row `trial.expired` exists, and
`exempt_used`/`exempt_admin`/`inactive` for the accounts that never expire. The
page is read-only, offers a `?trial=` filter, and shows the login and the audit
time rather than an email address; a repository added and later removed still
counts as used, because the `repo.added` audit row is the evidence. The
`events` table records activation and intervention events only; no prompt or
token data.

The sweep behind that page (`src/users/trial.ts`, run hourly by the job service,
or by hand with `npm run trial:sweep -- [--dry-run] [--purge-dry-run] [--login <login>]`) selects
`status = approved`, `role = user`, registered more than 7 days ago, with no
`repos` row, no `repo.added` audit, no `jobs` row and no `trial.expired` audit.
The status change and the `trial.expired` audit row commit as one transaction, so
a crash cannot leave an account rejected with no record of why; the notice is
mailed after that commit, and a failed send cannot cause a second rejection
because the row is already there. The bilingual notice names the 7-day rule, the
used-account exemption and the way back: an administrator re-approves the
account, which is not swept again because of that audit row — a rejected account
cannot resubmit, so the notice must not promise that. The audit row is also what
makes the sweep idempotent: a rerun offers nothing and mails nobody, and an
account restored by hand stays skipped. Operator output carries the login and the
registration date, never an address.

The same sweep then runs the purge phase (#690) on the same clock, so one writer
owns the whole lifecycle and no second scheduler can erase an account the first
one is still rejecting. `Store.trialPurgeCandidates(now, graceHours)` offers
every `status = rejected`, `role = user` account whose `trial.expired` row is at
least `TRIAL_PURGE_GRACE_HOURS` (default 72) old, with counts of its
repositories, jobs, instances and GitHub installations; the phase re-reads those
counts immediately before deleting, because usage can arrive between the two
reads. A hand run started with `--login` applies that login to this phase too:
its candidates are only the named account's, so it writes no `trial.purged` and
no `trial.purge_skipped` for anyone else, and it prints that scope before either
phase runs. The hourly service run carries no login and still covers every
candidate. A used account is skipped and audited as `trial.purge_skipped` with the
blocking resource and its count; an unused one goes to `Store.purgeUserRows(id)`,
the single delete path that #691's superadmin deletion also calls (it decides no
eligibility — the caller asserts the account is dead). That function is one
transaction: it computes the spend aggregate and the row counts, deletes the rows
no cascade reaches (`artifact_versions.repo_id`, `audit_log.user_id`, `events`,
the six `settings` shapes keyed or valued by the account id or login, and the two
`ON DELETE SET NULL` rows `error_reports` and `feedback_triage`), deletes
the `users` row so the repo-scoped cascade fires, and writes one `trial.purged`
retention row with `user_id` NULL so it survives. The page's purge section reads
those rows (`Store.recentPurgeAudits`) and renders the reason, the operator, the
row total and the per-currency spend — the aggregate never folds buckets, because
`cost_usd` is in each row's own currency.

The superadmin deletion (#691) sits on the same delete path. `GET
/admin/users/:id/delete` is a read-only preview: it counts the account's
repositories, jobs (all, running and queued), FlyBot instances, API tokens,
GitHub installation records, error reports and feedback triage rows, names the
backup window, and says that the GitHub
App installation itself is not uninstalled — it keeps its repository access and
its webhooks until an operator removes it on GitHub; the preview writes no audit
row.
`POST /admin/users/:id/delete` is superadmin-only, CSRF-guarded,
`destructiveLimit`-rated and re-authenticated with
`requireRecentAuth(..., 'admin.user.delete')`; it refuses self-deletion, the last
superadmin and a login that is not the exact GitHub login. Its teardown order is
cancel jobs, stop and remove instances, revoke tokens, then
`Store.purgeUserRows(id, { reason: 'admin.deleted', operator: 'superadmin',
action: 'admin.user.deleted' })`. Every step is idempotent, so a failure
(recorded as `admin.user.delete_failed` with the step name only) leaves the
account visible and the same confirm retries. The user page's danger zone links
to the preview; `adminDeleteUserPage` renders both languages, the counts, the
backup warning and the blocked state.

### The job page's change story

The job page answers "did it pass", and a maintainer's first question is "what
is the change". `GET /repos/:id/jobs/:jobId` therefore makes one read of the
job's pull request and hands the render a `ChangeStory`: the body split into
what changed, risks and ran, plus the diff totals. It is a read model over what
the agent already wrote — no model call and no summary of a summary.

The read is cached per job for 60 seconds, the same shape as `inboxCache` above,
so refreshing the page spends no GitHub request; a job with no pull request
skips the read entirely and the block is absent. The body comes from
`PullRequestInfo.body`, and the totals from `pullRequestDiffTotals`, which sums
the existing changed-file walk. When that walk hits its own cap the totals are
reported as unavailable rather than summed: a number taken from part of a change
would understate it.

`src/lib/changeStory.ts` is pure. It recognises `## What changed`, `## Risks`
and `## Ran` at any heading level, and the bare `Ran:` line this repository's PR
template uses; a repeated heading keeps the last occurrence and the block says
so, so an edited body cannot silently show the abandoned draft. A heading the
body does not carry renders `not stated` and is never filled from another
section. A read that fails — 404, no token, a capped list — leaves the page at
200 and names the unavailable fact instead, because a page that 500s on a read
it did not need is worse than no block.

### Review and merge as one action

The job page opens with one card that answers a single question: what is the next
step on this pull request. `src/views/reviewMerge.ts` derives it from facts the
page already has — the job row, the repository role, the stored
`verification_json` and `path_guard_json`, the newest independent-review record,
and the pull request's current tip — and names exactly one state: `merge`,
`review`, `stale`, `checks`, `fix`, `moved-base`, `blocked`, `waiting` or `done`.
Each state carries one action: the `task.merge` command, the `recheck` that
records a fresh verdict, or a link to where the fix happens.

The rule that matters is the stale verdict. `verification_json.sha` names the
commit a verdict covers, and the tip comes from the same cached pull-request read
the change story makes, so a verdict recorded before a new commit was pushed is
reported as `stale` instead of being read as green. The card also mirrors the
merge gate's own answers — GitHub's `behind` (base moved), `dirty` (conflict),
`blocked`, pending and failing checks, the path guard, an unacknowledged rule
change, changes-requested reviews, the role, and the independent review's risk —
so a state it calls ready is not one the merge path refuses on those grounds. It
adds no merge call and no second verdict vocabulary; the policy stays in
`tryMerge`, and the repository's own settings stay with #885.

The repository page's delivery list links to this card rather than rendering a
second merge control; the bulk "merge all clean PRs" action is unchanged.

### Email notifications

Fledge sends mail from the configured `MAIL_FROM` (production:
`fledge@hugoxk.online`). The shared FlyBot service keeps its own
`flybot@hugoxk.online` sender; the two projects do not share a mailbox.

Each user can set `notify_email` (blank falls back to the GitHub email),
`email_job_updates`, `email_daily_digest` and `email_job_success`. Job mail
covers failure and a new team question; question mails are deduped by
`sessionId + questionId` in `settings`.

Which finished job earns its own mail is decided by `src/lib/emailPolicy.ts` and
nothing else, because "one mail per run" is what flooded an owner's inbox:

- A **scheduled success** is carried by the daily digest. `email_job_success`
  (off by default, so an existing user sees no change) asks for a per-job
  success mail as well.
- A **failure that queued a transient retry** sends nothing. The retry's own
  result is the one that speaks, so one incident produces one mail instead of
  one per attempt.
- **Failures for one repository coalesce** inside `JOB_EMAIL_COOLDOWN_MINUTES`
  (default 60, `0` disables coalescing) through
  `job_email_last_failure:<repoId>` in `settings`. Any success clears that key,
  even when it sends no mail, so the next failure is news again.
- A **run a person started** always mails its result. That is `jobs.owner_started`,
  recorded when the run is enqueued: every `manual` console route marks it, and
  so does the retry/resume button, which enqueues a `followup`. The trigger alone
  cannot say it — `tick()` reaches the same `followup` trigger through
  `decideNextJob()` for any due repository with an open work item, and that run
  belongs to the digest.

A server-side digest pass runs after
`DIGEST_HOUR` in `DIGEST_TIMEZONE`, builds a 24-hour summary per approved user
(jobs, PRs, spend, next scheduled runs, open questions) and sends it once per
day (`digest_sent:<userId>:<date>`). Templates include the repo, job id,
issue/PR links, summary or question, and a link to the repository inbox or job page; they never
contain tokens or model keys. Approval and quota mail are transactional and are
not controlled by the digest/job switches.

### In-app notifications

A notification row keeps the `kind` and stores the `message` exactly as the
producer wrote it, so `src/jobs/service.ts` and `src/gateway/notifier.ts` write
Chinese while the ops alerts in `src/db.ts` write English. When the producer has
one, the row also keeps the failure `code` (`notifications.code`). The dashboard
is the only reader, and it knows the reader's locale at render time: `noticeBlock`
(`src/views/pages.ts`) rebuilds a job-failure sentence from the `code` with
`failureSentence`, and otherwise passes the stored sentence through
`localizeNotification` (`src/i18n.ts`), which rebuilds it in the reader's
language from the template it matches — both directions, with the interpolated
job id, repo label, minutes and similar facts kept as data. A message no code and
no template knows, including every row written before those existed, renders
verbatim. Nothing is rewritten in the database.

### Release surface

An operator has to see which release is running without a shell. `readReleaseSurface`
(`src/lib/releaseSurface.ts`) reads three local files and returns
`{ version, changelogVersion, releasedAt, fragments }`: `version` from
`package.json`, the newest dated `CHANGELOG.md` section (`[Unreleased]` carries no
date and is skipped), and the count of `changelog.d/*.md` fragments excluding
`README.md`. There is no GitHub call, token or network access, and the footer of
every page carries `v<version>` while the `/admin` card states the running
version (naming `package.json` as its source), the newest section and the pending
count. A path that is missing at runtime renders "not available in this build"
for that line rather than `0` or `—`; a zero fragment count is a real fact and
reads "nothing pending". This release surface stays a local-files read and names
no commit. The build identity lives on `/healthz` instead — `commit` and
`builtAt`, stamped at build time from `GIT_SHA`/`BUILD_TIME` and explained in
decision [0007](decisions/0007-build-identity.md) — because two `main` builds
between a tag and the next version bump answer the same `version` and cannot
otherwise be told apart from outside. Those two fields are bearer-only (#236):
they are served on the `METRICS_TOKEN` credential `/metrics` uses (or to loopback
in a development build without a token), never to an anonymous caller. The same gated
answer carries `webhookSecretSlot` (#466) — `current`, `previous` or `none`, the
slot the webhook verifier is using — so a half-finished secret rotation is
visible to the operator and never to an anonymous caller.

### Release chain

The surface above reads local files, so it says which version this build carries
but not whether that version was actually released and deployed. Issue #280 adds
the other half: `node scripts/verify-release.mjs` reads the chain back through
the API — the plan's base `main`, the `release/v<version>` branch and tip, the
merged release pull request, the annotated tag object and its target commit, the
image tag and digest, the SBOM, the provenance attestation and the GitHub
Release — and, when `--base-url` is given, the running `/healthz` version and
commit. The model is pure (`scripts/lib/release-status.mjs`): every link is
`ok`, `missing`, `mismatch` or `skipped`, an unreadable link is `missing` rather
than green, and the CLI exits `1` on any problem and `2` on input it cannot read.
A merged release whose branch was deleted is `skipped`, not red — the pull
request head is then the record of the tip. The publish workflow writes the
image reference, the SBOM artifact name and the attested digest into the GitHub
Release body, which is what makes those three links API-readable; a release
published before that line existed reads `missing` and is reported as such.

The `/admin` card renders the snapshot the command writes to
`${DATA_DIR}/release-status.json` (`src/lib/releaseStatus.ts`): it never calls
GitHub, and a missing or unparseable snapshot renders "no release chain is
recorded" rather than an empty card. The snapshot carries the tag target and the
Release URL as fields (`targetSha`, `releaseUrl`); the target is never re-read
out of a link's detail text. The card is one "Release & deployment" summary: the
running version, CHANGELOG section and pending fragments share one line; the
header carries one status badge and one GitHub Release link. It renders one live
`Running instance` row and only the artifact links the snapshot marked `missing`
or `mismatch`; the `skipped` provenance links and the stored `healthz` probe are
omitted, and the full chain sits behind a details disclosure. That row
compares the version in `package.json` and the commit stamp this process booted
with against the recorded tag target, so an operator can see at a glance whether
the instance they are looking at is the release the chain names. The header says
`released and running` only when every artifact link is ok and the live row is
the tag target; otherwise it says `published; running differs` or `chain
incomplete`. A published GitHub Release is therefore never labelled "not
released" just because the host runs a local build. A snapshot that claims `ok`
with no links, or that contradicts its own problems, is refused as unparseable —
a green header over an empty table is the one shape the card must never render.

The admin header also carries a compact summary strip (Pending, Users, Jobs,
Audit, Release, Backups) whose items link to the existing sections; it lives
inside the header card, so no new `.card[id]` is added and the section-nav
contract is unchanged. The user table keeps its fields and POST routes but
folds quota, role, private-model and approve/reject controls behind a `Manage`
details control, so the default row is a summary rather than a stack of forms.
The mechanical release pull request is opted into GitHub auto-merge after it is
opened or reused; `ci-ok`, `review-gate` and `pr-lint` still decide when it may
squash, and `--match-head-commit` pins the tip. The release card also renders a
compact `plan → merge → publish` timeline from the snapshot's `plan.plannedAt`,
`pull.mergedAt` and `release.publishedAt`, so a late release can be attributed to
the scheduler, the checks or the merge wait.
### Backup surface

The other half of "your data is safe" is a fact the operator can see without
reading `mtime` on a shell. `readBackupStatus` (`src/lib/backupStatus.ts`) lists
the directory `npm run db:backup` writes (`config.backup.dir`: `BACKUP_DIR ??
DATA_DIR/backups`, the same resolution as the script) and reads the `<copy>.json`
manifest beside each copy. The `/admin` card reports the newest copy with its
size and age, whether that copy's manifest still matches, how many copies exist,
and — above `BACKUP_EXPECTED_HOURS` (default 26) — that the schedule looks stale.
It never opens `fledge.db` and has no backup, restore or delete control, so a
page view cannot touch the database being backed up.

The manifest is checked in three steps and the card never claims more than it
did: `size` is compared always; `sha256` is compared only for the newest copy and
only when that copy is at most 4 MiB (`SHA256_MAX_BYTES`), because hashing is the
only read of a copy's bytes on a render path and a bounded burst keeps `/admin`
responsive on a slow disk. Every other copy is compared by size alone and reads
"size matches, sha256 not checked (only the newest copy is hashed)", so a render
reads at most one copy's bytes and at most 4 MiB of them, not the 14 copies
`scripts/backup.mjs` keeps. A larger copy reads "not checked (copy above N MiB)" —
not a pass; `npm run db:restore-drill` is what verifies it. A copy with no
manifest, or a manifest that names another file or cannot be parsed, is its own
row, so "stopped running" (stale) and "running, producing bad copies" (mismatch)
never share a sentence. The copies line follows the same rule: only `differs`
counts a contradiction, copies without a manifest and copies whose `sha256` was
not read are named in their own words, and a directory with no copy says "nothing
to check" instead of claiming every copy matches. A failed run writes no file at
all, so the console can report it only as staleness plus a mismatch; the drill
prints its verdict and records nothing, so the card says "restore drill: none
recorded" rather than a green it cannot prove.

### Data retention windows (#281)

`Store.pruneOldData` is the one age-based delete pass, run from the scheduler
tick (at most hourly) and otherwise unchanged. Every window now comes from
`config.retention.windows`, built in `loadConfig` from `scripts/lib/retention.mjs`
— one table that also feeds each predicate and the preview, so the rows a preview
counts are exactly the rows a deploy deletes. Unset keeps the literal this
service has always used (OAuth states 7 days; approval tokens, read
notifications, webhook deliveries and sent outbox 30; unread notifications and
events 90; dead/blocked outbox 90; job events, finished jobs, audit log and
unknown outbox 365; quota ledger 730), and `configured` is false for a fallback
so the page can mark it `default`. Unset never means "keep forever": that would
silently stop deleting rows the service deletes today. `sessions` are removed by
`expires_at` and `api_tokens` have no age window; both are reported as such
rather than given a number. `Store.retentionCounts` counts at the configured
windows for the `/admin` card, which is read-only and has no window control; the
operator tool `scripts/retention.mjs --dry-run --days N` counts any window on a
host copy. The delete path refuses a window that is not a whole number of days of
at least 1, before the first delete: `loadConfig` already refuses such an env
value, and `pruneOldData({ jobs: 0 })` is a direct caller the config cannot see,
so the store checks the same invariant rather than trusting its input.

### Operational alerts

A failed job also feeds the ops signal: three consecutive failures in one
repository write an `ops.repeated_failures` audit entry, one in-app notification
and, when `NOTIFY_WEBHOOK_URL` is set, a `repo.repeated_failures` webhook. The
notice is deduped until the next successful job resets it.

### FlyBot bridge

The bridge is a tiny HTTP service on the FlyBot host. Fledge POSTs a job
descriptor; the bridge relays it to a configured FlyBot chat session. The agent:

1. fetches the GitHub token from `GET /api/jobs/:id/credential` with the job
   secret;
2. uses the platform model at `.../v1` with the job token;
3. creates a branch, commits to the fork when one is used, opens an issue and a
   PR against the upstream;
4. calls `POST /api/jobs/:id/callback` with the branch, issue URL, PR URL,
   summary and an `attribution` object naming the roles that wrote, claimed,
   implemented, tested and reviewed the change. Review jobs instead list all
   open upstream PRs, post scored COMMENT reviews, and return `reviewScore`.

The playbook asks every role to end its GitHub issues, PRs and comments with one
small line: `<sub>Fledge · team · role · step</sub>`, where step is claimed,
implemented, tested or reviewed. On a successful iterate job Fledge also adds a
collapsible automation block to the PR. It lists only the steps that actually
happened (a single role is grouped once), links the issue and job page, and
states whether the maintainer enabled auto-merge. A missing step is omitted rather than shown as
"pending", so the block stays truthful and quiet even when attribution is thin.

Both endpoints require `Authorization: Bearer <callbackSecret>`. The secret is
generated per job, stored as a hash, and never appears in the UI.

## Owner search

`/search` answers "where is my X" without a query that can leave the signed-in
owner's rows. The route in `src/app.ts` parses `q` plus optional `kind` and `repo`
filters, then calls one store method per section — `Store.searchOwned` in
`src/db.ts` — for repositories, jobs, work items and audit rows, and
`searchPage` in `src/views/pages.ts` renders them, 20 rows per section with the
cap stated on the page.

The scoping is the point of the read model, so it lives in the SQL and not in the
view: every section's clause carries `user_id = ?`, and the `repo` filter is
resolved against that owner's own repository ids, which means a repository id
belonging to someone else is dropped rather than answered — the page cannot be
used to probe another account's ids. `LIKE` patterns are built by `likePattern`,
which escapes `%`, `_` and `\` and appends `ESCAPE '\'`, so a user's `%` matches
a literal `%`. Row types are `Pick<>`s of the full row types, so no section can
render a token, a key or an email column: those are not selected at all. Audit
rows carry no repository, so the audit section is labelled as unscoped rather
than filtered by `repo`. An empty `q` renders the empty state instead of a
listing, and every row links to the page that already owns it.

## Data model

| Table | Purpose |
|---|---|
| `users` | GitHub identity, application status, signed agreement fields (name/version/time/IP/UA), role, quota, own model (encrypted key) |
| `sessions` | hashed session id, expiry, IP/UA; the settings page lists and revokes the viewer's rows by `user_id` |
| `oauth_states` | short-lived OAuth `state` values |
| `approval_tokens` | single-use approve/reject links |
| `repos` | upstream/fork identity, encrypted token, permission, reviewer config, goal, cadence, state |
| `jobs` | lifecycle, kind (iterate/review), branch, issue/PR URL, review score, summary, cost, job-scoped token hash, and the service principal a run executes under with the revision it resolved at (#749) |
| `api_tokens` | `flg_` tokens (PAT, job or instance), hashed, with `scope` (`gateway` or `jobs:read`) and `expires_at`; a PAT always carries an expiry |
| `quota_ledger` | per-request cost records: model, currency, price snapshot, `cost_known` (0 = could not be priced) |
| `notifications` | in-app messages (quota, job failure), stored as written and localized at render |
| `postmortems` | one evidence-backed write-up per failed/stalled/cancelled job, with category, recurrence key, owner and preventive action |
| `postmortem_recurrences` | one ledger row per recurrence key: count, first/last seen, affected repositories and the single escalation marker |
| `audit_log` | who changed what |
| `management_commands` | one receipt per command: principal, channel, idempotency scope/key, request hash, operation, target, arguments, expected/before/after revision, status and result (#540) |
| `resource_revisions` | the fence a command compares against, one row per resource; a resource with no row is at revision 1 (#540) |
| `tenants` | GitHub owner scope; the first slice stores the legacy login id `github.com:legacy:<owner-lowercase>` (#541) |
| `projects` | one row per repository, keyed by the repository id and linked to its tenant (#541) |
| `principals` | one human principal per user (`principal:user:<user_id>`), plus service principals (`kind='service'`, no user, `disabled_at` when disabled) that unattended runs execute as (#541, #749) |
| `repo_members` | per-repository `maintainer`/`developer`/`viewer` rows with a revocation time (#541) |
| `scoped_grants` | explicit capability grants with source, evidence, expiry, revocation and revision (#541) |
| `identity_migrations` | one report row per identity backfill version (#541) |
| `security_findings` | one row per `rule + path + line` a job reported, with `open`/`fixed`/`dismissed`/`regressed`, the job that dismissed it and the written reason or evidence; absence from a later report never moves a row (#379) |
| `budget_scopes` | one stored CNY cap per scope — `repository` keyed by repository id, `principal` keyed by `principal:user:<id>` — with the action it takes (`alert`/`pause`/`cancel`); a missing row means no cap, never a zero cap, and the job scope keeps reading `repos.job_budget_cny` (#697) |
| `settings` | small key/value flags (e.g. quota notice dedupe); age-based pruning reclaims the per-job plan markers (`plan_expired:`, `plan_reminded:`) on the same window as the `jobs` rows |

## Deployment records

A release and a deployment are separate events. `scripts/verify-release.mjs`
proves the tag/image chain; an operator records the deployment itself on
`/admin/deployments` (admin-only) with the environment, version, commit, image
digest, operator and the observed `/healthz` / `/readyz`. Fledge never opens a
host connection or runs the deploy: every field is a recorded fact.

The read model compares the latest recorded deployment with the newest released
tag and reports `ok`, `behind`, `mismatch` or `unknown`; a `/healthz` commit that
does not match the record is a mismatch. Promotion requires a canary checklist
(`/healthz`, `/readyz`, a smoke job, error and latency windows) and fails closed
when evidence is missing. A rollback record names the previous digest/commit,
owner and redacted command, and is verified only when the resulting `/healthz`
matches the previous commit. `scripts/verify-release.mjs --deployment FILE`
turns the same drift verdict into a release-check link.

## Job lifecycle

```
queued ──► running ──► succeeded
   │          │
   │          ├──► failed
   │          ├──► timeout ──► failed
   │          └──► paused (one decision, waiting for an answer)
   └──► quota_exhausted
```

- `queued` is written before the runner is called.
- `running` is set when the bridge accepts the job (or immediately for the mock).
- `succeeded` / `failed` come from the callback or the mock.
- A terminal callback that carries one `decision` does not finish the job: it
  moves to `paused` with `error = decision.why`, stores the bounded question in
  `jobs.decision_json`, releases its lease and records one `job.decision` event.
  The question is an inbox card whose id is `job:<jobId>`; the first answer is
  stored under `decision_json.answer` and starts exactly one retry whose goal
  carries the question and the answer. The retry is judged first and the answer
  is written only when it was accepted, so an enqueue refusal (`JOB_ACTIVE`,
  `QUEUE_FULL`, `REPO_DISABLED`, `PLATFORM_PAUSED`) leaves the card unanswered in
  the inbox instead of consuming the question. A second decision or a second
  answer is refused, and only that retry resumes the work (#381).
- The repo records `last_run_at` and `last_status`; a scheduled job is skipped if
  another job for the repo is active. `jobs.continuity_json` stores the run
  digest, `jobs.output_kind` its classification, `jobs.continuity_used` whether
  the carry-over block was injected and `jobs.carry_over_json` the block's
  counts and its per-link observation.

The claim/worker dispatch model, the `queued` meaning and the idempotent
callback contract are decided in [decisions/0004](decisions/0004-job-queue.md).

## Management commands (#540)

Every console write used to be its own route: parse the form, check the owner,
call the service, write an audit row, redirect. A second surface (an API, a chat
entry, automation) would have had to copy all four steps. `src/management/`
replaces that shape with one contract. The first migrated write is the job cancel
form; slice 2 moved the rest of the job commands onto it.

A command is an operation from a closed catalog (`src/management/catalog.ts`),
a target (`projectId`, plus `jobId` today), validated arguments, the revision the
caller saw (`expected_revision`), an idempotency key, and the source conversation
or message when the caller has one. The actor — principal, channel, tenant,
capabilities — is built by the server from the session and the repository; a form
field, an IM message or a model cannot supply it, and an argument that names one
(`actor`, `tenant_id`, `capabilities`, `sql`, `url`, `path`) is refused rather
than ignored.

The service stores a receipt before the business write, in `accepted` state.
Repeating the same key with the same request hash returns that receipt and runs
nothing; reusing the key with different arguments returns
`idempotency_conflict`; a revision that has moved on returns
`management_revision_conflict` and writes no receipt at all. Execution re-reads
the caller's capabilities from the database and compares the revision again, so
a change of hands between acceptance and execution fails the receipt before the
business write. On success the receipt, the revision bump and the
`management.command` audit row commit in one transaction.

`task.cancel` and `task.pause` are only partly outside the transaction, and the
split is at the await: stopping live bot sessions over the bridge and clearing the
instance's job token happen first, best-effort and safe to repeat, so a repeat can
never duplicate them. Everything that changes state — the job row, the repository
status, the work item, the audit and job-event rows, the receipt, the revision
bump — is handed back as the operation's `commit` callback and runs inside a
single SQLite transaction. The one exception is the platform-token revocation
named below. A crash therefore leaves either both the effect and its
receipt, or neither: the receipt stays `accepted`, which is the truth.

The platform-token revocation is the one local write that is not in that
transaction: it happens with the awaited work, before the commit, so a command
whose transaction fails leaves the job queued or running with its token already
revoked. Closing that gap means moving the revocation into the `commit` callback,
which this slice does not do.
`Jobs.prepareCancel`/`preparePause` put the awaited work in one place so the
legacy `cancelJob`/`pauseJob` and the command cannot drift apart.

`task.create`, `task.resume` and `task.retry` are the rest of slice 2. Their
business write is `Jobs.enqueue`, which runs in the operation body because its
admission gates await the GitHub duplicate, credential and preflight reads; the
receipt, the revision bump and the `management.command` audit still commit
together afterwards. The gap that leaves is narrow, and it is why none of the
three needs an `unknown` path: the only durable object `enqueue` creates is the
local job row, so a crash between that row and the receipt leaves the receipt
`accepted`, the same key replays `command_in_progress`, and a fresh key is
refused by the active-job gate (`JOB_ACTIVE`) instead of queueing a second job. A
create is fenced on the project's revision, bumped on every create; a resume or a
retry is fenced on the source job's.

A failed receipt keeps the refusal code and the parameter its sentence
interpolates (`error_code`, `error_detail`), so replaying it answers with the same
sentence: `BRANCH_MISSING` with its branch, `DUPLICATE_WORK` with its pull request
URL. The console builds that sentence from the same banner table every other
refusal uses. The parameter is stored only when the sentence has a `{detail}` or
`{branch}` slot — a bare value would otherwise displace the text the service
wrote.

A receipt that has already answered is never rewritten. In `shadow` the route
reserves the receipt, runs today's path and settles it; the same key submitted
again replays that receipt and settles nothing, so one command moves the revision
once and a resubmitted page cannot turn a recorded success into a failure.

That split is why `task.create`, `task.resume` and `task.retry` never need the
`unknown` state: the only durable object `enqueue` creates is the local job row.

`task.cancel` does (#540 slice 5), because its bridge stop can cross the external
commit boundary with no answer. A command that throws while it awaits that step
no longer escapes as a 500 and no longer leaves a receipt nobody can finish: the
receipt becomes `unknown`, and the console says the step was not confirmed
instead of claiming it failed. The next attempt with the same key reconciles
first, through the operation's optional `reconcile` hook, against a stable
marker. For a cancel the marker is the job row: a job that is no longer `queued`
or `running` means the stop already happened, whoever wrote it. `applied`
settles the receipt with `reconciled: true` and no second revision bump (the
effect is what moved the revision), `absent` resends exactly once under the same
revision fence, and `still-unknown` — or an operation with no hook at all —
answers `management_unknown` and writes nothing. Nothing is resent blind.

`task.merge` (#540 slice 6) is the first command whose durable effect is not in
SQLite: GitHub performs the merge. The gates and the merge call stay in
`Jobs.tryMerge`, which the auto-merge path uses too, so the two paths cannot
disagree about what may merge. The operation calls `Jobs.manualMerge` with the
transport failure rethrown, which is what turns a lost answer into an `unknown`
receipt instead of a refusal. The stable marker is the remote pull request, read
back by `Jobs.probePullRequestMerged`: `merged` settles the receipt with
`reconciled: true`, and the verdict's `settle` callback writes the work item, the
PR state, the `job.manually_merged` audit row and the job event that the lost
answer skipped — inside the receipt transaction, exactly where `commit` runs on
the accepted path. The merge already moved the revision, so the settle does not
bump it. A probe that finds the pull request not merged proves the effect absent
and the command runs once more under the same fence. A fresh key that finds the
pull request already merged is a success (`alreadyMerged`), not the old failure
sentence, and `recordMerge` skips the counter, audit and event when the merge is
already recorded. Merging requires the new `job.merge` capability, held by
`maintainer` only; `release.manage` is also maintainer-only, but cutting a
release is not merging this pull request.

`ManagementService.markUnknown` is for an adapter that learns about a lost
response itself, such as a future API or chat channel: only the principal on the
receipt may call it, it applies only while the receipt is still `accepted`, and a
receipt that has already answered is replayed rather than rewritten. A probe that
fails leaves the receipt `unknown` instead of guessing.

The form route stays a thin adapter: it renders the revision and a fresh key,
calls the service, and turns the receipt into the same redirect as before.

`MANAGEMENT_SERVICE=off|shadow|on` (default `off`) governs the `task.pause`
adapter added with the switch. `task.create`, `task.resume` and `task.retry` run
through the service in every mode, as `task.cancel` does: the switch was the
pilot's safety net for one operation, and widening it to the rest is a later
change. `off` keeps the route that existed before the contract,
`shadow` reserves and records the command but still runs that route — so the
receipt is where a divergence shows — and `on` lets the command answer. An
unknown value is `off`: a typo must not start enforcing.

`repo.update` is slice 4, the first non-job write: the merge-policy block of the
console settings form (`require_protection`, `allow_paths`, `deny_paths`,
`target_branch`, `stage_mode`, `repo_role`). It is fenced on the repository's own
revision, not the project's, so a job queued elsewhere cannot invalidate a
settings save while a policy written from another tab does. The command rewrites
only the fields the caller sent, refuses a value outside the closed set
(`invalid_arguments`) instead of clamping it and re-checks the chosen role against
the connection's permission when it runs (`repo_role_not_allowed`). Its capability
is `repo.policy`, which both roles hold, because the console let both save this
block before the move; `config.write` would have narrowed it to maintainers. A
replay is answered from the stored receipt, so a refreshed or retried submit
writes nothing the second time and does not move the fence twice.

The rest of the write surface — the other half of the settings form (goal,
models, budgets, intervals, auto-merge, reviewer), releases and member grants —
still calls its service directly. Each migrates by registering one operation and
leaving its route as an adapter; none of them may keep a second copy of the rules.
The issue-thread `/fledge plan` and `/fledge fix` commands are the chat adapter:
they register a `task.create` receipt in the `chat` channel instead of calling
`Jobs.enqueue` themselves. The comment id is the claim key and the idempotency
key, and the two guards answer different questions. A per-comment marker records
`claimed` from the moment a delivery starts until the answer is posted, then
`done`; it absorbs a duplicate delivery, it is released when a delivery fails, and
a claim left behind by a killed process lapses after the same five minutes as the
webhook delivery row, so a comment can be retried instead of being dropped. The
receipt is the second guard: a retaken `/fledge plan` or `/fledge fix` replays the
first result, and a retaken `/fledge retry` is refused by the single-active-job
rule every enqueue goes through, so a retaken delivery queues nothing twice. A
chat message has no rendered page, so the revision fence is read as the event is
handled rather than posted back by a form. The refusal mapping that made this
possible is the same one the console uses: an operation hands its service's
enqueue code back as the receipt's `error_code`, with `error_detail` carrying the
value the service named, and the surface builds its sentence from the one banner
table rather than inventing text.

## Identity backfill and capability resolution (#541)

The first identity slice adds the rows and a read-only resolver; every existing
owner check still decides access, so behaviour does not change. On open,
`Store.migrateIdentity()` backfills one tenant per repository owner, one project
per repository, one human principal per user, one `repo_members` row for the
connection owner and one explicit `scoped_grants` row for that owner. The
migration is idempotent, records its counts in `identity_migrations` version 1,
and `createRepo` ensures the same rows for a repository added later. A user with
no repository still gets a principal.

The tenant id is deliberately legacy: `repos` carries the owner login, not the
numeric GitHub owner id, so the id is `github.com:legacy:<owner-lowercase>` until
a later rekey. A rename must not merge or rebuild identity; the project id is the
repository id and stays stable. A numeric owner id is follow-up work, not a guess
this slice makes.

`src/identity/authorization.ts` resolves an actor from active memberships, active
grants and the legacy `repos.user_id` owner. `maintainer`, `developer` and
`viewer` expand to capability sets; `superadmin` is the only wildcard, while
`admin` gets `grants.manage` and repository capabilities only through a
membership or grant. `GET /api/auth/me` is the first read surface: it requires an
approved session and returns the user summary, tenant/project roles,
capabilities and platform capabilities without a token or key column.

## The service principal execution identity (#749, slice 1)

A service principal is a `principals` row with `kind='service'`, a tenant, no
`user_id` and one or more `scoped_grants` rows. `resolveServiceActor(store,
principalId, { projectId, capability?, expectedRevision? })` in
`src/identity/serviceActor.ts` turns it into the same `ActorContext` a human actor
gets, from the grant alone: the capability set is the union of the active grants
that cover the project, no repository role is derived, and `platformRole` stays
undefined, so `superadmin` is unreachable from a service principal.

The resolver refuses instead of widening. An unknown id (`unknown_principal`), a
row that is not `kind='service'` (`not_a_service_principal`), a `disabled_at` row
(`principal_disabled`), no active grant at all (`no_active_grant`), active grants
that name another project (`project_not_granted`), a capability outside the
covering grants (`capability_not_granted`) and a revision the caller has moved past
(`stale_revision`) each raise `ServiceActorRefused` with that code. A revoked or
expired grant is inactive, so it excludes both its project and its capability. A
grant with no `project_id` covers a project only when both name the same tenant.

`jobs.principal_id` and `jobs.principal_revision` record the principal a run
executes under and the revision it was created at; a human-owned job keeps both
NULL. `resolveServiceActorForJob(store, job, { capability? })` resolves through
that pair and refuses when the principal has moved past the recorded revision, so
a rotation or revocation stops the run rather than silently re-authorising it.
`Store.createJob` reads the revision inside the same write as the row.

Not in this slice: creating, rotating and disabling a principal with its audit
row, revoking a running job's token on revocation, binding a schedule or release
to a principal, and the console surface. The `disabled_at` column exists so the
resolver can refuse; the audited flow that sets it is follow-up work.

## Shared repository read path (#105, slice 1)

Repository membership reaches the product surfaces here. `Store.listRepos`,
`listReposPage` and `countReposForViewer` include every repository with an active
`repo_members` row for the viewer, so the dashboard and its total describe what
the person can see rather than what they connected. The owner-only
`countReposForUser` stays the connection-limit count, because a shared repository
is the owner's connection and must not consume a member's own repository limit.

Every `/repos/:id` route resolves the viewer through `ownedRepo`: the connection
owner is the maintainer of last resort, an active member row supplies its own
role, and a missing repository and a non-member answer the same 404 so an id does
not leak. A `viewer` reads but any mutating route answers 403; repository
settings (merge policy, target branch, role gate, auto-merge) require
`maintainer`, and so do the routes that are settings in effect or can end the
connection: `POST /repos/:id/role` (it writes the same `repo_role` column as the
settings form and clears `auto_merge`), `/delete`, `/release`, `/enable`,
`/disable`, `/instance`, `/instance/stop` and `/models/apply`. A `developer`
keeps the work routes — `/work`, `/run`, `/plan`, `/triage`, `/review` and the
job actions — and `/run` is resolved through `ownedRepo` like the other starts,
so it answers for a member instead of the 404 a stranger gets. The member write path — `addRepoMember`, `setRepoMemberRole`,
`removeRepoMember` — validates the capability vocabulary and refuses to remove
the connection owner, which is what keeps a repository with a maintainer.
Invitations, accept/leave/transfer, the audit rows for each membership change and
member-aware controls in the views are the following slices; no route shown to a
viewer writes yet.

## Notification webhook egress

`buildApp()` checks `NOTIFY_WEBHOOK_URL` before it opens the store. In production
an unsafe target stops the process instead of starting with an alert path that
would POST into the internal network. The same guard runs on every send and on
every redirect hop, so a runtime change or a redirect fails closed. The guard
resolves the host and refuses loopback, RFC1918, carrier-grade NAT, link-local,
multicast, ULA, IPv6 loopback and IPv4-mapped private addresses; an exact
`NOTIFY_WEBHOOK_ALLOWED_HOSTS` entry is the only way an operator may name a
private self-hosted target. Errors name the host but never the secret or payload.

## CI gate detection (#543, slice 1)

The repository page carries a CI gate check, reached from its action row. It is
read-only and answers whether the repository's own CI gates a merge, from four
GitHub reads on the default branch: the `.github/workflows` directory, the
contents of each workflow file, the branch protection, and the newest merged pull
requests with the check runs on the commit that landed.

`src/lib/ciGate.ts` is pure — the route hands it the facts — and it reports five
findings: a workflow file exists; one triggers on `pull_request`; that one runs a
test command; the default branch requires a check; and no pull request merged in
the window landed without a successful check. A gap names the workflow file or the
branch it read, so the operator can re-read the same evidence on GitHub. A
protection read GitHub refuses is `unknown`, never `gated`; a report with no
branch protection is `gaps`.

The workflow trigger and test command are read as text, not parsed YAML, and the
report quotes the line it matched. Nothing here creates a branch, a commit or a
pull request on the user's repository: proposing the four lanes and opening one
gate pull request after a human confirms is a later slice of #543, and it keeps
the human-confirmed shape.

## Trust boundaries

| Boundary | Control |
|---|---|
| Browser → Fledge | session cookie, CSRF token on every form, rate limits (a mutating route names its class — login, destructive or expensive — and the class budget comes from `RATE_LIMIT_*` config; `src/lib/rateLimit.ts`, documented in `docs/security.md`); destructive writes also need a GitHub re-authentication inside `RECENT_AUTH_MINUTES` (`sessions.recent_auth_at`, audited as `recent_auth_required`), and that includes both posts that write a repository's `repo_role` — the settings form and the role form, which also clears `auto_merge` and `reviewer_enabled` when it demotes to developer. The bounce returns to the page the form was on with exactly one `notice` — the key is replaced, not appended, because a page that just came out of a save already carries one and a second key parses as an array that `queryText()` refuses |
| Fledge → GitHub | user's fine-grained token; platform OAuth only for identity |
| Fledge → SMTP | credentials in env, never logged |
| FlyBot bridge → Fledge | job callback secret; credential URL; job token |
| Fledge → model provider | platform key or user key; SSRF guard on user URLs |
| User → host resources | per-user ceilings on repositories (`LIMIT_REPOS_PER_USER`) and FlyBot instances (`LIMIT_INSTANCES_PER_USER`, optional `LIMIT_INSTANCES_GLOBAL`), refused before anything is created and audited as `limit.refused`. The explicit provision and both repository-add paths consult the instance ceiling, so an add cannot bypass it; only an instance that holds a slot counts, so a stopped instance does not block its own restart. Admins are exempt |
| Admin email link | single-use 32-byte token, 7-day expiry |

## Failure modes

- **Approval mail cannot be sent.** The approval request writes an
  `approval.mail_failed` audit entry, the applicant's status page and the pending
  list on `/admin` show the failure, and an admin can resend from that list. The
  marker is derived (`store.approvalMailFailures()` compared with
  `users.approval_sent_at`), so a later successful send clears it. See
  `docs/security.md` for the operator probe (`npm run mail:probe`).

| Failure | Behaviour |
|---|---|
| Bridge unreachable | job fails with `RUNNER_ERROR`; user notified |
| Agent never calls back | job failed after `JOB_TIMEOUT_MINUTES` (default 90); progress heartbeats update the running summary but do not extend the limit |
| Provider 429/5xx | gateway returns the upstream status; user sees the error |
| Quota exhausted | job marked `quota_exhausted`; one notification + email per day |
| SQLite locked | WAL + single process; retries surface as 500 and are logged |
| Mail down | approval still exists in Admin; login shows pending |

## Non-goals for v0.1

- Running arbitrary code inside Fledge.
- Auto-merging.
- Multi-tenant process isolation (one instance = one operator/team).
- Billing integration; the 1 CNY quota is a soft platform budget, not an invoice.

## Project memory (`#539`)

A repository can keep durable, versioned memory: decisions, conventions and
experience that a later job cites instead of re-deriving. The store is
`project_memories` (the current revision, unique per `(repo_id, key)`) plus
`project_memory_versions` (every revision, including the first, written once and
never updated in place). `src/lib/memory.ts` holds the rules that are not SQL.

- **Writes are fenced.** Every write carries `expected_revision`; `0` means
  create-only. A stale revision is refused with `memory_revision_conflict` and
  the current entry is left untouched — the store compares inside one
  `BEGIN IMMEDIATE` transaction and appends the version only after the fence
  passes. An identical write is a no-op and creates no revision.
- **Reads are exact.** A read names a revision and returns that body, its
  `sha256` digest and whether it is historical. Nothing is served from a cache
  and no read returns "the latest" when a revision was asked for. A revision is
  read under its own audience, never the current entry's, so a historical
  revision written for another role is neither listed nor rendered after the
  entry moves to a wider audience.
- **Audience is a role, not a permission.** An entry is `project` or
  `role:<maintainer|developer>`. The reader's role is the repository's own chosen
  role, so an administrator acting as a developer reads the developer view, and
  an entry outside the audience is reported as absent (404) rather than listed.
  A writer may not author an entry for a role it cannot act as, and a write aimed
  at an entry outside the actor's audience is refused as absent before the
  revision fence, leaving the row untouched.
- **The page is reachable.** The repository page's memory card links to
  `/repos/:id/memory`; the page is not an orphan that only a typed URL opens.
- **Sources are shown.** An exact-revision read lists that revision's `sources`
  next to the body, links the ones Fledge can turn into a GitHub URL (`pr#N`,
  `file:<path>`, `commit:<sha>`, an `http(s)` URL) and marks the rest
  unrecognised. It does not claim the reference still resolves upstream.
- **Lookups are bounded.** Search is a case-insensitive substring match over the
  key, body and scope of the visible entries: the query is capped at 120
  characters (a longer one is refused by name) and results are capped at 50. The
  result table lists the key and its metadata, never the body, so a long entry
  cannot lengthen the list. There is no ranking and no embedding, so the same
  store always answers the same way.

The slice is the repository page (`/repos/:id/memory`, `src/views/memory.ts`).
Not built yet: the bounded index handed to a job prompt and the agent read tool
(`src/jobs/service.ts`), the three-notes-per-run agent writer, repository-document
promotion with merge/blob proof, review scheduling and export.

## Gate plans and sessions (`#543` first slice)

A repository onboarding run proposes a **gate plan** before anything is written.
This slice stores the proposal and the human decision; it never writes to the
repository.

- **The plan is a closed schema** (`src/gates/plan.ts`). It names `baseSha`
  (40-hex), `mergeQueue`, `existingFiles`, `gaps`, `notes` and exactly the four
  lanes `pr-ready`, `pr-merge`, `daily` and `release`. Each lane carries
  `commands`, `observe`, `source` and an optional `durationMs`. Unknown fields
  and lanes, empty commands, a malformed SHA and an oversize value are refused by
  `validateGatePlan` with a stable code and field path. The normalized plan is
  hashed with SHA-256 over canonical JSON, so the same plan hashes the same way
  regardless of property order.
- **A session is the record** (`gate_sessions` in `src/db.ts`). It holds the
  repository, status (`analyzing`, `proposed`, `confirmed`, `created`, `refused`,
  `failed`), the base SHA, the canonical plan JSON, its hash, the confirming
  actor and time, and the PR/branch/error fields. `Store` exposes
  `createGateSession`, `getGateSession`, `getGateSessionForRepo`,
  `updateGateSession`, `claimGateSession` and `listGateSessionsForRepo`.
- **The API proposes, it does not write.** `POST /repos/:id/gate/sessions` is
  maintainer-only and CSRF-checked. It validates the plan, optionally reads the
  default-branch SHA with a GitHub `GET /branches/:branch` call, and refuses a
  stale plan with `STALE_BASE_SHA`; if GitHub is unavailable the explicit
  `baseSha` is stored. `GET /repos/:id/gate/sessions/:sessionId` returns the
  stored plan and status. `POST /repos/:id/gate/sessions/:sessionId/confirm`
  recomputes the hash from the stored plan, then marks the session `confirmed`
  with the actor and time. No route calls a GitHub write endpoint, opens a branch
  or creates a pull request.
- **The page is reachable.** The repository page's gate card links to
  `/repos/:id/gate` (`src/views/gate.ts`), which lists sessions, renders the plan
  preview, and offers a maintainer a confirm form. Every value is escaped and
  every sentence is bilingual.

Trial runs are not built: Fledge still does not clone or execute a user
repository, so a lane duration is evidence reported by the analysis run.

## Applying a confirmed gate plan (`#543` second slice)

A confirmed session can be applied once, through
`POST /repos/:id/gate/sessions/:sessionId/create` (maintainer-only, CSRF-checked).
It is the only route that writes to a user's repository, and the write is exactly
one branch, the composed files and one pull request.

- **The claim is a compare-and-set** (`Store.claimGateSession`). The route moves
  the row `confirmed` → `analyzing` with a single `UPDATE ... WHERE status =
  'confirmed'`, so two clicks cannot both open a pull request; the loser gets a
  409. A session that already carries `pr_url` is refused with
  `GATE_PR_ALREADY_CREATED`.
- **The base branch is re-read first** (`src/gates/apply.ts`). If it no longer
  matches the plan's `baseSha`, nothing is written: the session becomes
  `refused` with `stale_base_sha`, and the caller has to run the analysis again.
  Creating the branch uses the plan SHA, never a branch name.
- **Composition is pure** (`src/gates/compose.ts`). Given the plan and the files
  read at the base SHA it returns the exact bytes and the PR body. It writes
  `.github/ci-gates.json` (the lane contract), `scripts/gate/gate.mjs` when
  missing, `.github/workflows/release.yml` when missing, and
  `.github/workflows/fledge-gate.yml` for the lanes that need their own triggers.
- **An existing workflow is merged, never replaced.** The preferred target is
  `.github/workflows/ci.yml` (else the first workflow file that has an `on:` and
  a `jobs:` block). Only the pr-ready `fledge-gate` job and a `pull_request`
  trigger are inserted; the schedule, tag and `merge_group` triggers stay in the
  dedicated file so an unrelated workflow never starts running on them. If the
  trigger block has a shape the text merge will not rewrite, the pr-ready lane
  falls back into the dedicated file and the PR body records why.
- **Lanes keep their four outcomes** (`src/gates/lanes.ts`). An empty lane is
  `not_applicable`, never `pass`; a missing exit code is a failure; an observe
  lane's failure is `observe_fail`, recorded and not fatal. A repository without
  a merge queue runs pr-merge after merge, and the contract records the
  merge-preview gap: a check that only sees the merged tree cannot block a pull
  request. A merge-queue repository gets `merge_group` instead, and no such gap.
- **The page shows the result.** `/repos/:id/gate` offers the create form on a
  confirmed session, then links the PR and the branch, and shows the recorded
  `error_code` on a refusal or failure. Every sentence stays bilingual.

GitHub writes use `GithubClient.createBranch` (`POST /git/refs`) and
`GithubClient.putFile` (`PUT /contents/:path`, with the blob SHA when updating).
Nothing force-pushes and nothing merges the gate pull request.

## Release tags for hosted repositories

`src/releases/release.ts` turns a maintainer's release request into either a
refusal or one annotated tag. The version is supplied, never derived: a strict
SemVer parser accepts `v1.2.3` or `v1.2.3-beta.1` and nothing else. The previous
version tag is the highest SemVer tag whose commit is an ancestor of the target
(the `compare/{base}...{head}` status decides ancestry, not tag date or string
order), so "nothing to release" and "not higher than what shipped" are decidable
from the repository's own history.

The preflight is read-only — every call is a GET — and checks, in this order: the
version parses; the confirmed SHA is a commit in the repository; the default
branch contains that commit; the default branch is protected by required checks
(the gate onboarding of #543); a tag-triggered `.github/workflows/release.yml`
exists at the target commit; the tag does not exist; there is something to
release; the version is higher than the previous tag. A not-higher refusal
carries the next legal version, and the page shows it.

The containment check reads `compare/{defaultBranch}...{target}`, so `behind`
means the target is an ancestor of the default branch — the branch contains it —
and `identical` means the same commit; only those two are accepted. `ahead` means
the target carries commits the default branch lacks, which is the unmerged branch
this check exists to stop, and `diverged` shares no base with it; both are
`target_not_on_default`, and a compare that cannot be read is
`ancestry_unreadable` rather than a pass on an assumption. A tag push runs the
workflows committed in the tagged tree, so a target the default branch never
contained would make "this release was built from this repository at this commit"
uncheckable. The previous-version scan decides ancestry first: it walks the
SemVer tags newest-first and stops at the first one the target is ahead of or
equal to, because that is the highest reachable tag. A target older than the
newest tags therefore still knows its real previous release; capping the walk to
the ten newest tags before the ancestry test did not, and it silently skipped
both "nothing to release" and "not higher" for such a target, so a downgrade
passed. The walk costs one compare per tag newer than the previous release, and
the destructive class limit on the route is what paces repeats. Both routes that
write a tag — this release POST and the readiness page's tag button — take the
destructive class limit and a fresh GitHub confirmation; the release POST is
filed under the destructive route class, beside the other ref writes. On the
readiness route the confirmation is checked before the branch is read
(`src/app.ts:2508-2509`). The release POST parses its own form body — version and
SHA, no GitHub read — and only then requires the confirmation
(`src/app.ts:2554-2559`), so on neither route does a GitHub read or a token
precede it.

A tag-triggered workflow means a `tags:` filter directly under the `push:` event.
The filter's depth is read from the block instead of assumed to be two spaces, so
a four-space workflow reads the same as a two-space one, and `tags:` under another
event (`workflow_dispatch.inputs.tags`) is not a trigger — reading it as one would
write an irreversible tag whose release workflow never runs. `tags-ignore` is not
accepted as a positive answer either: the glob cannot be judged against the
version about to be created, and a missed tag is the worse error.

Only a plan that passes every check reaches the write: an annotated tag object
(`POST /git/tags`) followed by its ref (`POST /git/refs`). A 422 on the ref means
somebody else created the tag first and is a refusal, never an update; a 422 on
the tag object means the commit is not there any more and is the same refusal as
the preflight's missing-commit check. Nothing deletes or moves a ref, and Fledge
never publishes a Release. The write uses the token Fledge already holds for the
repository: the GitHub App installation token when the repository is installed,
otherwise the connected account's repo-scoped OAuth token.

The page is the only surface a maintainer reads, so every outcome lands there:
`?release=1&refused=<reason>` renders the refusal (with the suggested version)
above the form, and `?release=1&tagged=<tag>` confirms the tag that was created.
A name that already has a `repo_releases` row is a re-tag: the row is updated in
place to the new `target_sha`, `tag_object_sha`, `user_id` and preflight (the
previous tag and the actor of this tag), keeping its `created_at`, so the row
describes the action that produced the state it shows rather than the first
tagger. `status` stays `tagged`, `updated_at` moves forward, the audit appends a
new `release.tagged` row, and `?release=1&tagged=<tag>&retagged=1` renders the
re-tag wording instead of the created-tag banner or a refusal. A refusal from
the ref write that is not a 422 reports only `the tag reference was refused by
GitHub (HTTP <status>); nothing was moved or deleted`; the upstream body text is
never quoted. A 422 keeps its own `tag v1.2.3 already exists; nothing was moved or
deleted` sentence, so the race and the generic refusal do not merge.

`repo_releases` records one row per created tag (`UNIQUE(repo_id, tag_name)`), with
the tag object SHA, the target commit, the previous tag and the actor. The
workflow-run slice adds its observation to that same row (additive columns, no
second table): `run_id`, `run_attempt`, `status`, `conclusion`, `workflow_name`,
`draft_release_id`, `draft_url`, `external_release_id`, `last_checked_at` and
`notes_source_json`. `release_sources` from the issue is still not a table: the
notes slice keeps its exact sources as one JSON column on the row they belong to,
because a source only ever exists for that release and is written once.

The read-only readiness view (`GET /repos/:id/release-readiness`, #546 slice 1)
answers the same question before a version is typed: the latest SemVer tag
reachable from the default branch and its commit time, the commits since it, the
pull requests merged since it with how many are features, and whether a
`changelog.d` fragment is pending for that range. Every call is a GET on the
installation token Fledge already holds; it creates no tag, no Release and asks
for no token with release scope. The three version-independent refusals
(`missing_gate`, `missing_release_workflow`, `no_new_commits`) come from
`releaseRefusals` in `src/releases/release.ts`, the same table `planRelease` reads,
so the page and `POST /repos/:id/release` cannot state different reasons for the
same facts; `tag_exists` and `not_higher` stay on the write path because they need
a requested version. A feature is a merged pull request carrying an `enhancement`
or `feature` label, or, with neither, a title with a `feat` conventional prefix,
and the page names which rule counted each one. The merged count is bounded by
the closed-pull-request page cap; when the cap is reached while rows are still
inside the window the page says the count may be higher instead of printing a
smaller number. A fragment counts when it is present at the head with a blob the
previous tag does not have, so an edited fragment is still pending work.

The one write on that page is `POST /repos/:id/release-readiness/tag` (#546 slice
2): the form carries the head the page rendered, and the route reads the default
branch again immediately before the tag write. A head that is not the one the
form carried is refused as `branch_moved` with both commits named, because a tag
is never moved or deleted and a stale target costs a version rather than a retry;
a refused ref write (403/404) is `tag_scope_missing`, naming `Contents: write`
instead of repeating GitHub's text. The route creates the annotated tag and its
`repo_releases` row and stops there — observing the run and preparing a draft
Release stay with `src/releases/tracking.ts`, so the page's own write path cannot
publish anything.

## Following the release workflow and preparing a draft

`src/releases/tracking.ts` observes the workflow a tag fires and stops at a draft
Release — a human still edits and publishes it. The reconcile is bounded: three
pages of runs (`GET /actions/runs?branch=<tag>`, so another workflow's traffic
cannot push the tag's run out of the window), three pages of jobs
(`GET /actions/runs/{id}/jobs`), and no history crawl. The selected run must match
twice: its head is the tag commit, and its path is the release workflow
(`.github/workflows/release.yml` or `.yaml`). Neither match is a preference with a
fallback — a tag whose release workflow has not appeared yet is `run_missing`,
because a draft body that says the release workflow succeeded has to be true.
Among the runs that do match, the newest run and highest attempt win.

A draft is prepared only when the run is completed with conclusion `success` and
every job is `success`, `neutral` or `skipped`. An in-progress run or job keeps
the row at `running`; a `failure`, `cancelled`, `timed_out`, `startup_failure`,
`action_required` or `stale` run, or one failed job under a green run, records
`run_failed` and creates nothing. Fledge never reruns the workflow.

Before the run is read, `GET /releases/tags/{tag}` answers whether the repository
already has a Release for this tag. The id this row recorded is its own: still a
draft is `draft_exists`, and once the human published it the same id is
`draft_published` — the pointer and the page link are kept either way, because
publishing is the documented end state. Any other Release is `external_release`:
the row stores its id and no second Release is created. A Release that appears
between the read and the write is caught as a 422 on `POST /releases`, re-read by
tag, and recorded as external instead of retried. `POST /releases` is fixed to
`draft: true` in the client, so this path cannot publish.

The first observation happens once after a successful tag write and is recorded
even when no run exists yet (`run_missing`); a failed observation is logged and
never turns the created tag into a refusal. The maintainer repeats it from the
repository page with `POST /repos/:id/releases/:releaseId/check` (owner only,
CSRF, maintainer role), which re-reads the run, writes the tracking columns and
audits `release.checked`. The page shows the status, run id, conclusion, draft
link or external marker, and the check button. Nothing here publishes a Release,
deletes or moves a tag, or starts a workflow.

## The draft body is the release range (#546 slice 3)

`src/releases/notes.ts` builds the draft body from `[previous tag, target SHA]`
and hands it to the same create call. `compareReleaseRange` reads
`GET /compare/{previous tag}...{target}` once for its commits, and
`listMergedPullRequestsSince` supplies the merged pull requests with their
`merge_commit_sha`. Membership is decided by ancestry, not by date: a pull request
is in the release only when its merge commit is one of the compared commits, and a
pull request merged before the previous tag is absent however recent its merge
date looks. Every source appears exactly once — the pull request is listed by
number and title, and its merge commit is not printed again as a bare commit — so
the body cannot double-count one change. `total_commits` larger than the returned
commits, or a pull-request walk that hit its page cap, marks the notes partial and
the body says so rather than describing a smaller release.

The range is read only at the moment a draft is about to be written, so a run that
is still going, failed, or already has a Release costs no compare. A failed range
read is caught, logged as `release notes range read failed`, and the draft keeps
its placeholder body: losing the Release to an unreadable commit list would be
worse than a draft without notes. The exact sources are stored on the same row in
`notes_source_json` by the same reconcile that created the draft, and the
repository page renders them with their links, so the page and the body cannot
disagree about what the release contains. A stored value that is missing or
malformed renders no sources rather than an error — the draft Release is the
record of what shipped, the column is its explanation.

## The failed run analysis is read-only (#546 slice 4)

`POST /repos/:id/releases/:releaseId/analyze` reads the failed jobs of the run the
release row recorded. It is a maintainer action with an explicit button, and it is
the only place Fledge reads a workflow log for a release. The credential is the
point: `GithubApp.ephemeralToken` mints an installation token with exactly
`actions: read` outside the token cache and narrowed to the one repository named in
the mint body, the read uses it, and `GithubApp.revokeToken` revokes it with
`DELETE /installation/token` in the same call's `finally`. `actions: read` is what
`/actions/runs/{id}/jobs` and `/actions/jobs/{id}/logs` need; a token with
`contents: read` could also read the source of every repository in the installation,
which a log read cannot justify. A repository whose token is a user OAuth token is
refused with `ANALYSIS_READ_ONLY_TOKEN` rather than widened, because a user token
cannot be narrowed. A revocation that fails is stored with the result rather than
swallowed.

`src/releases/analysis.ts` keeps the excerpt honest: the whole log is redacted
before any slice, so a secret split by a truncation cannot survive as a fragment,
and the bounded tail records the exact 1-based lines it kept (`lineStart`,
`lineEnd`, `totalLines`) plus the job's `html_url`. At most two failed jobs are
read per analysis. The route hands the mint to the module as a callback, so the
order is the module's: a run that is still going or concluded anything but a
failure is refused before a token is minted, and a POST against a green or running
row spends no credential at all. The result is written to `analysis_json` on
`repo_releases` (schema 47), which is beside `status`, `conclusion` and the draft
pointer and never inside them: an analysis cannot turn a failure into a success,
create a Release or rerun a workflow. The repository page renders each excerpt with
its line range and the job link, and a stored value that is missing or malformed
renders no analysis rather than an error.

## The strategy bundle (#433 slice 1)

A repository's development strategy is one artifact, not a set of settings spread
over the playbook, the rule overrides and the goal. `src/strategy/bundle.ts` keys
each part independently (`rules:<path>`, `playbook:team`, `goal:guidance`, and
later the rubric, task templates and routing), and every value is a reference to
where the content lives — a rule override revision, the playbook version plus the
fingerprint of the goal it was built from, the hash of the goal text — never a
copy of a moving path. The bundle's name is `sha256` over the canonically ordered
section map, so the same strategy always hashes the same and any change produces a
new bundle.

`strategy_bundles` stores one row per version (`UNIQUE(repo_id, version)` and
`UNIQUE(repo_id, hash)`, so the same content cannot be stored twice), with its
parent version and the actor who froze it. `strategy_pointers` holds `candidate`,
`canary` and `stable`, but slice 1 writes only `candidate`: `stable` and `canary`
need the promotion decision of a later slice, and a freeze that could move them
would ship a strategy without the human approval this epic requires.

`GET /repos/:id/strategy` (owner only) renders the three pointers, the sections of
the current candidate and their sources, and the version history. The form it
carries includes the candidate version it rendered, and `POST /repos/:id/strategy`
(owner only, CSRF, maintainer role) compares that base with the current candidate
inside one transaction: a stale form is refused naming both versions and writes
nothing, because two tabs must not silently replace each other's candidate. When
the assembled content already has a bundle — the repository's sources came back to
something frozen before — the freeze writes no second row, because the hash is the
identity, but it still moves `candidate` onto that bundle inside that transaction
and reports that version: the pointer always names the content the page assembled.
The sections are assembled from sources that already exist — `repo_rule_overrides`
by revision, the role playbook by version and goal fingerprint, the goal by hash —
and a path or key under a frozen family (`evaluator`, `evidence`, `ci`, `gate`,
`auth`, `gateway`, `capability`) is refused before the store is asked to write.
Canary promotion with rollback, the accepted-version lineage edge and the global
bundle are later slices.

## Every job records its strategy (#433 slice 2)

A job row carries `strategy_hash`, `strategy_version` and `strategy_json`, written
by `Store.createJob` from `currentStrategySections` — the same assembly the
strategy page reads — so a page a maintainer opens and the strategy a job names
cannot disagree. The section map is stored on the job rather than as a pointer to
a bundle row because a job can run a strategy that was never frozen, and because
history must not change under a later pointer move: the job keeps the exact map it
was created under. `strategy_version` is NULL for exactly the unfrozen case; the
page says "not frozen" instead of borrowing the candidate's version number. A
strategy whose sources name a frozen section is not a bundle the page would
accept, so that job records none rather than a hash that was never valid.

The job page shows the hash, the version when there is one, and the sections the
job recorded. When the previous job on the same repository recorded a different
hash, the page names the section keys that moved — added, changed or removed —
with the value each key had on both sides; the comparison is
`Store.previousStrategyJob` (the newest earlier row of that repository that
recorded a strategy), so a row from before the columns existed is skipped rather
than reported as "no change". The older job keeps its own hash and its own page;
a bundle change is a diff between two jobs, never a rewrite of the earlier one. A
job whose row predates the columns renders "no strategy was recorded" rather than
an empty strategy.
## Run now is an occurrence, not a moved cursor (#544)

A schedule names logical instants; the tick decides which of them run. "Run now"
is the one command that starts an instant a person asked for, and it keeps the
same record: an occurrence row, settled `dispatched` with the job it started or
`skipped` with the refusal.

The occurrence's identity is the `command_key` the console form rendered, under
`UNIQUE(schedule_id, command_key)`. The same key returns the occurrence it
already wrote — a double click is one run — and a new key is a distinct
instance. The row is written before the job, so a crash between the two leaves a
row the next press reads instead of a second job, and a refused run still
settles the row so the replay answers the same refusal.

The recurrence cursor (`last_occurrence_at`) is not touched: "run this now" must
not move when the schedule next fires. `schedule_occurrences.command_key` is
null on every row the tick wrote, which is why the unique index is partial.

## A paused schedule is decided, not run (#544)

A schedule carries a state — `active` or `paused` — in `schedules.status`, with
the instant of the last pause in `paused_at`. Only a maintainer's button writes
it (`POST /repos/:id/schedule/pause` and `.../resume`, audited as
`schedule.pause` / `schedule.resume`); saving the schedule form never changes it,
so editing an expression cannot quietly switch a paused schedule back on.

A paused schedule is still planned. The tick runs `planTick` as usual and then
records the decision as `skipped` with reason `paused`, in the same
`recordScheduleDecisions` transaction that moves the cursor — the pause window is
readable afterwards instead of vanishing, and because the cursor keeps moving a
resume does not make up a backlog or dispatch once per missed instant. The
paused branch sits before the budget, active-job and idle reasons, because
"somebody paused this" is the honest explanation for the instant.

`run-now` stays available while paused: a person pressing the button is an
explicit command, not the cadence, and it settles under its own command key.
Resuming does not create an occurrence or move the cursor either, so the only
thing it changes is whether the next instant dispatches.
