---
name: web-interface-guidelines
description: Review and write accessible, fast, delightful web UI against Vercel's Web Interface Guidelines. Use before shipping any UI, CSS, form or navigation change.
license: MIT; see LICENSE and guidelines.md.
---

# Web Interface Guidelines

Read `guidelines.md` before changing UI, and name the exact MUST/SHOULD/NEVER
rule in the PR or review. The checklist covers:

- keyboard and focus; visible focus rings; managed focus in dialogs
- hit targets (mobile 44px, desktop 24px); 16px mobile inputs; no blocked paste
- forms: inline validation, submit state, autocomplete, no dead zones
- state and navigation: URL as state, Back/Forward, links are links
- feedback: optimistic UI, confirm destructive actions, aria-live
- motion: honor `prefers-reduced-motion`, no `transition: all`
- layout: safe areas, no horizontal overflow, intrinsic sizing
- content: inline help first, labels for icons, locale-aware formats

This file is a skill wrapper; `guidelines.md` is the complete MIT-licensed
checklist from https://github.com/vercel-labs/web-interface-guidelines.
