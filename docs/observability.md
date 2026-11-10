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
- `fledge_jobs_total{status,kind}`, `fledge_job_seconds`, `fledge_jobs_active`,
  `fledge_jobs_queued`
- `fledge_retries_total{kind}`, `fledge_merges_total{result}`,
  `fledge_path_guard_blocked_total`, `fledge_verification_failed_total`
- `fledge_github_requests_total{method,status}`,
  `fledge_github_request_seconds`
- `fledge_bridge_requests_total{status}`, `fledge_bridge_request_seconds`

Suggested SLOs:

| SLO | Target |
|---|---|
| job success rate (7d) | ≥ 90% |
| p95 queue wait | < 10 min |
| p95 job duration | < 30 min |
| merge success after green checks | ≥ 98% |
| bridge availability | ≥ 99% |
| GitHub 429/5xx rate | < 2% |

## Alert rules and SLO report

Prometheus alert rules live in [`deploy/prometheus/fledge-alerts.yml`](../deploy/prometheus/fledge-alerts.yml).
They cover job success, p95 queue wait, p95 job duration, bridge failure rate,
GitHub 429s and open operational alerts, each with a runbook link.

```sh
npm run build
PROMETHEUS_URL=http://127.0.0.1:9090 npm run slo:report
```

The report prints the 7-day success rate, remaining error budget, queue/job p95,
bridge success and GitHub 429 rate. Missing series render as `n/a`.

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

## Instance health

The scheduler probes each ready instance through the bridge for DSH `state`.
A bridge that answers `/healthz` but cannot reach DSH is not ready. Failed instances are probed too; a healthy bridge and DSH move them back to ready and audit `flybot.instance.recovered`. A healthy probe also refreshes the stored team session IDs from DSH `state`, and the same refresh runs before job dispatch; the change is audited as `flybot.team.sessions_refreshed`. When no job
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
