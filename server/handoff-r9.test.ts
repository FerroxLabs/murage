// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Review round 9 of the hand-off boundary. Each test reproduces a reviewer's scenario against the production code:
//   R9-01  a reviewer's notes and the lead's note keep where they came from and reach a bot only through the result gate, at the lead's wake
//          and at the assignee's redo: when the review answer is withheld or deleted before the prompt is written, its words are not in it;
//   R9-02  a transcript is judged from its newest line back and only as far as the prompt reaches, the copy memo is stamped once per
//          operation, and a reply link written to a copy row keeps every verdict;
//   R9-03  a shared run that failed after writing part of an answer delivers it marked as partial, with how it ended kept in its receipt;
//   R9-04  a fixed reason the shared queue closes work with keeps its status key in the bot's receipt;
//   R9-05  a stored correction reaches the project room only through the gate;
//   F3     a cancelled queued hand-off's receipt never reads "The request finished.".
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryStore } from "./boundary-ports.ts";
import { configureBotEgress, RowSink } from "./bot-egress.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeDatabase, database } from "./database.ts";
import { findDelegationReceipt, recordDelegationReceipt } from "./delegations.ts";
import { runDeliverCardResult, runDeliverSharedResult } from "./handoff-boundary.ts";
import { REPLAY_BUDGET_CAP_BYTES } from "./memory/disclosures.ts";
import { closeMessageDb } from "./message-db.ts";
import { cancelledEnding, configureStatusRoster, outboundWords, status, statusFromStored, type Outbound } from "./murage-status.ts";
import { DIRECT_TRANSCRIPT_WINDOW_ROWS, directTranscriptWindowFull, TRANSCRIPT_EXAMINED_ROWS } from "./partition-sources.ts";
import { botMessages, botViewer, botWindow } from "./bot-read.ts";
import { applyCardRunDispatched, applyReviewVerdict, enqueueCardRun, redoContext, releasedRedoNotes, sendProjectCardBack } from "./project-cards.ts";
import { cardAskText, continuationResultsPrompt } from "./project-prompt.ts";
import { inheritedRequestLineage, roomRequestById } from "./project-records.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { applyCardRunEffect, cardGenerationCurrent, leadNextStep, reviewWakeTarget } from "./project-turn-engine.ts";
import { configureResultEgress, type EgressMessage } from "./result-egress.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
// evhand's note recorder is superseded by write-time lineage (project-notes.ts recordNoteLineage): inert here, so these scenarios run on the write-time rules
// (preview2 merge: scenarios that assert evhand's holders/sources/ranges note design are it.skip: writetime wins, notes rest on write-time lineage)
const configureNoteRecorder = (_recorder?: unknown): void => {};
import { completeRequest, finishRequestTurn, insertRoomRequest, markRequestDispatched, roomRequest, type RoomRequest } from "./room-requests.ts";
import { queueClosedStatus } from "./shared-work.ts";
import { Store, type Message } from "./store.ts";

const SECRET = "UNCLEARED REVIEW SECRET /private/OWNER-PLAN.txt";
afterEach(() => { configureNoteRecorder(undefined); configureResultEgress(undefined); configureBotEgress(undefined); configureStatusRoster(undefined); });

describe("R9-01: a teammate's note on a card is released at each prompt that quotes it", () => {
  let db: DatabaseSync;
  const MEMBERS = ["lead", "jax", "rev"];
  const names = new Map([["lead", "Nova"], ["jax", "Jax"], ["rev", "Reed"]]);
  const name = (id: string) => names.get(id) ?? "a member";
  let clock = 1000;
  const tick = () => (clock += 10);
  /** What is stored now, as the gate reads it: deleting a key deletes the message, `withheldFromBots` withholds it. */
  const stored = new Map<string, EgressMessage>();
  const put = (threadId: string, id: string, extra: Partial<EgressMessage> = {}) => stored.set(`${threadId}\u0000${id}`, { id, ...extra });
  const insert = (table: string, row: Record<string, unknown>) =>
    db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row) as Array<string | number | null>);
  const hooks = () => ({
    cardGenerationCurrent,
    cardEffect: (tx: DatabaseSync, request: RoomRequest) => applyCardRunEffect(tx, request, { memberIds: MEMBERS, now: tick() }),
    returnThread: () => "room",
    reviewWake: (tx: DatabaseSync, request: RoomRequest) => reviewWakeTarget(tx, request, { memberIds: MEMBERS, roomThreadId: "room" }),
  });

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initializeProjectTables(db);
    clock = 1000;
    stored.clear();
    insert("project_settings", { group_id: "g", mode: "conversation", lead_bot_id: "lead", parts: "{}", parallel_cards: 3, work_roots: "[]", work_profile: "ask", run_state: "running", updated_at: 1 });
    insert("project_goals", { id: "goal", group_id: "g", title: "Ship", state: "working", review: 1, created_at: 1, criteria: "[]" });
    db.prepare(`INSERT INTO room_requests (id, root_id, group_id, verb, from_kind, to_bot_id, origin, root_thread_id, audience_fingerprint, not_owner_audience, unattended, admission_key, state, created_at)
      VALUES ('lead-turn','lead-turn','g','room_turn','owner','lead','desktop','room','owner',0,0,'turn:lead-turn','running',1)`).run();
    configureResultEgress({
      message: (threadId, id) => stored.get(`${threadId}\u0000${id}`),
      authorize: () => ({ ok: true }), copyOriginWithheld: () => false,
      capturedMessageWithheld: () => false, messageSourceForgotten: () => false, messageMadeWithMemory: () => false, partitionAllowed: () => true, ownUnsharedWork: () => true,
    });
  });

  /** The writing turns are known and carried only allowed lines: a note is stored (here) as its own message of that turn. The lineage rules
   * themselves are tested in handoff-r10.test.ts (R11c). */
  const recordNotes = () => configureNoteRecorder({
    store: ({ threadId, text }: { threadId: string; text: string }) => { const id = `m-note-${stored.size}`; put(threadId, id, { text }); return { id } as Message; } });

  /** Jax's card runs, its result is stored, and Reed reviews it asking for changes with the secret in the notes. `block`: the notes came from the
   * fenced block in Reed's reply (they name it); otherwise from the review tool (the review run's own answer stands in). */
  function changesRequested(block: boolean): RoomRequest {
    insert("project_work_items", { id: "c1", group_id: "g", goal_id: "goal", number: 1, title: "Pricing sheet", state: "todo", position: 1, created_by: "lead", created_at: 1, updated_at: 1, assignee_bot_id: "jax" });
    const queued = enqueueCardRun(db, { cardId: "c1", actor: { kind: "server" }, now: tick() });
    if (!queued.ok) throw new Error(queued.reason);
    db.prepare("UPDATE room_requests SET return_bot_id='lead' WHERE id=?").run(queued.requestId);
    expect(applyCardRunDispatched(db, { cardId: "c1", requestId: queued.requestId, deskThreadId: "desk-jax", now: tick() }).ok).toBe(true);
    put("desk-jax", "m-result");
    completeRequest(db, queued.requestId, { state: "done", now: tick(), resultMessageId: "m-result" }, hooks());
    const review = db.prepare("SELECT id, to_bot_id FROM room_requests WHERE verb='review' AND work_item_id='c1' ORDER BY created_at DESC LIMIT 1").get() as { id: string; to_bot_id: string };
    markRequestDispatched(db, review.id, { now: tick(), targetThreadId: "desk-rev" });
    // the reviewer's stored answer: with the fenced block it holds the notes' words; after a tool verdict it holds none of them
    put("desk-rev", "m-review", { text: block ? `Verdict: changes. Fix the figures: ${SECRET}` : "Review recorded" });
    expect(applyReviewVerdict(db, { cardId: "c1", requestId: review.id, reviewerBotId: review.to_bot_id, verdict: "changes", notes: `Fix the figures: ${SECRET}`, now: tick(),
      ...(block ? { notesFrom: { threadId: "desk-rev", messageIds: ["m-review"] } } : {}) }).ok).toBe(true);
    completeRequest(db, review.id, { state: "done", now: tick(), resultMessageId: "m-review" }, hooks());
    return roomRequest(db, review.id)!;
  }
  /** The lead's wake prompt for that review, written now. */
  const wake = (review: RoomRequest) => {
    const next = leadNextStep(db, review, { memberIds: MEMBERS, name, viewer: { botId: "lead", threadId: "room" }, notOwnerAudience: false });
    expect(next?.step).toBe("send_back");
    return continuationResultsPrompt(true, [{ botName: "Reed", state: "done", review: { verdict: "changes", cardNumber: 1 }, next }]);
  };
  /** The assignee's redo ask, written now. */
  const redo = () => cardAskText({ verb: "assign", number: 1, title: "Pricing sheet", description: "d", withdrawn: false, redo: releasedRedoNotes(db, redoContext(db, "c1"), false) });

  it("the lead's wake: the notes are there while the answer is, and gone once the owner withholds it", () => {
    recordNotes();
    const review = changesRequested(true);
    expect(wake(review)).toContain(SECRET);
    put("desk-rev", "m-review", { withheldFromBots: true });
    const prompt = wake(review);
    expect(prompt).not.toContain(SECRET);
    // the allowed verdict still tells the lead what to do; only its free text is left out
    expect(prompt).toContain('action "send_back"');
  });

  it.skip("the lead's wake: a tool verdict's notes that no stored message holds have no origin to check, and are left out (R10-01)", () => {
    const review = changesRequested(false);
    expect(wake(review)).not.toContain(SECRET);
    // once a stored message holds the words, the note follows that message
    put("desk-rev", "m-earlier", { text: `Working note: ${SECRET}` });
    db.prepare("UPDATE project_activity SET detail=json_remove(detail,'$.notesOrigin') WHERE kind='card_result'").run();
    expect(wake(review)).not.toContain(SECRET);
  });

  it("the assignee's redo: neither the reviewer's notes nor the lead's note quoting them survive the review answer's deletion", () => {
    recordNotes();
    changesRequested(true);
    const lead = { kind: "lead" as const, botId: "lead", lineage: inheritedRequestLineage(roomRequestById(db, "lead-turn")!) };
    expect(sendProjectCardBack(db, { cardId: "c1", actor: lead, note: `Reed says: ${SECRET} LEAD COPY`, now: tick() }).ok).toBe(true);
    const before = redo();
    expect(before).toContain(`Fix the figures: ${SECRET}`);
    expect(before).toContain("LEAD COPY");
    stored.delete("desk-rev\u0000m-review");
    const after = redo();
    expect(after).not.toContain(SECRET);
    expect(after).not.toContain("LEAD COPY");
    expect(after).toContain("Work on card 1: Pricing sheet");
  });

  it("a note with no origin (a row written before notes kept one, or a lead with no turn) is never shown", () => {
    changesRequested(true);
    db.prepare("UPDATE project_activity SET detail=json_remove(detail,'$.notesOrigin') WHERE kind='card_result'").run();
    expect(sendProjectCardBack(db, { cardId: "c1", actor: { kind: "lead", botId: "lead" }, note: `again ${SECRET}`, now: tick() }).ok).toBe(true);
    expect(redo()).not.toContain(SECRET);
  });
});

describe("R9-02: a turn's transcript check costs its window, not the history", () => {
  /** n originals and n copies of them stored, the copies as a lead's transcript; counts the copy chain check's original reads, the door's
   * chain judge's source reads (nothing kept across operations, rule 19) and memo stamp reads. */
  function copiesWorld(n: number) {
    const real = new DatabaseSync(":memory:");
    real.exec("CREATE TABLE messages (thread_id TEXT NOT NULL, id TEXT NOT NULL, role TEXT, json TEXT NOT NULL, PRIMARY KEY (thread_id, id))");
    const insert = real.prepare("INSERT INTO messages (thread_id, id, role, json) VALUES (?,?,'bot',?)");
    const copies: Message[] = [];
    real.exec("BEGIN");
    for (let index = 0; index < n; index += 1) {
      insert.run("worker", `o${index}`, JSON.stringify({ id: `o${index}`, role: "bot", text: "original answer" }));
      const copy = { id: `c${index}`, at: index, role: "bot", kind: "text", text: `@Worker replied to the delegated task: answer ${index}`, copyOf: { threadId: "worker", messageIds: [`o${index}`] } } as Message;
      insert.run("lead", copy.id, JSON.stringify(copy));
      copies.push(copy);
    }
    real.exec("COMMIT");
    const count = { reads: 0, sources: 0, stamps: 0 };
    const db = new Proxy(real, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          const statement = target.prepare(sql);
          const counter = /SELECT json FROM messages/.test(sql) ? "reads" : /SELECT role,json FROM messages/.test(sql) ? "sources" : /copy_chain_epoch/.test(sql) && /^\s*SELECT/.test(sql) ? "stamps" : null;
          if (!counter) return statement;
          return { get: (...args: never[]) => { count[counter] += 1; return statement.get(...args); } };
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { real, db, copies, count };
  }

  it("the memo is stamped once per operation, not once per copy", () => {
    const { real, db, copies, count } = copiesWorld(1_000);
    expect(botMessages(db, botViewer("bot"), "lead", copies)).toHaveLength(1_000);
    expect(botMessages(db, botViewer("bot"), "lead", copies)).toHaveLength(1_000);
    expect(count.stamps).toBe(2);
    real.close();
  });

  it("a lead conversation with 10,000 historical copies does the same work per turn as one with 1,000: its window's", () => {
    const run = (n: number) => {
      const world = copiesWorld(n);
      const judged = botWindow(world.db, botViewer("bot"), "lead", world.copies, directTranscriptWindowFull(REPLAY_BUDGET_CAP_BYTES, DIRECT_TRANSCRIPT_WINDOW_ROWS), TRANSCRIPT_EXAMINED_ROWS);
      world.real.close();
      return { ...world.count, window: judged.window.map(row => row.id), older: judged.older.length };
    };
    const small = run(1_000), large = run(10_000);
    expect(small.window).toHaveLength(DIRECT_TRANSCRIPT_WINDOW_ROWS);
    expect(large.window).toHaveLength(DIRECT_TRANSCRIPT_WINDOW_ROWS);
    expect(large.window.at(-1)).toBe("c9999");
    expect(large.older).toBe(10_000 - DIRECT_TRANSCRIPT_WINDOW_ROWS);
    expect(small.reads).toBe(DIRECT_TRANSCRIPT_WINDOW_ROWS);
    expect(large.reads).toBe(small.reads);
    expect(small.sources).toBe(DIRECT_TRANSCRIPT_WINDOW_ROWS);
    expect(large.sources).toBe(small.sources);
    expect(large.stamps).toBe(1);
  });

  it("a copy inside the window whose original was deleted is left out, and the window reaches one line further", () => {
    const { real, db, copies } = copiesWorld(1_000);
    real.exec("DELETE FROM messages WHERE thread_id='worker' AND id='o999'");
    const judged = botWindow(db, botViewer("bot"), "lead", copies, directTranscriptWindowFull(REPLAY_BUDGET_CAP_BYTES, DIRECT_TRANSCRIPT_WINDOW_ROWS), TRANSCRIPT_EXAMINED_ROWS);
    expect(judged.window.map(row => row.id)).not.toContain("c999");
    expect(judged.window).toHaveLength(DIRECT_TRANSCRIPT_WINDOW_ROWS);
    expect(judged.window[0]!.id).toBe(`c${999 - DIRECT_TRANSCRIPT_WINDOW_ROWS}`);
    real.close();
  });

  it("linking a finished hand-off's copy (a reply link, a recipient) keeps every verdict; a withheld mark does not", () => {
    const { real, db, copies, count } = copiesWorld(1_000);
    const read = () => botMessages(db, botViewer("bot"), "lead", copies);
    read();
    const first = count.reads;
    real.exec(`UPDATE messages SET json=json_set(json,'$.replyToId','asker-msg','$.to',json('["Asker"]')) WHERE thread_id='lead'`);
    expect(read()).toHaveLength(1_000);
    expect(count.reads).toBe(first);
    // the memo is read again; the owner's note itself is not the door's judge (rule 17), a deleted original is
    real.exec(`UPDATE messages SET json=json_set(json,'$.withheldFromBots',json('true')) WHERE thread_id='worker' AND id='o5'`);
    expect(read().map(row => row.id)).toContain("c5");
    expect(count.reads).toBeGreaterThan(first);
    real.exec(`DELETE FROM messages WHERE thread_id='worker' AND id='o5'`);
    expect(read().map(row => row.id)).not.toContain("c5");
    real.close();
  });

  it("the direct turn and the room render both judge their transcript through the window", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    // the direct turn judges only the newest text lines of the branch, read from the line index in a doubling window (turnctx), never the active path
    expect(index).toMatch(/store\.activeTextLines\(threadId, window\)[^]*?botMessages\(database\(\), botViewer\(bot\.id\), threadId, branchTail\.messages\)/);
    expect(index).not.toMatch(/partitionTranscript(Messages|Window)\(/);
    const room = index.slice(index.indexOf("function renderRoomContext("), index.indexOf("// comms bus: passed into the visibility helpers"));
    expect(room).toMatch(/botWindow\(database\(\), botViewer\(botId\), threadId, available,/);
  });
});

describe("hand-off endings (R9-03, R9-04, R9-05, F3)", () => {
  const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });
  beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); });

  function world() {
    const store = new Store(selection);
    const asker = store.createBot({ name: "Asker" }, { seedMessages: false }), worker = store.createBot({ name: "Worker" }, { seedMessages: false });
    configureResultEgress({
      message: (threadId, id) => store.messageById(threadId, id),
      authorize: () => ({ ok: true }), copyOriginWithheld: () => false, capturedMessageWithheld: () => false, messageSourceForgotten: () => false,
      messageMadeWithMemory: () => false, partitionAllowed: () => true, ownUnsharedWork: () => true,
    });
    configureStatusRoster(name => store.bots.some(bot => bot.name === name));
    const ask = (key: string): RoomRequest => insertRoomRequest(database(), {
      groupId: "g", verb: "ask", fromKind: "bot", fromBotId: asker.id, toBotId: worker.id, targetThreadId: worker.threadId, admissionKey: key, now: 1, state: "running",
      lineage: { rootThreadId: asker.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false },
    }).request;
    return { store, asker, worker, ask };
  }

  it("R9-03: a shared run that failed after writing part of an answer delivers it marked unfinished, and its receipt keeps how it ended", () => {
    const { store, asker, worker, ask } = world();
    const request = ask("ask:partial");
    const partial = store.appendMessage(worker.threadId, { role: "bot", kind: "text", text: "PARTIAL WORK ONLY" });
    finishRequestTurn(database(), request.id, { ok: false, now: 2, resultMessageId: partial.id, ending: status("delegated_turn_failed", { why: "auth" }), diagnostic: "401 from the provider" });
    const finished = roomRequest(database(), request.id)!;
    expect(finished.state).toBe("failed");
    runDeliverSharedResult({ store: boundaryStore(store), rows: new RowSink(store), comms: { reply: () => undefined, clearFinishing: () => undefined } as never }, finished);
    const row = store.messagesFor(asker.threadId).find(message => message.requestId === request.id)!;
    expect(row.text).toContain("PARTIAL WORK ONLY");
    expect(row.text).toMatch(/^\(Delegated turn did not finish: it is not signed in to its provider\. It did not finish; its partial reply follows\)/);
    expect(row.copyOf).toEqual({ threadId: worker.threadId, messageIds: [partial.id] });
    const receipt = findDelegationReceipt(request.id)!;
    expect(receipt.status).toBe("failed");
    expect(receipt.resultStatus).toEqual({ key: "delegated_turn_failed", data: { why: "auth" } });
    expect(outboundWords(statusFromStored(receipt.resultStatus!.key, receipt.resultStatus!.data)!)).toBe("Delegated turn did not finish: it is not signed in to its provider");
    // the diagnostic's words, not the digits "401" (a random id can hold them: 1.0.3 CI run 39361461617, "...631401b8...")
    expect(JSON.stringify(receipt)).not.toContain("401 from the provider");
    expect(JSON.stringify(receipt)).not.toMatch(/\b401\b/);
  });

  it("R9-04: 'Paused: N team steps' and the other fixed queue reasons keep their status key in the bot's receipt", () => {
    const { worker } = world();
    const paused = queueClosedStatus("root_cap", worker.id)!;
    expect(outboundWords(paused)).toMatch(/^Paused: \d+ team steps since your last message\. Say continue\.$/);
    recordDelegationReceipt({ id: "closed-1", sourceThreadId: "t", toBotId: worker.id, toBotName: worker.name, status: "failed", result: paused, lineage: true });
    const kept = findDelegationReceipt("closed-1")!;
    expect(kept.resultStatus?.key).toBe("queue_paused_steps");
    expect(outboundWords(statusFromStored(kept.resultStatus!.key, kept.resultStatus!.data)!)).toBe(outboundWords(paused));
    expect(outboundWords(statusFromStored("queue_closed", { name: worker.name, why: "sharing_removed" })!)).toBe("Worker is no longer shared with this team.");
    expect(statusFromStored("queue_closed", { name: worker.name, why: "/private/OWNER-PLAN.txt" })).toBeUndefined();
    const shared = readFileSync(new URL("./shared-work.ts", import.meta.url), "utf8");
    // pm-sends x evhand: both refusals (admission and authorization) become one "cancel" verdict, settled with the status key (settleShared)
    expect(shared).toMatch(/return decision\.retry === "never" \? \{ kind: "cancel", note: decision\.reason, line: decision\.line \}/);
    expect(shared).toMatch(/\{ kind: "cancel", note: allowed\.code, line: allowed\.line \}/);
    expect(shared).toMatch(/case "cancel": \{ const ended = row\.toBotId \? queueClosedStatus\(verdict\.note, row\.toBotId\) : undefined;[^\n]*recordClosedSharedDelegation\(row, verdict\.line, database\(\), ended\); deps\?\.closed\(row, verdict\.line\);/);
  });

  it("R9-05: a correction reaches the project room only as its status; a legacy correction's stored words never do", () => {
    const { store, asker, worker, ask } = world();
    const request = ask("ask:card");
    const result = store.appendMessage(worker.threadId, { role: "bot", kind: "text", text: "the card's result" });
    store.appendMessage(worker.threadId, { role: "bot", kind: "activity", actorKind: "murage", replyToId: result.id, tool: { name: "On record: PRIVATE CRITERION from the owner's plan", ok: true } } as never);
    const deliver = () => {
      const lines: string[] = [];
      const view = { ...boundaryStore(store), saveCardSummary: () => undefined, projectCard: () => null, cardTitle: () => "'Card'" as never, leadName: () => "Lead" as never };
      runDeliverCardResult({ rows: new RowSink({ appendMessage: (_thread, message, id) => ({ ...message, id: id ?? `row-${lines.length}`, at: 1 }) as Message }),
        roomMurageLine: (_thread, text: Outbound) => { lines.push(outboundWords(text)); return null; }, roomRequestStillOwnerAudience: () => true, store: view as never },
      { request, bot: worker as never, group: { id: "g", threadId: asker.threadId } as never, card: { id: "card-1" } as never, threadId: worker.threadId, resultId: result.id, reviewRun: null });
      return lines.join("\n");
    };
    const legacy = deliver();
    expect(legacy).not.toContain("PRIVATE CRITERION");
    expect(legacy).toContain("result for 'Card'");
    // a status correction (rule 21) is copied as its status: the table's words for its counts, never the row's stored words
    store.appendMessage(worker.threadId, { role: "bot", kind: "activity", actorKind: "murage", replyToId: result.id, tool: { name: "On record: PRIVATE stored words", ok: true },
      murage: { kind: "status", status: { key: "criteria_claim_corrected", data: { met: 0, total: 1 } } } } as never);
    const room = deliver();
    expect(room).toContain("On record: 0 of 1 done criteria met.");
    expect(room).not.toContain("PRIVATE");
  });

  it("F3: a queued hand-off cancelled before it ran reads as cancelled, never as finished", () => {
    for (const note of ["cancelled by you", "team-deleted", "sharing-removed", "project closing", "cancelled with the request that asked", null]) {
      expect(outboundWords(cancelledEnding(note))).toBe("cancelled");
    }
    expect(outboundWords(cancelledEnding("no such bot"))).toBe("no such bot");
    // the queued hand-off's admission moved to the dispatch (handoff-dispatch.ts decide)
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const dispatch = readFileSync(new URL("./handoff-dispatch.ts", import.meta.url), "utf8");
    expect(dispatch).toMatch(/receipt: \{ status: "cancelled", result: cancelledEnding\(request\.outcomeNote\) \}/);
    for (const source of [index, dispatch]) expect(source).not.toMatch(/statusFromNote\((askRow|request)\.outcomeNote \?\? "cancelled"\)/);
  });
});
