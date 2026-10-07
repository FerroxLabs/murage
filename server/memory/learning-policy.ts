import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export const memoryLearningV1Schema = z.object({
  automaticFacts: z.boolean(), automaticProcedures: z.boolean(), reviewMode: z.boolean(),
  inputLimit: z.number().int().nonnegative().max(10_000_000),
  outputLimit: z.number().int().nonnegative().max(2_000_000),
  callsPerMinute: z.number().int().nonnegative().max(60),
  dailyCostUsd: z.number().finite().nonnegative().max(1000).nullable(),
}).strict();

export const DEFAULT_MEMORY_LEARNING_V1 = Object.freeze({ automaticFacts: true, automaticProcedures: true, reviewMode: false,
  inputLimit: 100000, outputLimit: 20000, callsPerMinute: 6, dailyCostUsd: null });

export const memoryLearningSchema = z.object({
  version:z.literal(2), automaticFacts:z.boolean(), automaticProcedures:z.boolean(), reviewMode:z.boolean(),
  perCallOutputTokens:z.object({extraction:z.number().int().nonnegative().max(2000),grounding:z.number().int().nonnegative().max(64),reflection:z.number().int().nonnegative().max(8000)}).strict(),
  dailyInputTokens:z.number().int().nonnegative().max(10_000_000),dailyOutputTokens:z.number().int().nonnegative().max(2_000_000),
  callsPerMinute:z.number().int().nonnegative().max(60),learnFrom:z.object({chats:z.boolean(),channels:z.boolean()}).strict(),
  botsPaused:z.array(z.string().min(1)).max(1000),
}).strict();
export const memoryLearningPatchSchema=memoryLearningSchema.omit({version:true}).partial();
export const DEFAULT_MEMORY_LEARNING=Object.freeze({version:2 as const,automaticFacts:true,automaticProcedures:true,reviewMode:false,
  perCallOutputTokens:{extraction:2000,grounding:64,reflection:8000},dailyInputTokens:400000,dailyOutputTokens:60000,callsPerMinute:6,
  learnFrom:{chats:true,channels:true},botsPaused:[] as string[]});
export function upgradeMemoryLearning(settings:unknown,revision:number){
  const old=memoryLearningV1Schema.parse(settings);
  return memoryLearningSchema.parse({...DEFAULT_MEMORY_LEARNING,automaticFacts:old.automaticFacts,automaticProcedures:old.automaticProcedures,reviewMode:old.reviewMode,
    ...(revision===0?{}:{callsPerMinute:old.callsPerMinute,dailyInputTokens:Math.ceil(old.inputLimit/3.5),dailyOutputTokens:old.outputLimit})});
}
export function downgradeMemoryLearning(settings:unknown){
 const current=memoryLearningSchema.parse(settings);
 return memoryLearningV1Schema.parse({automaticFacts:current.automaticFacts,automaticProcedures:current.automaticProcedures,reviewMode:current.reviewMode,
  callsPerMinute:current.callsPerMinute,inputLimit:Math.min(10000000,current.dailyInputTokens*4),outputLimit:Math.min(2000000,current.dailyOutputTokens),dailyCostUsd:null});
}

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
