import type { Config } from '../config.js'
import type { RepoRow } from '../db.js'
import { decryptSecret } from '../lib/secrets.js'
import { GithubApp } from './app.js'

export async function repoGithubToken(repo: RepoRow, config: Config, app: GithubApp): Promise<string> {
  if (repo.installation_id !== null) {
    if (!app.configured) throw new Error('GitHub App 未配置，无法读取该仓库')
    return app.installationToken(repo.installation_id)
  }
  return decryptSecret(repo.token_enc, config.tokenEncryptionKey)
}
