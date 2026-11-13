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

// `extra` is how many repositories the caller is about to add: one for the
// single form, the size of the deduped selection for a bulk add. The check is
// "used + extra exceeds the cap", so a selection that exactly fills the last
// free slots is allowed. A bulk add with nothing fresh to create passes 0 and is
// never refused, because it would create nothing.
export function repoLimitRefusal(input: { used: number; cap: number; admin: boolean; extra?: number }): LimitRefusal | null {
  if (input.admin) return null
  if (input.cap <= 0) return null
  const extra = input.extra ?? 1
  if (input.used + extra <= input.cap) return null
  return { code: 'REPO_LIMIT', used: input.used, cap: input.cap }
}

// A posted selection can name the same repository twice (`o/a` and `O/A`). The
// bulk path counts the selection to decide what it will add and how many
// instances those additions provision, so it has to count each repository once,
// exactly as the create loop does; counting duplicates would refuse a selection
// that fits.
export function dedupeRepoNames(selected: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of selected) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(key)
  }
  return unique
}

// `extra` is how many new instances the caller is about to create: one for the
// provision route, and one per fresh repository for a bulk add, because both
// add paths provision as they go. The check is "used + extra exceeds the cap",
// so an add that exactly fills the last free slot is allowed.
export function instanceLimitRefusal(input: {
  usedForUser: number
  capForUser: number
  usedGlobal: number
  capGlobal: number
  admin: boolean
  extra?: number
}): LimitRefusal | null {
  if (input.admin) return null
  const extra = input.extra ?? 1
  if (input.capForUser > 0 && input.usedForUser + extra > input.capForUser) {
    return { code: 'INSTANCE_LIMIT', used: input.usedForUser, cap: input.capForUser }
  }
  // Name the ceiling that actually refused: reporting the per-user numbers for
  // a global refusal showed "0/3" to a user stopped by the deployment ceiling.
  if (input.capGlobal > 0 && input.usedGlobal + extra > input.capGlobal) {
    return { code: 'INSTANCE_LIMIT', used: input.usedGlobal, cap: input.capGlobal }
  }
  return null
}
