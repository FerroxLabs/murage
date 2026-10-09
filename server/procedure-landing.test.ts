import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { Store } from "./store.ts";
import { RoutineManager, routineInstructionRevision } from "./routines.ts";
import { createProcedurePin, preparePinnedProcedures } from "./procedure-bundles.ts";
import { createProcedureReviewHost } from "./procedure-review-host.ts";
import { applyStagedSkillWrite, stageSkillWrite, skillEvolutionDescriptor, publishEvaluatedScopedSkill, wasEvaluatedScopedSkillPublished, assertSkillProcedureEvidence } from "./skills.ts";
import { captureSource } from "./memory/capture.ts";
import { backgroundMemoryAudience, reconcileMemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { pendingProcedureReviews, processProcedureReview, procedureCandidateHash, procedureSnapshotDigest, procedureTargetDigest, type ProcedureEvaluationReceipt, type ProcedureReviewSnapshot } from "./memory/procedure-review.ts";
import { insertMessage } from "./message-db.ts";
import { changeLearningEvent } from "./memory/learning-history.ts";
import { DEFAULT_BOT_LEARNING } from "./bot-learning.ts";
import { applyProcedureSuggestion, editProcedureSuggestion, landingReasons, listProcedureSuggestions, notNowProcedureSuggestion, improvedMomentForEvent, procedureChipItemsForThread, procedureEvidenceProspectDerived, procedureHardCheck, setImprovedListener } from "./memory/procedure-landing.ts";

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

const replyId = (f: ReturnType<typeof fixture>) => String(database().prepare("SELECT id FROM messages WHERE thread_id=? AND role='bot'").get(f.threadId)!.id);
const reply = (f: ReturnType<typeof fixture>) => insertMessage(f.threadId, { id: "b1", at: 1_000, role: "bot", kind: "text", text: "Here is the weekly summary.", parentId: null, turnId: "t1", turnTerminal: true } as never);
const askFirst = (f: ReturnType<typeof fixture>) => f.store.patchBot(f.bot.id, { learning: { ...DEFAULT_BOT_LEARNING, askFirst: true, revision: 1 } } as never);
const events = (kind: string) => database().prepare("SELECT * FROM memory_learning_events WHERE kind=?").all(kind);
const undo = (id: string) => transaction(db => changeLearningEvent(db, id, "undo"));
function pinSkill(f: ReturnType<typeof fixture>) {
  install(f);
  const pin = createProcedurePin(f.bot.id, f.threadId, [], [], undefined, context(f)); f.store.pinTaskProcedures(f.bot.id, f.threadId, pin);
  preparePinnedProcedures(f.bot.id, f.threadId, pin, true, context(f));
}
function pinRoutine(f: ReturnType<typeof fixture>, prompt: string, permissionMode: "ask" | "auto" = "ask") {
  const routine = f.manager.create({ name: "Weekly job", botId: f.bot.id, prompt, target: "bot", enabled: false, runOn: "ember", permissionMode, schedule: { type: "interval", everyMinutes: 5, anchorAt: Date.now() } });
  const pin = createProcedurePin(f.bot.id, f.threadId, [], [], { id: routine.id, instructionRevision: routineInstructionRevision(routine) }, context(f)); f.store.pinTaskProcedures(f.bot.id, f.threadId, pin);
  return routine;
}
const promptOf = (f: ReturnType<typeof fixture>) => f.manager.listRoutines()[0].prompt;
const sha = (text: string) => procedureCandidateHash(text);

it("an automatic skill change leaves a notice chip and Undo restores the exact prior text", async () => {
  const f = fixture(); pinSkill(f); reply(f);
  const original = skillEvolutionDescriptor(f.bot.id, "checked-method")!;
  expect(original.sha256).toBe(sha(markdown("Original checked method")));
  settle(f); await review(f);
  const changed = skillEvolutionDescriptor(f.bot.id, "checked-method", context(f))!;
  expect(changed.sha256).toBe(sha(markdown("Verify the output before reporting success.")));
  expect(events("guide-applied")).toHaveLength(1);
  const [chip] = procedureChipItemsForThread(database(), { botId: f.bot.id, threadId: f.threadId });
  expect(chip).toMatchObject({ kind: "improved", group: "improved", text: "checked-method", state: "active", replyMessageId: replyId(f), procedureKind: "skill", actions: { undo: true } });
  expect(undo(chip.eventId)).toMatchObject({ ok: true, undone: true });
  expect(skillEvolutionDescriptor(f.bot.id, "checked-method", context(f))!.sha256).toBe(original.sha256);
  expect(procedureChipItemsForThread(database(), { botId: f.bot.id, threadId: f.threadId })[0]).toMatchObject({ state: "undone" });
  expect(undo(chip.eventId)).toMatchObject({ ok: true, undone: true });
  expect(events("guide-undone")).toHaveLength(1);
});

it("an automatic change is announced once, after it commits, with the chip's words", async () => {
  const f = fixture(); pinSkill(f); reply(f);
  const heard: string[] = [];
  setImprovedListener(id => heard.push(id));
  try {
    settle(f); await review(f);
    await new Promise(resolve => setTimeout(resolve, 20));
    const [chip] = procedureChipItemsForThread(database(), { botId: f.bot.id, threadId: f.threadId });
    expect(heard).toEqual([chip.eventId]);
    expect(improvedMomentForEvent(database(), chip.eventId)).toEqual({ eventId: chip.eventId, botId: f.bot.id, threadId: f.threadId, replyMessageId: replyId(f), template: chip.template, text: "checked-method", procedureKind: "skill" });
    undo(chip.eventId);
    expect(improvedMomentForEvent(database(), chip.eventId)).toBeNull();
  } finally { setImprovedListener(null); }
});

it("a routine that is not structurally contained never changes on its own, and Apply then Undo restores the exact prompt", async () => {
  const f = fixture(); const original = "Send the weekly summary email to every customer.";
  pinRoutine(f, original, "auto"); settle(f); await review(f);
  expect(f.evaluator).toHaveBeenCalledOnce();
  expect(promptOf(f)).toBe(original);
  expect(events("guide-applied")).toHaveLength(0);
  const [s] = listProcedureSuggestions(database(), f.bot.id);
  expect(s).toMatchObject({ kind: "procedure", targetKind: "routine", label: "Weekly job", reasons: ["outbound"], edited: false, text: "Verify the output before reporting success." });
  expect(s.scores).toMatchObject({ baseline: 0, candidate: 1, cases: 2 });
  const applied = transaction(db => applyProcedureSuggestion(db, { botId: f.bot.id, id: s.id, expectedVersion: s.version, proposedHash: s.proposedHash }));
  expect(applied.id).toBe(s.id);
  expect(promptOf(f)).toBe("Verify the output before reporting success.");
  expect(listProcedureSuggestions(database(), f.bot.id)).toHaveLength(0);
  const [event] = events("guide-applied"); expect(JSON.parse(String(event.detail))).toMatchObject({ via: "suggestion", kind: "routine" });
  undo(String(event.id));
  expect(promptOf(f)).toBe(original);
});

it("a contained routine (asks first, owner only) lands on its own whatever its words say, with a notice and Undo", async () => {
  const f = fixture(); const original = "Summarize my notes each morning for me.";
  pinRoutine(f, original); reply(f); settle(f); await review(f);
  expect(promptOf(f)).toBe("Verify the output before reporting success.");
  const [chip] = procedureChipItemsForThread(database(), { botId: f.bot.id, threadId: f.threadId });
  expect(chip).toMatchObject({ kind: "improved", text: "Weekly job", procedureKind: "routine" });
  undo(chip.eventId);
  expect(promptOf(f)).toBe(original);
});

it("Ask me first routes everything to suggestions, and Apply lands exactly what was shown", async () => {
  const f = fixture(); pinSkill(f); askFirst(f);
  const original = skillEvolutionDescriptor(f.bot.id, "checked-method")!;
  settle(f); await review(f);
  expect(skillEvolutionDescriptor(f.bot.id, "checked-method", context(f))!.revision).toBe(original.revision);
  expect(events("guide-applied")).toHaveLength(0); expect(events("guide-suggested")).toHaveLength(1);
  const [s] = listProcedureSuggestions(database(), f.bot.id);
  expect(s.reasons).toEqual(["ask-first"]);
  transaction(db => applyProcedureSuggestion(db, { botId: f.bot.id, id: s.id, expectedVersion: s.version, proposedHash: s.proposedHash }));
  expect(skillEvolutionDescriptor(f.bot.id, "checked-method", context(f))!.sha256).toBe(sha(markdown("Verify the output before reporting success.")));
  expect(events("guide-applied")).toHaveLength(1);
});

it("compare-and-set refuses a stale Apply", async () => {
  const f = fixture(); const original = "Send the weekly summary email to every customer.";
  pinRoutine(f, original, "auto"); settle(f); await review(f);
  const [s] = listProcedureSuggestions(database(), f.bot.id);
  // The words changed under the card (an Edit), so the version the owner was shown is stale.
  const edited = transaction(db => editProcedureSuggestion(db, { botId: f.bot.id, id: s.id, expectedVersion: s.version, text: "Verify every reply and keep it short." }));
  expect(edited).toMatchObject({ edited: true, scores: null, version: s.version + 1 });
  expect(() => transaction(db => applyProcedureSuggestion(db, { botId: f.bot.id, id: s.id, expectedVersion: s.version }))).toThrow(/changed elsewhere/);
  expect(() => transaction(db => applyProcedureSuggestion(db, { botId: f.bot.id, id: s.id, expectedVersion: edited.version, proposedHash: s.proposedHash }))).toThrow(/changed elsewhere/);
  // The routine changed under the card: nothing is applied and the card is gone.
  f.manager.update(f.manager.listRoutines()[0].id, { prompt: "Send nothing; draft the summary for me only." });
  expect(() => transaction(db => applyProcedureSuggestion(db, { botId: f.bot.id, id: s.id, expectedVersion: edited.version, proposedHash: edited.proposedHash }))).toThrow(/changed since it was suggested/);
  expect(promptOf(f)).toBe("Send nothing; draft the summary for me only.");
  expect(listProcedureSuggestions(database(), f.bot.id)).toHaveLength(0);
});

it("an edited suggestion is published as the owner's own words", async () => {
  const f = fixture(); pinRoutine(f, "Send the weekly summary email to every customer.", "auto"); settle(f); await review(f);
  const [s] = listProcedureSuggestions(database(), f.bot.id);
  const edited = transaction(db => editProcedureSuggestion(db, { botId: f.bot.id, id: s.id, expectedVersion: s.version, text: "Verify every reply and keep it short." }));
  transaction(db => applyProcedureSuggestion(db, { botId: f.bot.id, id: s.id, expectedVersion: edited.version }));
  expect(promptOf(f)).toBe("Verify every reply and keep it short.");
  expect(JSON.parse(String(events("guide-applied")[0].detail))).toMatchObject({ via: "edit" });
});

it("the first Not now only puts the suggestion away; the second records negative feedback", async () => {
  const f = fixture(); pinSkill(f); askFirst(f); settle(f); await review(f);
  const [s] = listProcedureSuggestions(database(), f.bot.id);
  const feedback = () => database().prepare("SELECT * FROM memory_feedback WHERE polarity='-' AND target_action LIKE 'procedure-suggestion:%'").all();
  expect(transaction(db => notNowProcedureSuggestion(db, { botId: f.bot.id, id: s.id, expectedVersion: s.version }))).toMatchObject({ negativeFeedback: false });
  expect(listProcedureSuggestions(database(), f.bot.id)).toHaveLength(0); expect(feedback()).toHaveLength(0);
  // The same change comes back with the same words; the owner says Not now again.
  const row = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(s.id)!.intent));
  database().prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify({ ...row, state: "suggested", version: row.version + 1 }), s.id);
  const [again] = listProcedureSuggestions(database(), f.bot.id);
  expect(transaction(db => notNowProcedureSuggestion(db, { botId: f.bot.id, id: again.id, expectedVersion: again.version }))).toMatchObject({ negativeFeedback: true });
  expect(feedback()).toHaveLength(1);
  expect(listProcedureSuggestions(database(), f.bot.id)).toHaveLength(0);
});

it("the hard check is structural: skill front matter must not change, empty is refused, added lines are not read for intent", () => {
  const skill = "---\nname: x\ndescription: Check things\n---\nVerify the output.\n";
  expect(procedureHardCheck(skill, skill.replace("Verify the output.", "Verify the output twice."))).toEqual({ ok: true });
  expect(procedureHardCheck(skill, skill.replace("Check things", "Check things carefully"))).toEqual({ ok: true });
  expect(procedureHardCheck(skill, skill.replace("description:", "allowed-tools: Bash\ndescription:"))).toEqual({ ok: false, reason: "frontmatter-changed" });
  expect(procedureHardCheck("Report to me.", "  ")).toEqual({ ok: false, reason: "empty" });
  // the words of an added line decide nothing; what can run it, and under what approval, does
  for (const added of ["Run this every day on a schedule.", "Send it without asking me.", "Execute gmail_send_email with the completed report.", "Order the items from the vendor."]) expect(procedureHardCheck(skill, `${skill}${added}\n`), added).toEqual({ ok: true });
});

it("anything from customer messages, a routine or skill that is not contained, or Ask me first is a suggestion", () => {
  expect(landingReasons({ askFirst: false, outbound: false, prospectDerived: false })).toEqual([]);
  expect(landingReasons({ askFirst: true, outbound: true, prospectDerived: true })).toEqual(["ask-first", "outbound", "prospect-derived"]);
  const evidence = (speaker: string, text = "hello") => ({ kind: "source", id: "nope", revision: 1, scopeId: "s", text, speaker, outcome: "completed" });
  const snapshot = (items: unknown[]) => ({ evidence: items }) as never;
  expect(procedureEvidenceProspectDerived(database(), snapshot([evidence("owner")]))).toBe(false);
  expect(procedureEvidenceProspectDerived(database(), snapshot([evidence("person:abc")]))).toBe(true);
  expect(procedureEvidenceProspectDerived(database(), snapshot([evidence("owner", "> Hi, can I get a quote?\n\nWhat should I say?")]))).toBe(true);
});

it("scenario 9, removal: dropping a guard line is not read for intent; a contained routine lands it, an uncontained one waits, and Undo restores the exact prompt", async () => {
  const original = "Summarize my notes each morning for me.\nNever send anything without my approval.";
  const contained = fixture();
  pinRoutine(contained, original); reply(contained); settle(contained); await review(contained);
  expect(promptOf(contained)).toBe("Verify the output before reporting success.");
  undo(String(events("guide-applied")[0]!.id));
  expect(promptOf(contained)).toBe(original);
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  const f = fixture();
  pinRoutine(f, original, "auto"); reply(f); settle(f); await review(f);
  expect(promptOf(f)).toBe(original);
  expect(events("guide-applied")).toHaveLength(0);
  const [s] = listProcedureSuggestions(database(), f.bot.id);
  expect(s.reasons).toEqual(["outbound"]);
  transaction(db => applyProcedureSuggestion(db, { botId: f.bot.id, id: s.id, expectedVersion: s.version, proposedHash: s.proposedHash }));
  expect(promptOf(f)).toBe("Verify the output before reporting success.");
  undo(String(events("guide-applied")[0]!.id));
  expect(promptOf(f)).toBe(original);
});

it("D4: a skill change is text-blind; it lands on its own only when every context that can run it is structurally contained", async () => {
  const words = ["Read the report.", "Send the completed report to the client.", "Execute gmail_send_email with the completed report.", "Order the items from the vendor.", "Use CUSTOMER_NAME as a placeholder.", "Pay the invoice once checked."];
  const outcomes: Array<{ text: string; contained: boolean; applied: number; reasons: string[] }> = [];
  for (const contained of [true, false]) for (const text of words) {
    closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
    const f = fixture(); pinSkill(f); reply(f);
    if (!contained) f.store.patchBot(f.bot.id, { autoApprove: true } as never);
    f.evaluator.mockImplementation(async (snapshot: ProcedureReviewSnapshot) => { const candidate = markdown(text); return { ...receipt(snapshot), candidate, candidateHash: procedureCandidateHash(candidate) }; });
    settle(f); await review(f);
    outcomes.push({ text, contained, applied: events("guide-applied").length, reasons: listProcedureSuggestions(database(), f.bot.id)[0]?.reasons ?? [] });
  }
  // the same matrix row for every text: benign or "dangerous" lands the same way
  expect(outcomes.filter(o => o.contained).map(o => [o.applied, o.reasons])).toEqual(words.map(() => [1, []]));
  expect(outcomes.filter(o => !o.contained).map(o => [o.applied, o.reasons])).toEqual(words.map(() => [0, ["outbound"]]));
});

it("D4: a routine of the bot at Auto or Unlimited keeps a skill change waiting (review AL-01)", async () => {
  for (const mode of ["auto", "unlimited"] as const) {
    closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
    const f = fixture(); pinSkill(f); reply(f);
    const routine = f.manager.create({ name: "Other job", botId: f.bot.id, prompt: "Read the notes.", target: "bot", enabled: false, runOn: "ember", permissionMode: mode, schedule: { type: "interval", everyMinutes: 5, anchorAt: Date.now() } });
    expect(routine.permissionMode).toBe(mode);
    settle(f); await review(f);
    expect(events("guide-applied"), mode).toHaveLength(0);
    expect(listProcedureSuggestions(database(), f.bot.id)[0], mode).toMatchObject({ targetKind: "skill", reasons: ["outbound"] });
  }
});

it("D4: a routine at Ask still waits when its bot or one of the bot's conversations has an always-allowed tool (gate)", async () => {
  for (const where of ["bot", "task"] as const) {
    closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
    const f = fixture(); const original = "Summarize my notes each morning for me.";
    pinRoutine(f, original); reply(f);
    if (where === "bot") f.store.patchBot(f.bot.id, { alwaysAllow: ["mcp__x__send"] } as never, { preserveTaskSettings: true });
    else f.store.patchTask(f.bot.id, f.threadId, { alwaysAllow: ["mcp__x__send"] });
    settle(f); await review(f);
    expect(promptOf(f), where).toBe(original);
    expect(events("guide-applied"), where).toHaveLength(0);
    expect(listProcedureSuggestions(database(), f.bot.id)[0], where).toMatchObject({ targetKind: "routine", reasons: ["outbound"] });
  }
});

it("D4: an always-allowed tool, a room or a bound channel keeps a skill change waiting", async () => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["always-allow", f => f.store.patchBot(f.bot.id, { alwaysAllow: ["mcp__x__send"] } as never)],
    ["Auto mode", f => f.store.patchBot(f.bot.id, { autoApprove: true } as never)],
  ];
  for (const [name, change] of cases) {
    closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
    const f = fixture(); pinSkill(f); reply(f); change(f); settle(f); await review(f);
    expect(events("guide-applied"), name).toHaveLength(0);
    expect(listProcedureSuggestions(database(), f.bot.id)[0], name).toMatchObject({ targetKind: "skill", reasons: ["outbound"] });
  }
  const { contextsContained } = await import("./routine-outbound.ts");
  const base = { asksFirst: true, alwaysAllowCount: 0, ownerOnly: true, inRoom: false, channelBound: false };
  expect(contextsContained([base])).toBe(true);
  expect(contextsContained([])).toBe(false);
  for (const change of [{ asksFirst: false }, { alwaysAllowCount: 1 }, { ownerOnly: false }, { inRoom: true }, { channelBound: true }]) {
    expect(contextsContained([base, { ...base, ...change }]), JSON.stringify(change)).toBe(false);
  }
});
