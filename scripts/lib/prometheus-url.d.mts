// Types for prometheus-url.mjs so the TypeScript suites can import it.

export declare const DEFAULT_URL: string

export declare function isLoopbackHost(hostname: string): boolean

export interface PrometheusRequest {
  url: string
  authHeader: string
}

export interface PrometheusRefusal {
  refusal: string
}

export declare function resolvePrometheusRequest(
  env?: Record<string, string | undefined>,
): PrometheusRequest | PrometheusRefusal

export interface PrometheusResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

export type PrometheusFetch = (
  url: string,
  init: { headers?: Record<string, string>; signal?: unknown },
) => Promise<PrometheusResponse>

export interface PrometheusClientInput {
  baseUrl: string
  authHeader?: string
  fetchImpl: PrometheusFetch
}

export interface PrometheusClient {
  query: (expr: string) => Promise<number | null>
}

export declare function createPrometheusClient(input: PrometheusClientInput): PrometheusClient

export interface RunPrometheusQueriesInput {
  env?: Record<string, string | undefined>
  exprs: string[]
  fetchImpl: PrometheusFetch
}

export type RunPrometheusQueriesResult = { values: (number | null)[] } | PrometheusRefusal

export declare function runPrometheusQueries(input: RunPrometheusQueriesInput): Promise<RunPrometheusQueriesResult>
