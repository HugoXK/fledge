export type MetricLabels = Record<string, string | number | boolean>

interface Series {
  name: string
  help: string
  labels: MetricLabels
  value: number
}

interface HistogramSeries {
  name: string
  help: string
  labels: MetricLabels
  buckets: number[]
  counts: number[]
  sum: number
  count: number
}

// The highest finite boundary must stay above every latency threshold the alert
// rules in deploy/prometheus/fledge-alerts.yml compare against: histogram_quantile
// never interpolates inside the +Inf bucket, so a p95 that lands there reads as the
// top finite boundary and a threshold above it could never fire.
const DEFAULT_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 600, 1200, 1800, 3600]

const counters = new Map<string, Series>()
const gauges = new Map<string, Series>()
const histograms = new Map<string, HistogramSeries>()

function labelKey(name: string, labels: MetricLabels): string {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== '' && value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
  return `${name}|${entries.map(([key, value]) => `${key}=${String(value)}`).join('&')}`
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function formatLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== '' && value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return ''
  return `{${entries.map(([key, value]) => `${key}="${escapeLabel(String(value))}"`).join(',')}}`
}

export function incCounter(name: string, labels: MetricLabels = {}, value = 1, help = ''): void {
  const key = labelKey(name, labels)
  const current = counters.get(key)
  if (current === undefined) counters.set(key, { name, help, labels, value })
  else current.value += value
}

export function setGauge(name: string, value: number, labels: MetricLabels = {}, help = ''): void {
  const key = labelKey(name, labels)
  gauges.set(key, { name, help, labels, value })
}

export function observeHistogram(name: string, value: number, labels: MetricLabels = {}, help = '', buckets = DEFAULT_BUCKETS): void {
  if (!Number.isFinite(value) || value < 0) return
  const key = labelKey(name, labels)
  let current = histograms.get(key)
  if (current === undefined) {
    current = { name, help, labels, buckets, counts: buckets.map(() => 0), sum: 0, count: 0 }
    histograms.set(key, current)
  }
  current.sum += value
  current.count += 1
  for (let index = 0; index < current.buckets.length; index += 1) {
    if (value <= current.buckets[index]!) current.counts[index] = (current.counts[index] ?? 0) + 1
  }
}

export function renderMetrics(): string {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const series of counters.values()) {
    if (!seen.has(series.name)) {
      if (series.help !== '') lines.push(`# HELP ${series.name} ${series.help}`)
      lines.push(`# TYPE ${series.name} counter`)
      seen.add(series.name)
    }
    lines.push(`${series.name}${formatLabels(series.labels)} ${series.value}`)
  }
  seen.clear()
  for (const series of gauges.values()) {
    if (!seen.has(series.name)) {
      if (series.help !== '') lines.push(`# HELP ${series.name} ${series.help}`)
      lines.push(`# TYPE ${series.name} gauge`)
      seen.add(series.name)
    }
    lines.push(`${series.name}${formatLabels(series.labels)} ${series.value}`)
  }
  seen.clear()
  for (const series of histograms.values()) {
    if (!seen.has(series.name)) {
      if (series.help !== '') lines.push(`# HELP ${series.name} ${series.help}`)
      lines.push(`# TYPE ${series.name} histogram`)
      seen.add(series.name)
    }
    const labels = formatLabels(series.labels)
    for (let index = 0; index < series.buckets.length; index += 1) {
      const bucketLabels = formatLabels({ ...series.labels, le: String(series.buckets[index]) })
      lines.push(`${series.name}_bucket${bucketLabels} ${series.counts[index] ?? 0}`)
    }
    lines.push(`${series.name}_bucket${formatLabels({ ...series.labels, le: '+Inf' })} ${series.count}`)
    lines.push(`${series.name}_sum${labels} ${series.sum}`)
    lines.push(`${series.name}_count${labels} ${series.count}`)
  }
  return `${lines.join('\n')}\n`
}

export function resetMetrics(): void {
  counters.clear()
  gauges.clear()
  histograms.clear()
}

export function metricsSnapshot(): { counters: Array<{ name: string; labels: MetricLabels; value: number }>; gauges: Array<{ name: string; labels: MetricLabels; value: number }>; histograms: Array<{ name: string; labels: MetricLabels; count: number; sum: number }> } {
  return {
    counters: [...counters.values()].map(({ name, labels, value }) => ({ name, labels, value })),
    gauges: [...gauges.values()].map(({ name, labels, value }) => ({ name, labels, value })),
    histograms: [...histograms.values()].map(({ name, labels, count, sum }) => ({ name, labels, count, sum })),
  }
}
