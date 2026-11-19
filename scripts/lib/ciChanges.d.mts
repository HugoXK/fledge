// Types for the change classifier. The workflow writes these flags as step
// outputs and `ci-ok` reads them to decide whether a skipped job was not
// applicable rather than missing.
export interface GateChanges {
  docsOnly: boolean
  source: boolean
  frontend: boolean
  // #1103: the set the `visual` job and `ci-ok`'s SKIP_WHEN entry read. It
  // includes `frontend` plus the matrix code, so a diff that changes what the
  // gate measures still runs it.
  visual: boolean
  deps: boolean
  db: boolean
  docker: boolean
  workflows: boolean
  codeql: boolean
  deploy: boolean
}

export declare function isDocPath(path: string): boolean
export declare function isSourcePath(path: string): boolean
export declare function isFrontendPath(path: string): boolean
export declare function isVisualPath(path: string): boolean
export declare function isDependencyPath(path: string): boolean
export declare function isDbPath(path: string): boolean
export declare function isWorkflowPath(path: string): boolean
export declare function isDeployPath(path: string): boolean
export declare function isDockerInputPath(path: string): boolean
export declare function allGateChanges(): GateChanges
export declare function classifyChanges(paths: string[]): GateChanges
