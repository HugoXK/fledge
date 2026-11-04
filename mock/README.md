# Fledge UI mock

A standalone, mock-only HTML prototype for design review. It does not call the
Fledge API, use a database or touch GitHub.

Open `fledge-ui.html` directly in a browser. No build or server is needed.

What to review:

- Dashboard: role badges per repository, quota, notifications and recent jobs.
- Repository detail: `maintainer` vs `developer`, review availability and the
  maintainer-only auto-merge switch.
- Add repository: GitHub permission check, explicit role choice (no default),
  and a developer-only path for an upstream repository without `admin`/`maintain`.
- Role switching: a developer cannot enable review or auto-merge; switching a
  maintainer to developer clears both.
- Add repository: the mock follows the real user flow — use the GitHub App
  picker or the manual fine-grained token form, land on the repository page,
  then choose a role.
- The preview is intentionally the **user view only**: no admin page, no
  superadmin team console and no workspace proxy controls.
- Job lifecycle: run iterate/plan/review, open the job detail, and execute a
  completed plan.
- Global settings and the mock question inbox.
- The top-right `中 / EN` switch changes the main labels; mock content stays as
  written.
