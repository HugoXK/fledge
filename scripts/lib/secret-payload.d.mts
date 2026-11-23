// Types for the column-payload reader the restore drill uses, so the TypeScript
// suite can call the real implementation instead of re-deriving its rules.
export interface ColumnKeys {
  /** The default key a `v1` payload needs, or null when the file carries none. */
  key: string | null
  /** The key ids a `v2` payload may name. */
  keyring: Readonly<Record<string, string>>
}

export class SecretKeyFileError extends Error {}

export function decryptColumnPayload(payload: string, keys?: ColumnKeys): string

export function readSecretKeyFile(path: string): ColumnKeys
