import type { FastifyRequest } from 'fastify'

// One reader for a bounded query string. It returns undefined for an absent or
// empty value so a handler cannot mistake '' for a present choice.
export function queryText(request: FastifyRequest, name: string): string | undefined {
  const value = (request.query as Record<string, unknown> | undefined)?.[name]
  return typeof value === 'string' && value !== '' ? value.slice(0, 500) : undefined
}
