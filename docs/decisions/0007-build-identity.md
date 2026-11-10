# 0007 — `/healthz` names the build it runs

Status: **accepted** (implemented in the same pull request as #183)
Date: 2026-11-10

## Context

`/healthz` answered `{ ok, service, version, time }`, and `version` is read at
runtime from the deployed tree's own `package.json` (`src/version.ts`). That
value is honest and it is not an identity: every `main` build between the
`v0.2.4` tag and the `0.3.0` bump answers `"0.2.4"`. On 2026-11-10 production
was running commits merged after that tag — the `/lang` redirect fallback and the
`/apply` login redirect were both live — and still reported `0.2.4`, so "is fix X
deployed?" cost a hand-written probe per fix and the deployed commit could not be
named at all. `docs/architecture.md` stated the opposite as a design choice ("the
surface reports no commit or build identifier"), so that sentence was wrong in
practice and is corrected here.

## Decision

`/healthz` adds exactly two fields and keeps everything else:

- `commit` — 12-character lowercase hex short sha, or `unknown`
- `builtAt` — `YYYY-MM-DDTHH:MM:SSZ` (UTC), or `unknown`

Both are always present and never empty. They are read once at boot from
`GIT_SHA`/`BUILD_TIME` (`src/lib/buildIdentity.ts`), stamped by the release job
and passed through `Dockerfile` build args and `docker-compose.yml`; the runtime
image has no `.git`, so a runtime `git rev-parse` would answer `unknown` forever
and is deliberately not used. No branch, host name, environment name or image
label is added: `/healthz` is unauthenticated and stays boring.

## Alternatives considered

- **Report the commit in the footer/release card too.** Rejected for this change:
  that surface reads files through `process.cwd()` and a different root
  (`src/lib/releaseSurface.ts`), which is a separate defect; one field on one
  endpoint is enough to identify a deploy.
- **Omit the fields when the build carried no stamp.** Rejected: silence is the
  failure being fixed. A reader who sees no field must not be able to mistake
  that for a match, so `unknown` is served explicitly.
- **Keep `version` as the only source of truth.** Rejected: it cannot distinguish
  two commits inside one version range, which is exactly the question an operator
  asks after a deploy.

## Consequences

`/healthz` becomes self-identifying, so a deploy can be checked from outside
(`commit` equals the commit deployed; `unknown` or a mismatch means the running
artifact is not the one intended). A local `npm run dev` build will answer
`unknown`, which is correct rather than a defect. The liveness contract, HTTP
status and `HEALTHCHECK` are unchanged.
