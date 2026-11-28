import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { Store } from '../db.js'
import { requireSuperAdmin } from '../auth/session.js'
import { buildIncidentBundle, incidentMarkdown, parseIncidentWindow } from './incident.js'
import { queryText } from './queryText.js'
import { cachedRouterProbe } from './routerHealth.js'

// #1234: the read-only support export. It is kept out of `src/app.ts` so the
// grandfathered composition root does not grow; the superadmin rule and the
// redaction stay next to the builder they call.
export function registerIncidentRoute(
  app: FastifyInstance,
  deps: { store: Store; config: Config; clockState: () => unknown },
): void {
  const { store, config, clockState } = deps
  app.get('/admin/incident/:window', async (request, reply) => {
    const viewer = requireSuperAdmin(request)
    if (viewer.preview === true) return reply.redirect('/console')
    const parsed = parseIncidentWindow(String((request.params as Record<string, string>).window))
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error })
    const clock = clockState()
    const router = config.router.url === '' ? undefined : await cachedRouterProbe(config).catch(() => undefined)
    const bundle = buildIncidentBundle({ store, config, window: parsed.window, clock, router })
    const format = queryText(request, 'format')
    const markdown = format === 'markdown' || format === 'md'
    const extension = markdown ? 'md' : 'json'
    reply.header('content-disposition', `attachment; filename="fledge-incident-${parsed.window.label}.${extension}"`)
    return markdown
      ? reply.type('text/markdown; charset=utf-8').send(incidentMarkdown(bundle))
      : reply.type('application/json; charset=utf-8').send(bundle)
  })
}
