# FlyBot bridge

Fledge does not run code. It asks a FlyBot agent to do the work, then waits for a
signed callback. This bridge is the small adapter between the two on the FlyBot
host.

```
Fledge ──POST /run──► bridge ──/api/bot send──► FlyBot chat session
   ▲                                               │
   └──── POST /api/jobs/:id/callback ──────────────┘
```

## Run

```sh
BRIDGE_TOKEN="$(openssl rand -base64 32)" \
FLYBOT_CHAT_SESSION_ID=session-... \
node bridge/flybot-bridge.mjs
```

| Variable | Required | Meaning |
|---|---|---|
| `BRIDGE_TOKEN` | yes | Shared secret with Fledge; >= 16 chars |
| `FLYBOT_CHAT_SESSION_ID` | yes | The Bot chat that should take iterate jobs |
| `FLYBOT_REVIEW_SESSION_ID` | no | A dedicated reviewer chat; defaults to the iterate session |
| `BRIDGE_PORT` | no | Default 8787 |
| `BRIDGE_HOST` | no | Default 127.0.0.1 |
| `FLYBOT_WEB` | no | Default `http://127.0.0.1:3080` |
| `FLYBOT_LOG` | no | DSH web log that contains the rotating sign-in token |
| `FLYBOT_REVIEW_SESSION_ID` | no | Dedicated reviewer chat; defaults to the iterate chat |
| `MAX_PROMPT_BYTES` | no | Default 32768 |
| `FLEDGE_GATEWAY_ORIGIN` | no | Enables the per-instance `/v1` model proxy |
| `FLEDGE_GATEWAY_TOKEN` | no | User-scoped `flg_` token used by the model proxy |
| `MODEL_PROXY_BIND` / `MODEL_PROXY_PORT` | no | Proxy bind address/port; unset disables it |
| `MODEL_PROXY_KEY` | no | Key the instance model client sends to the proxy |

The bridge reads the current DSH web token from the log (it changes when DSH
restarts), logs in, and calls `/api/bot` with `endpoint: "send"`. It listens on
loopback only; keep it that way.

## Contract

Every path except `/healthz` needs `Authorization: Bearer $BRIDGE_TOKEN`, and the
listener stays on loopback. `test/bridgeContract.test.ts` pins this table against
the real file.

| Request | Status | Body |
|---|---|---|
| `GET /healthz` | `200` | `{ok, service:'fledge-flybot-bridge', modelProxy}` |
| `POST /run`, accepted | `202` | `{ok:true, accepted:true}` |
| `POST /run`, `POST /dsh`, `POST /job-done`, malformed JSON | `400` | `{error:'invalid JSON'}` |
| `POST /run`, a required field missing | `400` | `{error:'jobId, credentialUrl and callbackUrl are required'}` |
| `POST /dsh`, no `endpoint` | `400` | `{error:'endpoint required'}` |
| any path without the token | `401` | `{error:'unauthorized'}` |
| an unknown path, or a method other than `POST` | `404` | `{error:'not found'}` |
| a body over `MAX_PROMPT_BYTES` | `413` | `{error:'body too large'}` |
| a DSH send or `/dsh` call that fails | `502` | `{error}` for `/dsh`; `/run` adds the redacted `detail` |
| `POST /job-done` | `200` | `{ok:true}`, and it clears the per-job model token |

`POST /run` with `Authorization: Bearer $BRIDGE_TOKEN`:

```json
{
  "jobId": "job_abc",
  "kind": "iterate",
  "repo": { "owner": "octo", "name": "demo", "defaultBranch": "main" },
  "upstream": { "owner": "octo", "name": "demo", "defaultBranch": "main", "htmlUrl": "https://github.com/octo/demo" },
  "fork": { "owner": "alice", "name": "demo", "defaultBranch": "main", "htmlUrl": "https://github.com/alice/demo" },
  "isFork": true,
  "permission": "write",
  "canReview": true,
  "canCreateIssue": true,
  "goal": "Fix one reproducible bug and open a PR.",
  "callbackUrl": "https://fledge.example/api/jobs/job_abc/callback",
  "callbackSecret": "…",
  "rulesText": "## .fledge/rules.md\n…",
  "skills": [{ "name": "release-notes", "path": ".agents/skills/release-notes/SKILL.md", "description": "Release notes", "bytes": 812 }],
  "contextUrl": "https://fledge.example/api/jobs/job_abc/context",
  "credentialUrl": "https://fledge.example/api/jobs/job_abc/credential",
  "credentialSecret": "…",
  "platform": {
    "baseUrl": "https://fledge.example/v1",
    "model": "your-model",
    "token": "flg_…"
  },
  "timeoutMinutes": 45,
  "instructions": "…"
}
```

The bridge returns `202 {ok:true}` once DSH accepted the message. It does not wait
for the job; the agent reports back to Fledge.

A send DSH does not accept answers `502 {error, detail}`. `detail` is the DSH
answer itself, redacted and truncated to 300 characters — for a provider that is
over budget or rate limiting this is the only place Fledge ever sees the real
cause, so it is relayed verbatim instead of being replaced with a generic
"could not reach DSH". Fledge classifies on that text and stores the provider
failure code. `sessionId` in the payload routes
the job to a repository-specific Lead, Product, Test or Reviewer session. `kind`
may be `iterate`, `plan`, `scope`, `verify` or `review`.

The bridge also exposes `POST /dsh` (authenticated with `BRIDGE_TOKEN`) as a
small proxy for DSH `/api/bot`. Fledge uses it to read state, rename the Chief
and provision the repository team. The `/v1/*` listener is the instance model
proxy: it replaces the caller's key with the user-scoped Fledge gateway token
and streams the response back.

The agent prompt includes:

1. get the GitHub token from `credentialUrl` with `credentialSecret`;
2. use the model at `platform.baseUrl` with `platform.token`;
3. for `kind=iterate`: push to `fork`, create/reuse an issue on `upstream`, open
   one focused PR against `upstream`, no force-push and never merge; Fledge
   performs the maintainer-enabled auto-merge after checking the PR. The goal
   may carry a `[Carry-over ...]` block with the last runs and open work; it is
   state, not a new goal. Never create an inventory, backlog, or
   `存量/盘点/清账/reconcile` issue; work on one concrete issue or PR, and report
   zero output when there is no concrete defect;
4. for `kind=discover`: inspect the repository, open issues/PRs, tests and
   recent CI; if one concrete defect or improvement is found, create at most one
   focused issue and report its URL; never open a branch or PR, and never create
   an inventory/backlog/盘点/清账/reconcile issue;
5. for `kind=scope`: use the Product session to produce scope, non-goals,
   acceptance criteria and a test plan; do not create a branch or PR;
6. for `kind=verify`: use the Test session to run the relevant tests against the
   existing PR/branch and report `testRed`/`testGreen`; do not create a branch
   or PR;
7. for `kind=review`: review every open PR, score each 0–100; post a COMMENT
   review, never request changes or approve/merge, and report `reviewScore` plus
   a `followUps` array for each Fledge PR that needs a same-branch fix;
8. POST the result to `callbackUrl` with
   `{status, branch, prUrl, issueUrl, reviewScore, summary, error}`.

A repository can also carry its own rule and skill files. When it does, the
payload adds `rulesText` (the effective `.fledge/*` text for the job's fixed
commit, at most 16000 bytes), a `skills` index and a `contextUrl`. The index is a list,
not the text: the agent reads one skill with `GET contextUrl?path=<path>` and its
`callbackSecret`, and only while the job is queued or running. Rules and skills
are repository content, not configuration — they cannot add tools, permissions,
stages or authority, and Fledge never executes them. The body is capped at 32 KiB
per file and 256 KiB for the set; a set whose rule text does not fit the 16000-byte
prompt budget refuses the job instead of being truncated.

Every dispatch also carries the skill bundles Fledge attested before the job
started: `skillBundleHash` (the set hash) and `skillBundles`, a closed list of
`{name, source, version, contentHash, state}`. The prompt lists them under
"Attested skill bundles" and says that only the listed bundles may influence the
job. The list is provenance, not a capability: it does not widen the rules or
skills contract above, and an agent that loads a skill from another source is
outside this job's attestation.

The callback answers:

- `200 {"ok":true}` — recorded;
- `200 {"ok":true,"duplicate":true}` — this exact result was already recorded;
  it is a success, do not resend it;
- `409` — the report was rejected: the job is already finished with a different
  result, or it passed the hard timeout. Do not retry; a retry cannot change it;
- `400` — the payload is invalid (for example a bad branch name).

Send the final callback before `timeoutMinutes` (90 by default). A heartbeat
never extends that deadline: it only postpones the stall sweep.

The payload also carries `repoRole` (`maintainer` or `developer`) and
`autoMerge` for reporting. `autoMerge` is true only when the user selected the
maintainer role and enabled the repository switch; the agent never merges.

## Security

- The bridge never sees the user's GitHub token.
- The job token is scoped to one user and revoked when the job finishes.
- The bridge token is a shared secret; rotate it by updating both sides.
- The bridge logs no credential; `FLYBOT_LOG` is read for the DSH session token
  and never printed.
- Bind to `127.0.0.1` or a private Tailscale address; never expose it publicly.
