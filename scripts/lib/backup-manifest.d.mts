// Types for the backup manifest helpers, so the TypeScript suite can call the
// real implementation instead of re-deriving its rules.
export interface ManifestDatabaseFacts {
  tables: Record<string, number>
  schemaVersion: number
}

export interface BackupManifestEncryption {
  format: string
  version: number
  algorithm: string
  /** Which derivation produced the key: a 32-byte key used as-is, or scrypt over a passphrase. */
  kdf?: 'raw' | 'scrypt'
  keyId: string
  keyVersion: number
}

export interface BackupManifest {
  copy: string
  createdAt: string
  size: number
  sha256: string
  schemaVersion: number
  tables: Record<string, number>
  encryption?: BackupManifestEncryption
}

export declare function manifestPath(copyPath: string): string
export declare function sha256File(path: string): Promise<string>
export declare function databaseFacts(path: string): ManifestDatabaseFacts
export declare function writeManifest(copyPath: string): Promise<string>
export declare function readManifest(copyPath: string): BackupManifest | null
