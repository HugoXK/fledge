import test from 'node:test'
import assert from 'node:assert/strict'
import { configureOtel, endSpan, otlpPayload, startSpan } from '../src/lib/otel.js'

test('otel is a no-op without an endpoint and builds an OTLP payload when sampled', () => {
  configureOtel({ endpoint: '' })
  const off = startSpan('x', { a: 1 })
  assert.equal(off.sampled, false)
  endSpan(off)

  configureOtel({ endpoint: 'http://127.0.0.1:4318' })
  const span = startSpan('job.enqueue', { kind: 'iterate' })
  endSpan(span, 'OK')
  const payload = otlpPayload([{ ...span, endedAt: span.startedAt + 10, status: 'OK' }]) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> }
  assert.equal(payload.resourceSpans[0]?.scopeSpans[0]?.spans.length, 1)
  configureOtel({ endpoint: '' })
})
