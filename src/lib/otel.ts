import { randomBytes } from 'node:crypto'
import { log } from './log.js'

type AttributeValue = string | number | boolean

export interface SpanHandle {
  traceId: string
  spanId: string
  name: string
  attributes: Record<string, AttributeValue>
  startedAt: number
  sampled: boolean
}

interface FinishedSpan extends SpanHandle {
  endedAt: number
  status: 'OK' | 'ERROR'
  error?: string
}

let endpoint = ''
let serviceName = 'fledge'
let buffer: FinishedSpan[] = []
let timer: NodeJS.Timeout | null = null
let flushing = false

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

export function configureOtel(input: { endpoint?: string; serviceName?: string }): void {
  endpoint = (input.endpoint ?? '').replace(/\/$/, '')
  serviceName = input.serviceName ?? 'fledge'
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  if (endpoint === '') {
    buffer = []
    return
  }
  timer = setInterval(() => void flushOtel(), 5_000)
  timer.unref()
}

export function startSpan(name: string, attributes: Record<string, AttributeValue> = {}): SpanHandle {
  return {
    traceId: hex(16),
    spanId: hex(8),
    name,
    attributes,
    startedAt: Date.now(),
    sampled: endpoint !== '',
  }
}

export function endSpan(span: SpanHandle, status: 'OK' | 'ERROR' = 'OK', error?: string, attributes: Record<string, AttributeValue> = {}): void {
  if (!span.sampled) return
  const merged = { ...span.attributes, ...attributes }
  buffer.push({ ...span, attributes: merged, endedAt: Date.now(), status, ...(error === undefined ? {} : { error }) })
  if (buffer.length > 1000) buffer = buffer.slice(-1000)
}

export async function withSpan<T>(name: string, fn: () => Promise<T> | T, attributes: Record<string, AttributeValue> = {}): Promise<T> {
  const span = startSpan(name, attributes)
  try {
    const result = await fn()
    endSpan(span, 'OK')
    return result
  } catch (error) {
    endSpan(span, 'ERROR', error instanceof Error ? error.message : String(error))
    throw error
  }
}

function attribute(key: string, value: AttributeValue): unknown {
  if (typeof value === 'number') return { key, value: { intValue: Math.round(value) } }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } }
  return { key, value: { stringValue: value } }
}

export function otlpPayload(spans: FinishedSpan[]): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [attribute('service.name', serviceName)] },
        scopeSpans: [
          {
            scope: { name: 'fledge' },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              name: span.name,
              kind: 1,
              startTimeUnixNano: String(span.startedAt * 1_000_000),
              endTimeUnixNano: String(span.endedAt * 1_000_000),
              attributes: Object.entries(span.attributes).map(([key, value]) => attribute(key, value)),
              status: { code: span.status === 'OK' ? 1 : 2, ...(span.error === undefined ? {} : { message: span.error }) },
            })),
          },
        ],
      },
    ],
  }
}

export async function flushOtel(): Promise<void> {
  if (endpoint === '' || flushing || buffer.length === 0) return
  flushing = true
  const batch = buffer
  buffer = []
  try {
    await fetch(`${endpoint}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(otlpPayload(batch)),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    log.warn('otel export failed', { error: String(error) })
  } finally {
    flushing = false
  }
}

export async function shutdownOtel(): Promise<void> {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  await flushOtel()
}
