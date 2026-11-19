# #1056 masthead singular labels

Rendered `dashboardPage` for a viewer with exactly one repository, one job and one
open work item, at 390 and 1280 CSS px, in Chinese and English. Captured at
`main` `cb3a0e2b673a7e4c4609e48093096392ae46c62d` (before) and at the fix tip
(after) with Chromium via Playwright.

| frame | masthead text | overflowX | bytes |
| --- | --- | --- | --- |
| before-en-390 | 1 repositories / 1 jobs / 1 open work items | 0 | 61997 |
| after-en-390 | 1 repository / 1 job / 1 open work item | 0 | 61910 |
| before-en-1280 | 1 repositories / 1 jobs / 1 open work items | 0 | 75671 |
| after-en-1280 | 1 repository / 1 job / 1 open work item | 0 | 75594 |
| before-zh-390 | 1 个仓库 / 1 个任务 / 1 个未完成工作项 | 0 | 55504 |
| after-zh-390 | 1 个仓库 / 1 个任务 / 1 个未完成工作项 | 0 | 55504 |
| before-zh-1280 | 1 个仓库 / 1 个任务 / 1 个未完成工作项 | 0 | 69925 |
| after-zh-1280 | 1 个仓库 / 1 个任务 / 1 个未完成工作项 | 0 | 69925 |
