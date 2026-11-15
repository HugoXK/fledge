import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// #700: the host serves /assets with a four-hour freshness lifetime and the page
// carries no cache directive of its own, so a deploy that changes a stylesheet
// leaves a returning tab running the old copy against new markup. The in-repo
// fix is the URL: a token derived from the file's bytes makes the stale copy
// unreachable whatever the host sends.
//
// The token is a digest of the file, never of the commit. /healthz withholds
// `config.build.commit` behind `diagnosticsAccess` (#236, #466), and an asset
// URL is public, so a commit stamp here would publish exactly what that guard
// withholds.

const TOKEN_LENGTH = 12

const tokens = new Map<string, string>()

/** The token for a known body of bytes: same bytes, same token. */
export function assetVersionOf(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, TOKEN_LENGTH)
}

/** The token for `public/<name>`, digested on first use and memoised per path. */
export function assetToken(name: string): string {
  const cached = tokens.get(name)
  if (cached !== undefined) return cached
  const token = assetVersionOf(readFileSync(join(process.cwd(), 'public', name)))
  tokens.set(name, token)
  return token
}

/**
 * `/assets/app.css` → `/assets/app.css?v=<digest of public/app.css>`.
 * The result is path characters and hex only, so a caller may interpolate it
 * into HTML without escaping it.
 */
export function assetUrl(path: string): string {
  return `${path}?v=${assetToken(path.slice('/assets/'.length))}`
}
