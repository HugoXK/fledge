import type { Config } from '../config.js'
import type { UserRow } from '../db.js'

export interface QuotaView {
  unlimited: boolean
  initialCny: number
  usedCny: number
  remainingCny: number
  remainingUsd: number
  exhausted: boolean
}

export function quotaView(user: UserRow, config: Config): QuotaView {
  const usedCny = Math.max(0, user.quota_used_usd * config.quota.usdCny)
  if (user.quota_unlimited === 1) {
    return {
      unlimited: true,
      initialCny: user.quota_cny,
      usedCny,
      remainingCny: user.quota_cny,
      remainingUsd: user.quota_cny / config.quota.usdCny,
      exhausted: false,
    }
  }
  const remainingCny = Math.max(0, user.quota_cny - usedCny)
  return {
    unlimited: false,
    initialCny: user.quota_cny,
    usedCny,
    remainingCny,
    remainingUsd: remainingCny / config.quota.usdCny,
    exhausted: remainingCny <= 0,
  }
}

export function costUsdFromUsage(usage: unknown, pricePerTokenUsd: number): number {
  if (usage === null || typeof usage !== 'object') return 0
  const record = usage as Record<string, unknown>
  const total = Number(record.total_tokens)
  if (Number.isFinite(total) && total > 0) return total * pricePerTokenUsd
  const prompt = Number(record.prompt_tokens)
  const completion = Number(record.completion_tokens)
  const sum = (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0)
  return sum > 0 ? sum * pricePerTokenUsd : 0
}

export function headerCost(headers: Record<string, string | string[] | undefined>): number | null {
  const raw = headers['x-litellm-response-cost']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}
