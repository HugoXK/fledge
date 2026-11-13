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
its design tokens are documented in [docs/ui.md](ui.md).

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
the previous chip marked. `/admin`'s top card has no `id` on purpose — it is the
page header, not a section — so nothing is marked at the very top of that page;
that is the accepted state, not a defect.

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
  missing states the reason instead of offering a control. Once a job exists the
  checklist is replaced by a first-run summary whose outcome is the first job's
  own status, read all-time (not a window-scoped count), in four shapes: the
  job's PR link when it opened one, "finished" with a link to Recent jobs when it
  succeeded without a PR, "running" while it is queued or running, and the retry
  path on the repository page when it failed.
- **Next action** (`src/views/pages.ts`, `nextActionFor`): `/dashboard` opens
  with one server-derived action instead of a wall of equal cards. The order is
  the order a person would take them — an open question only they can answer, an
  exhausted platform quota, the most urgent alert (stalled or slow job, stale
  PR, invalid credential, repository budget), the account's newest failed job,
  the unfinished first-run step — and when none applies, an all-clear that names
  the known next scheduled automatic run (a repository the scheduler has never
  run is not a known time and never shadows one), or says that no repository runs
  automatically. Every source is one the route already loads, so the block cannot
  disagree with the sections below it. The newest job is read on its own, not
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
  so a phone loses no route. Below 420px the row also drops the wordmark (the
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
  paints with `--accent-strong`, the one interactive accent.
- **Dashboard job filters** (`src/lib/jobFilters.ts`): `/dashboard` accepts
  `repo`, `status` and `kind` as GET parameters and applies them in SQL, so the
  count, the page and the pagination links describe the same list; a value the
  account cannot use is dropped rather than turned into an error page, and the
  filter lives in the URL rather than in a client store. Every control that
  rebuilds that URL keeps the state it is not changing: the 7/30-day window,
  both "Clear filters" links and both pagers read the keys from one helper, so
  the filter survives a window switch and a page click, and the window survives
  a filter and a clear. The admin search page (`/admin/search`) builds its two
  job filters from those same `JOB_FILTER_STATUSES` and `JOB_FILTER_KINDS` lists
  and the same label helpers, so every kind a job can have is selectable there
  and both locales read the console's words rather than the stored code; the
  option values stay the codes, so the query, the totals and the CSV export are
  unchanged. A second hand-written list in a view is how `scope` and `verify`
  went missing from a form once already.
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
  waiting for the 90-minute job timeout. Queue admission rejects a new job when
  the global or per-user cap is reached. A partial unique index
  (`jobs_one_active_per_repo`) makes the one-active-job-per-repository rule a
  database invariant, not only a read-time check; a database written before the
  index existed is deduped when it opens — keep a running job (else the oldest
  queued one) and fail the rest with `JOB_DUPLICATE_ACTIVE_SUPERSEDED` and an
  audit row, so a duplicate row cannot turn startup into a boot failure. A
  demoted row that was running a work item resets that item to `triaged` in the
  same transaction (a legal `in_progress -> triaged` edge in
  `WORK_ITEM_TRANSITIONS`) and its audit row names the item id, because the item
  would otherwise stay `in_progress` behind a job that can never finish. The
  lease and queue columns are schema version 33.
- **No worker process**: a 60-second tick chooses the next job for a due repo.
  With open work it follows up the highest-priority item (or reviews its PR when
  a maintainer reviewer is due); with no open work it **stays idle** unless the
  discovery interval is due, in which case it may run one `discover` job that
  creates at most one concrete issue and never a PR. The latest three run digests
  and open work items are carried
  into the goal as bounded data. Work sessions use a short global cooldown
  (`WORK_SESSION_COOLDOWN_MINUTES`, default 15 minutes); the per-repository
  interval is only an upper bound on the idle check, with a 60-minute floor for
  discovery, not a reason to produce.
  A run backs off after two unproductive (failed, zero-output or meta) runs and
  is skipped while another job for that repository is active. The global
  concurrency cap is 2. Review cadence is from every 6 hours to every 30 days.
  Jobs that exceed the timeout are failed.
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
  Iterate jobs preflight the target branch, record the base SHA
  and warn when the fork is behind. An open work item changes what the next
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
  is audited as `job.merge_review_override`. The agent prompt always forbids
  merging. The switch is stored on the repository and included in the job
  payload for reporting. A stale or downgraded role blocks the merge.
  A merge also needs the newest `iterate` job for that pull request to have
  succeeded: a queued, running, failed, cancelled or paused follow-up on the
  same PR holds it back, so an older succeeded job cannot merge work that is
  still in flight or that failed afterwards. A pull request that is already
  merged is never a candidate, so the bulk merge does not re-check it on every
  pass.

### Model gateway

`/v1/*` is OpenAI-compatible and authenticated with `flg_` tokens. A token
carries a `scope` and an `expires_at`: `gateway` is the only enforced scope, a
personal token always gets a finite lifetime (30/90/365 days, default
`PAT_EXPIRY_DAYS` 90) and only an admin may create an operator token without one.
The gateway answers `401 invalid_api_key` for an unknown, revoked, expired or
non-approved token and `403 insufficient_scope` for a live token outside the
gateway scope, decided before `last_used_at` is written; neither refusal echoes
the token. The settings page lists each token's scope, expiry and last use, and
revoke stays one click.

- If the user has an own model configured, Fledge proxies to it and does **not**
  meter platform quota.
- Otherwise it proxies to `PLATFORM_LLM_BASE_URL` with `PLATFORM_LLM_KEY`, reads
  `x-litellm-response-cost` (or estimates from `usage`), and records the cost in
  `quota_ledger` + `users.quota_used_usd`.
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
short-lived App JWT (with a clock-skew correction from GitHub's `Date` header),
exchanges it for an installation token, lists the installation repositories and
stores only `repos.installation_id`; `repoGithubToken()` prefers a user OAuth token authorized with `repo` scope for human attribution and otherwise uses a fresh installation
token when that column is set and falls back to the encrypted PAT otherwise. The
installation callback binds the installation to the logged-in user (verified
through the user's OAuth token or an individual account match). GitHub webhooks
are verified with `X-Hub-Signature-256` before parsing; verified events are
recorded in `events` for the follow-up loop. PAT onboarding stays available.

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
dashboard repository table, the repository page's delivery, board and work-item
tables, and the support view's repository and job tables. Adding the class and a
`data-label` per cell is the whole change; a table must not grow a second card
mechanism. The delivery board is the one exception, `table-cards table-cards-head`:
its header row is the stage filter, so it stays in the flow and reflows as a
wrapping row of links above the cards instead of disappearing. Above 640px the scroller is also bounded vertically
(`100dvh` minus `--header-h` and `--space-7`, and minus the repository
subnav's `--subnav-h` on a repository page) and its `thead th` is sticky on an
opaque `--panel`, so column names stay above the rows they label; the two rules
are one contract and `test/density.test.ts` asserts both. The row density is a
saved preference: `/density/:mode` writes the `fledge_density` cookie the way
`/lang/:locale` writes the language one, `<html data-density>` carries it (the
response hook fills it in from the cookie, so no page builder has to remember),
and `<html data-density="compact">` trims only the cell box. Below 641px the
bounded scroller and the density do not apply: the tables are the card stack and
the 44px touch floor stays. Between 641px and 960px a wide table (the
delivery board is 952px wide at 768) can still be wider than its `.table-scroll`
box, so that band draws an always-present classic scrollbar — an explicit track
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
`job.failed`, `job.merged`, `stage.missing`, `team.role`), so a job can be
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

The repository page adds a compact delivery board grouped by work-item state; each state header links to a filtered work-item list (`?workState=`). The dashboard has two scopes. `/dashboard?window=7|30` shows the signed-in
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

`GET /api/read/metrics` exposes the same read model as JSON for an external
control room: a normal user gets `personal`, a super admin gets the global sections.
The route is read-only and session-scoped.

The evolution ledger is intentionally separate from the job path. It adds
`artifact_versions`, `evaluations` and `promotions`: an artifact candidate, its
held-out evidence, and a human-approved decision. AgentDescent is an offline
engine behind this ledger; it never runs a user repository, never receives a
GitHub token and cannot change the evaluator, CI or merge gate. See
[decisions/0003](decisions/0003-agentdescent-evolution.md). The read-only
`scripts/evolution-shadow.mjs` exporter turns recent jobs into a redacted
dataset, and `--report` prints the baseline plus a time-ordered train/holdout
split; it does not write to the database.

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
start with a code, and the route puts that code on the redirect with the payload
after a colon: the code's own parameter where it has one (`BRANCH_MISSING:main`,
`JOB_LIMIT:2`, `BOT_MODEL_ASSIGNMENT_FAILED:chief, lead`) or else the sentence the
service wrote. The banner asks the sentence table first, so those codes read in
the reader's language with their parameter filled in. A code whose table entry
carries `{detail}` keeps that parameter too — the duplicate-work refusal names the
pull request that already covers the issue (`DUPLICATE_WORK:<url>`) — so the value
the service found survives the redirect instead of being dropped when the sentence
is rebuilt. A refusal that names a pull request (`DUPLICATE_WORK` for work in
flight, `ALREADY_FIXED` for a fix that landed) renders that value as a link, so the
maintainer opens the pull request the refusal came from instead of copying a URL out
of the sentence; the anchor is built only for a `github.com` pull request URL,
because the banner value arrives as a query parameter and any other value stays
escaped text. A code with no sentence
keeps the text that travelled with it, which the dictionary translates as it did
before this change, so no refusal reads worse than at base; only a bare code with
neither a sentence nor a text renders a sentence naming the code, so an unknown
value cannot leak. The raw text stays in `jobs.error`, under "Technical detail"
and in the notification row, for operators and for the API, and "Technical
detail" prints it as written rather than translating it. The choice is
recorded in `docs/decisions/0009-job-failure-codes.md`.

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
not a post marker, so it does not block a retry. If a review posted its comments
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
or a `review` when the item has a PR and a maintainer reviewer is due. With no
open work it returns `none` with reason `idle`: the scheduler writes
`last_status='idle'` and creates no job, issue or PR. When the repository's
discovery interval is due, it may instead run one `discover` job; that job may
create at most one concrete issue (never a PR/branch), and if it finds nothing
concrete it creates nothing. The callback refuses a discovery result that carries
a branch or pull request (`DISCOVERY_PR_FORBIDDEN`). The job goal gets a bounded
`Carry-over` block with the last three run digests and up to four open items; the
block is data, not an instruction, and is capped well below the 4000-character
goal limit. Each finished run is classified as `pr`, `issue`, `review`, `zero`,
`meta` or `failed`. A meta issue
(`存量/盘点/清账/reconcile/inventory/backlog audit`) is closed on the tracking
board and notifies the owner instead of counting as a productive run. Two
consecutive failed, zero-output or meta iterate runs double the effective
cooldown up to a 4x cap; the manual run path and reviews bypass the backoff.

### Work types and triage

A job carries two independent values. `kind` is the pipeline that runs it
(`iterate`, `review`, `plan`, `scope`, `verify`, `discover`, `triage`); `work_type`
is the contract the work is held to and is stored on the row. The registry in
`src/lib/workTypes.ts` is the only list of work types — `iterate`, `triage`,
`dependency`, `security`, `docs`, `performance`, `accessibility`, `migration` —
and each entry declares its allowed stages, the evidence keys it requires, a
declared risk tier, a per-job budget ceiling, whether it may open a branch and
whether its pull request may auto-merge. Only `iterate` and `triage` have a
handler in this slice; a declared type with no handler is refused at enqueue
exactly like an unknown one (`UNKNOWN_WORK_TYPE` / `WORK_TYPE_UNSUPPORTED`),
because nothing may run under a contract that is not enforced.

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

The kind and the work type are checked as a pair in both directions: a
`triage` run cannot be declared as another work type, and no other kind can
borrow the triage contract, so the page can never show the iterate contract for a
run that is forbidden to write. Resume and retry read one shared rule instead of
a ternary: a row keeps its own kind when that kind's contract does not depend on
the row being re-enqueued (review, plan, triage), everything else runs as iterate
work, and a declared work type that is not what the new kind implies travels with
the re-enqueue so a contract with no handler is refused rather than re-labelled.
A failed triage row therefore comes back as `kind='triage'`. What a triage row can
never do is start itself: this slice has no route, form or scheduler branch that
enqueues `kind='triage'`, so `triage` rows come from the service and from retry
only; the console control that starts one is tracked in #523. The report itself is
strict: an issue URL must carry a host (`https://` alone is refused) and a title
over `TRIAGE_TITLE_MAX` is refused rather than shortened, because a cut title
reads like the issue's real one. `triage` is also a filterable kind: it is in the
dashboard's `JOB_FILTER_KINDS`, offered by the dashboard, the search and the admin
search forms, and applied by `/search` as a value the user chose — a kind that
matches no job returns nothing rather than dropping the filter and answering with
every job. `discover` stays out of it because an account never starts a discovery
run by hand.

### Platform emergency stop

The stop is one `settings` row (`platform.stop`: when, who, why), not a field on
the `Jobs` object, so a restart cannot resume scheduling from a stale in-memory
"open" and a second process reads the same answer. `enqueue()` reads the row on
every call and refuses `PLATFORM_PAUSED` before the per-repository and per-role
gates; `tickOnce()` reads it once per tick, after its cleanup (stale jobs,
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
active job; requests are parked per fingerprint, so two different reviews on one
commit are two follow-ups rather than one overwritten entry. A follow-up does not
receive a second automation comment; the job list labels it "Follow-up".

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
on the issue with the work-item/job/PR state. `/fledge approve` is maintainer-only
and approves the latest completed plan.

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

### Pull-request delivery

Each repository page has a delivery list of iterate jobs with open pull requests,
with review score, cost, age and a maintainer one-click merge. Merging re-checks
the PR state, checks, commit status, reviews and branch protection through the
same path as auto-merge, updates the linked work item and marks the job's PR
state. A webhook updates the PR state when a PR is merged or closed. A bulk
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

### Per-job cost, evidence and metrics

The bridge's model proxy normally uses the per-repository instance token. While
a job is running it uses that job's short-lived `flg_` token instead (the
`/run` payload carries it), so the gateway can write `job_id` into
`quota_ledger` and add `jobs.cost_usd`. The job page shows cost, attribution and
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
or by hand with `npm run trial:sweep -- [--dry-run] [--login <login>]`) selects
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
in a development build without a token), never to an anonymous caller.

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
out of a link's detail text. The one live row is `This process`, which compares
the version in `package.json` and the commit stamp this process booted with
against that recorded tag target, so an operator can see at a glance whether the
instance they are looking at is the release the chain names. A snapshot that
claims `ok` with no links, or that contradicts its own problems, is refused as
unparseable — a green header over an empty table is the one shape the card must
never render.
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
| `jobs` | lifecycle, kind (iterate/review), branch, issue/PR URL, review score, summary, cost, job-scoped token hash |
| `api_tokens` | `flg_` tokens (PAT, job or instance), hashed, with `scope` (only `gateway` today) and `expires_at`; a PAT always carries an expiry |
| `quota_ledger` | per-request cost records |
| `notifications` | in-app messages (quota, job failure), stored as written and localized at render |
| `audit_log` | who changed what |
| `settings` | small key/value flags (e.g. quota notice dedupe); age-based pruning reclaims the per-job plan markers (`plan_expired:`, `plan_reminded:`) on the same window as the `jobs` rows |

## Job lifecycle

```
queued ──► running ──► succeeded
   │          │
   │          ├──► failed
   │          └──► timeout ──► failed
   └──► quota_exhausted
```

- `queued` is written before the runner is called.
- `running` is set when the bridge accepts the job (or immediately for the mock).
- `succeeded` / `failed` come from the callback or the mock.
- The repo records `last_run_at` and `last_status`; a scheduled job is skipped if
  another job for the repo is active. `jobs.continuity_json` stores the run
  digest, `jobs.output_kind` its classification and `jobs.continuity_used`
  whether the carry-over block was injected.

The claim/worker dispatch model, the `queued` meaning and the idempotent
callback contract are decided in [decisions/0004](decisions/0004-job-queue.md).

## Trust boundaries

| Boundary | Control |
|---|---|
| Browser → Fledge | session cookie, CSRF token on every form, rate limits; destructive writes also need a GitHub re-authentication inside `RECENT_AUTH_MINUTES` (`sessions.recent_auth_at`, audited as `recent_auth_required`) |
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
