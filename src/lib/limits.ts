// Per-user ceilings on the two things a user can create that consume host
// resources: connected repositories and running FlyBot instances. Kept pure so
// the rule can be tested without a bridge, a GitHub round trip or a database.
//
// Admins and superadmins are exempt: they are the operator's own accounts and
// the ceiling exists to stop one user exhausting the host, not to lock the
// operator out of their own deployment. A cap of 0 means "no ceiling".

export type LimitCode = 'REPO_LIMIT' | 'INSTANCE_LIMIT'

export interface LimitRefusal {
  code: LimitCode
  used: number
  cap: number
}

export function repoLimitRefusal(input: { used: number; cap: number; admin: boolean }): LimitRefusal | null {
  if (input.admin) return null
  if (input.cap <= 0) return null
  if (input.used < input.cap) return null
  return { code: 'REPO_LIMIT', used: input.used, cap: input.cap }
}

export function instanceLimitRefusal(input: {
  usedForUser: number
  capForUser: number
  usedGlobal: number
  capGlobal: number
  admin: boolean
}): LimitRefusal | null {
  const refusal: LimitRefusal = { code: 'INSTANCE_LIMIT', used: input.usedForUser, cap: input.capForUser }
  if (input.admin) return null
  if (input.capForUser > 0 && input.usedForUser >= input.capForUser) return refusal
  if (input.capGlobal > 0 && input.usedGlobal >= input.capGlobal) return refusal
  return null
}
