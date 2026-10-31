export function nowIso(): string {
  return new Date().toISOString()
}

export function addMinutes(minutes: number, from = Date.now()): string {
  return new Date(from + minutes * 60_000).toISOString()
}

export function addDays(days: number, from = Date.now()): string {
  return new Date(from + days * 86_400_000).toISOString()
}

export function isPast(iso: string | null | undefined, at = Date.now()): boolean {
  if (iso === null || iso === undefined || iso === '') return true
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? true : parsed <= at
}

export function humanTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toISOString().replace('T', ' ').replace('.000Z', 'Z')
}

export function humanTimeShort(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toISOString().slice(0, 19).replace('T', ' ')
}
