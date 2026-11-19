import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')

test('the compose healthcheck probes readiness, not liveness', () => {
  const testLine = compose
    .split('\n')
    .find((line) => line.trim().startsWith('test:'))
  assert.ok(testLine !== undefined, 'docker-compose.yml has a healthcheck test line')
  // /healthz answers 200 while the process is up even when the database cannot
  // be read, so a container whose DB is broken would report healthy. /readyz is
  // the probe that answers 503 in that state.
  assert.match(testLine, /\/readyz\b/)
  assert.doesNotMatch(testLine, /\/healthz\b/)
})
