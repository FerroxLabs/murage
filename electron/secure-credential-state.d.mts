// SPDX-License-Identifier: AGPL-3.0-or-later
export interface SecureCredentialState {
  read(): Record<string, string>;
  update<T = Record<string, string>>(
    derive: (credentials: Record<string, string>) => Record<string, string> | Promise<Record<string, string>>,
    afterPersist?: (credentials: Record<string, string>) => T | Promise<T>,
    options?: { skipUnchanged?: boolean },
  ): Promise<T | Record<string, string>>;
}
export function createSecureCredentialState(
  initialCredentials: Record<string, string>,
  persist: (credentials: Record<string, string>) => Promise<void>,
  options?: { writable?: boolean },
): SecureCredentialState;
