import { mkdirSync } from "node:fs";
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
import { closeMessageDb, insertMessage } from "./message-db.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { flushCoalesced } from "./atomic.ts";
import { startRecoveryScheduler } from "./recovery-scheduler.ts";
import { changeLearningEvent, learningHistory } from "./memory/learning-history.ts";
import { DEFAULT_BOT_LEARNING } from "./bot-learning.ts";
import { reconcileOutstandingChangesPass, reconcileOutstandingChanges, applyProcedureSuggestion, editProcedureSuggestion, landingReasons, listProcedureSuggestions, notNowProcedureSuggestion, improvedMomentForEvent, procedureChipItemsForThread, procedureEvidenceProspectDerived, procedureHardCheck, setImprovedListener } from "./memory/procedure-landing.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

/** A full reset of the data dir between fixtures. A reset inside a test must do what the suite's afterEach does between tests (testing/setup.ts): the
 * message log and the WAL upkeep hold their own handles and the stores hold deferred writes, so a bare rm leaves the next fixture reading a
 * deleted file (its reply and evidence never arrive) or a stale write landing in the fresh directory. */
async function resetDataDir() {
  try { flushCoalesced(); } catch { /* nothing left to write */ }
  closeMessageDb(); await stopWalMaintenance(); closeDatabase();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
}
beforeEach(resetDataDir);
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
const undo = (id: string) => changeLearningEvent(database(), id, "undo");
function pinSkill(f: ReturnType<typeof fixture>) {
  install(f);
  const pin = createProcedurePin(f.bot.id, f.threadId, [], [], undefined, context(f),{ownerTurn:true,shipped:()=>true}); f.store.pinTaskProcedures(f.bot.id, f.threadId, pin);
  preparePinnedProcedures(f.bot.id, f.threadId, pin, true, context(f));
}
function pinRoutine(f: ReturnType<typeof fixture>, prompt: string, permissionMode: "ask" | "auto" = "ask") {
  const routine = f.manager.create({ name: "Weekly job", botId: f.bot.id, prompt, target: "bot", enabled: false, runOn: "ember", permissionMode, schedule: { type: "interval", everyMinutes: 5, anchorAt: Date.now() } });
  const pin = createProcedurePin(f.bot.id, f.threadId, [], [], { id: routine.id, instructionRevision: routineInstructionRevision(routine) }, context(f),{ownerTurn:true,shipped:()=>true}); f.store.pinTaskProcedures(f.bot.id, f.threadId, pin);
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
  const applied = applyProcedureSuggestion(database(), { botId: f.bot.id, id: s.id, expectedVersion: s.version, proposedHash: s.proposedHash });
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
  applyProcedureSuggestion(database(), { botId: f.bot.id, id: s.id, expectedVersion: s.version, proposedHash: s.proposedHash });
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
  expect(() => applyProcedureSuggestion(database(), { botId: f.bot.id, id: s.id, expectedVersion: s.version })).toThrow(/changed elsewhere/);
  expect(() => applyProcedureSuggestion(database(), { botId: f.bot.id, id: s.id, expectedVersion: edited.version, proposedHash: s.proposedHash })).toThrow(/changed elsewhere/);
  // The routine changed under the card: nothing is applied and the card is gone.
  f.manager.update(f.manager.listRoutines()[0].id, { prompt: "Send nothing; draft the summary for me only." });
  expect(() => applyProcedureSuggestion(database(), { botId: f.bot.id, id: s.id, expectedVersion: edited.version, proposedHash: edited.proposedHash })).toThrow(/changed since it was suggested/);
  expect(promptOf(f)).toBe("Send nothing; draft the summary for me only.");
  expect(listProcedureSuggestions(database(), f.bot.id)).toHaveLength(0);
});

it("an edited suggestion is published as the owner's own words", async () => {
  const f = fixture(); pinRoutine(f, "Send the weekly summary email to every customer.", "auto"); settle(f); await review(f);
  const [s] = listProcedureSuggestions(database(), f.bot.id);
  const edited = transaction(db => editProcedureSuggestion(db, { botId: f.bot.id, id: s.id, expectedVersion: s.version, text: "Verify every reply and keep it short." }));
  applyProcedureSuggestion(database(), { botId: f.bot.id, id: s.id, expectedVersion: edited.version });
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
  await resetDataDir();
  const f = fixture();
  pinRoutine(f, original, "auto"); reply(f); settle(f); await review(f);
  expect(promptOf(f)).toBe(original);
  expect(events("guide-applied")).toHaveLength(0);
  const [s] = listProcedureSuggestions(database(), f.bot.id);
  expect(s.reasons).toEqual(["outbound"]);
  applyProcedureSuggestion(database(), { botId: f.bot.id, id: s.id, expectedVersion: s.version, proposedHash: s.proposedHash });
  expect(promptOf(f)).toBe("Verify the output before reporting success.");
  undo(String(events("guide-applied")[0]!.id));
  expect(promptOf(f)).toBe(original);
});

it("D4: a skill change is text-blind; it lands on its own only when every context that can run it is structurally contained", async () => {
  const words = ["Read the report.", "Send the completed report to the client.", "Execute gmail_send_email with the completed report.", "Order the items from the vendor.", "Use CUSTOMER_NAME as a placeholder.", "Pay the invoice once checked."];
  const outcomes: Array<{ text: string; contained: boolean; applied: number; reasons: string[] }> = [];
  for (const contained of [true, false]) for (const text of words) {
    await resetDataDir();
    const f = fixture(); pinSkill(f); reply(f);
    if (!contained) f.store.patchBot(f.bot.id, { autoApprove: true } as never);
    f.evaluator.mockImplementation(async (snapshot: ProcedureReviewSnapshot) => { const candidate = markdown(text); return { ...receipt(snapshot), candidate, candidateHash: procedureCandidateHash(candidate) }; });
    settle(f); await review(f);
    outcomes.push({ text, contained, applied: events("guide-applied").length, reasons: listProcedureSuggestions(database(), f.bot.id)[0]?.reasons ?? [] });
  }
  // the same matrix row for every text: benign or "dangerous" lands the same way
  expect(outcomes.filter(o => o.contained).map(o => [o.applied, o.reasons])).toEqual(words.map(() => [1, []]));
  expect(outcomes.filter(o => !o.contained).map(o => [o.applied, o.reasons])).toEqual(words.map(() => [0, ["outbound"]]));
  // twelve full data-dir resets: over the 20 s default on a busy Windows runner
}, 90_000);

it("D4: a routine of the bot at Auto or Unlimited keeps a skill change waiting (review AL-01)", async () => {
  for (const mode of ["auto", "unlimited"] as const) {
    await resetDataDir();
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
    await resetDataDir();
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
    await resetDataDir();
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

// ── R2-01 (upgfast review r2): a held memory, or one still being gone over, refuses Apply, Undo and the automatic review BEFORE anything is published ──
import { setIntegrityFlags } from "./memory/integrity-flags.ts";
const holdMemory = (code: string | null) => setIntegrityFlags(database(), { hold: code });
const pendingPass = (events: number) => setIntegrityFlags(database(), { pending: true, eventsFloor: events, lessonsFloor: 0, feedbackFloor: 0 });
const clearPass = () => setIntegrityFlags(database(), { hold: null, pending: false, eventsFloor: null, lessonsFloor: null, feedbackFloor: null });
const ledger = () => Number(database().prepare("SELECT count(*) AS n FROM memory_learning_events").get()!.n);
const publishers = (f: ReturnType<typeof fixture>) => [vi.spyOn(f.manager, "promoteInstructions"), vi.spyOn(f.manager, "update"), vi.spyOn(f.manager, "rollbackInstructions")];

it("R2-01: a held Apply calls no publisher and changes no row; a pass still pending refuses it too; once clear, the same Apply lands", async () => {
  const f = fixture(); const original = "Send the weekly summary email to every customer.";
  pinRoutine(f, original, "auto"); settle(f); await review(f);
  const [s] = listProcedureSuggestions(database(), f.bot.id);
  const spies = publishers(f);
  const apply = () => applyProcedureSuggestion(database(), { botId: f.bot.id, id: s.id, expectedVersion: s.version, proposedHash: s.proposedHash });
  const rowsBefore = ledger();
  holdMemory("INVALID_MEMORY_REFERENCE");
  expect(apply).toThrow(/set memory aside/);
  pendingPass(1_000_000); holdMemory(null);
  expect(apply).toThrow(/still going over earlier memory/);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(promptOf(f)).toBe(original);
  expect(ledger()).toBe(rowsBefore);
  expect(events("guide-applied")).toHaveLength(0);
  expect(listProcedureSuggestions(database(), f.bot.id)).toHaveLength(1); // the card is still waiting
  clearPass();
  expect(apply).not.toThrow();
  expect(promptOf(f)).toBe("Verify the output before reporting success.");
  expect(events("guide-applied")).toHaveLength(1);
});

it("R2-01: an Apply whose publisher throws after the rows were written leaves the rows as they were (the publication is the last statement)", async () => {
  const f = fixture(); const original = "Send the weekly summary email to every customer.";
  pinRoutine(f, original, "auto"); settle(f); await review(f);
  const [s] = listProcedureSuggestions(database(), f.bot.id);
  vi.spyOn(f.manager, "promoteInstructions").mockImplementation(() => { throw new Error("the routine file could not be written"); });
  expect(() => applyProcedureSuggestion(database(), { botId: f.bot.id, id: s.id, expectedVersion: s.version, proposedHash: s.proposedHash })).toThrow(/changed since it was suggested/);
  // the intent row was written first and is settled as "failed": nothing landed, nothing shows, and the card is still waiting
  expect(appliedStates()).toEqual(["failed"]);
  expect(procedureChipItemsForThread(database(), { botId: f.bot.id, threadId: f.threadId })).toHaveLength(0);
  expect(promptOf(f)).toBe(original);
  expect(listProcedureSuggestions(database(), f.bot.id)).toHaveLength(1);
  expect(() => applyProcedureSuggestion(database(), { botId: f.bot.id, id: s.id, expectedVersion: s.version, proposedHash: s.proposedHash })).toThrow();
  expect(outboxPointers()).toBe(0);
});

it("R2-01: a held Undo restores nothing and writes nothing; a change made before a pending pass waits for it, one made after does not", async () => {
  const f = fixture(); const original = "Summarize my notes each morning for me.";
  pinRoutine(f, original); reply(f); settle(f); await review(f);
  const [chip] = procedureChipItemsForThread(database(), { botId: f.bot.id, threadId: f.threadId });
  const spies = publishers(f);
  const rowsBefore = ledger();
  holdMemory("INVALID_MEMORY_REFERENCE");
  expect(() => undo(chip.eventId)).toThrow(/set memory aside/);
  holdMemory(null);
  const newest = Number(database().prepare("SELECT max(rowid) AS r FROM memory_learning_events").get()!.r);
  pendingPass(newest); // the change is at or below the floor: made before the pass began
  expect(() => undo(chip.eventId)).toThrow(/still going over earlier memory/);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(promptOf(f)).toBe("Verify the output before reporting success.");
  expect(ledger()).toBe(rowsBefore);
  expect(database().prepare("SELECT undone_at FROM memory_learning_events WHERE id=?").get(chip.eventId)!.undone_at).toBeNull();
  pendingPass(0); // made after the pass began: it rests only on this session's own rows
  expect(undo(chip.eventId)).toMatchObject({ ok: true, undone: true });
  expect(promptOf(f)).toBe(original);
});

it("R2-01: the automatic review re-checks the gate in its final transaction: nothing is published, no attempt is spent, and it is tried again", async () => {
  const f = fixture(); const original = "Summarize my notes each morning for me.";
  pinRoutine(f, original); reply(f); settle(f);
  const spies = publishers(f);
  const ids = pendingProcedureReviews(4);
  expect(ids.length).toBeGreaterThan(0);
  // the pass begins while the evaluation is in flight
  const evaluate = f.evaluator.getMockImplementation()!;
  f.evaluator.mockImplementation(async snapshot => { const receipt = await evaluate(snapshot); pendingPass(1_000_000); return receipt; });
  for (const id of ids) await processProcedureReview(id, f.bridge.host, new AbortController().signal);
  for (const row of database().prepare("SELECT id FROM memory_scope_bindings WHERE id LIKE 'procedure-review:%'").all()) await processProcedureReview(String(row.id), f.bridge.host, new AbortController().signal);
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(promptOf(f)).toBe(original);
  expect(events("guide-applied")).toHaveLength(0);
  const waiting = database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'procedure-review:%'").all().map(row => JSON.parse(String(row.intent)));
  expect(waiting.some(intent => intent.status === "deferred" && intent.reason === "memory-held" && !(intent.attempts > 0))).toBe(true);
});


// ── P1 (r4): the change is recorded before and after it lands, and a failure or a crash between is settled from the text itself ─────────────────────────
const appliedStates = () => database().prepare("SELECT json_extract(detail,'$.publishState') AS s FROM memory_learning_events WHERE kind='guide-applied' ORDER BY rowid").all().map(row => (row.s === null ? "applied" : String(row.s)));
const outboxPointers = () => Number(database().prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE id>='procedure-outbox:' AND id<'procedure-outbox;'").get()!.n);
/** Fails the Nth..last COMMIT of the connection the way a full disk does; `until` ends the failing (a disk that frees up). */
function failCommits(from: number, to = Infinity) {
  const db = database(), real = db.exec.bind(db); let n = 0;
  const spy = vi.spyOn(db, "exec").mockImplementation((sql: string) => {
    if (sql === "COMMIT") { n++; if (n >= from && n <= to) throw Object.assign(new Error("database or disk is full"), { code: "ERR_SQLITE_ERROR", errcode: 13 }); }
    return real(sql);
  });
  return { restore: () => spy.mockRestore(), count: () => n };
}
async function suggestion(original = "Send the weekly summary email to every customer.") {
  const f = fixture(); pinRoutine(f, original, "auto"); settle(f); await review(f);
  const [s] = listProcedureSuggestions(database(), f.bot.id);
  const apply = () => applyProcedureSuggestion(database(), { botId: f.bot.id, id: s.id, expectedVersion: s.version, proposedHash: s.proposedHash });
  return { f, s, apply, original };
}
const LANDED = "Verify the output before reporting success.";

it("P1: SQLITE_FULL at the first commit publishes nothing and records nothing", async () => {
  const { f, apply, original } = await suggestion();
  const spies = publishers(f);
  const fail = failCommits(1, 1);
  expect(apply).toThrow(/full/);
  fail.restore();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(promptOf(f)).toBe(original);
  expect(appliedStates()).toEqual([]);
  expect(outboxPointers()).toBe(0);
  expect(listProcedureSuggestions(database(), f.bot.id)).toHaveLength(1);
});

it("P1: SQLITE_FULL at the second commit, once: the change is found landed and recorded before the error leaves", async () => {
  const { f, s, apply } = await suggestion();
  const fail = failCommits(2, 2);
  expect(apply()).toMatchObject({ id: s.id, kind: "procedure" });
  fail.restore();
  expect(promptOf(f)).toBe(LANDED);
  expect(appliedStates()).toEqual(["applied"]);
  expect(outboxPointers()).toBe(0);
  expect(listProcedureSuggestions(database(), f.bot.id)).toHaveLength(0);
});

it("P1: a crash between the publication and the second commit leaves a row the next sweep settles as applied", async () => {
  const { f, s, apply } = await suggestion();
  const fail = failCommits(2); // the disk stays full: the second commit and the immediate reconcile both fail, as a crash would leave it
  expect(apply).toThrow(/full/);
  fail.restore();
  expect(promptOf(f)).toBe(LANDED); // published
  expect(appliedStates()).toEqual(["publishing"]); // ...and the row that says so exists
  expect(outboxPointers()).toBe(1);
  expect(listProcedureSuggestions(database(), f.bot.id)).toHaveLength(0); // the text moved on, so the card is no longer an offer
  expect(reconcileOutstandingChanges(database())).toBe(1);
  expect(appliedStates()).toEqual(["applied"]);
  expect(outboxPointers()).toBe(0);
  expect(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(s.id)!.intent).toMatch(/"state":"applied"/);
});

it("P1: a publication that never happened is settled as failed and the suggestion stays suggested", async () => {
  const { f, apply, original } = await suggestion();
  vi.spyOn(f.manager, "promoteInstructions").mockImplementation(() => { throw new Error("the routine file could not be written"); });
  const fail = failCommits(2); // the settling write cannot happen either
  expect(apply).toThrow();
  fail.restore();
  expect(appliedStates()).toEqual(["publishing"]);
  expect(reconcileOutstandingChanges(database())).toBe(1);
  expect(appliedStates()).toEqual(["failed"]);
  expect(promptOf(f)).toBe(original);
  expect(listProcedureSuggestions(database(), f.bot.id)).toHaveLength(1);
});

it("P1: text that is neither the intended nor the previous one is held and shown to the owner, never dropped", async () => {
  const { f, apply } = await suggestion();
  const fail = failCommits(2);
  expect(apply).toThrow(/full/);
  fail.restore();
  f.manager.update(f.manager.listRoutines()[0].id, { prompt: "Something the owner wrote in the meantime." });
  expect(reconcileOutstandingChanges(database())).toBe(1);
  expect(appliedStates()).toEqual(["held"]);
  const history = learningHistory(database(), { bots: f.store.bots, groups: f.store.groups } as never, { botId: f.bot.id });
  expect(history.events.find((event: any) => event.kind === "guide-applied")!.procedure).toMatchObject({ state: "held" });
  expect(promptOf(f)).toBe("Something the owner wrote in the meantime.");
});

it("P1: an Undo whose second commit fails is completed from the restored text; a refused rollback is reported, never ignored", async () => {
  const f = fixture(); const original = "Summarize my notes each morning for me.";
  pinRoutine(f, original); reply(f); settle(f); await review(f);
  const [chip] = procedureChipItemsForThread(database(), { botId: f.bot.id, threadId: f.threadId });
  // a rollback that reports {ok:false}
  const refuse = vi.spyOn(f.manager, "rollbackInstructions").mockReturnValueOnce(false as never);
  expect(() => undo(chip.eventId)).toThrow(/changed since it was updated/);
  expect(database().prepare("SELECT undone_at FROM memory_learning_events WHERE id=?").get(chip.eventId)!.undone_at).toBeNull();
  expect(database().prepare("SELECT json_extract(detail,'$.undoState') AS u FROM memory_learning_events WHERE id=?").get(chip.eventId)!.u).toBeNull();
  refuse.mockRestore();
  // the disk is full for the second commit and the reconcile after it
  const fail = failCommits(2);
  expect(() => undo(chip.eventId)).toThrow(/full/);
  fail.restore();
  expect(promptOf(f)).toBe(original); // the text went back
  expect(reconcileOutstandingChanges(database())).toBe(1);
  expect(database().prepare("SELECT undone_at FROM memory_learning_events WHERE id=?").get(chip.eventId)!.undone_at).not.toBeNull();
  expect(events("guide-undone")).toHaveLength(1);
  expect(outboxPointers()).toBe(0);
});

it("P3: Keep is gated before its update", async () => {
  const f = fixture(); pinRoutine(f, "Summarize my notes each morning for me."); reply(f); settle(f); await review(f);
  const [chip] = procedureChipItemsForThread(database(), { botId: f.bot.id, threadId: f.threadId });
  holdMemory("INVALID_MEMORY_REFERENCE");
  expect(() => changeLearningEvent(database(), chip.eventId, "keep")).toThrow(/set memory aside/);
  expect(database().prepare("SELECT kept_at FROM memory_learning_events WHERE id=?").get(chip.eventId)!.kept_at).toBeNull();
  clearPass();
  expect(changeLearningEvent(database(), chip.eventId, "keep")).toMatchObject({ kept: true });
});


// ── r6 finding 2: recovery runs whatever the memory mode is, and a pointer that cannot settle yet never starves the ones behind it ──────
for (const mode of ["paused", "off"] as const) it(`r6-2: memory ${mode}, a double commit failure and a restart: one boot pass of the recovery scheduler settles the change`, async () => {
  {
    const { f, apply } = await suggestion();
    const fail = failCommits(2); // the second commit and the immediate reconcile both fail
    expect(apply).toThrow(/full/);
    fail.restore();
    expect(appliedStates()).toEqual(["publishing"]);
    setMemoryMode(mode); // idle consolidation never runs in these modes
    // a restart: a scheduler with no memory of an earlier pass
    const scheduler = startRecoveryScheduler({ db: () => database(), outbox: reconcileOutstandingChangesPass, intervalMs: 3_600_000 });
    try { expect(scheduler.runNow()).toMatchObject({ ran: true, settled: 1 }); } finally { scheduler.stop(); }
    expect(appliedStates()).toEqual(["applied"]);
    expect(outboxPointers()).toBe(0);
    expect(promptOf(f)).toBe(LANDED);
  }
});

it("r6-2: 25 pointers that cannot settle ahead of 1 that can: the wrapping cursor reaches it on the second pass", () => {
  const db = database();
  db.prepare("INSERT INTO memory_scopes VALUES('s-ws','workspace','ws','[]',0)").run();
  const put = db.prepare("INSERT INTO memory_scope_bindings VALUES(?,'s-ws','system','procedure-outbox',0,'granted',?)");
  for (let i = 0; i < 25; i++) put.run(`procedure-outbox:a${String(i).padStart(2, "0")}`, "{}"); // no event id: skipped, never dropped, so they stay ahead for ever
  put.run("procedure-outbox:gone", JSON.stringify({ eventId: "gone", at: 1 })); // an event that no longer exists: settled and dropped
  const scheduler = startRecoveryScheduler({ db: () => database(), outbox: reconcileOutstandingChangesPass, intervalMs: 3_600_000 });
  try {
    const first = scheduler.runNow();
    expect(first).toMatchObject({ examined: 20, settled: 0 });
    expect(scheduler.cursor()).toBe("procedure-outbox:a19");
    const second = scheduler.runNow();
    expect(second.settled).toBe(1);
    expect(second.examined).toBe(6);
    expect(scheduler.cursor()).toBeNull(); // the range ended: the next pass begins again at the start
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE id='procedure-outbox:gone'").get()!.n)).toBe(0);
  } finally { scheduler.stop(); }
});

it("r6-2: the idle consolidation no longer carries the outbox pass", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  const idle = source.slice(source.indexOf("onIdleConsolidation:"), source.indexOf("onIdleConsolidation:") + 6000);
  expect(idle).not.toContain("reconcileOutstandingChanges");
  expect(source).toContain("startRecoveryScheduler({");
});
