// #392: one authenticator for every surface that accepts a personal `flg_`
// token. It was the gateway's private function until the public read API needed
// the same three answers, and two copies would drift: a revocation rule added to
// one of them is a hole in the other.
//
// The scope is a parameter, not a default: a caller names the capability it
// requires, and the token's stored scope must equal it. A token that exists but
// carries another scope is `forbidden` (403, `insufficient_scope`), decided
// before `last_used_at` is written, so a refused token leaves no trace it was
// tried. An unknown, revoked or expired token is simply not found here
// (`findApiToken` filters both), and a token whose user is not approved is
// treated the same way, which keeps that answer a plain 401.
import type { FastifyRequest } from 'fastify'
import type { ApiTokenRow, Store, UserRow } from '../db.js'
import { sha256Hex } from './secrets.js'
import type { TokenScope } from './tokens.js'

export type ApiTokenAuth =
  | { kind: 'ok'; token: ApiTokenRow; user: UserRow }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }

function bearer(request: FastifyRequest): string {
  const header = String(request.headers.authorization ?? '')
  if (header.slice(0, 7).toLowerCase() !== 'bearer ') return ''
  return header.slice(7).trim().slice(0, 512)
}

export function authenticateApiToken(request: FastifyRequest, store: Store, scope: TokenScope): ApiTokenAuth {
  const raw = bearer(request)
  if (!raw.startsWith('flg_')) return { kind: 'unauthorized' }
  const token = store.findApiToken(sha256Hex(raw))
  if (token === undefined) return { kind: 'unauthorized' }
  const user = store.userById(token.user_id)
  if (user === undefined || user.status !== 'approved') return { kind: 'unauthorized' }
  if (token.scope !== scope) return { kind: 'forbidden' }
  store.touchApiToken(token.id)
  return { kind: 'ok', token, user }
}
