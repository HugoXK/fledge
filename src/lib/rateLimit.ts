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
