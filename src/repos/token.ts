import type { Config } from '../config.js'
import type { RepoRow, Store, UserRow } from '../db.js'
import { decryptSecret } from '../lib/secrets.js'
import { GithubApp } from './app.js'

export async function repoGithubToken(repo: RepoRow, config: Config, app: GithubApp, store?: Store): Promise<string> {
  if (repo.installation_id !== null) {
    if (!app.configured) throw new Error('GitHub App 未配置，无法读取该仓库')
    const user: UserRow | undefined = store?.userById(repo.user_id)
    if (user?.github_token_enc !== null && user?.github_token_enc !== undefined) {
      const scopes = (user.github_token_scopes ?? '').split(/[ ,]+/)
      if (scopes.includes('repo')) return decryptSecret(user.github_token_enc, config.tokenEncryptionKey)
    }
    return app.installationToken(repo.installation_id)
  }
  return decryptSecret(repo.token_enc, config.tokenEncryptionKey)
}
