export type RepoRole = 'maintainer' | 'developer'

export const REPO_ROLE_LABELS: Record<RepoRole, [string, string]> = {
  maintainer: ['维护者', 'Maintainer'],
  developer: ['开发者', 'Developer'],
}

export function parseRepoRole(value: unknown): RepoRole | null {
  return value === 'maintainer' || value === 'developer' ? value : null
}

export function allowedRepoRoles(permission: string): RepoRole[] {
  return permission === 'admin' || permission === 'maintain'
    ? ['maintainer', 'developer']
    : ['developer']
}

export function roleAllowed(permission: string, role: RepoRole): boolean {
  return allowedRepoRoles(permission).includes(role)
}

export function canUseMaintainerRole(repo: { repo_role: string; permission: string }): boolean {
  return repo.repo_role === 'maintainer' && roleAllowed(repo.permission, 'maintainer')
}
