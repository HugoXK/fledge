// #544 slice 8: "Run now" is an explicit command, not a moved cursor.
//
// The card asks for one property: the same command key returns the same
// occurrence, and a new key is a distinct instance. The key is the identity the
// console form carries, so it has to be bounded and opaque before it reaches a
// unique index: an empty key would make every press the same press, and an
// unbounded one would let a client grow a row key by key.
export const RUN_NOW_KEY_MAX = 80

export type RunNowKeyReason = 'empty' | 'too-long' | 'invalid'

export type RunNowKey =
  | { ok: true; key: string }
  | { ok: false; reason: RunNowKeyReason }

// Letters, digits, `:`, `_` and `-` — the shape `randomId('cmd')` produces, and
// narrow enough that a key cannot carry a path or a sentence into the ledger.
const KEY_SHAPE = /^[A-Za-z0-9:_-]+$/

export function parseRunNowKey(raw: unknown): RunNowKey {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') return { ok: false, reason: 'empty' }
  if (value.length > RUN_NOW_KEY_MAX) return { ok: false, reason: 'too-long' }
  if (!KEY_SHAPE.test(value)) return { ok: false, reason: 'invalid' }
  return { ok: true, key: value }
}
