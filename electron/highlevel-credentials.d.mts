// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HighLevelCredentialBootstrap, HighLevelCredentialIntent, HighLevelSecretBank } from '../server/highlevel/credential-commit.ts';
export function validHighLevelBank(value: unknown): value is HighLevelSecretBank;
export function validHighLevelIntent(value: unknown): value is HighLevelCredentialIntent;
export function createHighLevelCredentialBridge(options: {
  commitCredential: string;
  readDocument(): Record<string, unknown>;
  updateDocument(derive: (document: Record<string, unknown>) => Record<string, unknown>): Promise<void>;
  assertSafeStorage(): Promise<void>;
  request(action: 'prepare' | 'commit', body: unknown, credential: string): Promise<unknown>;
}): {
  bootstrap(): Promise<HighLevelCredentialBootstrap>;
  commit(input: unknown): Promise<{ ok: true } | { ok: false; error: string }>;
};
export function assertHighLevelSafeStorage(options: {
  safeStorage: { getSelectedStorageBackend?(): string | undefined; isAsyncEncryptionAvailable(): boolean | Promise<boolean> };
  storeUnavailable?: boolean;
  platform?: NodeJS.Platform;
}): Promise<void>;
