# 0005 — Log rotation and retention

Status: **accepted** (implemented in the same pull request as the restore drill)
Date: 2026-11-06

## Context

Fledge is a single Node process behind nginx. It writes one JSON line per event
to stdout/stderr (`src/lib/log.ts`), and the systemd unit
(`deploy/fledge.service`) sets no `StandardOutput=`/`StandardError=`, so every
line goes to journald under the default host policy. The only file logs on the
host belong to nginx.

That means "log rotation" has two different shapes: journald has no files to
rotate, only capacity and retention limits, while nginx writes real files that
need logrotate. Before this decision the repository shipped no sample for
either, and `docs/deploy.md` only said "watch disk".

A log store that is silently unbounded is an availability risk: a failing job
that retries every few seconds can fill the disk and take SQLite down with it.

## Options

1. **journald capacity caps only.** Install a journald drop-in
   (`SystemMaxUse`, `SystemMaxFileSize`, `MaxRetentionSec`, `SystemKeepFree`)
   and a logrotate sample for the nginx access/error files. No application code
   changes; the operator keeps `journalctl -u fledge` filtering.
2. **Application-owned file sink.** Fledge opens its own log file, rotates it by
   size or date in process, and keeps N days. Full control of format and
   retention, but it needs a file handle, a rotation timer, a reopen path for
   logrotate (SIGHUP) and a place to keep the file — all new failure modes in a
   process that already owns the SQLite writer.
3. **Both.** journald caps plus a file sink for external shipping. Best for
   forensics and shipping to a log platform, twice the surface to reason about
   and to test.

## Recommendation

Option 1.

- journald already receives every line, so capping it bounds the whole service
  log without touching code. The caps live on the host, which is also where the
  disk lives.
- The systemd unit's existing security settings (`ProtectSystem=strict`,
  `ReadWritePaths=/var/lib/fledge`) would need a writable log directory added for
  option 2, widening what the service may write.
- Option 2 buys nothing today: there is no log shipper and no retention policy
  that journald cannot express.
- nginx keeps its own files, so it keeps its own rotation; naming the files
  `fledge-access.log`/`fledge-error.log` makes the sample unambiguous instead of
  competing with the distribution's rotation of `access.log`.

Samples: `deploy/journald-fledge.conf` (host drop-in, not a unit drop-in) and
`deploy/logrotate-fledge.conf`. The runbook and verification commands are in
`docs/deploy.md` §7 and §9.

## Consequences

- The caps are host-wide for journald (`SystemMaxUse` applies to the journal,
  not to one unit), so a noisy neighbour unit shares the budget. `SystemKeepFree`
  protects the disk from all units at once, which is the behaviour we want.
- Logs older than the retention window are gone; that is the point. An incident
  that needs older logs must be exported before the window closes.
- Rotating the journal does not need a service restart; rotating nginx logs
  reloads nginx only.
- Rollback is removing the drop-in and restarting `systemd-journald`; no code,
  schema or data changes.

## Sizing the sample values

The sample is a starting point, not a measurement of production traffic, so the
numbers are chosen from what the code actually emits:

- One line per event: job enqueued/running/progress/finished, repo refresh,
  model call summaries, HTTP access from Fastify. A normal job produces tens of
  lines, not thousands; a failing job that retries is the loud case.
- `SystemMaxUse=500M` is roughly a month of that traffic on a single small host
  and is small enough to leave room for a distribution's own units.
- `SystemMaxFileSize=50M` bounds a single journal file so vacuuming can happen
  without rewriting a large file.
- `SystemKeepFree=1G` outranks the size caps: if the disk gets tight, journald
  drops old entries instead of filling the disk. This is the number that
  actually protects SQLite, which shares the host and must be able to write.
- `MaxRetentionSec=30day` bounds time even when the volume stays below the cap.

An operator with different traffic edits these four values in the drop-in; none
of them is build-time behaviour and none requires a code change.

## Rollback

```sh
sudo rm /etc/systemd/journald.conf.d/fledge.conf
sudo systemctl restart systemd-journald
```

The distro defaults apply again. Nothing Fledge stores changes: no schema, no
data, no log format — only how long the journal keeps lines it already wrote.
The nginx stanza is independent and is rolled back by removing
`/etc/logrotate.d/fledge`.

## Non-goals

- No application log file, no in-process rotation, no SIGHUP reopen handler.
- No log shipping, aggregation, sampling or structured retention by event type.
- No change to what is logged, redaction rules, or log levels.
- No rotation of the development mail outbox (`$DATA_DIR/mail-outbox`); it is a
  console-transport aid that a production instance with SMTP never writes, and
  an operator may delete it at any time.
