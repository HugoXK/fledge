import type { Translate } from '../i18n.js'

export const MIN_INTERVAL_MINUTES = 15
export const MAX_INTERVAL_MINUTES = 43_200

export const ITERATION_INTERVALS = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10_080, 20_160, 43_200]
export const REVIEW_INTERVALS = [360, 720, 1440, 2880, 4320, 10_080, 20_160, 43_200]

export function normalizeInterval(value: unknown, fallback = 1440): number {
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(parsed)))
}

export function intervalLabel(minutes: number, t: Translate): string {
  const value = normalizeInterval(minutes)
  const labels: Record<number, [string, string]> = {
    15: ['每 15 分钟', 'Every 15 minutes'],
    30: ['每 30 分钟', 'Every 30 minutes'],
    60: ['每小时', 'Hourly'],
    120: ['每 2 小时', 'Every 2 hours'],
    180: ['每 3 小时', 'Every 3 hours'],
    360: ['每 6 小时', 'Every 6 hours'],
    720: ['每 12 小时', 'Every 12 hours'],
    1440: ['每天', 'Daily'],
    2880: ['每 2 天', 'Every 2 days'],
    4320: ['每 3 天', 'Every 3 days'],
    10_080: ['每周', 'Weekly'],
    20_160: ['每 2 周', 'Every 2 weeks'],
    43_200: ['每 30 天', 'Every 30 days'],
  }
  const exact = labels[value]
  if (exact !== undefined) return t(exact[0], exact[1])
  if (value % 1440 === 0) return t(`每 ${value / 1440} 天`, `Every ${value / 1440} days`)
  if (value % 60 === 0) return t(`每 ${value / 60} 小时`, `Every ${value / 60} hours`)
  return t(`每 ${value} 分钟`, `Every ${value} minutes`)
}
