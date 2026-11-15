interface Bucket {
  count: number
  resetAt: number
}

function ipv6Groups(ip: string): string[] {
  const [head = '', tail = ''] = ip.split('::')
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === '' ? [] : tail.split(':')
  const zeros = 8 - headGroups.length - tailGroups.length
  return [...headGroups, ...Array<string>(zeros).fill('0'), ...tailGroups].map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''))
}

// A bucket has to be keyed on an identity the client cannot mint per request.
// IPv4 is exact. IPv6 keeps only its /64 prefix, because one client commonly
// controls a whole /64, so the low 64 bits are free to rotate and a per-address
// key is worth nothing.
export function rateLimitKey(request: { ip: string }): string {
  const ip = request.ip.replace(/%.*$/, '')
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped !== null) return mapped[1]!
  if (!ip.includes(':')) return ip
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

