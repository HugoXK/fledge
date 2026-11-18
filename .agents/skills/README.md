# UI design skills

These skills are vendored for the Fledge UI work. They are third-party
material, kept with their licences:

- `frontend-design/` — Apache-2.0, from
  https://github.com/anthropics/skills (`skills/frontend-design`). See
  `frontend-design/LICENSE.txt`.
- `web-interface-guidelines/` — MIT, from
  https://github.com/vercel-labs/web-interface-guidelines. See
  `web-interface-guidelines/LICENSE`; the full checklist is `guidelines.md`.

DSH discovers these at `<projectRoot>/.agents/skills` (rank 200) and loads them
through the `skill` tool. The server DSH also gets a copy under
`~/.dsh/skills` so a session outside this repository can use them.
