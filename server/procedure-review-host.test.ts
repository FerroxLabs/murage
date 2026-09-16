import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { Store } from "./store.ts";
import { RoutineManager, routineInstructionRevision } from "./routines.ts";
import { createProcedurePin, preparePinnedProcedures } from "./procedure-bundles.ts";
import { taskWorkspacePath } from "./workspace.ts";
import { createProcedureReviewHost } from "./procedure-review-host.ts";
import { applyStagedSkillWrite, stageSkillWrite, skillEvolutionDescriptor, publishEvaluatedScopedSkill, wasEvaluatedScopedSkillPublished, assertSkillProcedureEvidence } from "./skills.ts";
import { captureSource } from "./memory/capture.ts";
import { backgroundMemoryAudience, reconcileMemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { pendingProcedureReviews, processProcedureReview, procedureCandidateHash, procedureSnapshotDigest, procedureTargetDigest, type ProcedureEvaluationReceipt, type ProcedureReviewSnapshot } from "./memory/procedure-review.ts";
import { bindHumanThread, observeVerifiedHuman, linkHumanBinding, resolveHumanBinding } from "./human-principals.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
const markdown = (text: string) => `---\nname: checked-method\ndescription: Check actual results\n---\n${text}\n`;
function receipt(snapshot: ProcedureReviewSnapshot): ProcedureEvaluationReceipt {
  const candidate = snapshot.target.kind === "skill" ? markdown("Verify the output before reporting success.") : "Verify the output before reporting success.";
  return { id: `synthetic:${snapshot.requestId}`, requestId: snapshot.requestId, targetDigest: procedureTargetDigest(snapshot.target), snapshotDigest: procedureSnapshotDigest(snapshot), evidenceDigest: snapshot.evidenceDigest, candidate, candidateHash: procedureCandidateHash(candidate), evaluator: "synthetic-host-check", decision: "accepted", heldout: { corpusDigest: "a".repeat(64), untouched: true, cases: 2, baseline: 0, candidate: 1, regressions: 0 }, budgetRespected: true, cancelled: false };
}
function fixture(evaluate = true) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot(), threadId = bot.threadId;
  reconcileMemoryRoster({ bots: store.bots, groups: store.groups }); setMemoryMode("capture");
  let bridge: ReturnType<typeof createProcedureReviewHost>;
  const manager = new RoutineManager({ file: join(DATA_DIR, "routines.json"), botState: () => "busy", createTask: () => null, startTurn: async () => {},
    validateInstructionPromotion: (routine, proposal) => bridge.validateRoutinePromotion(routine, proposal),
    validateInstructionEvidence: (context, evidence) => bridge.validateRoutineEvidence(context, evidence) });
  const evaluator = vi.fn(async (snapshot: ProcedureReviewSnapshot) => receipt(snapshot));
  bridge = createProcedureReviewHost({ store, routines: () => manager, ...(evaluate ? { evaluate: evaluator } : {}),
    validateEvidence: (audience, evidence) => { try { assertSkillProcedureEvidence({ audienceKey: audience.audienceKey, allowedScopeIds: audience.scopeIds }, evidence); return true; } catch { return false; } }, skills: {
    current: (id, name, context) => skillEvolutionDescriptor(id, name, { audienceKey: context.audienceKey, allowedScopeIds: context.scopeIds }),
    publish: (snapshot, result, context) => publishEvaluatedScopedSkill(snapshot, result, { audienceKey: context.audienceKey, allowedScopeIds: context.scopeIds }),
    wasPublished: (snapshot, result, context) => wasEvaluatedScopedSkillPublished(snapshot, result, { audienceKey: context.audienceKey, allowedScopeIds: context.scopeIds }),
  } });
  return { store, bot, threadId, manager, bridge, evaluator };
}
function context(f: ReturnType<typeof fixture>, threadId = f.threadId) {
  const audience = backgroundMemoryAudience(f.bot.id, threadId, { bots: f.store.bots, groups: f.store.groups })!;
  return { audienceKey: audience.audienceKey, allowedScopeIds: audience.scopeIds };
}
function install(f: ReturnType<typeof fixture>) {
  const stage = stageSkillWrite(f.bot.id, { action: "create", source: "learn:synthetic", files: [{ path: "SKILL.md", content: markdown("Original checked method") }] });
  if ("error" in stage) throw Error(stage.error);
  const applied = applyStagedSkillWrite(f.bot.id, stage.id); if ("error" in applied) throw Error(applied.error);
}
function settle(f: ReturnType<typeof fixture>) {
  transaction(db => {
    captureSource(db, { id: "synthetic-tool", threadId: f.threadId, turnId: "turn", kind: "tool-outcome", speaker: "tool", outcome: "failed", text: "The reported output did not exist." });
    captureSource(db, { id: "synthetic-terminal", threadId: f.threadId, turnId: "turn", kind: "turn", speaker: "harness", outcome: "completed", text: "Turn completed." });
  });
}
async function review(f: ReturnType<typeof fixture>) {
  for (const id of pendingProcedureReviews(4)) await processProcedureReview(id, f.bridge.host, new AbortController().signal);
  const rows = database().prepare("SELECT id FROM memory_scope_bindings WHERE id LIKE 'procedure-review:%'").all();
  for (const row of rows) await processProcedureReview(String(row.id), f.bridge.host, new AbortController().signal);
  return rows;
}
it("runs the actual source queue through the host and scoped skill publisher without changing another person's version", async () => {
  const f = fixture(); install(f);
  const original = skillEvolutionDescriptor(f.bot.id, "checked-method")!;
  const pin = createProcedurePin(f.bot.id, f.threadId, [], [], undefined, context(f)); f.store.pinTaskProcedures(f.bot.id, f.threadId, pin);
  preparePinnedProcedures(f.bot.id, f.threadId, pin, true, context(f));
  settle(f); const rows = await review(f);
  expect(rows).toHaveLength(1); expect(f.evaluator).toHaveBeenCalledOnce();
  expect(skillEvolutionDescriptor(f.bot.id, "checked-method")?.revision).toBe(original.revision);
  expect(skillEvolutionDescriptor(f.bot.id, "checked-method", context(f))?.revision).not.toBe(original.revision);
  const next = f.store.createTask(f.bot.id, "next", false)!;
  const improved = createProcedurePin(f.bot.id, next.threadId, [], [], undefined, context(f, next.threadId));
  expect(preparePinnedProcedures(f.bot.id, next.threadId, improved, false, context(f, next.threadId)).importedPrompt).toContain("checked-method");
  const selectedFile = (thread: string, bundleId: string) => join(taskWorkspacePath(DATA_DIR, f.bot.id, thread), ".murage-procedures", bundleId, "skills", "checked-method", "SKILL.md");
  expect(readFileSync(selectedFile(next.threadId, improved.bundleId), "utf8")).toContain("Verify the output before reporting success.");
  expect(readFileSync(selectedFile(f.threadId, pin.bundleId), "utf8")).toContain("Original checked method");
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "TEAM", userId: "OTHER" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  const other = f.store.createTask(f.bot.id, "other", false)!; bindHumanThread(other.threadId, resolveHumanBinding(binding));
  expect(skillEvolutionDescriptor(f.bot.id, "checked-method", context(f, other.threadId))?.revision).toBe(original.revision);
});
it("publishes a validated routine update through the same host and retains source handles on future runs", async () => {
  const f = fixture();
  const routine = f.manager.create({ name: "Review output", botId: f.bot.id, prompt: "Original routine", target: "bot", enabled: false, runOn: "ember", schedule: { type: "interval", everyMinutes: 5, anchorAt: Date.now() } });
  const pin = createProcedurePin(f.bot.id, f.threadId, [], [], { id: routine.id, instructionRevision: routineInstructionRevision(routine) }, context(f)); f.store.pinTaskProcedures(f.bot.id, f.threadId, pin);
  settle(f); await review(f);
  const promoted = f.manager.listRoutines()[0];
  expect(promoted.prompt).toBe("Verify the output before reporting success.");
  expect(promoted.schedule).toEqual(routine.schedule); expect(promoted.enabled).toBe(false);
  const run = f.manager.runNow(routine.id)!;
  expect(run.instructionEvidence?.map(item => item.id)).toContain("synthetic-tool");
  database().prepare("UPDATE memory_sources SET state='retired' WHERE id='synthetic-tool'").run();
  expect(f.bridge.validateRoutineEvidence(run, run.instructionEvidence!)).toBe(false);
});
it("keeps the real production host pending when no evaluator is configured", async () => {
  const f = fixture(false); install(f);
  f.store.pinTaskProcedures(f.bot.id, f.threadId, createProcedurePin(f.bot.id, f.threadId, [], [], undefined, context(f)));
  settle(f); const rows = await review(f);
  expect(rows).toHaveLength(1); expect(f.evaluator).not.toHaveBeenCalled();
  expect(JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(rows[0].id)!.intent))).toMatchObject({ status: "deferred", reason: "procedure-evaluator-unavailable" });
});
