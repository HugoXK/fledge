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
for the job; the agent reports back to Fledge. `sessionId` in the payload routes
the job to a repository-specific Lead or Reviewer.

The bridge also exposes `POST /dsh` (authenticated with `BRIDGE_TOKEN`) as a
small proxy for DSH `/api/bot`. Fledge uses it to read state, rename the Chief
and provision the repository team. The `/v1/*` listener is the instance model
proxy: it replaces the caller's key with the user-scoped Fledge gateway token
and streams the response back.

The agent prompt includes:

1. get the GitHub token from `credentialUrl` with `credentialSecret`;
2. use the model at `platform.baseUrl` with `platform.token`;
3. for `kind=iterate`: push to `fork`, create/reuse an issue on `upstream`, open
   one focused PR against `upstream`, no force-push, no merge;
4. for `kind=review`: review every open upstream PR, score each 0–100 and post a
   COMMENT review, never approve/merge, and report `reviewScore`;
5. POST the result to `callbackUrl` with
   `{status, branch, prUrl, issueUrl, reviewScore, summary, error}`.

## Security

- The bridge never sees the user's GitHub token.
- The job token is scoped to one user and revoked when the job finishes.
- The bridge token is a shared secret; rotate it by updating both sides.
- The bridge logs no credential; `FLYBOT_LOG` is read for the DSH session token
  and never printed.
- Bind to `127.0.0.1` or a private Tailscale address; never expose it publicly.
