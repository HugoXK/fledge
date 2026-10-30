# Deployment samples

- `fledge.service` — systemd unit. The app runs as `fledge`, reads
  `/etc/fledge/fledge.env`, writes `/var/lib/fledge`.
- `nginx.conf.example` — TLS reverse proxy with SSE buffering disabled for
  `/v1/`.

Typical layout:

```
/opt/fledge            # this repository, built (dist/)
/etc/fledge/fledge.env # mode 600, see ../.env.example
/var/lib/fledge        # DATA_DIR / DB_PATH
```

See [../docs/deploy.md](../docs/deploy.md) for the full checklist.
