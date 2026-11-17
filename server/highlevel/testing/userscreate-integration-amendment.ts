// SPDX-License-Identifier: AGPL-3.0-or-later
import amendments from './userscreate-integration-amendment.json' with { type: 'json' };
/** Compose the reviewed users.create completion/company/schema additions with
 * the join tip's F7 approval context and validation wording. Only exact reviewed
 * declarations/hashes normalize; frozen-snapshot independently pins the union. */
export function beforeUsersCreateIntegration(snapshot: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(snapshot);
  for (const amendment of amendments) {
    const value = result[amendment.file];
    result[amendment.file] = Array.isArray(value) ? value.map(item => item === amendment.after ? amendment.before : item)
      : value === amendment.after ? amendment.before : value;
  }
  return result;
}
