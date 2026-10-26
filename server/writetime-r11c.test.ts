// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// evhand r11c (Astra, P1 at 09e3bfab6), closed by write-time lineage (DESIGN-WRITETIME 2.5): a short secret a bot copies into a note on a
// card is not "fresh" because no overlap match finds it. Reproduction (r11c REPORT.md):
//   1. the lead's stored reply holds "Owner-only budget access PIN 1234.";
//   2. the lead sends the card back with "Please use PIN 1234 for the sheet";
//   3. the owner withholds, then deletes, the original reply;
//   4. the assignee's redo prompt still held "PIN 1234".
// And the reviewer-tool variant: the reviewer's notes copy "CODE 5678" from its own earlier reply into the lead's wake.
//
// Now a note rests on its writer's whole turn (a prefix carry, project-notes.ts recordNoteLineage), and releaseNote asks the read predicate
// about the note's own object. S1 (the turn) and S4 (the predicate) are S0 stubs at this point of the lane, so they are modelled here by
// memory/testing/fake-lineage.ts: these tests prove what S2 records and asks, on the production card, note, gate and prompt code.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memory/lineage-write.ts", async importOriginal => ({ ...(await importOriginal<object>()), ...(await import("./memory/testing/fake-lineage.ts")).fakeWrite }));
vi.mock("./memory/deny-read.ts", async importOriginal => ({ ...(await importOriginal<object>()), ...(await import("./memory/testing/fake-lineage.ts")).fakeRead }));

import type { EgressMessage } from "./result-egress.ts";
import type { RoomRequest } from "./room-requests.ts";

// The modules under test are loaded after the mocks, from a fresh module graph: a module some earlier import already evaluated would keep
// the S0 stubs (vitest mocks only what is imported after vi.mock, and resetModules starts the graph again).
let fakeLineage: typeof import("./memory/testing/fake-lineage.ts").fakeLineage;
let egress: typeof import("./bot-egress.ts"), cards: typeof import("./project-cards.ts"), prompt: typeof import("./project-prompt.ts");
let records: typeof import("./project-records.ts"), tables: typeof import("./project-tables.ts"), engine: typeof import("./project-turn-engine.ts");
let results: typeof import("./result-egress.ts"), requests: typeof import("./room-requests.ts"), statusMod: typeof import("./murage-status.ts");
beforeAll(async () => {
  vi.resetModules();
  fakeLineage = (await import("./memory/testing/fake-lineage.ts")).fakeLineage;
  [egress, cards, prompt, records, tables, engine, results, requests, statusMod] = await Promise.all([import("./bot-egress.ts"), import("./project-cards.ts"),
    import("./project-prompt.ts"), import("./project-records.ts"), import("./project-tables.ts"), import("./project-turn-engine.ts"), import("./result-egress.ts"),
    import("./room-requests.ts"), import("./murage-status.ts")]);
}, 120_000);

afterEach(() => { results.configureResultEgress(undefined); egress.configureBotEgress(undefined); statusMod.configureStatusRoster(undefined); fakeLineage.reset(); });

describe("evhand r11c: a short secret copied into a note is withheld with what the note's turn rested on", () => {
  let db: DatabaseSync;
  const MEMBERS = ["lead", "jax", "rev"];
  const names = new Map([["lead", "Nova"], ["jax", "Jax"], ["rev", "Reed"]]);
  const name = (id: string) => names.get(id) ?? "a member";
  let clock = 1000;
  const tick = () => (clock += 10);
  const stored = new Map<string, EgressMessage>();
  const put = (threadId: string, id: string, extra: Partial<EgressMessage> = {}) => { stored.set(`${threadId}\u0000${id}`, { id, ...extra }); };
  const insert = (table: string, row: Record<string, unknown>) =>
    db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row) as Array<string | number | null>);
  const hooks = () => ({
    cardGenerationCurrent: engine.cardGenerationCurrent,
    cardEffect: (tx: DatabaseSync, request: RoomRequest) => engine.applyCardRunEffect(tx, request, { memberIds: MEMBERS, now: tick() }),
    returnThread: () => "room",
    reviewWake: (tx: DatabaseSync, request: RoomRequest) => engine.reviewWakeTarget(tx, request, { memberIds: MEMBERS, roomThreadId: "room" }),
  });

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    tables.initializeProjectTables(db);
    clock = 1000;
    stored.clear();
    fakeLineage.reset();
    insert("project_settings", { group_id: "g", mode: "conversation", lead_bot_id: "lead", parts: "{}", parallel_cards: 3, work_roots: "[]", work_profile: "ask", run_state: "running", updated_at: 1 });
    insert("project_goals", { id: "goal", group_id: "g", title: "Ship", state: "working", review: 1, created_at: 1, criteria: "[]" });
    db.prepare(`INSERT INTO room_requests (id, root_id, group_id, verb, from_kind, to_bot_id, origin, root_thread_id, audience_fingerprint, not_owner_audience, unattended, admission_key, state, created_at)
      VALUES ('lead-turn','lead-turn','g','room_turn','owner','lead','desktop','room','owner',0,0,'turn:lead-turn','running',1)`).run();
    results.configureResultEgress({
      message: (threadId, id) => stored.get(`${threadId}\u0000${id}`), authorize: () => ({ ok: true }), copyOriginWithheld: () => false,
      capturedMessageWithheld: () => false, messageSourceForgotten: () => false, messageMadeWithMemory: () => false, partitionAllowed: () => true, ownUnsharedWork: () => true,
    });
  });

  /** Jax's card runs and Reed reviews it asking for changes. `beforeVerdict` runs just before Reed records the verdict (Reed's turn). */
  function changesRequested(notes: string, beforeVerdict?: () => void): RoomRequest {
    insert("project_work_items", { id: "c1", group_id: "g", goal_id: "goal", number: 1, title: "Pricing sheet", state: "todo", position: 1, created_by: "lead", created_at: 1, updated_at: 1, assignee_bot_id: "jax" });
    const queued = cards.enqueueCardRun(db, { cardId: "c1", actor: { kind: "server" }, now: tick() });
    if (!queued.ok) throw new Error(queued.reason);
    db.prepare("UPDATE room_requests SET return_bot_id='lead' WHERE id=?").run(queued.requestId);
    expect(cards.applyCardRunDispatched(db, { cardId: "c1", requestId: queued.requestId, deskThreadId: "desk-jax", now: tick() }).ok).toBe(true);
    put("desk-jax", "m-result");
    requests.completeRequest(db, queued.requestId, { state: "done", now: tick(), resultMessageId: "m-result" }, hooks());
    const review = db.prepare("SELECT id, to_bot_id FROM room_requests WHERE verb='review' AND work_item_id='c1' ORDER BY created_at DESC LIMIT 1").get() as { id: string; to_bot_id: string };
    requests.markRequestDispatched(db, review.id, { now: tick(), targetThreadId: "desk-rev" });
    beforeVerdict?.();
    expect(cards.applyReviewVerdict(db, { cardId: "c1", requestId: review.id, reviewerBotId: review.to_bot_id, verdict: "changes", notes, now: tick() }).ok).toBe(true);
    put("desk-rev", "m-review");
    requests.completeRequest(db, review.id, { state: "done", now: tick(), resultMessageId: "m-review" }, hooks());
    return requests.roomRequest(db, review.id)!;
  }
  const wake = (review: RoomRequest) => {
    const next = engine.leadNextStep(db, review, { memberIds: MEMBERS, name, viewer: { botId: "lead", threadId: "room" }, notOwnerAudience: false });
    expect(next?.step).toBe("send_back");
    return prompt.continuationResultsPrompt(true, [{ botName: "Reed", state: "done", review: { verdict: "changes", cardNumber: 1 }, next }]);
  };
  const redo = () => prompt.cardAskText({ verb: "assign", number: 1, title: "Pricing sheet", description: "d", withdrawn: false, redo: cards.releasedRedoNotes(db, cards.redoContext(db, "c1"), false) });
  const lead = () => ({ kind: "lead" as const, botId: "lead", lineage: records.inheritedRequestLineage(records.roomRequestById(db, "lead-turn")!) });
  /** The lead's earlier reply in its room, holding the short secret. */
  const leadSaidPin = () => { fakeLineage.write("room", "m-lead"); put("room", "m-lead"); };

  it("the lead's note copying PIN 1234 from its own earlier reply leaves the redo once the owner withholds, then deletes, that reply", () => {
    changesRequested("Fix the figures.");
    leadSaidPin();
    fakeLineage.open("room");                                            // the lead's turn: it was shown its earlier reply
    expect(cards.sendProjectCardBack(db, { cardId: "c1", actor: lead(), note: "Please use PIN 1234 for the sheet", now: tick() }).ok).toBe(true);
    const before = redo();
    expect(before).toContain("PIN 1234");
    expect(before).toContain("Fix the figures.");
    // the note is a Murage object resting on the lead's turn: a prefix carry from (room, the turn's lsn)
    expect([...fakeLineage.records.keys()].filter(key => key.startsWith("note:lead-turn:"))).toHaveLength(1);
    fakeLineage.deny("room", "m-lead"); put("room", "m-lead", { withheldFromBots: true });
    const withheld = redo();
    expect(withheld).not.toContain("PIN 1234");
    expect(withheld).toContain("Fix the figures.");                     // the reviewer's note did not rest on that reply
    expect(withheld).toContain("Work on card 1: Pricing sheet");
    stored.delete("room\u0000m-lead");
    expect(redo()).not.toContain("PIN 1234");
  });

  it("the reviewer's tool verdict copying CODE 5678 from its own earlier reply leaves the lead's wake once the owner withholds that reply", () => {
    const review = changesRequested("Please use CODE 5678 when you redo it.", () => {
      fakeLineage.write("desk-rev", "m-rev-early"); put("desk-rev", "m-rev-early");
      fakeLineage.open("desk-rev");                                      // Reed's review turn
    });
    expect(wake(review)).toContain("CODE 5678");
    fakeLineage.deny("desk-rev", "m-rev-early");
    const prompt = wake(review);
    expect(prompt).not.toContain("CODE 5678");
    expect(prompt).toContain('action "send_back"');                     // the verdict still tells the lead what to do
  });

  it("U02: a note held back after a forget is said in the redo, so the member asks for it instead of working as if none was written", () => {
    changesRequested("Fix the figures.");
    leadSaidPin();
    fakeLineage.open("room");
    expect(cards.sendProjectCardBack(db, { cardId: "c1", actor: lead(), note: "Please use PIN 1234 for the sheet", now: tick() }).ok).toBe(true);
    expect(redo()).not.toContain("not available to you now");
    fakeLineage.deny("room", "m-lead"); put("room", "m-lead", { withheldFromBots: true });
    const held = redo();
    expect(held).not.toContain("PIN 1234");
    expect(held).toContain("Fix the figures.");
    expect(held).toContain("This card has the lead's note on your earlier result, not available to you now.");
    expect(cards.releasedRedoNotes(db, cards.redoContext(db, "c1"), false)).toMatchObject({ leadNoteHeld: true });
  });

  it("U02: the lead's wake says the reviewer's notes are held, and still tells it what to do", () => {
    const review = changesRequested("Please use CODE 5678 when you redo it.", () => {
      fakeLineage.write("desk-rev", "m-rev-early"); put("desk-rev", "m-rev-early");
      fakeLineage.open("desk-rev");
    });
    expect(wake(review)).not.toContain("not available to you now");
    fakeLineage.deny("desk-rev", "m-rev-early");
    const prompt = wake(review);
    expect(prompt).not.toContain("CODE 5678");
    expect(prompt).toContain("The reviewer's notes on Card 1");
    expect(prompt).toContain("are not available to you now. Ask the reviewer to say again what to change");
    expect(prompt).toContain('action "send_back"');
  });

  it("a copy from another thread the lead's turn was shown is withheld too (the turn's parents carry onto the note)", () => {
    changesRequested("Fix the figures.");
    fakeLineage.write("dm-owner", "m-plan"); put("dm-owner", "m-plan");
    const turn = fakeLineage.open("room");
    turn.parents.push({ kind: "line", threadId: "dm-owner", messageId: "m-plan" });
    expect(cards.sendProjectCardBack(db, { cardId: "c1", actor: lead(), note: "Use PIN 1234", now: tick() }).ok).toBe(true);
    expect(redo()).toContain("PIN 1234");
    fakeLineage.deny("dm-owner", "m-plan");
    expect(redo()).not.toContain("PIN 1234");
  });

  it("failing first: a note written with no recorded turn (the S0 stub, as before this lane) keeps only the result gate, and the copied PIN stays", () => {
    changesRequested("Fix the figures.");
    leadSaidPin();
    expect(cards.sendProjectCardBack(db, { cardId: "c1", actor: lead(), note: "Please use PIN 1234 for the sheet", now: tick() }).ok).toBe(true);
    fakeLineage.deny("room", "m-lead"); put("room", "m-lead", { withheldFromBots: true });
    // the r11c leak as it stood: S1's running turn is what closes it, so S1 must register the lead's and the reviewer's turns
    expect(redo()).toContain("PIN 1234");
    expect(fakeLineage.records.size).toBe(0);
  });

  it("a note whose origin names a malformed lineage id is no origin at all, so it is never shown", () => {
    changesRequested("Fix the figures.");
    fakeLineage.open("room");
    expect(cards.sendProjectCardBack(db, { cardId: "c1", actor: lead(), note: "Please use PIN 1234", now: tick() }).ok).toBe(true);
    db.prepare("UPDATE project_activity SET detail=json_set(detail,'$.noteOrigin.lineage',42) WHERE kind='card_moved'").run();
    expect(redo()).not.toContain("PIN 1234");
  });
});
