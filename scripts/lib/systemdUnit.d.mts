// Types for systemdUnit.mjs, so the TypeScript suite can pin the parser the
// `deploy-check` gate runs (#882).

export interface SystemdUnitParse {
  /** Section names in file order; a repeated name appears twice. */
  sections: string[]
  /** Number of `Key=Value` directives read. */
  directives: number
  /** Every problem found, in file order; empty when the unit satisfies the contract. */
  errors: string[]
}

export declare function parseSystemdUnit(text: string): SystemdUnitParse
