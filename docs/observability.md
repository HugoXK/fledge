# Observability and operations

## Metrics

`GET /metrics` exposes Prometheus text format. Without `METRICS_TOKEN` it is
loopback-only; with a token, send `Authorization: Bearer <token>` or
`?token=<token>`. Keep the token out of URLs in production logs where possible.

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

## Shutdown and recovery

On `SIGTERM`/`SIGINT` Fledge stops scheduling, waits up to
`SHUTDOWN_GRACE_SECONDS` for active jobs, closes HTTP, flushes traces and closes
SQLite. Startup removes orphan `retry_pending:`/`pending_followup:` settings,
orphan job events and orphan instances.

## Backup restore drill

`npm run db:restore-drill -- --db <path> --backup-dir <dir>` proves a backup
restores without touching the live database. CI runs
`npm run db:restore-drill:ci` against a disposable database.
