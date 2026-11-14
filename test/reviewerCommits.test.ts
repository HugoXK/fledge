import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #598. The rule itself lives in `scripts/lib/review-gate.mjs`
// (`reviewerAuthoredCommit`) and is not re-implemented here: the early check reads
// the same function, so a change to what counts as a reviewer commit cannot drift
// between the hourly-ish gate and this signal.
//
// What is new is *when* a person hears about it. Today the only place the
// condition is named is the job log of a red `review-gate` run, so `#532`, `#533`
// and `#618` each spent a review round on a tip that could never merge. This
// suite runs the early CLI against fixtures and pins three things: it fails on
// the push that makes the condition true, it names the commit and the identity,
// and it stays quiet for a tip whose commits belong to authors.
//
// Red half, stated as absence: before `scripts/reviewer-commits.mjs` existed
// these cases could not pass at all (the process failed to start), which is why
// the fixture that must exit 1 is the honest red-half witness — the previous
// state was "nothing runs, nothing is said".

const CLI = 'scripts/reviewer-commits.mjs'

interface Run {
  status: number
  stdout: string
  stderr: string
}

function runCli(files: { commits: unknown; policy: unknown }): Run {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-reviewer-commits-'))
  try {
    const commitsPath = join(dir, 'commits.json')
    const policyPath = join(dir, 'policy.json')
    writeFileSync(commitsPath, JSON.stringify(files.commits))
    writeFileSync(policyPath, JSON.stringify(files.policy))
    const result = spawnSync(process.execPath, [CLI, '--commits-json', commitsPath, '--policy-json', policyPath], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: '', GITHUB_REPOSITORY: '', GITHUB_EVENT_PATH: '', GITHUB_STEP_SUMMARY: '' },
    })
    return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const policy = {
  version: 2,
  reviewers: ['HugoXK-bot'],
  requiredPass: 'HugoXK-bot',
  requiredPassEmail: 'hugo2001xk@gmail.com',
  writers: ['HugoXK', 'HugoXK-bot'],
}

function commit(sha: string, login: string | null, email: string, name = 'Hugo'): Record<string, unknown> {
  return { sha, author: login === null ? null : { login }, commit: { author: { name, email } } }
}

test('a tip whose third commit is authored by the reviewer identity fails and names it', () => {
  const run = runCli({
    policy,
    commits: [
      commit('aaaaaaaaaaaa1', 'HugoXK', 'ke.xu@zju.edu.cn'),
      commit('bbbbbbbbbbbb2', 'HugoXK', 'ke.xu@zju.edu.cn'),
      commit('2b37154394ab6314d47c86ba803987f99436c396', 'HugoXK-bot', 'hugo2001xk@gmail.com'),
    ],
  })
  assert.equal(run.status, 1, 'the push that makes the condition true must fail, not wait for a verdict round')
  assert.match(run.stderr, /2b37154394ab/)
  assert.match(run.stderr, /hugoXK-bot/i)
  assert.match(run.stderr, /re-author/i)
  assert.equal(run.stdout.trim(), '')
})

test('a tip whose commits all belong to authors passes quietly', () => {
  const run = runCli({
    policy,
    commits: [
      commit('cccccccccccc1', 'HugoXK', 'ke.xu@zju.edu.cn'),
      commit('dddddddddddd2', 'HugoXK', 'ke.xu@zju.edu.cn'),
      // An address that resolves to no account: `author` is null, and it is not
      // the reviewer's address either, so it is an ordinary tip.
      commit('eeeeeeeeeeee3', null, 'dev3@fledge.local', 'Dev-3'),
    ],
  })
  assert.equal(run.status, 0)
  assert.match(run.stdout, /no reviewer-authored commit/, 'a clean tip says so rather than printing nothing')
  assert.equal(run.stderr.trim(), '')
})

test('the check reads requiredPass and reviewers, not only one of them', () => {
  const shipped = runCli({
    policy: { ...policy, requiredPass: 'HugoXK-bot', reviewers: ['Some-other-reviewer'] },
    commits: [commit('ffffffffffff1', 'Some-Other-Reviewer', 'other@example.com')],
  })
  assert.equal(shipped.status, 1, 'a login in `reviewers` is a reviewer identity too')
  assert.match(shipped.stderr, /some-other-reviewer/i)

  const required = runCli({
    policy: { ...policy, reviewers: [], requiredPass: 'HugoXK-bot' },
    commits: [commit('ffffffffffff2', 'hugoxk-bot', 'hugo2001xk@gmail.com')],
  })
  assert.equal(required.status, 1, 'requiredPass alone is enough, and the match is case-insensitive')
  assert.match(required.stderr, /hugoxk-bot/i)
})

test('a commit with no linked account but the reviewer\'s address is caught', () => {
  const run = runCli({
    policy,
    commits: [commit('abababababab9', null, 'hugo2001xk@gmail.com')],
  })
  assert.equal(run.status, 1, 'the unlinked-address branch of the rule fires here too')
  assert.match(run.stderr, /hugo2001xk@gmail\.com/i)
})

test('an unreadable fixture is a failure, never a silent pass', () => {
  const missing = spawnSync(process.execPath, [CLI, '--commits-json', '/nonexistent/commits.json', '--policy-json', '/nonexistent/policy.json'], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_TOKEN: '', GITHUB_REPOSITORY: '', GITHUB_EVENT_PATH: '', GITHUB_STEP_SUMMARY: '' },
  })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /cannot read/i)
})
