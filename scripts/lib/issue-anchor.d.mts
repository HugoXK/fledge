// Types for issue-anchor.mjs, the pairing `issue-body-hash.d.mts` already uses,
// so a TypeScript suite can import the pure scanner instead of re-deriving it.

export interface Anchor {
  path: string
  start: number
  end: number | null
  /** The citation as the body wrote it: `path:line` or `path:start-end`. */
  ref: string
}

export type ResolvedPath =
  | { kind: 'exact'; path: string }
  | { kind: 'suffix'; path: string }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; candidates: string[] }

export function unfencedLines(body: string): string[]
export function pinOf(body: string): string
export function anchorsOf(body: string): Anchor[]
export function lastLineOf(contents: string): number
export function resolvePath(path: string, paths: string[]): ResolvedPath
export function staleFound(anchor: Anchor, lastLine: number): string | null
