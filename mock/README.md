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
  maintainer to developer clears both. The role check older than six hours is
  revalidated before review or auto-merge.
- Add repository: the mock follows the real flow — connect first, land on the
  repository page, then choose a role. The demo permission selector is only a
  mock harness.
- The superadmin header has a `预览用户视图` toggle; the real UI uses the same
  distinction between the simple user view and the advanced team/workspace view.
- Job lifecycle: run iterate/plan/review, open the job detail, and execute a
  completed plan.
- Team console, global settings, admin page and the mock question inbox.
- The top-right `中 / EN` switch changes the main labels; mock content stays as
  written.
