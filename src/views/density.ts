// #473: table density is a display preference like the language, and it is
// saved the same way — a cookie the server reads while rendering. A client-side
// toggle cannot do this honestly: the rows are already in the response, so the
// reader would see the comfortable layout first and watch it collapse.
import type { FastifyRequest } from 'fastify'

export type Density = 'comfortable' | 'compact'

export const DENSITY_COOKIE = 'fledge_density'
export const DENSITIES: readonly Density[] = ['compact', 'comfortable']

export function isDensity(value: unknown): value is Density {
  return value === 'compact' || value === 'comfortable'
}

// An unknown or missing cookie is the comfortable layout, which is also the
// layout every page had before this preference existed.
export function resolveDensity(request: FastifyRequest): Density {
  const saved = request.cookies?.[DENSITY_COOKIE]
  return isDensity(saved) ? saved : 'comfortable'
}
