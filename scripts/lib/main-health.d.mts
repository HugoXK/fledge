// Types for main-health.mjs so the TypeScript suites can import it.

export declare const MAIN_REF: string
export declare const RED_LABEL: string
export declare const RED_TITLE: string
export declare const MAIN_EVENTS: string[]

export interface OpenTracker {
  number: number
  title?: string
  createdAt?: string
}

export interface MainHealthInput {
  conclusion?: string
  eventName?: string
  ref?: string
  sha?: string
  failingJobs?: string[]
  runUrl?: string
  openTrackers?: OpenTracker[]
}

export interface TrackerRef {
  number: number
  title: string
}

export interface IssuePayload {
  title: string
  labels: string[]
  body: string
}

export type MainHealthAction = 'create' | 'comment' | 'close' | 'none'

export interface MainHealthDecision {
  action: MainHealthAction
  reason: string
  tracker?: TrackerRef
  issue?: IssuePayload
  body?: string
}

export declare function decision(input?: MainHealthInput): MainHealthDecision
