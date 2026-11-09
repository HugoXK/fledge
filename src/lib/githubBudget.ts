interface Bucket {
  tokens: number
  updatedAt: number
  pausedUntil: number
}

const buckets = new Map<string, Bucket>()
let defaultPerMinute = 120

export function configureGithubBudget(perMinute: number): void {
  defaultPerMinute = Math.max(1, Math.floor(perMinute))
}

export async function acquireGithubBudget(token: string, perMinute = defaultPerMinute): Promise<void> {
  const key = token
  const ratePerMs = perMinute / 60_000
  const capacity = perMinute
  for (;;) {
    const now = Date.now()
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = { tokens: capacity, updatedAt: now, pausedUntil: 0 }
      buckets.set(key, bucket)
    }
    if (bucket.pausedUntil > now) {
      await sleep(Math.min(bucket.pausedUntil - now, 30_000))
      continue
    }
    const elapsed = Math.max(0, now - bucket.updatedAt)
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * ratePerMs)
    bucket.updatedAt = now
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return
    }
    await sleep(Math.min(30_000, Math.max(25, Math.ceil((1 - bucket.tokens) / ratePerMs))))
  }
}

export function noteGithubRateLimit(token: string, retryAfterMs: number): void {
  const now = Date.now()
  const bucket = buckets.get(token) ?? { tokens: 0, updatedAt: now, pausedUntil: 0 }
  bucket.tokens = 0
  bucket.updatedAt = now
  bucket.pausedUntil = Math.max(bucket.pausedUntil, now + Math.max(0, retryAfterMs))
  buckets.set(token, bucket)
}

export function resetGithubBudget(): void {
  buckets.clear()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)))
}
