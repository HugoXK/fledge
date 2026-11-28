// The published OpenAPI 3.1 contract for the token-authenticated API v1 (#1243).
//
// One route ships today: `GET /api/v1/jobs` (#392). Until this file the only
// machine-readable description of it was prose in docs/api.md, which a control
// room has to read by hand. The contract lives here as data, next to the routes
// it describes, and `test/openapi.test.ts` pins it to what `src/app.ts` actually
// registers — a new `/api/v1/*` route with no entry here fails that test.
//
// The document is deliberately hand-written rather than generated from the whole
// route table: this is the public, token-authenticated surface only. Session
// routes, callbacks and the console pages are not part of the contract and must
// never appear in it.

export type Operation = { method: 'get'; path: string }

// What the contract claims the app registers. The test compares this list with
// the `/api/v1/*` routes found in src/app.ts and with the document's own paths,
// so the three cannot drift apart silently.
export const API_V1_OPERATIONS: readonly Operation[] = [
  { method: 'get', path: '/api/v1/jobs' },
  { method: 'get', path: '/api/v1/openapi.json' },
]

const ERROR_TYPES = ['invalid_api_key', 'insufficient_scope', 'rate_limited', 'invalid_cursor']

// The three shapes the gateway answers with (#392): the same authenticator is
// used by both surfaces, so the contract names the same three type strings the
// jobs route can return.
const ERROR_RESPONSE = (description: string): Record<string, unknown> => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
})

export function openApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Fledge API',
      version: '1.0.0',
      summary: 'The token-authenticated read API for a Fledge instance.',
      description:
        'Every route here needs a Fledge API token (`flg_…`) with the `jobs:read` scope, sent as `Authorization: Bearer <token>`. ' +
        'The contract itself is public: it names no instance data and is served without a token so a client can be generated before one exists. ' +
        'Session-cookie routes, callbacks and console pages are not part of this API.',
    },
    servers: [{ url: '/', description: 'This instance' }],
    tags: [{ name: 'jobs', description: 'The caller’s own jobs.' }, { name: 'contract', description: 'This document.' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/v1/jobs': {
        get: {
          tags: ['jobs'],
          operationId: 'listJobs',
          summary: 'List the caller’s jobs, newest first.',
          description:
            'Answers with the caller’s own jobs only. `next_cursor` is the id to pass back as `cursor` for the next page, or null on the last page.',
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: 'cursor',
              in: 'query',
              required: false,
              description: 'A job id from a previous `next_cursor`. An id that is not one of the caller’s jobs is rejected with `invalid_cursor`.',
              schema: { type: 'string' },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              description: 'Page size. Values outside 1–100 are clamped, and a non-integer falls back to the default.',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
          ],
          responses: {
            '200': {
              description: 'One page of the caller’s jobs.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/JobPage' } } },
            },
            '400': ERROR_RESPONSE('The `cursor` id does not belong to the caller.'),
            '401': ERROR_RESPONSE('The token is missing, unknown, revoked or expired.'),
            '403': ERROR_RESPONSE('The token is valid but lacks the `jobs:read` scope.'),
            '429': ERROR_RESPONSE('The per-caller API rate limit is exhausted.'),
          },
        },
      },
      '/api/v1/openapi.json': {
        get: {
          tags: ['contract'],
          operationId: 'getOpenApiContract',
          summary: 'This OpenAPI 3.1 document.',
          description: 'Served without a token: the contract describes the instance, not its data.',
          security: [],
          responses: {
            '200': {
              description: 'The OpenAPI 3.1 document for this API.',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'A Fledge API token (`flg_…`) with the `jobs:read` scope.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['type', 'message'],
              properties: {
                type: { type: 'string', enum: ERROR_TYPES },
                message: { type: 'string' },
              },
            },
          },
        },
        JobSummary: {
          type: 'object',
          required: ['id', 'kind', 'status', 'repo', 'createdAt', 'finishedAt', 'prUrl', 'issueUrl', 'reviewScore', 'costUsd'],
          properties: {
            id: { type: 'string' },
            kind: { type: 'string' },
            status: { type: 'string' },
            repo: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            finishedAt: { type: ['string', 'null'], format: 'date-time' },
            prUrl: { type: ['string', 'null'] },
            issueUrl: { type: ['string', 'null'] },
            reviewScore: { type: ['number', 'null'] },
            costUsd: { type: 'number' },
          },
        },
        JobPage: {
          type: 'object',
          required: ['data', 'next_cursor'],
          properties: {
            data: { type: 'array', items: { $ref: '#/components/schemas/JobSummary' } },
            next_cursor: { type: ['string', 'null'], description: 'The id to pass as `cursor` for the next page, or null on the last page.' },
          },
        },
      },
    },
  }
}
