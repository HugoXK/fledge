// #183: an instance that reports only `version` cannot name the commit it runs,
// so two different `main` builds between a tag and the next version bump are
// indistinguishable from outside. These two values come from the build
// environment (`GIT_SHA`, `BUILD_TIME`) and are read once, at boot: the runtime
// image carries no `.git`, and a `git rev-parse` here would answer `unknown`
// forever.

export interface BuildIdentity {
  // 12-character lowercase hex, or `unknown` when the build carried no stamp.
  commit: string
  // `YYYY-MM-DDTHH:MM:SSZ` (UTC), or `unknown`.
  builtAt: string
}

export const UNKNOWN_BUILD = 'unknown'

const SHORT_SHA = /^[0-9a-f]{12}$/
const FULL_SHA = /^[0-9a-f]{40}$/
const BUILD_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

// The release job stamps the full sha; the contract is the short form, so both
// shapes are accepted and everything else answers `unknown` instead of echoing
// a value nobody can compare against `git rev-parse`.
export function shortCommit(raw: string | undefined): string {
  const value = (raw ?? '').trim().toLowerCase()
  if (SHORT_SHA.test(value)) return value
  if (FULL_SHA.test(value)) return value.slice(0, 12)
  return UNKNOWN_BUILD
}

export function buildTime(raw: string | undefined): string {
  const value = (raw ?? '').trim()
  return BUILD_TIME.test(value) ? value : UNKNOWN_BUILD
}

export function buildIdentity(env: NodeJS.ProcessEnv = process.env): BuildIdentity {
  return { commit: shortCommit(env.GIT_SHA), builtAt: buildTime(env.BUILD_TIME) }
}
