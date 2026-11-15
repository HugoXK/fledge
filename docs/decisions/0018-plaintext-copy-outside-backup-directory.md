# 0018 — the plaintext copy a backup is made from never enters the backup directory

Status: **accepted** (2026-11-15)
Date: 2026-11-15
Supersedes: nothing; it replaces the `fledge-<stamp>.db.enc.plaintext.tmp`
convention in `scripts/backup.mjs` and `scripts/restore-drill.mjs`

## Context

An encrypted backup is taken by copying the live SQLite database to a plaintext
file and encrypting that file. The plaintext copy used to be written inside the
backup directory, so the directory an operator copies off-host held a complete,
readable database for as long as the encryption took — and a `SIGKILL` during
that window left it there permanently under a name `prune` never matched. Peak
disk use in the backup volume was twice the database. The file was also created
`0644`; only the `chmod 0600` after the copy narrowed it.

## Decision

The plaintext copy is a second copy of everything the encryption protects, so its
location is treated as part of the protection, not as an implementation detail:

- It is taken in an owner-only (`0700`) work directory outside the backup
  directory, as `fledge.db.plaintext.tmp` mode `0600`, and that directory is
  removed on every exit path. `BACKUP_WORK_DIR` moves the work root, because the
  system temp directory is not guaranteed to have room for a database.
- A process killed outright cannot clean up, so leftovers are collected by age,
  never by name alone: the next run sweeps `fledge-backup-*`/`fledge-drill-*`
  work directories, and `prune` removes a `*.plaintext.tmp` in the backup
  directory, both only once the entry is an hour old. Younger than that may be a
  backup still running under the previous version during a rolling restart.
- The backup directory holds the ciphertext (and its streamed `.body.tmp`) only.
  A copy of that directory is never a readable database, which is the property an
  operator relies on when moving a backup off-host.

A crash can still leave a plaintext copy in the work directory. That copy is
inside the same trust boundary as the live database — the same account can read
`fledge.db` itself — and it is not the artifact that leaves the host. The
alternative, keeping the copy in the backup directory for a shorter time, trades
a smaller window for a durable leak, which is the wrong trade for a security
fix.
