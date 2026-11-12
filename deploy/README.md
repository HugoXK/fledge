# Deployment samples

- `fledge.service` — systemd unit. The app runs as `fledge`, reads
  `/etc/fledge/fledge.env`, writes `/var/lib/fledge`.
- `nginx.conf.example` — TLS reverse proxy with SSE buffering disabled for
  `/v1/`. Its `access_log`/`error_log` are the names the logrotate sample rotates.
- `journald-fledge.conf` — host-level journald drop-in
  (`/etc/systemd/journald.conf.d/`) that caps the journal Fledge logs into; it is
  not a unit drop-in.
- `logrotate-fledge.conf` — `/etc/logrotate.d/` stanza for the nginx files above.

Typical layout:

```
/opt/fledge            # this repository, built (dist/)
/etc/fledge/fledge.env # mode 600, see ../.env.example
/var/lib/fledge        # DATA_DIR / DB_PATH
```

See [../docs/deploy.md](../docs/deploy.md) for the full checklist.
