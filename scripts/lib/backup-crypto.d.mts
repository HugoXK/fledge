// Types for the backup encryption helpers, so the TypeScript suite can call the
// real implementation instead of re-deriving its rules.
export interface RawBackupKey {
  kind: 'raw'
  key: Buffer
  id: string
  /** Where the value came from; diagnostic only, never used to derive the key. */
  source?: string
}

export interface PassphraseBackupKey {
  kind: 'passphrase'
  secret: string
  /** Where the value came from; diagnostic only, never used to derive the key. */
  source?: string
}

export type BackupKeyInfo = RawBackupKey | PassphraseBackupKey

export interface BackupKeyOptions {
  /** Refuse a base64-shaped value that decodes to 16–31 bytes. Write paths keep this on. */
  rejectTruncatedBase64Key?: boolean
}

export interface BackupEncryptionMetadata {
  format: string
  version: number
  algorithm: string
  kdf?: 'raw' | 'scrypt'
  keyId: string
  keyVersion: number
}

export declare class BackupKeyError extends Error {}

export declare function loadBackupKey(env?: Record<string, string | undefined>, options?: BackupKeyOptions): BackupKeyInfo | null
export declare function encryptBackupFile(plaintextPath: string, targetPath: string, keyInfo: BackupKeyInfo | null): Promise<BackupEncryptionMetadata>
export declare function decryptBackupFile(path: string, targetPath: string, keyInfo: BackupKeyInfo | null): Promise<BackupEncryptionMetadata>
