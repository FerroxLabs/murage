// SPDX-License-Identifier: AGPL-3.0-or-later
// Hydration producer owner: c3-memory. Response fence owner: sfx-fixture.
// Memory HTTP composition consumer owner: new3-g2d.
import { attachResultProvenance } from "../consuming-turn-response.ts";
import { memoryRefs } from "./prompt-parts.ts";
type HydratedVersion = { id: string; version: number; evidence: readonly { sourceId?: unknown; revision?: unknown }[] };

/** The actual hydrated versions, including their source revisions, must cross
 * the final response fence. Metadata stays outside the serialized tool body. */
export function memoryReadResponse<T extends object>(body: T, records: readonly HydratedVersion[]): T {
  const refs = records.flatMap(record => memoryRefs([
    { kind: "record", id: record.id, version: record.version },
    ...record.evidence.map(source => {
      if (typeof source.sourceId !== "string" || !source.sourceId || typeof source.revision !== "number"
        || !Number.isSafeInteger(source.revision) || source.revision < 1) throw new Error("MEMORY_READ_PROVENANCE_UNAVAILABLE");
      return { kind: "source" as const, id: source.sourceId, version: source.revision };
    }),
  ]));
  attachResultProvenance(body, { refs });
  return body;
}
