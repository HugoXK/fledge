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

## Release automation

`fledge-deploy-tag.sh` and `fledge-verify-release.sh` are the host half of the
release flow: deploy the newest SemVer tag (never roll a newer main back) and
write `release-status.json` for `/admin`. See
[`docs/deploy.md`](../docs/deploy.md#automatic-tag-deployment-and-verification)
for the cron examples, environment overrides and safety rules.
