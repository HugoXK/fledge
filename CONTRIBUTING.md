# Contributing

Thanks for helping Fledge grow. This is a small codebase; keep changes focused.

## Setup

- Node 22.9+ (the app uses `node:sqlite`).
- `npm ci`
- `cp .env.example .env` and fill the secrets if you need OAuth/email.
- `npm run dev`

## Before opening a PR

```sh
npm run check
```

This runs lint, typecheck, tests and a production build. CI runs the same
commands.

- Add a test that fails without your change.
- Keep the change to one concern; avoid drive-by refactors.
- Update the docs when behaviour or configuration changes.
- Never commit `.env`, keys, tokens, the data directory, or the mail outbox.
- Use English for code, comments and commit messages. User-facing UI text is
  Chinese; keep the English and Chinese READMEs in step.

## Code style

- TypeScript strict mode; no `any` unless there is a comment explaining why.
- Small functions, plain names, no comments that restate the code.
- Server-rendered HTML: escape every interpolated value with `escapeHtml`.
- Never log a token, a key, a request body, or a full email body.
- Migrations are additive; bump `PRAGMA user_version` only when needed.

## Commit and PR

- Imperative subject, reason in the body.
- One logical change per PR.
- Describe what you ran (`npm run check`, a manual flow) and what you did not.
- Security-sensitive changes need a short threat note in the PR.

## Reporting bugs

Open an issue with:

- the expected behaviour;
- the actual behaviour;
- a minimal reproduction (a curl, a test, or exact steps);
- the version/commit.

For a vulnerability, do **not** open a public issue; see [SECURITY.md](SECURITY.md).
