import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchFailureLog } from '../src/actions/workflowLog.js'
import { GithubClient } from '../src/repos/github.js'
import { json, startFakeServer } from './helpers.js'

// #703: the failure-log intake called `listWorkflowJobs` without a page count, so
// it read the client default of two pages. On a run with more than 200 jobs a
// page-3 failure was invisible and the row recorded `no_failed_job` — a claim
// about the run that was not true. `docs/api.md` promises three pages.

const PAGE = 100
const RUN = 9001
const FAILING_JOB = 250

type Job = { id: number; conclusion: string | null }

/** Three pages of 100 jobs: every job is green except `FAILING_JOB`. */
function threePages(failingConclusion: string | null): Job[][] {
  const pages: Job[][] = []
  let id = 1
  for (let page = 1; page <= 3; page += 1) {
    const batch: Job[] = []
    for (let index = 0; index < PAGE; index += 1) {
      batch.push({ id, conclusion: id === FAILING_JOB ? failingConclusion : 'success' })
      id += 1
    }
    pages.push(batch)
  }
  return pages
}

interface Probe {
  /** `maxPages` requested by each call, in order. */
  depth: number[]
  /** Every page number actually fetched, in order. */
  pageRequests: number[]
  /** The job ids whose log was read. */
  logIds: number[]
}

function newProbe(): Probe {
  return { depth: [], pageRequests: [], logIds: [] }
}

/** A client whose paging behaves like the real one: it honours `maxPages`. */
function pagedClient(pages: Job[][], probe: Probe) {
  return {
    async listWorkflowJobs(_owner: string, _name: string, _runId: number, maxPages = 2): Promise<Job[]> {
      probe.depth.push(maxPages)
      const seen: Job[] = []
      for (let page = 1; page <= maxPages; page += 1) {
        probe.pageRequests.push(page)
        const batch = pages[page - 1] ?? []
        seen.push(...batch)
        if (batch.length < PAGE) break
      }
      return seen
    },
    async getJobLog(_owner: string, _name: string, jobId: number): Promise<string> {
      probe.logIds.push(jobId)
      return `2026-11-14T12:00:00Z running tests\nAssertionError: expected 1 to equal 2\n`
    },
  }
}

test('a failure on page 3 of a 300-job run is found, not recorded as no_failed_job', async () => {
  const probe = newProbe()
  const result = await fetchFailureLog(pagedClient(threePages('failure'), probe), 'o', 'w', RUN)

  assert.equal(result.error, null)
  assert.match(result.excerpt ?? '', /AssertionError: expected 1 to equal 2/)
  assert.deepEqual(probe.logIds, [FAILING_JOB], 'the excerpt is the page-3 job log')
  assert.ok(probe.pageRequests.includes(3), 'page 3 was read')
})

test('an all-green 300-job run records no_failed_job only after all three pages', async () => {
  const probe = newProbe()
  const result = await fetchFailureLog(pagedClient(threePages('success'), probe), 'o', 'w', RUN)

  assert.deepEqual(result, { excerpt: null, error: 'no_failed_job' })
  assert.deepEqual(probe.pageRequests, [1, 2, 3], 'every page was read before saying the run had no failure')
})

test('the GitHub client itself reads the third jobs page for the intake', async () => {
  const pages = threePages('failure')
  const requested: number[] = []
  const api = await startFakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake.test')
    if (url.pathname === `/repos/o/w/actions/runs/${RUN}/jobs`) {
      const page = Number(url.searchParams.get('page') ?? '1')
      requested.push(page)
      return json(response, 200, { total_count: 300, jobs: pages[page - 1] ?? [] })
    }
    if (url.pathname === `/repos/o/w/actions/jobs/${FAILING_JOB}/logs`) {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('2026-11-14T12:00:00Z AssertionError: expected 1 to equal 2\n')
      return
    }
    json(response, 404, { message: 'not found' })
  })
  try {
    const result = await fetchFailureLog(new GithubClient('test-token', api.url), 'o', 'w', RUN)
    assert.equal(result.error, null)
    assert.match(result.excerpt ?? '', /AssertionError/)
    assert.ok(requested.includes(3), `the client asked for page 3 (asked for ${requested.join(', ')})`)
  } finally {
    await api.close()
  }
})
