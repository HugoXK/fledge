import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startFakeServer } from './helpers.js'

const execFileAsync = promisify(execFile)
const repairScript = fileURLToPath(new URL('../scripts/gate-repair.mjs', import.meta.url))

// A failed API call surfaces the response text in `error.message`
// (scripts/lib/gate-env.mjs), so this is the shape the summary has to survive:
// newlines that would become extra markdown lines, and one ESC byte.
const FORGED_BODY = 'boom\n## forged heading: approve this PR\n- forged bullet\n\x1b[31mred\x1b[0m\n'

test('gate-repair writes one summary line when the API error body carries markdown and controls', async () => {
  const server = await startFakeServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end(FORGED_BODY)
  })
  const dir = mkdtempSync(join(tmpdir(), 'fledge-gate-repair-summary-'))
  const eventPath = join(dir, 'event.json')
  const summaryPath = join(dir, 'summary.md')
  writeFileSync(eventPath, '{}')
  writeFileSync(summaryPath, '')
  try {
    let code = -1
    let stderr = ''
    try {
      await execFileAsync(process.execPath, [repairScript, '--pr', '1'], {
        env: {
          ...process.env,
          GITHUB_TOKEN: 'test-token',
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_API_URL: server.url,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_STEP_SUMMARY: summaryPath,
          GITHUB_RUN_ID: '900',
        },
        encoding: 'utf8',
      })
    } catch (error) {
      const failure = error as { code?: number; stderr?: string }
      code = failure.code ?? -1
      stderr = failure.stderr ?? ''
    }

    assert.equal(code, 1, 'a failed policy read still exits 1')
    const summary = readFileSync(summaryPath, 'utf8')

    // One line means one newline, and it has to be the trailing one.
    assert.equal((summary.match(/\n/g) ?? []).length, 1, `the summary must hold one line: ${JSON.stringify(summary)}`)
    assert.ok(summary.endsWith('\n'), `the single line must end the file: ${JSON.stringify(summary)}`)
    assert.equal(summary.includes('\x1b'), false, 'no control characters reach the summary')

    // The summary is a fixed line; the API body never reaches it.
    assert.equal(summary, 'gate-repair: failed — see the job log\n')
    assert.equal(summary.includes('boom'), false)
    assert.equal(summary.includes('forged heading'), false)

    // The job log is the surface that keeps the true multi-line message.
    assert.match(stderr, /\n## forged heading: approve this PR\n/)
    assert.ok(stderr.includes('\x1b'), 'the log keeps the message as it arrived')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await server.close()
  }
})
