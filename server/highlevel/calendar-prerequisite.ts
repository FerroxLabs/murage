// SPDX-License-Identifier: AGPL-3.0-or-later
import type { z } from "zod";
import { HIGHLEVEL_OPERATION_MANIFEST } from './operations/manifest.ts';
import { HIGHLEVEL_ENDPOINTS } from './provider-contract.ts';
import type { ReadSpec } from './operations/registry.ts';
/** Calendar ownership needs the qualified location-scoped user collection even
 * before the independently built users family is advertised. This spec is only
 * usable through a caller's declared preflight list, never a callable tool. */
export function calendarUserPrerequisite(): ReadSpec {
 const row = HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === 'users.list')!;
 return { id: row.id, family: row.family, row, endpoint: HIGHLEVEL_ENDPOINTS[row.id]!, args: row.argsSchema as z.ZodType<Record<string, unknown>>,
  title: '', risk: 'R', maxReads: 1, nested: false, preflight: row.preflight,
  recordRefs: () => [], fields: () => [], targets: () => 1, project: value => value,
  prepareRead: async () => { throw new Error('Preflight-only read'); } };
}
