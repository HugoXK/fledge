# Deployment samples

- `fledge.service` — systemd unit. The app runs as `fledge`, reads
  `/etc/fledge/fledge.env`, writes `/var/lib/fledge`. Its `ExecStartPre=` replays
  `/etc/fledge/release-status.json` before start (#462): a host without that file,
  or with one that disagrees with `/opt/fledge` or with the image digest it
  records, does not start. The file is written by the release step, never by
  hand — `node scripts/verify-release.mjs --version X.Y.Z --local-image-digest
  sha256:… --write /etc/fledge/release-status.json`, then `chown root:fledge` and
  `chmod 0640` so the service user can read it (`0600` root-owned would make the
  hook exit `2`); the command and the expected output for each refusal are in
  [../docs/deploy.md](../docs/deploy.md#required-before-start). The hook is
  offline: no token, no API, no docker.
- `nginx.conf.example` — TLS reverse proxy with SSE buffering disabled for
  `/v1/`. Its `access_log`/`error_log` are the names the logrotate sample rotates.
- `journald-fledge.conf` — host-level journald drop-in
  (`/etc/systemd/journald.conf.d/`) that caps the journal Fledge logs into; it is
  not a unit drop-in.
- `logrotate-fledge.conf` — `/etc/logrotate.d/` stanza for the nginx files above.

Typical layout:

```
/opt/fledge                     # this repository, built (dist/)
/etc/fledge/fledge.env          # mode 600, see ../.env.example
/etc/fledge/release-status.json # root:fledge 0640, written by the release step
/var/lib/fledge                 # DATA_DIR / DB_PATH
```

See [../docs/deploy.md](../docs/deploy.md) for the full checklist.

## What CI checks these samples (#882)

A diff that touches `deploy/` runs the `deploy-check` job. It installs nginx and
then runs `scripts/check-deploy-samples.sh`, which does four things and says in
the job summary which kind each one is:

1. **real** — parses `nginx.conf.example` with a real `nginx -t`, inside the
   wrapper `nginx.check.conf`;
2. **real negative proof** — runs the same invocation on a copy of the example
   with an unknown directive appended and requires it to be rejected, so a check
   that accepts every config cannot pass the job;
3. **static** — parses `fledge.service` with `scripts/check-systemd-unit.mjs`, a
   static unit parser that runs without systemd. It is used instead of
   `systemd-analyze verify`, which is absent on a runner and whose output names
   the runner's own unrelated units;
4. **static negative proof** — requires that parser to reject a copy of the unit
   with `ExecStart` removed.

Run the same contract locally with nginx installed: `bash
scripts/check-deploy-samples.sh`. A runner without nginx is a failed step, never
a recorded gap, so the samples cannot pass unchecked.

## Release automation

`fledge-deploy-tag.sh` and `fledge-verify-release.sh` are the host half of the
release flow: deploy the newest SemVer tag (never roll a newer main back), gate
the rollout on the release it built with `scripts/rollout-check.mjs` (the
process, the page and the served `app.css` must all be that tag, #658), put the
previous release back when the gate refuses it, and write `release-status.json`
for `/admin`. See
[`docs/deploy.md`](../docs/deploy.md#automatic-tag-deployment-and-verification)
and [`docs/deploy.md`](../docs/deploy.md#gate-a-rollout-on-the-release-it-claims)
for the cron examples, environment overrides, the expected check output and the
refusal drill.
