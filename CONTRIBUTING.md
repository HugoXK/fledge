# Contributing to Fledge

Thanks for helping. This file explains how to set up Fledge, how to test a change
and which rules a change must follow. For what Fledge does and how to run it, see
[README.md](README.md). For automation-assisted work, read [AGENTS.md](AGENTS.md).

## Pull requests

- One issue, one branch, one PR. If an issue already has a PR, push to that
  branch (rebase, `update-branch`, or a new commit). Never open a second PR and
  close the first.
- A change is admitted when it fixes a reproducible defect or is something the
  routine work itself needs. Vague polish, new configuration keys and design
  proposals are not admitted without an owner decision.
- Add a failing test first, then the fix.
- List what you ran and what you did not run. “Tested locally” is not evidence.
- Never commit `.env`, tokens, keys, cookies, `data/`, or the mail outbox.
- Keep the English and Chinese READMEs in step when behaviour changes.

## Maintainer / agent loop

1. Read [LESSONS.md](LESSONS.md), [docs/code-standards.md](docs/code-standards.md)
   and [docs/autonomous-dev.md](docs/autonomous-dev.md) before coding.
2. Claim the issue: assign the bot account, add `agent-working`, comment with the
   branch.
3. Work in a separate worktree from the latest `main`.
4. Write the regression test and run it red on the base.
5. Fix, then run the gates at the tip you will link:

   ```sh
   npm ci
   npm run check
   ```

6. Open the PR with `Fixes #N`, what changed, `Ran:` / `Not run:`, risks, and a
   changelog fragment for a user-visible change.
7. The reviewer re-runs the gates at the **tip**. T2/T3 need a PASS at that tip;
   T0/T1 merge on green `ci-ok`.
8. Merge through the queue; never admin-merge, never bypass a check.

### Verifier checklist

- [ ] Tip SHA named (`git rev-parse HEAD`)
- [ ] Commands **run** at that tip listed with pass/fail
- [ ] Material checks **not run** listed (Docker, real SMTP, real OAuth, a real
      FlyBot job)
- [ ] The new test fails on the base and passes at the tip
- [ ] The fix covers the class (shared helper), not one sample
- [ ] T2/T3: a PASS at the same tip (self-PASS counts) with a real `Ran:`
- [ ] `npm run check` green at the tip
- [ ] Changelog fragment for a user-visible change
- [ ] Owned doc updated, or `Docs-not-needed:` in the PR body and a branch commit
- [ ] No secret in the diff, logs, screenshots or PR body

## Set up

Requirements: Node 22.9+ (the app uses `node:sqlite`), npm 10+.

```sh
git clone https://github.com/HugoXK/fledge.git
cd fledge
npm ci
cp .env.example .env
# generate SESSION_SECRET and TOKEN_ENCRYPTION_KEY, then:
npm run dev
```

For a local demo without OAuth, keep `DEV_LOGIN_LOGIN=dev` and open
<http://localhost:8080/auth/dev>. It is refused in production.

## Test a change

```sh
npm run check        # lint + typecheck + tests + build; this is what CI runs
npm test             # node:test suites
npm run typecheck
npm run lint
npm run build
```

The tests use in-memory SQLite and local fake servers; no network is required.
For a user-visible change, also run `npm run dev` and click the flow once. For a
change to the model gateway, run a 1-token request against a fake upstream or
your own test key; never against a real user's quota.

## Write a change

- TypeScript strict; follow the code around the change.
- Small functions, plain names. A comment only for a hidden constraint.
- Escape every value interpolated into HTML.
- Never log a request body, token, key, full email or repo URL with credentials.
- Keep migrations additive and idempotent; bump `PRAGMA user_version` for a
  breaking change.
- User-facing strings are Chinese; keep `README.md` and `README.zh.md` in step.
- Commit messages: English, imperative subject, reason in the body.

### Changelog

For a change users can see, add one file
`changelog.d/<issue-or-slug>.<kind>.md` (`added`, `changed`, `deprecated`,
`removed`, `fixed`, `security`). The content is one paragraph, no heading and no
leading `- `. Do not edit `CHANGELOG.md` in a feature PR; the release routine
assembles the fragments. See [changelog.d/README.md](changelog.d/README.md).

## Workflow docs

| Doc | Role |
|---|---|
| [AGENTS.md](AGENTS.md) | Binding pipeline, tiers, labels and hard rules |
| [LESSONS.md](LESSONS.md) | Dated lessons; promote after 3 days |
| [docs/code-standards.md](docs/code-standards.md) | Verifier honesty, review format, merge rules |
| [docs/autonomous-dev.md](docs/autonomous-dev.md) | Maintenance, claims, release |

## Report a problem

Open an issue with:

- the expected behaviour and the actual behaviour;
- a minimal reproduction (a curl, a test, or exact steps);
- the version/commit and Node version;
- whether you used the mock runner or the FlyBot bridge.

For a vulnerability, do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## License

Fledge is licensed under [Apache-2.0](LICENSE). By submitting a contribution you
agree that it is licensed under the same terms, as section 5 of the licence says.
