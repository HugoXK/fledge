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
| `FLYBOT_CHAT_SESSION_ID` | yes | The Bot chat that should take jobs |
| `BRIDGE_PORT` | no | Default 8787 |
| `BRIDGE_HOST` | no | Default 127.0.0.1 |
| `FLYBOT_WEB` | no | Default `http://127.0.0.1:3080` |
| `FLYBOT_LOG` | no | Default `/home/xuke/work/dsh-web.log` |
| `MAX_PROMPT_BYTES` | no | Default 32768 |

The bridge reads the current DSH web token from the log (it changes when DSH
restarts), logs in, and calls `/api/bot` with `endpoint: "send"`. It listens on
loopback only; keep it that way.

## Contract

`POST /run` with `Authorization: Bearer $BRIDGE_TOKEN`:

```json
{
  "jobId": "job_abc",
  "repo": { "owner": "octo", "name": "demo", "defaultBranch": "main" },
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
for the job; the agent reports back to Fledge.

The agent prompt includes:

1. get the GitHub token from `credentialUrl` with `credentialSecret`;
2. use the model at `platform.baseUrl` with `platform.token`;
3. one branch, one focused PR, no force-push, no merge;
4. POST the result to `callbackUrl` with `{status, branch, prUrl, summary, error}`.

## Security

- The bridge never sees the user's GitHub token.
- The job token is scoped to one user and revoked when the job finishes.
- The bridge token is a shared secret; rotate it by updating both sides.
- The bridge logs no credential; `FLYBOT_LOG` is read for the DSH session token
  and never printed.
- Bind to `127.0.0.1` or a private Tailscale address; never expose it publicly.
