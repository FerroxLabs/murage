import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const memoryLearningSchema = z.object({
  automaticFacts: z.boolean(), automaticProcedures: z.boolean(), reviewMode: z.boolean(),
  inputLimit: z.number().int().nonnegative().max(10_000_000),
  outputLimit: z.number().int().nonnegative().max(2_000_000),
  callsPerMinute: z.number().int().nonnegative().max(60),
  dailyCostUsd: z.number().finite().nonnegative().max(1000).nullable(),
}).strict();
export const memoryLearningPatchSchema = memoryLearningSchema.partial();
export const DEFAULT_MEMORY_LEARNING = Object.freeze({ automaticFacts: true, automaticProcedures: true, reviewMode: false,
  inputLimit: 100000, outputLimit: 20000, callsPerMinute: 6, dailyCostUsd: null });

export function readMemoryLearning(db: DatabaseSync) {
  const row = db.prepare("SELECT revision,settings FROM memory_learning_config WHERE id=1").get();
  if (!row) throw new Error("MEMORY_LEARNING_CONFIG_MISSING");
  return { revision: Number(row.revision), ...memoryLearningSchema.parse(JSON.parse(String(row.settings))) };
}

/** Caller owns the transaction and owner authorization; version prevents lost updates. */
export function updateMemoryLearning(db: DatabaseSync, patch: unknown, expectedRevision: number | undefined) {
  const input = memoryLearningPatchSchema.parse(patch);
  const current = readMemoryLearning(db), { revision, ...settings } = current;
  if (expectedRevision !== revision) throw Object.assign(new Error("MEMORY_LEARNING_REVISION_CONFLICT"), { status: 409 });
  const next = memoryLearningSchema.parse({ ...settings, ...input });
  const changed = db.prepare("UPDATE memory_learning_config SET revision=revision+1,settings=? WHERE id=1 AND revision=?")
    .run(JSON.stringify(next), revision);
  if (changed.changes !== 1) throw Object.assign(new Error("MEMORY_LEARNING_REVISION_CONFLICT"), { status: 409 });
  return { revision: revision + 1, ...next };
}
