import type { Config } from '../config.js'
import type { RepoRow, Store, UserRow } from '../db.js'
import { decryptSecret } from '../lib/secrets.js'
import { GithubApp } from './app.js'

export async function repoGithubToken(repo: RepoRow, config: Config, app: GithubApp, store?: Store): Promise<string> {
  if (repo.installation_id !== null) {
    if (!app.configured) throw new Error('GitHub App 未配置，无法读取该仓库')
    const user: UserRow | undefined = store?.userById(repo.user_id)
    if (config.githubApp.useUserToken && user?.github_token_enc !== null && user?.github_token_enc !== undefined) {
      const scopes = (user.github_token_scopes ?? '').split(/[ ,]+/)
      if (scopes.includes('repo')) return decryptSecret(user.github_token_enc, config.tokenEncryptionKey)
    }
    return app.installationToken(repo.installation_id)
  }
  return decryptSecret(repo.token_enc, config.tokenEncryptionKey)
}

// #390 review: a triage run reads issues and code and writes nothing, so its token
// is minted read-only rather than being the user's repo-scoped OAuth token. That
// token cannot be narrowed, so when one is all that exists the honest answer is a
// refusal: a prompt injection in an issue body must not hold a write credential.
export const TRIAGE_TOKEN_PERMISSIONS: Record<string, 'read'> = { contents: 'read', issues: 'read', pull_requests: 'read' }

export class ReadOnlyTokenUnavailable extends Error {
  readonly code = 'TRIAGE_READ_ONLY_TOKEN'

  constructor(message: string) {
    super(message)
    this.name = 'ReadOnlyTokenUnavailable'
  }
}

export async function triageReadOnlyToken(repo: RepoRow, app: GithubApp): Promise<string> {
  if (repo.installation_id === null || !app.configured) {
    throw new ReadOnlyTokenUnavailable('TRIAGE_READ_ONLY_TOKEN: triage needs a GitHub App installation; a user token cannot be narrowed to read-only, so the run is refused.')
  }
  return app.installationToken(repo.installation_id, TRIAGE_TOKEN_PERMISSIONS)
}
