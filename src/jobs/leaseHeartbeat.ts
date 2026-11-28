// #1230: one renewal timer per live job. The machinery lives here rather than
// inside `Jobs` so `src/jobs/service.ts` stays under its size entry; the refusal
// counter belongs to the timer, not to the caller.
import type { Store } from '../db.js'
import { incCounter } from '../lib/metrics.js'

export class LeaseHeartbeats {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  clear(jobId: string): void {
    const timer = this.timers.get(jobId)
    if (timer !== undefined) {
      clearInterval(timer)
      this.timers.delete(jobId)
    }
  }

  start(store: Store, jobId: string, owner: string, leaseMs: number): void {
    this.clear(jobId)
    const timer = setInterval(() => {
      if (store.renewJobLease(jobId, owner, leaseMs)) return
      // A refused renewal on a live row means the lease moved to another worker;
      // a terminal row releasing its lease is the normal end and is not counted.
      const job = store.getJob(jobId)
      if (job !== undefined && (job.status === 'queued' || job.status === 'running')) {
        incCounter('fledge_job_lease_renew_failures_total', { kind: job.kind }, 1, 'Job lease renewals refused because the lease moved')
      }
      this.clear(jobId)
    }, Math.max(1000, Math.floor(leaseMs / 5)))
    timer.unref()
    this.timers.set(jobId, timer)
  }
}
