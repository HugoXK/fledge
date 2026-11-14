A repository can declare its own Fledge rules and text skills on its default branch. Fledge reads them at the fixed commit a job already resolved, records the commit and every file hash on the job, and includes the rule text in the bridge prompt. A skill's full text is read on demand through the job-scoped context endpoint; it is never copied wholesale into every prompt.

## Paths

| Path | Purpose |
|---|---|
| `.fledge/rules.md` | General behavior for this repository. |
| `.fledge/review.md` | What a review must check. |
| `.fledge/develop.md` | Scope, test and evidence rules for development. |
| `.agents/skills/<name>/SKILL.md` | A text-only skill. Not executable. |

The names are fixed. A repository that has none of these files keeps the built-in behavior.

## Precedence and console overrides

The effective source of a rule file is decided per path, in this order:

1. **Repository file** — the file at the job's fixed commit wins.
2. **Console override** — used only when the repository has no file at that path.
   A maintainer edits it from the repository's rule overrides page.
3. **Built-in behavior** — implicit and empty when neither layer supplies the
   path.

Skills under `.agents/skills/` are repository-only in this slice; they cannot be
console-overridden. The console form edits only `.fledge/rules.md`,
`.fledge/review.md` and `.fledge/develop.md`.

A console override stores its content, a revision and the user who wrote it. The
form submits the revision it rendered, so a concurrent edit is refused instead
of silently overwriting the newer one. Clearing an override deletes that row; the
path then falls back to the built-in behavior unless the repository supplies a
file. Each job records the effective layer per rule path (`repository`, `console`
or `builtin`) in its job context `rules_json`.

## Rules that do not move

- The files are read from the default branch at the job's resolved commit, never from a pull request head. A change to them only affects later jobs.
- The whole set is rejected when a file is a symlink or submodule, contains a NUL byte, is larger than 32 KiB, or the set exceeds 256 KiB or 32 skills. There is no partial load.
- Skills are text. They cannot add tools, permissions, stages or authority, and Fledge never executes them.
- The job context endpoint only serves the files recorded for that job. It needs the job callback secret, only answers while the job is queued or running, and records each read as a job event.
- A pull request that changes a rule or skill file is flagged in verification. Auto-merge stays blocked until a maintainer acknowledges that exact head SHA; the acknowledgement is stored per job and SHA, so a new commit needs a new one.

## Limits

| Limit | Value |
|---|---|
| Rule file | 32 KiB |
| Skill file | 32 KiB |
| Rules + skills per job | 256 KiB |
| Skills | 32 |
| Prompt rule text | first 16 KiB (the rest stays in the context endpoint) |
