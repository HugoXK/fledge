import type { UserRow } from '../db.js'

export function notifyEmail(user: UserRow): string {
  const custom = (user.notify_email ?? '').trim()
  return custom !== '' ? custom : (user.email ?? '')
}

export function replyAddressFor(from: string, token: string): string {
  const at = from.lastIndexOf('@')
  if (at <= 0) return from
  return `${from.slice(0, at)}+${token}${from.slice(at)}`
}
