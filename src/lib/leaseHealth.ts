// #1230: the lease rows the admin card and the age gauge read. They live here
// rather than on `Store` so `src/db.ts` stays under its size entry; the reader
// takes the public `get` surface, which `Store` already satisfies.
export interface LeaseQueryReader {
  get<T>(sql: string, ...params: unknown[]): T | undefined
}

// #1230: the lease a live job holds, as one row the admin card and the age
// gauge can read. `since` is the attempt start for a running job and the row's
// own start/creation time for a claim that has not started yet.
export interface LiveLeaseRow {
  job_id: string
  kind: string
  repo_id: string
  owner: string
  name: string
  lease_owner: string | null
  lease_until: string | null
  since: string
}

// #1230: the newest attempt the reaper closed. The attempt row is written in
// the transaction that finalises the job, so this is the durable record of a
// reap rather than an in-process counter.
export interface ReapedLeaseRow {
  job_id: string
  kind: string
  repo_id: string
  owner: string
  name: string
  at: string | null
  error: string | null
}

// #1230: the oldest lease the platform still holds. A queued row can hold a
// dispatch claim before it starts, so both active statuses count. A running
// row's lease age starts at its attempt; a claim that has not started falls
// back to the row's own start/creation time.
export function oldestLiveLease(store: LeaseQueryReader): LiveLeaseRow | undefined {
  return store.get<LiveLeaseRow>(
    `SELECT j.id AS job_id, j.kind, j.repo_id, r.owner, r.name,
            j.lease_owner, j.lease_until,
            COALESCE(a.started_at, j.started_at, j.created_at) AS since
     FROM jobs j
     JOIN repos r ON r.id = j.repo_id
     LEFT JOIN job_attempts a ON a.job_id = j.id AND a.status = 'running'
     WHERE j.status IN ('queued', 'running') AND j.lease_until IS NOT NULL
     ORDER BY since ASC, j.id ASC
     LIMIT 1`,
  )
}

// #1230: the newest attempt the reaper closed, for the same card. Only a
// terminal `reaped` attempt counts; a failed or succeeded attempt is a normal
// end, not a lost lease.
export function lastReapedLease(store: LeaseQueryReader): ReapedLeaseRow | undefined {
  return store.get<ReapedLeaseRow>(
    `SELECT a.job_id, j.kind, j.repo_id, r.owner, r.name,
            a.finished_at AS at, a.error
     FROM job_attempts a
     JOIN jobs j ON j.id = a.job_id
     JOIN repos r ON r.id = j.repo_id
     WHERE a.status = 'reaped' AND a.finished_at IS NOT NULL
     ORDER BY a.finished_at DESC, a.id DESC
     LIMIT 1`,
  )
}
