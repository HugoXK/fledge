import type { UserRow } from '../db.js'

export function notifyEmail(user: UserRow): string {
  const custom = (user.notify_email ?? '').trim()
  return custom !== '' ? custom : (user.email ?? '')
}
