import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { CALL_OVERHEAD_ALLOWANCE, DEFAULT_LEARNING_CEILING, learningSpendLedgerId } from "../../shared/memory-learning-contract.ts";

export const memoryLearningV1Schema = z.object({
  automaticFacts: z.boolean(), automaticProcedures: z.boolean(), reviewMode: z.boolean(),
  inputLimit: z.number().int().nonnegative().max(10_000_000),
  outputLimit: z.number().int().nonnegative().max(2_000_000),
  callsPerMinute: z.number().int().nonnegative().max(60),
  dailyCostUsd: z.number().finite().nonnegative().max(1000).nullable(),
}).strict();

export const DEFAULT_MEMORY_LEARNING_V1 = Object.freeze({ automaticFacts: true, automaticProcedures: true, reviewMode: false,
  inputLimit: 100000, outputLimit: 20000, callsPerMinute: 6, dailyCostUsd: null });

/** The frozen v2 shape (1.0.0 to 1.0.2): memory schema 4 to 10 store it; the v1 -> v2 -> v3 chain and the 11 -> 10 downgrade read it. */
export const memoryLearningV2Schema = z.object({
  version:z.literal(2), automaticFacts:z.boolean(), automaticProcedures:z.boolean(), reviewMode:z.boolean(),
  perCallOutputTokens:z.object({extraction:z.number().int().nonnegative().max(2000),grounding:z.number().int().nonnegative().max(64),reflection:z.number().int().nonnegative().max(8000)}).strict(),
  dailyInputTokens:z.number().int().nonnegative().max(10_000_000),dailyOutputTokens:z.number().int().nonnegative().max(2_000_000),
  callsPerMinute:z.number().int().nonnegative().max(60),learnFrom:z.object({chats:z.boolean(),channels:z.boolean()}).strict(),
  botsPaused:z.array(z.string().min(1)).max(1000),
}).strict();
export const DEFAULT_MEMORY_LEARNING_V2=Object.freeze({version:2 as const,automaticFacts:true,automaticProcedures:true,reviewMode:false,
  perCallOutputTokens:{extraction:2000,grounding:64,reflection:8000},dailyInputTokens:400000,dailyOutputTokens:60000,callsPerMinute:6,
  learnFrom:{chats:true,channels:true},botsPaused:[] as string[]});
/** v1 -> v2 (memory schema 4). */
export function upgradeMemoryLearning(settings:unknown,revision:number){
  const old=memoryLearningV1Schema.parse(settings);
  return memoryLearningV2Schema.parse({...DEFAULT_MEMORY_LEARNING_V2,automaticFacts:old.automaticFacts,automaticProcedures:old.automaticProcedures,reviewMode:old.reviewMode,
    ...(revision===0?{}:{callsPerMinute:old.callsPerMinute,dailyInputTokens:Math.ceil(old.inputLimit/3.5),dailyOutputTokens:old.outputLimit})});
}
export function downgradeMemoryLearning(settings:unknown){
 const current=memoryLearningV2Schema.parse(settings);
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

// ---------------------------------------------------------------------------
// 1.0.3 (SETTINGS-LANES.md I0, switched on by L3): learning settings v3, the
// monthly ceiling, and their conversions. Memory schema 11 stores v3; the v2
// names above stay frozen for the v1 -> v2 -> v3 chain and the 11 -> 10 downgrade.

export const learningCeilingSchema = z.object({
  input: z.number().int().nonnegative().max(1_000_000_000_000),
  output: z.number().int().nonnegative().max(1_000_000_000_000),
}).strict();

/** v3: the two daily caps become one monthly ceiling; everything else is v2 verbatim. */
export const memoryLearningV3Schema = z.object({
  version: z.literal(3), automaticFacts: z.boolean(), automaticProcedures: z.boolean(), reviewMode: z.boolean(),
  perCallOutputTokens: z.object({ extraction: z.number().int().nonnegative().max(2000), grounding: z.number().int().nonnegative().max(64), reflection: z.number().int().nonnegative().max(8000) }).strict(),
  ceiling: learningCeilingSchema,
  callsPerMinute: z.number().int().nonnegative().max(60), learnFrom: z.object({ chats: z.boolean(), channels: z.boolean() }).strict(),
  botsPaused: z.array(z.string().min(1)).max(1000),
}).strict();
export type MemoryLearningV3 = z.infer<typeof memoryLearningV3Schema>;
export const memoryLearningV3PatchSchema = memoryLearningV3Schema.omit({ version: true }).partial();
export const DEFAULT_MEMORY_LEARNING_V3: Readonly<MemoryLearningV3> = Object.freeze({
  version: 3 as const, automaticFacts: true, automaticProcedures: true, reviewMode: false,
  perCallOutputTokens: { extraction: 2000, grounding: 64, reflection: 8000 },
  ceiling: { ...DEFAULT_LEARNING_CEILING }, callsPerMinute: 6, learnFrom: { chats: true, channels: true }, botsPaused: [] as string[],
});

/** The current shape (memory schema 11): what readMemoryLearning returns and the configure patch accepts. */
export const memoryLearningSchema = memoryLearningV3Schema;
export const memoryLearningPatchSchema = memoryLearningV3PatchSchema;
export const DEFAULT_MEMORY_LEARNING = DEFAULT_MEMORY_LEARNING_V3;

/** v2 -> v3 (r3.3): a zero daily cap on either side stays disabled as a zero ceiling; any other caps take the default ceiling.
 *  reviewMode, automaticFacts, automaticProcedures, learnFrom, botsPaused, callsPerMinute and perCallOutputTokens are copied. */
export function upgradeMemoryLearningV3(settings: unknown): MemoryLearningV3 {
  const old = memoryLearningV2Schema.parse(settings);
  const off = old.dailyInputTokens === 0 || old.dailyOutputTokens === 0;
  return memoryLearningV3Schema.parse({
    version: 3, automaticFacts: old.automaticFacts, automaticProcedures: old.automaticProcedures, reviewMode: old.reviewMode,
    perCallOutputTokens: { ...old.perCallOutputTokens }, ceiling: off ? { input: 0, output: 0 } : { ...DEFAULT_LEARNING_CEILING },
    callsPerMinute: old.callsPerMinute, learnFrom: { ...old.learnFrom }, botsPaused: [...old.botsPaused],
  });
}

/** v3 -> v2 (the 11 -> 10 downgrade): a zero ceiling on either side becomes zero daily caps; any other ceiling the v2 default caps. */
export function downgradeMemoryLearningV3(settings: unknown) {
  const current = memoryLearningV3Schema.parse(settings);
  const off = current.ceiling.input === 0 || current.ceiling.output === 0;
  return memoryLearningV2Schema.parse({
    version: 2, automaticFacts: current.automaticFacts, automaticProcedures: current.automaticProcedures, reviewMode: current.reviewMode,
    perCallOutputTokens: { ...current.perCallOutputTokens },
    dailyInputTokens: off ? 0 : DEFAULT_MEMORY_LEARNING_V2.dailyInputTokens, dailyOutputTokens: off ? 0 : DEFAULT_MEMORY_LEARNING_V2.dailyOutputTokens,
    callsPerMinute: current.callsPerMinute, learnFrom: { ...current.learnFrom }, botsPaused: [...current.botsPaused],
  });
}

/** Any stored learning settings (v1 without a version field, v2, v3) to v3, chained (v1 -> v2 -> v3). */
export function toMemoryLearningV3(settings: unknown, revision: number): MemoryLearningV3 {
  const version = (settings as { version?: unknown } | null)?.version;
  if (version === 3) return memoryLearningV3Schema.parse(settings);
  if (version === 2) return upgradeMemoryLearningV3(settings);
  return upgradeMemoryLearningV3(upgradeMemoryLearning(settings, revision));
}

/** Input reservation for one call (r4.1): one token per serialised byte plus the provider allowance. Replaces bytes/3.5. */
export function learningInputReserve(messages: ReadonlyArray<Readonly<{ role: string; content: string }>>): number {
  return Buffer.byteLength(JSON.stringify(messages)) + CALL_OVERHEAD_ALLOWANCE;
}

const UTC_DAY = /^extract-budget:(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DAY = /^continuity-budget:.+:(\d{4})-(\d{2})-(\d{2})$/;
/** True when a day ledger row belongs to `month` (server-local "YYYY-MM") for the seed (r4.2):
 *  an `extract-budget:<UTC day>` row whose [D 00:00Z, D+1 00:00Z) overlaps the local month, charged whole;
 *  a `continuity-budget:<bot>:<local day>` row whose day is in the local month. Over-counts by at most one UTC day per edge, never under. */
export function seedRowInMonth(id: string, month: string): boolean {
  const [year, mon] = month.split("-").map(Number);
  const local = LOCAL_DAY.exec(id);
  if (local) return Number(local[1]) === year && Number(local[2]) === mon;
  const utc = UTC_DAY.exec(id);
  if (!utc) return false;
  const start = Date.UTC(Number(utc[1]), Number(utc[2]) - 1, Number(utc[3])), end = start + 86_400_000;
  const monthStart = new Date(year!, mon! - 1, 1).getTime(), monthEnd = new Date(year!, mon!, 1).getTime();
  return start < monthEnd && end > monthStart;
}

/** Sum of the day ledgers that belong to `month`. Bounded by the number of day rows (one per UTC day plus one per bot per local day). */
export function learningSpendSeed(db: DatabaseSync, month: string): { input: number; output: number } {
  let input = 0, output = 0;
  for (const row of db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_id IN ('extract-budget','continuity-budget')").all()) {
    if (!seedRowInMonth(String(row.id), month)) continue;
    const budget = JSON.parse(String(row.intent)) as { input?: unknown; output?: unknown };
    if (typeof budget.input === "number" && Number.isFinite(budget.input)) input += Math.max(0, budget.input);
    if (typeof budget.output === "number" && Number.isFinite(budget.output)) output += Math.max(0, budget.output);
  }
  return { input, output };
}

/** Writes `learning-spend:<month>` from the day ledgers when it is absent (the schema step `from < 11`). No day rows: nothing is written, and an absent row reads as 0. */
export function seedLearningSpend(db: DatabaseSync, month: string, scopeId: string): boolean {
  const id = learningSpendLedgerId(month);
  if (db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id=?").get(id)) return false;
  const seed = learningSpendSeed(db, month);
  if (seed.input === 0 && seed.output === 0) return false;
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','learning-spend',0,'granted',?)").run(id, scopeId, JSON.stringify(seed));
  return true;
}

/** The request shapes L3 adds to memoryStatusRequestSchema (settings.ts): `configure` gains `ceiling: learningCeilingSchema.optional()`,
 *  and this one joins the union. Types: shared/memory-learning-contract.ts. */
export const retrySkippedRequestSchema = z.object({
  action: z.literal("retry-skipped"), sourceId: z.string().min(1).max(512), cursor: z.number().int().nonnegative(),
}).strict();
