import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// One root for the files this process reads about itself. `src/lib/` and
// `dist/lib/` are the same distance below the project root, so a module-relative
// base resolves `package.json`, `CHANGELOG.md` and `changelog.d` in a checkout
// and in the built image alike — and nothing depends on the directory the
// process was started from (a systemd unit's `WorkingDirectory`, a container
// `WORKDIR`). Two roots was how `/healthz` and the footer could report two
// versions of one running process (#192).
export function projectRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url))
}

/**
 * The version this code was shipped with. Throws when `package.json` cannot be
 * read — a process that cannot name its own release is a broken install, not a
 * version — and falls back to `0.0.0` when the file has no usable field.
 */
export function readPackageVersion(root: string = projectRoot()): string {
  const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }
  return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0'
}
