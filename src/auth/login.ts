import type { Config } from '../config.js'

// One rule for the token-login fallback, shared by the route guard in
// src/app.ts and the landing page in src/views/pages.ts. Two copies of this
// decision is how "OAuth configured + fallback deliberately kept" ended up
// hiding a login route that still answered.
export function oauthConfigured(config: Pick<Config, 'github'>): boolean {
  return config.github.clientId !== '' && config.github.clientSecret !== ''
}

export function tokenLoginEnabled(config: Pick<Config, 'github' | 'allowTokenLoginOnly'>): boolean {
  return !oauthConfigured(config) || config.allowTokenLoginOnly
}
