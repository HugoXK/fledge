import { isIP } from 'node:net'

interface Bucket {
  count: number
  resetAt: number
}

// One bucket for every address that cannot be parsed. Deriving a key from the
// malformed text would mint a bucket per spelling, which is an oracle for
// anyone who can influence request.ip.
export const OPAQUE_ADDRESS_KEY = 'unparseable-address'

function ipv6Groups(ip: string): string[] {
  const [head = '', tail = ''] = ip.split('::')
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === '' ? [] : tail.split(':')
  // Floored as well as guarded by the isIP call below, so no caller can hand
  // this a group count that indexes out of range.
  const zeros = Math.max(0, 8 - headGroups.length - tailGroups.length)
  return [...headGroups, ...Array<string>(zeros).fill('0'), ...tailGroups].map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''))
}

// A bucket has to be keyed on an identity the client cannot mint per request.
// IPv4 is exact. IPv6 keeps only its /64 prefix, because one client commonly
// controls a whole /64, so the low 64 bits are free to rotate and a per-address
// key is worth nothing. Anything that is not an address collapses onto one key:
// a trusted hop can forward a malformed value verbatim, and a per-spelling key
// would let that value mint buckets (and answer 500 for more than eight groups).
export function rateLimitKey(request: { ip: string }): string {
  const ip = request.ip.replace(/%.*$/, '')
  const version = isIP(ip)
  if (version === 4) return ip
  if (version === 0) return OPAQUE_ADDRESS_KEY
  // The pattern below checks digit shape only, so a spelling like
  // ::ffff:1.2.3.999 matches it without being an address. Validity decides the
  // fold: an invalid mapped spelling keeps the opaque key instead of minting a
  // bucket per spelling.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped !== null) return isIP(mapped[1]!) === 4 ? mapped[1]! : OPAQUE_ADDRESS_KEY
  return `${ipv6Groups(ip).slice(0, 4).join(':')}::/64`
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  take(key: string): boolean {
    const now = Date.now()
    const bucket = this.buckets.get(key)
    if (bucket === undefined || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (bucket.count >= this.limit) return false
    bucket.count += 1
    return true
  }

  sweep(): void {
    const now = Date.now()
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key)
  }
}

// #708: the classes a mutating route can name. One budget per class, read once
// from config, so a limit is tightened by an env change rather than by editing a
// handler. A route also names its own bucket, so two routes in the same class
// never share a counter and a busy page cannot spend another page's budget.
export type RateLimitClass = 'login' | 'destructive' | 'expensive'

export interface RateLimitBudget {
  max: number
  windowMs: number
}

export type RateLimitBudgets = Record<RateLimitClass, RateLimitBudget>

// The windows the routes carried before #708. `login` is the sign-in budget the
// auth routes already had; `destructive` is the 60-a-minute window
// `destructiveLimit` already gave the eight privileged routes; `expensive` is
// the same window for routes that start or stop work. Keeping the two classes
// separate means the expensive budget can be loosened without moving the
// destructive one.
export const DEFAULT_RATE_LIMIT_BUDGETS: RateLimitBudgets = {
  login: { max: 30, windowMs: 60_000 },
  destructive: { max: 60, windowMs: 60_000 },
  expensive: { max: 60, windowMs: 60_000 },
}

// One `RateLimiter` per class. Callers pass the bucket key themselves because a
// few routes key on the user rather than on the client address (recent-auth
// re-checks of the same account belong in one bucket).
export class RouteLimiters {
  private readonly limiters: Record<RateLimitClass, RateLimiter>

  constructor(budgets: RateLimitBudgets) {
    this.limiters = {
      login: new RateLimiter(budgets.login.max, budgets.login.windowMs),
      destructive: new RateLimiter(budgets.destructive.max, budgets.destructive.windowMs),
      expensive: new RateLimiter(budgets.expensive.max, budgets.expensive.windowMs),
    }
  }

  take(className: RateLimitClass, key: string): boolean {
    return this.limiters[className].take(key)
  }

  sweep(): void {
    for (const limiter of Object.values(this.limiters)) limiter.sweep()
  }
}

