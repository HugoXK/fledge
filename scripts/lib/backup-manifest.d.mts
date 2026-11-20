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

export type BackupCopyKind = 'plaintext' | 'encrypted'
export type BackupCandidateKind = 'copy' | 'manifest' | 'sidecar'

export interface BackupExpiryCandidate {
  path: string
  /** What the file is: a copy, its manifest, or one of its SQLite sidecars. */
  kind: BackupCandidateKind
  /** The copy class, or the file kind for a manifest/sidecar. */
  class: BackupCopyKind | 'manifest' | 'sidecar'
  ageHours: number
  reason: string
}

export interface BackupExpiryPlan {
  dir: string
  keep: { plaintext: number; encrypted: number }
  /** Copies found on disk, per class, before any keep count is applied. */
  scanned: { plaintext: number; encrypted: number }
  expiredCopies: number
  candidates: BackupExpiryCandidate[]
  candidateCount: number
}

export interface BackupExpiryOptions {
  dir: string
  keepPlaintext?: number
  keepEncrypted?: number
  now?: number
}

export declare const DEFAULT_KEEP_PLAINTEXT: number
export declare const DEFAULT_KEEP_ENCRYPTED: number
export declare function copyKind(name: string): BackupCopyKind | null
export declare function planBackupExpiry(options: BackupExpiryOptions): BackupExpiryPlan

export declare function manifestPath(copyPath: string): string
export declare function sha256File(path: string): Promise<string>
export declare function databaseFacts(path: string): ManifestDatabaseFacts
export declare function writeManifest(copyPath: string): Promise<string>
export declare function readManifest(copyPath: string): BackupManifest | null
