export interface LedgerSelectionInput {
  /** The ref the ceiling should come from; null for a local run. */
  baseRef?: string | null
  /** The ledger file's text at `baseRef`, or null when it is unreadable there. */
  baseContent?: string | null
  /** The ledger file's text in the tree under test. */
  headContent?: string | null
  /** True when a named base that cannot be read must fail instead of falling back. */
  strict?: boolean
}

export interface LedgerSelection {
  ledger: Record<string, number>
  source: string
}

export function selectLedger(input: LedgerSelectionInput): LedgerSelection
