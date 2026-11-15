// #708: every mutating route names one class here, and this table is the class
// policy the classifier test reads. A route that is not in it is unclassified,
// which is a test failure that names it — not a default. The table is explicit in
// both directions: a route removed from `src/app.ts` and left here is a stale
// entry, and the same test fails on that too.
//
// The rule (Lead, 2026-11-14; approver Chief for the ordinary class):
// 1. destructive — irreversible or privilege-changing;
// 2. expensive — starts, stops or merges real work;
// 3. ordinary — everything else that changes state, unlimited **by decision**.
//
// The classes are declared as data rather than read off the handlers because a
// handler's `limits.take(...)` says how a route is paced, not how it should be:
// classification is the policy, enforcement is the current state of it, and the
// two are compared where the limits are applied (#708's later slice).
export type RouteClass = 'destructive' | 'expensive' | 'ordinary'

// Irreversible or privilege-changing: a role, a token, a credential, a policy or
// a repository goes, or an account's standing changes.
const DESTRUCTIVE_ROUTE_LIST = [
  'POST /admin/users/:id/role',
  'POST /admin/users/:id/private-models',
  'POST /admin/users/:id/resend-approval',
  'POST /admin/users/:id/approve',
  'POST /admin/users/:id/reject',
  'POST /admin/users/:id/quota',
  'POST /admin/users/:id/delete',
  'POST /admin/simulation',
  'POST /settings/providers',
  'POST /settings/providers/:id/update',
  'POST /settings/providers/:id/discover',
  'POST /settings/providers/:id/models',
  'POST /settings/providers/:id/models/bulk',
  'POST /settings/providers/:id/models/:modelId/delete',
  'POST /settings/providers/:id/delete',
  'POST /settings/tokens',
  'POST /settings/tokens/:id/revoke',
  'POST /settings/sessions/:hash/revoke',
  'POST /settings/sessions/revoke-others',
  'POST /settings/sessions/rotate',
  'POST /repos/:id/delete',
  'POST /repos/:id/settings',
  'POST /repos/:id/instance/stop',
  // A rule override steers every later job on the repository, and the handler
  // already takes the destructive window; the class follows the window.
  'POST /repos/:id/rules',
  'POST /repos/:id/role',
  'POST /repos/:id/release-readiness/tag',
  'POST /repos/:id/security-findings/:findingId/dismiss',
  'POST /admin/deployments/promote',
  'POST /admin/deployments/rollback',
  'POST /admin/platform/stop',
  'POST /admin/platform/resume',
] as const

// Starts, stops or merges real work: a job, a plan, a release, a schedule, an
// instance or a team turn.
const EXPENSIVE_ROUTE_LIST = [
  // Adding a repository provisions an instance (the handler says so and takes the
  // expensive window itself), and importing an app provisions every imported
  // repository: both start work, so ADR 0022 files them expensive, not ordinary.
  'POST /repos',
  'POST /repos/app',
  'POST /repos/:id/instance',
  'POST /repos/:id/run',
  'POST /repos/:id/plan',
  'POST /repos/:id/triage',
  'POST /repos/:id/refresh',
  'POST /repos/:id/review',
  'POST /repos/:id/enable',
  'POST /repos/:id/disable',
  'POST /repos/:id/models/apply',
  'POST /repos/:id/schedule',
  'POST /repos/:id/schedule/remove',
  'POST /repos/:id/release',
  'POST /repos/:id/releases/:releaseId/check',
  'POST /repos/:id/gate/sessions',
  'POST /repos/:id/gate/sessions/:sessionId/confirm',
  'POST /repos/:id/delivery/merge-clean',
  'POST /repos/:id/work',
  'POST /repos/:id/work/:workItemId/state',
  'POST /repos/:id/work/:workItemId/run',
  'POST /repos/:id/work/:workItemId/scope',
  'POST /repos/:id/work/:workItemId/verify',
  'POST /repos/:id/team/stop',
  'POST /repos/:id/team/answer',
  'POST /api/repos/:id/team/stop',
  'POST /api/repos/:id/team/answer',
  'POST /repos/:id/chief/message',
  'POST /api/repos/:id/chief/message',
  'POST /repos/:id/jobs/:jobId/cancel',
  'POST /repos/:id/jobs/:jobId/pause',
  'POST /repos/:id/jobs/:jobId/resume',
  'POST /repos/:id/jobs/:jobId/retry',
  'POST /repos/:id/jobs/:jobId/recheck',
  'POST /repos/:id/jobs/:jobId/merge',
  'POST /repos/:id/jobs/:jobId/approve-plan',
  'POST /repos/:id/jobs/:jobId/reject-plan',
  'POST /repos/:id/jobs/:jobId/execute',
  // The workspace proxy is registered with `app.all` (the two
  // `/repos/:id/workspace/app…` registrations in `src/app.ts`), so it answers
  // every method; the mutating ones forward their body to the per-repo workspace
  // app, where they can start work inside the instance. That is why they are
  // expensive rather than ordinary. Nothing paces them yet: classification is
  // the policy, enforcement is the later slice.
  'POST /repos/:id/workspace/app',
  'PUT /repos/:id/workspace/app',
  'PATCH /repos/:id/workspace/app',
  'DELETE /repos/:id/workspace/app',
  'POST /repos/:id/workspace/app/*',
  'PUT /repos/:id/workspace/app/*',
  'PATCH /repos/:id/workspace/app/*',
  'DELETE /repos/:id/workspace/app/*',
  'POST /repos/:id/security-findings/:findingId/fix',
  'POST /admin/webhooks/:id/retry',
] as const

// Everything else that changes state. Listed rather than implied: "the rest are
// ordinary" names no route and decides no route, so an unlimited route has to
// appear here to be unlimited on purpose.
const ORDINARY_ROUTE_LIST = [
  'POST /auth/token',
  'POST /auth/logout',
  'POST /apply',
  'POST /repos/:id/memory',
  'POST /repos/:id/rules/delete',
  'POST /repos/:id/team/guidance',
  'POST /repos/:id/jobs/:jobId/priority',
  'POST /repos/:id/jobs/:jobId/relations',
  'POST /repos/:id/jobs/:jobId/decision',
  'POST /repos/:id/jobs/:jobId/ack-rule-change',
  'POST /settings/notifications',
  'POST /notifications/read',
  'POST /approve/:token',
  'POST /api/jobs/:id/callback',
  'POST /api/github/webhook',
  'POST /api/inbound/email',
] as const

export const DESTRUCTIVE_ROUTES: ReadonlySet<string> = new Set(DESTRUCTIVE_ROUTE_LIST)
export const EXPENSIVE_ROUTES: ReadonlySet<string> = new Set(EXPENSIVE_ROUTE_LIST)
export const ORDINARY_ROUTES: ReadonlySet<string> = new Set(ORDINARY_ROUTE_LIST)

// The sweep's key: `METHOD /path`, the same shape the failure message prints.
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

export function routeClassOf(method: string, path: string): RouteClass | undefined {
  const key = routeKey(method, path)
  if (DESTRUCTIVE_ROUTES.has(key)) return 'destructive'
  if (EXPENSIVE_ROUTES.has(key)) return 'expensive'
  if (ORDINARY_ROUTES.has(key)) return 'ordinary'
  return undefined
}

// Every key this table classifies, once: the sweep compares this set with the
// routes it reads out of `src/app.ts`.
export function classifiedRoutes(): string[] {
  return [...DESTRUCTIVE_ROUTES, ...EXPENSIVE_ROUTES, ...ORDINARY_ROUTES].sort()
}
