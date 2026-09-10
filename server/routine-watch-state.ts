import { z } from "zod";
import type { RoutineWatchDefinition, RoutineWatchObservation, RoutineWatchState } from "../shared/routine-watch.ts";

const identity = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const definitionSchema = z.object({
  id: identity,
  source: z.object({ adapterId: identity, sourceId: identity, scopeId: identity }).strict(),
  expiresAt: instant,
  maxChecks: z.number().int().min(1).max(10_000),
}).strict();
const checkSchema = z.union([
  z.object({ id: identity, outcome: z.enum(["pending", "failed", "abandoned"]) }).strict(),
  z.object({ id: identity, outcome: z.enum(["baseline", "unchanged", "changed"]), fingerprint }).strict(),
]);
const stateSchema = z.object({
  version: z.literal(1), definition: definitionSchema, paused: z.boolean(), updatedAt: instant,
  checkpoint: fingerprint.optional(), checks: z.array(checkSchema).max(10_000),
}).strict().superRefine((state, ctx) => {
  let checkpoint: string | undefined;
  const ids = new Set<string>();
  let invalid = state.checks.length > state.definition.maxChecks;
  state.checks.forEach((check, index) => {
    if (ids.has(check.id)) invalid = true;
    ids.add(check.id);
    if (check.outcome === "pending" && (index !== state.checks.length - 1 || state.paused)) invalid = true;
    if ("fingerprint" in check) {
      const expected = checkpoint === undefined ? "baseline" : checkpoint === check.fingerprint ? "unchanged" : "changed";
      if (check.outcome !== expected) invalid = true;
      checkpoint = check.fingerprint;
    }
  });
  if (checkpoint !== state.checkpoint) invalid = true;
  if (invalid) ctx.addIssue({ code: "custom", message: "Invalid watch checkpoint or admission ledger" });
});

/** Validates and clones serialized state; malformed records cannot become work. */
export function readRoutineWatchState(value: unknown): RoutineWatchState {
  return stateSchema.parse(value);
}

function at(value: unknown, now: number): RoutineWatchState {
  const state = readRoutineWatchState(value);
  instant.parse(now);
  if (now < state.updatedAt) throw new Error("Watch clock moved backwards");
  return state;
}

export function createRoutineWatchState(definition: RoutineWatchDefinition, now: number): RoutineWatchState {
  const parsed = definitionSchema.parse(definition);
  instant.parse(now);
  if (parsed.expiresAt <= now) throw new Error("Watch must expire in the future");
  return { version: 1, definition: parsed, paused: false, updatedAt: now, checks: [] };
}

export type WatchAdmission = {
  state: RoutineWatchState;
  outcome: "admitted" | "duplicate" | "busy" | "paused" | "expired" | "limit-reached";
};

/** Pure reservation only. Persist returned state before any source read. */
export function reserveRoutineWatchCheck(value: unknown, checkId: string, now: number): WatchAdmission {
  const state = at(value, now);
  identity.parse(checkId);
  if (state.checks.some(check => check.id === checkId)) return { state, outcome: "duplicate" };
  if (now >= state.definition.expiresAt) return { state, outcome: "expired" };
  if (state.paused) return { state, outcome: "paused" };
  if (state.checks.some(check => check.outcome === "pending")) return { state, outcome: "busy" };
  if (state.checks.length >= state.definition.maxChecks) return { state, outcome: "limit-reached" };
  state.checks.push({ id: checkId, outcome: "pending" });
  state.updatedAt = now;
  return { state, outcome: "admitted" };
}

export type WatchCompletion = {
  state: RoutineWatchState;
  outcome: "baseline" | "unchanged" | "changed" | "failed" | "abandoned" | "stale";
};

/** Null means a failed read: it consumes admission but never erases baseline.
 * A changed outcome is eligible for later publication only after durable save.
 * Replayed or late completions have no publication outcome. */
export function completeRoutineWatchCheck(
  value: unknown, checkId: string, observation: RoutineWatchObservation | null, now: number,
): WatchCompletion {
  const state = at(value, now);
  identity.parse(checkId);
  const index = state.checks.findIndex(check => check.id === checkId && check.outcome === "pending");
  if (index < 0) return { state, outcome: "stale" };
  let outcome: Exclude<WatchCompletion["outcome"], "stale">;
  if (state.paused || now >= state.definition.expiresAt) {
    outcome = "abandoned";
    state.checks[index] = { id: checkId, outcome };
  } else if (observation === null) {
    outcome = "failed";
    state.checks[index] = { id: checkId, outcome };
  } else {
    const parsed = z.object({ fingerprint }).strict().parse(observation);
    outcome = state.checkpoint === undefined ? "baseline" : state.checkpoint === parsed.fingerprint ? "unchanged" : "changed";
    state.checkpoint = parsed.fingerprint;
    state.checks[index] = { id: checkId, outcome, fingerprint: parsed.fingerprint };
  }
  state.updatedAt = now;
  return { state, outcome };
}

/** Pause fences a pending result immediately; resume cannot revive it. The
 * caller must also cancel its read. A restart can explicitly abandon a stranded
 * reservation through this transition, then resume without resetting usage. */
export function pauseRoutineWatch(value: unknown, paused: boolean, now: number): RoutineWatchState {
  const state = at(value, now);
  z.boolean().parse(paused);
  state.paused = paused;
  if (paused) state.checks = state.checks.map(check => check.outcome === "pending" ? { id: check.id, outcome: "abandoned" } : check);
  state.updatedAt = now;
  return state;
}
