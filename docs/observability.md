# Observability and operations

## Metrics

`GET /metrics` exposes Prometheus text format. A production process refuses to
start unless `METRICS_TOKEN` is set; with a token, send
`Authorization: Bearer <token>`. The token is read from that header only — a
`?token=` value is not accepted, because a URL ends up in proxy access logs,
browser history and `Referer` headers — and it is compared in constant time.

Outside production an empty `METRICS_TOKEN` leaves `/metrics` loopback-only: a
local shell keeps working without configuration, and a public peer never does.
"Loopback" means the peer the configured `TRUST_PROXY` hop saw, so a
client-supplied `X-Forwarded-For` cannot make a public request look local. Name
the proxy hop in `TRUST_PROXY` (see `docs/deploy.md`); the default is the
loopback list for the direct-nginx path.

Test evidence is also checked against the PR check runs: a claimed green test with a failing test check is contradicted and blocks auto-merge.

Core series:

- `fledge_http_requests_total{method,route,status}` and
  `fledge_http_request_seconds`
- `fledge_jobs_total{status,kind}`, `fledge_job_seconds`,
  `fledge_job_queue_seconds`, `fledge_job_output_total`, `fledge_jobs_active`,
  `fledge_jobs_queued`
- `fledge_automation_idle_with_work_seconds{repo}` — how long a repository has
  had ready work with no active job. The series is **absent** when the repository
  is not waiting, so an empty panel means "nothing is idle", not "the scheduler
  is silent".
- `fledge_automation_dispatch_latency_seconds{kind}` — seconds from ready work
  to a dispatched job, so a near-zero reading means "the next item started at
  once" — the reading a successful work job should now give (#801) — and a
  15-minute one means a run that did not succeed held it. It keeps the default
  bucket list like every other histogram, and `FledgeDispatchLatencyHigh` pages
  on its p95 above 900s. The console prints the mean in milliseconds.
- `fledge_automation_blocked_total{reason}` — ready work that did not start, by
  reason (`cooldown`, `failure_backoff`, `active_job`, `instance_not_ready`,
  `user_not_ready`, `quota`). A failure shows `failure_backoff` instead of a
  dispatch, and a repository that is merely throttled shows `cooldown` — so a
  `cooldown` on a repository whose last work job succeeded means something other
  than the success wait held it.
- `fledge_queue_depth`, `fledge_lease_expired_total`,
  `fledge_admission_rejected_total{reason}`, `fledge_meta_issue_total`,
  `fledge_auto_merge_candidates`, `fledge_ops_alerts_open`
- `fledge_retries_total{kind}`, `fledge_merges_total{result}`,
  `fledge_path_guard_blocked_total`, `fledge_verification_failed_total`
- `fledge_notification_outbox{status}` — queued or delivered notifications by
  outbox state; a state with no rows is absent, so an empty panel means "none",
  not "zero delivered".
- `fledge_github_requests_total{method,status}`,
  `fledge_github_request_seconds`
- `fledge_bridge_requests_total{status}`, `fledge_bridge_request_seconds`
- `fledge_clock_skew_seconds` — the last measured offset against GitHub's `Date`
  header, positive when the process clock is ahead. The series is **absent** when
  nothing has been measured, so an empty panel means "unknown", not "aligned"; a
  scrape with no reading removes it rather than publishing a `0`.
- `fledge_router_up`, `fledge_router_probe_seconds` — the shared model router,
  and only while `MODEL_ROUTER_URL` is set. `up` is 1 when the last probe read a
  health answer; `probe_seconds` is how long that read took.
  `fledge_router_mode_rate_total` and `fledge_router_mode_budget_total` count
  what the router reported, while `fledge_router_all_keys_rate_limited_total`
  and `fledge_router_all_keys_exhausted_total` are incremented **only** when
  every key the router reports is capped with that one cause — a single cooling
  key never reaches the all-keys names, and a mixed cap (one key budget-capped,
  the others rate-capped) increments neither, because the names say why nothing
  can serve and a mixed cause is reported in `router.state` instead.
  `fledge_router_unreachable_total` counts probes that could
  not read an answer. The gauges are `fledge_router_key_spend{key}`,
  `fledge_router_key_max{key}`, `fledge_router_rate_cooldown_seconds`,
  `fledge_router_budget_cooldown_seconds` and `fledge_router_queue_depth`; `key`
  is one of the fixed aliases `primary`, `alt`, `third` and never a key value, a
  key file or a repository. A probe that cannot read an answer removes every
  label combination of those gauges, the per-key ones included, instead of
  leaving the previous reading, so an empty panel means "unknown", and a
  deployment with no `MODEL_ROUTER_URL` publishes none of these series.

The `/admin/metrics` page carries the same three numbers as one `Automation
health` card — repositories with ready work and no active job, the mean dispatch
latency since the process started, and the queue depth — so an operator reading
the page and an operator reading a dashboard are looking at one measurement, not
two definitions of it.

Automation alerts:

- The store raises `automation_idle_with_work` (warning; critical at twice the
  threshold) when a repository the scheduler may dispatch to has ready work and
  no running job for `AUTOMATION_IDLE_ALERT_MINUTES` (default 30) since its last
  run or its oldest ready item. "May dispatch to" is the dispatcher's own test —
  enabled, automatic iteration on, the owner approved, the bridge instance ready
  when the installation runs instances — and it lives in one place,
  `Store.automationDispatchBlocker`, so the alert cannot call a repository idle
  after the dispatcher has refused it as `user_not_ready` or
  `instance_not_ready`. The alert clears as soon as a job starts, because the
  condition is recomputed rather than remembered, and the notification pass
  keeps one per `OPS_ALERT_COOLDOWN_MINUTES` window.
- `FledgeDispatchLatencyHigh` pages when the p95 dispatch latency is above 15
  minutes. Thresholds are configured in the rules file; the store threshold is
  configured by `AUTOMATION_IDLE_ALERT_MINUTES`.
- Labels carry a `owner/name` repository label, the job kind and the reason. No
  issue title, URL, token or email reaches a metric label: the dispatcher passes
  only those three values.

Suggested SLOs:

| SLO | Target |
|---|---|
| job success rate (succeeded+failed, 7d) | ≥ 90% |
| p95 queue wait | < 10 min |
| p95 job duration | < 30 min |
| merge success after green checks | ≥ 98% <!-- slo:reported-only --> |
| bridge availability | ≥ 95% (failure rate ≤ 5% of non-2xx bridge requests) |
| GitHub 429 rate | ≤ 0.1 req/s (status=429 only) |

`test/sloDefinitions.test.ts` reads this table and the rules file together, so a
row and its rule cannot disagree about the unit (a share versus an absolute
rate), the selector (which responses are counted) or the target by more than one
percentage point. A target with no rule carries the `<!-- slo:reported-only -->`
marker instead: it is reported, not paged on, and pretending otherwise reads as
coverage that does not exist. The bridge and GitHub rows state the shipped rule
exactly; raising either target means changing `deploy/prometheus/fledge-alerts.yml`
in the same PR, which is an alerting change and not a documentation edit.

## Alert rules and SLO report

Prometheus alert rules live in [`deploy/prometheus/fledge-alerts.yml`](../deploy/prometheus/fledge-alerts.yml).
They cover job success, p95 queue wait, p95 job duration, bridge failure rate,
GitHub 429s, clock skew and open operational alerts, each with a runbook link.
`FledgeClockSkewHigh` pages at `abs(fledge_clock_skew_seconds) > 120` sustained
for ten minutes; its runbook is [`docs/deploy.md`](deploy.md), because the action
is on the host rather than in the application.

```sh
npm run build
PROMETHEUS_URL=http://127.0.0.1:9090 npm run slo:report
```

Set `PROMETHEUS_AUTH_HEADER` when Prometheus needs authentication: it is sent as
the request's `authorization` header and never travels in the URL. A
`PROMETHEUS_URL` that carries a username or password is refused before any
request — the credential is not scrubbed out of the URL, the URL itself is the
error — because Node prints a URL it cannot use into its own error text, and that
text lands in a terminal, a CI log or a shell history. A header is only sent over
`https:` unless the host is loopback (`127.0.0.1`, `localhost` or `::1`).

The report prints the 7-day success rate, remaining error budget, queue/job p95,
bridge success and GitHub 429 rate. Missing series render as `n/a`, and so does a
quiet window — counters present but flat — in the five rows that can then be
non-finite: the success rate, the error budget derived from it, both p95 values
and the bridge success rate. The GitHub 429 rate and the open-alert count read a
real `0` on the same window and keep printing it.

The job success rate counts only `succeeded` and `failed` jobs. The other terminal
states — `cancelled`, `paused`, `quota_exhausted` and `superseded` — are excluded
from the numerator and from the denominator alike, so the percentage is a rate
over jobs that ran to success or failure, not over every job Fledge accepted: a
surge of quota refusals, cancellations or superseded queued jobs shrinks that
population without moving the rate, and the report does not show how many jobs it
left out. A `superseded` job is one a newer trigger replaced before it started, so
it neither failed nor ran. The set itself is decided
in [decisions/0008](decisions/0008-slo-denominator.md).

## Traces

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP collector (for example
`http://127.0.0.1:4318`). Fledge exports JSON spans for HTTP requests, GitHub
calls and bridge dispatches. With an empty endpoint tracing is a no-op.

## Operational alerts

`Jobs.notifyOpsAlerts()` runs on the scheduler tick. Stalled jobs, stale PRs,
invalid credentials and budgets near their limit are notified to the repository
owner in-app, posted to the optional notification webhook as `ops.alert`, and
deduplicated for `OPS_ALERT_COOLDOWN_MINUTES`. Resolving an alert clears its
marker, so a later recurrence notifies again.

## Model router

The shared model router is a separate service, and Fledge probes it only when
`MODEL_ROUTER_URL` is set. `/readyz` then carries a `router` object beside the
database, instance and clock fields, with `state` (`ok`, `rate-limited`,
`budget-exhausted`, `unreachable`) and `latencyMs` and nothing else. Readiness
fails only on `unreachable` or on a router whose every reported key is capped:
`mode: rate` with one key cooling is a detail, not an outage, and a deployment
with no `MODEL_ROUTER_URL` answers exactly as it did before the probe existed.
An answer Fledge cannot parse — non-200, truncated, missing or unknown `mode` —
reads as `unreachable`, and `FledgeRouterUnavailable` pages on `fledge_router_up == 0`.

The ops alert goes to the superadmin (`ADMIN_GITHUB_LOGIN`) through the same
cooldown, event row and `ops.alert` webhook every other alert uses, because a
router with no serving key is not one repository's problem. The alert text and
the metric labels carry the state and the fixed key aliases only.

Operating the router:

- **Add a key.** Write the provider key to the router's key file and restart the
  router (`MODEL_ROUTER_PRIMARY_KEY_FILE`, `MODEL_ROUTER_ALT_KEY_FILE`,
  `MODEL_ROUTER_THIRD_KEY_FILE`; `MODEL_ROUTER_THIRD_MAX_BUDGET` caps the third).
  Fledge needs no change: the next probe reports the new key's spend and budget,
  and `/readyz` flips back to `ok` as soon as a key can serve.
- **Rotate a key.** Replace the file, restart the router, and watch
  `fledge_router_key_spend{key}` return to 0 with `fledge_router_key_max{key}`
  set. The spend history lives in the router's state file
  (`MODEL_ROUTER_STATE`) and follows the key alias, not the secret, so a rotation
  does not reset a budget that was already exhausted.
- **Tune the cooldowns.** `MODEL_ROUTER_RATE_WINDOW_MS` (default 60000) is how
  long a key stays cooling after a 429; `MODEL_ROUTER_QUEUE_DEPTH` (default 32)
  and `MODEL_ROUTER_MAX_WAIT_MS` (default 2000) bound the queue in front of the
  keys. Raising the window keeps a throttled key out of rotation longer, and the
  cooldown gauges show the effect immediately.
- **When every key is capped**, `/readyz` answers 503 with
  `router.state` naming `rate-limited` or `budget-exhausted`, the ops alert opens
  once per `OPS_ALERT_COOLDOWN_MINUTES`, and the fix is on the router: wait for
  the rate window, or add or rotate a key. Fledge does not retry, queue or spend
  on the router's behalf — it only reports.

## Instance health

The scheduler probes each ready instance through the bridge for DSH `state`.
A bridge that answers `/healthz` but cannot reach DSH is not ready. Failed instances are probed too; a healthy bridge and DSH move them back to ready and audit `flybot.instance.recovered`. A healthy probe also refreshes the stored team session IDs from DSH `state`, and a container restart clears the persisted DSH team lock first, and the same refresh runs before job dispatch; the change is audited as `flybot.team.sessions_refreshed`. When no job
is active, Fledge restarts the container, waits for DSH `state` and audits
`flybot.instance.auto_restarted`; the restart is rate-limited to once per ten
minutes. An instance with an active job is marked failed instead of restarted.

## Shutdown and recovery

On `SIGTERM`/`SIGINT` Fledge stops scheduling, waits up to
`SHUTDOWN_GRACE_SECONDS` for active jobs, closes HTTP, flushes traces and closes
SQLite. Startup removes orphan `retry_pending:`/`pending_followup:` settings,
orphan job events and orphan instances.

## Backup restore drill

`npm run db:restore-drill -- --db <path> --backup-dir <dir>` proves a backup
restores without touching the live database. CI runs
`npm run db:restore-drill:ci` against a disposable database.
