// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 lifecycle card (Sean's 1.0.2 logs, Claude engine): a routine's card patched to Completed in a thread with an open owner turn was
// attached to that turn (message-db.ts: every generated row while a turn runs), so a pending window on the owner turn's parents opened an
// inherit revoke with the owner's turn as its child at the card's old position: the owner's prompt read "checking", the dispatch was refused
// with MEMORY_CONTEXT_REVOKED, the re-dispatch too, and the owner's session was reset. A row Murage writes is never a turn's engine output:
// it gets only the refs of what it quotes, and no write makes another actor's open turn its inherit child. The real writers (message-db.ts
// appendMessage / updateMessage on the app's database) with the real lineage and revoke code.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb, readMessage, updateMessage } from "../message-db.ts";
import type { Message } from "../store.ts";
import { denyLookup, refsLookup } from "./deny-read.ts";
import { addTurnParents, bindProviderTurn, closeTurnLineage, memberTurnId, openTurnLineage, writeSessionLineage } from "./lineage-write.ts";
import { turnChildRef, type TurnLineage } from "./lineage-types.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { lineOf } from "./revoke-marker.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";
import { murageLine } from "../murage-line.ts";
import { imageOutputRow } from "../output-publication.ts";
import { TURN_STOPPED_NOTE } from "../turn-outcome.ts";
import { BrowserExtensionApprovals } from "../browser-extension-approvals.ts";
import { cancelPeerApprovalsFor, requestEventLimitApproval, requestPeerApproval, type ApprovalBus } from "../peer-approval.ts";
import { BrowserExtensionSetup } from "../browser-extension-setup.ts";
import { mirrorExchange, mirrorReply, type CommsBus } from "../comms-visibility.ts";
import { released } from "../testing/released.ts";
import { createOutputPublisher } from "../output-publication.ts";
import { Store, type BotRecord } from "../store.ts";
import { ensureTaskWorkspace } from "../workspace.ts";
import { randomUUID } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";

const P = "parent-conversation", E = "routine-run-thread";
const owner = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text: id, at: Date.now(), ...extra });
const card = (status: "running" | "completed", extra: Partial<Message> = {}, summary?: string): Message => ({
  id: "card", role: "bot", kind: "routine.run", at: Date.now(), text: status === "running" ? "Running" : "Completed",
  routineRun: { runId: "run-1", routineId: "routine-1", routineName: "Daily check", status, executionThreadId: E, ...(summary ? { summary } : {}) }, ...extra,
});

let opened: TurnLineage[] = [];
function reset(): void { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }
// The app's database is built once per file, not once per test: its schema and every table the writers create on first use (messages and
// their search index, the write revision, hand-offs, project settings, ...) cost a fully synced commit each, and on a loaded machine the
// first test spent seconds there. Each test starts from a copy of that built, certified file.
const TEMPLATE = `${DATA_DIR}.murage-row-lineage.db`;
beforeAll(() => {
  reset();
  new WritetimeFixture(database()).cert(true);
  appendMessage("warm-up", owner("w1"));
  appendMessage("warm-up", { ...card("running"), parentId: "w1" });
  updateMessage("warm-up", { ...card("completed", {}, "done"), parentId: "w1" });
  appendMessage("warm-up", { id: "w2", role: "bot", kind: "activity", at: Date.now(), parentId: "card", tool: { name: "Read", ok: true } });
  // (the fixture's room scopes carry audience '{}'; the app writes an array, and reopening a file checks that shape)
  database().exec("UPDATE memory_scopes SET audience='[]' WHERE json_type(audience)<>'array'");
  rmSync(TEMPLATE, { force: true });
  database().prepare("VACUUM INTO ?").run(TEMPLATE);
  reset();
});
afterAll(() => { reset(); rmSync(TEMPLATE, { force: true }); });
beforeEach(() => { reset(); opened = []; copyFileSync(TEMPLATE, join(DATA_DIR, "messages.db")); });
afterEach(() => { for (const turn of opened) closeTurnLineage(turn); opened = []; });

const lsnOf = (thread: string, id: string) => lineOf(database(), thread, id)!.lsn;
const tx = (work: () => void) => { database().exec("BEGIN IMMEDIATE"); try { work(); database().exec("COMMIT"); } catch (error) { database().exec("ROLLBACK"); throw error; } };
/** The owner turn's parent is a line of another conversation whose revoke is in flight (the window the lineage backfill's walk holds). */
function pendingParent(): number {
  appendMessage(P, owner("p1"));
  return pendingWindow();
}
/** The revoke of p1 (already written) starts walking now. */
function pendingWindow(): number {
  const R = 50;
  database().prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'line',?,?,?,'mark','','active')").run(R, JSON.stringify({ kind: "line", cause: "forget" }), lsnOf(P, "p1"), lsnOf(P, "p1"));
  database().prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,?,?)").run(P, lsnOf(P, "p1"), R);
  return R;
}
/** The owner turn, opened when its prompt is built, running in session claude/s-own and handed p1. */
function ownerTurn(T: string, shape: "direct" | "room" | "late handback"): TurnLineage {
  const turn = openTurnLineage(database(), { threadId: T, turnId: shape === "late handback" ? "t-1" : memberTurnId("bot-a") });
  opened.push(turn);
  if (shape === "room") opened.push(openTurnLineage(database(), { threadId: T, turnId: memberTurnId("bot-b") }));
  // late handback: the turn id came back first and the prompt was written later; a line landed in between
  if (shape === "late handback") appendMessage(T, owner("u2", { parentId: "card" }));
  // the session the turn resumes, then what the turn is handed (a frame, a lookup: addTurnParents)
  tx(() => writeSessionLineage(database(), { threadId: T, driverInstance: "claude", nativeSession: "s-own" }, turn));
  addTurnParents(turn, [{ kind: "line", threadId: P, messageId: "p1" }]);
  return turn;
}
const sessionRow = (T: string) => database().prepare("SELECT first_lsn AS f,last_lsn AS l FROM memory_session_lineage WHERE thread_id=? AND native_session='s-own'").get(T) as { f: number; l: number };
const count = (sql: string, ...args: string[]) => Number((database().prepare(sql).get(...args) as { n: number }).n);
/** What a refusal reads: the owner's prompt (its thread read up to its head) and the reset of its session. */
function expectOwnerTurnUntouched(T: string, turn: TurnLineage, session: { f: number; l: number }): void {
  expect(refsLookup(database(), [{ kind: "prefix", threadId: T, headLsn: turn.turnLsn }], CONTENT), "the owner's prompt still reads shown: no refusal").toEqual({ state: "shown" });
  expect(count("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=? AND since_lsn<=?", T, String(turn.turnLsn)), "no hold on the owner's prompt").toBe(0);
  expect(count("SELECT count(*) AS n FROM memory_deny_session WHERE thread_id=?", T), "no deny_session").toBe(0);
  expect(sessionRow(T), "the card did not advance the owner's session").toEqual(session);
}

describe("a row Murage writes is never attached to an open turn", () => {
  for (const shape of ["direct", "room", "late handback"] as const) it(`${shape}: a routine completing while the owner's turn waits on a pending window is no refusal and no deny_session`, () => {
    const T = `lifecycle-${shape.replace(" ", "-")}`;
    pendingParent();
    appendMessage(E, owner("e1"));
    appendMessage(T, owner("u1"));
    const from = shape === "room" ? { from: { botId: "bot-a", name: "A", color: "#000" } } : {};
    appendMessage(T, { ...card("running", from), parentId: "u1" }); // the card the routine's creation posted
    const turn = ownerTurn(T, shape);
    const session = sessionRow(T);
    updateMessage(T, { ...card("completed", from, "All good"), parentId: "u1" }); // syncRoutineRunToSource: the card turned Completed
    // Murage's own status line, posted while the turn runs (no member named in a room: before, every open turn of the thread merged)
    appendMessage(T, { id: "status", role: "bot", kind: "text", text: "Queued", at: Date.now(), actorKind: "murage", murage: { kind: "status" }, parentId: shape === "late handback" ? "u2" : "card" });
    expectOwnerTurnUntouched(T, turn, session);
    expect(count("SELECT count(*) AS n FROM memory_revoke_jobs WHERE kind='inherit'"), "no inherit revoke opened").toBe(0);
    expect(count("SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id<>50"), "no revoke of any kind").toBe(0);
  });

  // A voice note's words are the bot's own: written with the producing turn's id it is that turn's engine output, so it is withheld exactly
  // as the turn's text reply is when the turn's inputs are revoked; with no producing turn (a replay) it is a Murage line.
  it("a voice note from a turn is held like that turn's text reply when its inputs are revoked; one with no turn is not attached to it", () => {
    const T = "voice-note-lineage";
    const R = pendingParent();
    appendMessage(T, owner("u1"));
    const turn = ownerTurn(T, "direct");
    bindProviderTurn(turn, "prov-v");
    const reply: Message = { id: "r1", role: "bot", kind: "text", text: "Here you go.", at: Date.now(), parentId: "u1", turnId: "prov-v" };
    appendMessage(T, reply);
    appendMessage(T, { ...reply, id: "vn", text: "Spoken words.", artifactIds: ["a1"], parentId: "r1" }); // createVoiceNote with turnId
    const state = (id: string) => denyLookup(database(), { threadId: T, lines: [{ messageId: id, author: "generated" }] }, CONTENT).get(id)?.state;
    expect(state("r1")).toBe("checking");
    expect(state("vn"), "the voice note is held exactly as the text reply").toBe(state("r1"));
    // the pending window reaches the thread no earlier than the turn's head and no later than its first output line, so it covers both lines
    const since = Number(database().prepare("SELECT min(since_lsn) AS s FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?").get(T, R)!.s);
    expect(since).toBeGreaterThanOrEqual(turn.turnLsn);
    expect(since).toBeLessThanOrEqual(lineOf(database(), T, "r1")!.lsn);
    // a replay (no producing turn) in a thread of its own is a Murage line resting on no turn's inputs
    const R2 = "voice-replay";
    appendMessage(R2, owner("q1"));
    appendMessage(R2, murageLine({ ...reply, id: "replay", text: "Replayed.", artifactIds: ["a2"], parentId: "q1", turnId: undefined }));
    expect(denyLookup(database(), { threadId: R2, lines: [{ messageId: "replay", author: "generated" }] }, CONTENT).get("replay")?.state).toBe("shown");
  });

  // A generated image's row is the bot's own output: written by imageOutputRow with the producing turn's id it is that turn's engine output,
  // held like its text reply when the turn's inputs are revoked; with no producing turn it is a Murage line resting on no turn.
  it("a generated image row from a turn is held like that turn's text reply when its inputs are revoked; one with no turn is not", () => {
    const T = "image-row-lineage";
    pendingParent();
    appendMessage(T, owner("u1"));
    const turn = ownerTurn(T, "direct");
    bindProviderTurn(turn, "prov-i");
    const reply: Message = { id: "r1", role: "bot", kind: "text", text: "Here it is.", at: Date.now(), parentId: "u1", turnId: "prov-i" };
    appendMessage(T, reply);
    const image = { role: "bot" as const, kind: "text" as const, text: "Generated image", attachments: [{ kind: "image" as const, path: "/a/i.png", mime: "image/png" }] };
    appendMessage(T, { id: "img", at: Date.now(), parentId: "r1", ...imageOutputRow(image, "prov-i") });
    const state = (thread: string, id: string) => denyLookup(database(), { threadId: thread, lines: [{ messageId: id, author: "generated" }] }, CONTENT).get(id)?.state;
    expect(state(T, "r1")).toBe("checking");
    expect(state(T, "img"), "the image is held exactly as the text reply").toBe(state(T, "r1"));
    const R2 = "image-no-turn";
    appendMessage(R2, owner("q1"));
    appendMessage(R2, { id: "img2", at: Date.now(), parentId: "q1", ...imageOutputRow(image, undefined) });
    expect(state(R2, "img2")).toBe("shown");
  });

  // An image approval line or card quotes the model's prompt (it may be built from memory): marked murageLine with the producing turn's id,
  // it rests on that turn's inputs and is withheld with them, without becoming the turn's output; with no turn named it rests on none.
  for (const kind of ["activity", "options"] as const) it(`an image approval ${kind === "options" ? "card" : "line"} quoting the model's prompt is withheld when its turn's inputs are revoked`, () => {
    const T = `image-approval-${kind}`;
    pendingParent();
    appendMessage(T, owner("u1"));
    const turn = ownerTurn(T, "direct");
    bindProviderTurn(turn, "prov-a");
    const session = sessionRow(T);
    const prompt = "A portrait of the owner's dog Biscuit";
    const row: Omit<Message, "id" | "at"> = kind === "options"
      ? { role: "bot", kind, card: { title: "Approve image generation", subtitle: "One image", held: prompt, options: ["Allow", "Deny"], requestId: "image-1", tool: "generate_image" } }
      : { role: "bot", kind, tool: { name: "Making an image without asking (level)", ok: true, imageRecord: { summary: "1 image", prompt } } };
    appendMessage(T, { id: "ask", at: Date.now(), parentId: "u1", ...murageLine({ ...row, turnId: "prov-a" }) });
    const state = (thread: string, id: string) => denyLookup(database(), { threadId: thread, lines: [{ messageId: id, author: "generated" }] }, CONTENT).get(id)?.state;
    expect(state(T, "ask"), "the prompt is withheld with the turn's inputs").toBe("checking");
    expect(sessionRow(T), "Murage's card never advances the turn's session").toEqual(session);
    const R2 = `${T}-no-turn`;
    appendMessage(R2, owner("q1"));
    appendMessage(R2, { id: "ask2", at: Date.now(), parentId: "q1", ...murageLine({ ...row, turnId: undefined }) });
    expect(state(R2, "ask2")).toBe("shown");
  });

  // The browser approval card's summary carries the model's words (typed text, an address it chose). The real approvals class writes it
  // through the real message database; it names the turn running now (turnOf, the server's own turn state), so revoking that turn's inputs
  // withholds it, and it never becomes the turn's output or advances the turn's session. With no turn running it rests on none.
  for (const running of [true, false]) it(`a browser approval card quoting the model is ${running ? "withheld when its turn's inputs are revoked" : "shown when no turn is running"}`, () => {
    const T = `browser-approval-${running ? "turn" : "none"}`;
    pendingParent();
    appendMessage(T, owner("u1"));
    const turn = ownerTurn(T, "direct");
    bindProviderTurn(turn, "prov-b");
    const session = sessionRow(T);
    const bus = { store: { appendMessage: (thread: string, row: Omit<Message, "id" | "at">) => { const written = { id: "bcard", at: Date.now(), parentId: "u1", ...row } as Message; appendMessage(thread, written); return written; }, messageById: () => undefined, patchMessage: () => null }, broadcast: () => {} } as unknown as ApprovalBus;
    const approvals = new BrowserExtensionApprovals(bus, { turnOf: thread => (running && thread === T ? "prov-b" : undefined) });
    void approvals.ask({ bot: { id: "bot-a", name: "Mira", color: "blue" }, threadId: T, bindingId: "binding", generation: 1, digest: "a".repeat(64), summary: "Type \"the owner's dog Biscuit\" into the search box", waitMs: 1000 });
    const state = denyLookup(database(), { threadId: T, lines: [{ messageId: "bcard", author: "generated" }] }, CONTENT).get("bcard")?.state;
    expect(state).toBe(running ? "checking" : "shown");
    expect(sessionRow(T), "Murage's card never advances the turn's session").toEqual(session);
    approvals.cancelBinding("binding");
  });

  // The other writers that carry a bot's or model's words each name the producing turn the same way (turnOf: the server's own turn state), and
  // each is run for real against the real message database: revoking the turn's inputs withholds the row; with no turn running it rests on none.
  /** A store whose appends go to the real message database, with the ids the test names. */
  const realStore = (ids: string[]) => {
    const last = new Map<string, string>();
    const written = (thread: string, row: Omit<Message, "id" | "at">) => { const message = { id: ids.shift() ?? randomUUID(), at: Date.now(), parentId: last.get(thread) ?? "u1", ...row } as Message; appendMessage(thread, message); last.set(thread, message.id); return message; };
    return { appendMessage: written, messageById: () => undefined, patchMessage: () => null, patchGroup: () => undefined, groupByThread: () => undefined, group: () => undefined, bot: () => undefined } as never;
  };
  const turnInThread = (T: string, window = true) => { if (window) pendingParent(); else appendMessage(P, owner("p1")); appendMessage(T, owner("u1")); const turn = ownerTurn(T, "direct"); bindProviderTurn(turn, `prov-${T}`); return { turn, session: sessionRow(T) }; };
  const stateOf = (thread: string, id: string) => denyLookup(database(), { threadId: thread, lines: [{ messageId: id, author: "generated" }] }, CONTENT).get(id)?.state;
  const bot = (id: string): BotRecord => ({ id, name: "Mira", color: "blue", threadId: "unused", alwaysAllow: [] }) as unknown as BotRecord;

  for (const running of [true, false]) it(`a peer-approval card quoting the bot's message and an event-limit card are ${running ? "withheld when the turn's inputs are revoked" : "shown when no turn is running"}`, () => {
    const T = `peer-approval-${running ? "turn" : "none"}`;
    const { session } = turnInThread(T);
    const bus = { store: realStore(["pcard", "lcard"]), broadcast: () => {}, turnOf: (thread: string) => (running && thread === T ? `prov-${T}` : undefined) } as unknown as ApprovalBus;
    void requestPeerApproval(bus, bot("bot-a"), { ...bot("bot-t"), name: "Target" }, "Tell them the owner's dog is Biscuit", "ask_bot", T);
    void requestEventLimitApproval(bus, bot("bot-a"), "handoff", 3, "ev-1", T, "Target");
    expect(stateOf(T, "pcard")).toBe(running ? "checking" : "shown");
    expect(stateOf(T, "lcard")).toBe(running ? "checking" : "shown");
    expect(sessionRow(T), "Murage's cards never advance the turn's session").toEqual(session);
    cancelPeerApprovalsFor("bot-a");
  });

  // The room copy of a bot's message is the sender's bot row naming its source row by copyOf (LINEAGE-DESIGN-S6 rule 6): the sender's
  // "Messaged" row, the sending turn's engine row, written before the copy (an immediate send) or when the hand-off was queued.
  for (const running of [true, false]) it(`a bot's message mirrored into the room is ${running ? "withheld when its sending turn's inputs are revoked" : "shown when no turn is running"}`, () => {
    const T = `comms-${running ? "turn" : "none"}`, CH = `${T}-room`;
    const { session } = turnInThread(T);
    // with no turn running the message is sent from a conversation no turn is open in
    const source = running ? T : `${T}-quiet`;
    if (!running) appendMessage(source, owner("u1"));
    const store = realStore(["chip", "mirror"]);
    const bus = { store, broadcast: () => {}, turnOf: (thread: string) => (running && thread === T ? `prov-${T}` : undefined) } as unknown as CommsBus;
    // the source row and the room copy are written first; the target-side chip needs the full audience store, which this test does not build
    try { mirrorExchange(bus, bot("bot-a"), { ...bot("bot-t"), name: "Target" }, "Tell them the owner's dog is Biscuit", { id: "g", threadId: CH } as never, source); } catch (error) { expect(String(error)).toContain("HUMAN_TASK_UNAVAILABLE"); }
    expect(readMessage(CH, "mirror")?.copyOf).toEqual({ threadId: source, messageIds: ["chip"] });
    expect(stateOf(CH, "mirror")).toBe(running ? "checking" : "shown");
    // the source row is the sending turn's own line; the copy adds nothing to its session
    if (running) expect(sessionRow(T).l).toBe(lsnOf(T, "chip"));
    else expect(sessionRow(T)).toEqual(session);
  });

  // A hand-off queued by a turn can start after that turn ended, after 16 later provider turns or after a restart: its source row was written when it
  // was queued, so the room copy rests on the turn that sent the message, never on the turn running in the source thread when the copy is written.
  for (const shape of ["its turn ended", "17 later turns ran", "no turn ran", "the item predates the field"] as const) it(`a queued hand-off's room copy: ${shape}`, () => {
    const T = `queued-${shape.replace(/\W+/g, "-")}`, CH = `${T}-room`;
    const { turn } = turnInThread(T);
    const source = shape === "no turn ran" ? `${T}-quiet` : T;
    if (shape === "no turn ran") appendMessage(source, owner("u1"));
    const store = realStore(["source", "queued"]);
    // queue time: the sender's Messaged row (delegations.ts queueDelegation)
    const sent = store as unknown as { appendMessage(thread: string, row: Omit<Message, "id" | "at">): Message };
    const sourceId = shape === "the item predates the field" ? undefined
      : sent.appendMessage(source, { role: "bot", kind: "activity", tool: { name: "Messaged @Target" }, from: { botId: "bot-a", name: "Mira", color: "blue" }, ...(shape === "no turn ran" ? {} : { turnId: `prov-${T}` }) }).id;
    if (shape === "17 later turns ran") for (let i = 0; i < 17; i++) { const later = openTurnLineage(database(), { threadId: T, turnId: memberTurnId("bot-c") }); opened.push(later); bindProviderTurn(later, `prov-later-${i}`); }
    if (shape === "its turn ended" || shape === "17 later turns ran") closeTurnLineage(turn);
    const bus = { store, broadcast: () => {}, turnOf: (thread: string) => (thread === T ? "prov-later" : undefined) } as unknown as CommsBus;
    try { mirrorExchange(bus, bot("bot-a"), { ...bot("bot-t"), name: "Target" }, "Tell them the owner's dog is Biscuit", { id: "g", threadId: CH } as never, source, undefined, "question", { sourceMessageId: sourceId }); } catch (error) { expect(String(error)).toContain("HUMAN_TASK_UNAVAILABLE"); }
    if (shape === "the item predates the field") {
      // the legacy item: Murage's withheld line in the room, never the message
      const line = readMessage(CH, "queued");
      expect(JSON.stringify(line)).not.toContain("Biscuit");
      expect(line?.murage?.status?.key).toBe("withheld");
      return;
    }
    expect(readMessage(CH, "queued")?.copyOf).toEqual({ threadId: source, messageIds: [sourceId] });
    expect(stateOf(CH, "queued")).toBe(shape === "no turn ran" ? "shown" : "checking");
  });

  for (const running of [true, false]) it(`a reply copy mirrored into the room is ${running ? "withheld when the replying turn's original is revoked" : "shown when its original rests on no turn"}`, () => {
    const T = `reply-${running ? "turn" : "none"}`, CH = `${T}-room`;
    turnInThread(T);
    // the original reply, written by the producing turn (in its thread), or by no turn (in a thread with none open); the copy is mirrored from it
    const home = running ? T : `${T}-worker`;
    if (!running) appendMessage(home, owner("w1"));
    appendMessage(home, { id: "orig", role: "bot", kind: "text", text: "The owner's dog is Biscuit", at: Date.now(), parentId: running ? "u1" : "w1", ...(running ? { turnId: `prov-${T}` } : {}) });
    const session = sessionRow(T);
    const copyOf = { threadId: home, messageIds: ["orig"] };
    const store = Object.assign(realStore(["copy"]) as object, { messageById: (thread: string, id: string) => (thread === home && id === "orig" ? { id, turnId: running ? `prov-${T}` : undefined } : undefined) });
    mirrorReply({ store, broadcast: () => {} } as unknown as CommsBus, { ...bot("bot-t"), name: "Target" }, released("The owner's dog is Biscuit", copyOf), { id: "g", threadId: CH } as never, copyOf);
    expect(stateOf(CH, "copy")).toBe(running ? "checking" : "shown");
    expect(sessionRow(T), "the reply copy never advances the turn's session").toEqual(session);
  });

  // The output cards a recovery writes after a restart name the turn the receipt recorded when the file was saved (the capability's own turn
  // state is gone with the process); a receipt that recorded none has its card withheld.
  for (const recorded of [true, false]) it(`a saved-file card written by recovery after a restart is ${recorded ? "withheld when its recorded turn's inputs are revoked" : "withheld because no turn was recorded"}`, async () => {
    const dataStore = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const owned = dataStore.createBot();
    const T = owned.threadId;
    const { session } = turnInThread(T, false);
    const workspace = ensureTaskWorkspace(owned.id, T);
    const scope = { botId: owned.id, botName: owned.name, threadId: T, workspaceRoot: workspace };
    // the first run saves the file, but the card cannot be written then (the transcript is unavailable)
    const down = Object.assign(Object.create(dataStore) as Store, { appendMessage: () => { throw new Error("transcript unavailable"); } });
    const first = createOutputPublisher({ dataDir: DATA_DIR, database, store: down, artifactScopes: () => [scope] });
    expect(first.beforeDispatch({ botId: owned.id, threadId: T, runId: randomUUID(), workspaceRoot: realpathSync(workspace), managed: true })).toBe(true);
    mkdirSync(join(workspace, "outputs"), { recursive: true });
    writeFileSync(join(workspace, "outputs", "dog-Biscuit-notes.md"), "notes");
    await first.publishTerminalOutputs({ type: "turn.completed", ok: true, threadId: T, eventId: randomUUID(), ...(recorded ? { turnId: `prov-${T}` } : {}) } as never);
    // the restart: a new publisher over the same database, and a capability state that knows no turn
    const cards: Message[] = [];
    const landing = Object.assign(Object.create(dataStore) as Store, { appendMessage: (thread: string, row: Omit<Message, "id" | "at">) => { pendingWindow(); const message = { id: randomUUID(), at: Date.now(), parentId: "u1", ...row } as Message; appendMessage(thread, message); cards.push(message); return message; } });
    const second = createOutputPublisher({ dataDir: DATA_DIR, database, store: landing, artifactScopes: () => [scope], turnOfRun: () => undefined });
    await second.resumePending();   // async on int/1.0.3 (the recheck after the awaited attachment step)
    const card = cards.find(message => message.text?.startsWith("Saved file"));
    if (!recorded) { expect(card, "no recorded turn: the card is withheld, not shown unattributed").toBeUndefined(); return; }
    expect(card?.turnId).toBe(`prov-${T}`);
    expect(stateOf(T, card!.id)).toBe("checking");
    expect(sessionRow(T), "Murage's card never advances the turn's session").toEqual(session);
  });

  for (const running of [true, false]) it(`the browser setup card quoting the bot's reason is ${running ? "withheld when its turn's inputs are revoked" : "shown when no turn is running"}`, () => {
    const T = `browser-setup-${running ? "turn" : "none"}`;
    const { session } = turnInThread(T);
    const written = realStore(["scard"]) as unknown as { appendMessage: (t: string, r: Omit<Message, "id" | "at">) => Message };
    const store = { ...written, keyedCards: () => [], keyedCardsEverywhere: () => [], newestMatching: () => ({ id: "u1" }), bots: () => [], groups: () => [] };
    const setup = new BrowserExtensionSetup({ store: store as never, owner: () => bot("bot-a"), startHelper: async () => undefined, status: () => ({ profiles: [], bindings: [] }), optIn: () => {}, continueTask: async () => {}, turnOf: thread => (running && thread === T ? `prov-${T}` : undefined) });
    setup.request("bot-a", T, "I need your signed-in browser to read the owner's dog Biscuit's vet page");
    expect(stateOf(T, "scard")).toBe(running ? "checking" : "shown");
    expect(sessionRow(T), "Murage's card never advances the turn's session").toEqual(session);
  });

  for (const running of [true, false]) it(`the saved-file card naming the bot's file is ${running ? "withheld when its turn's inputs are revoked" : "shown when no turn can be named"}`, async () => {
    const dataStore = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const owned = dataStore.createBot();
    const T = owned.threadId;
    const { session } = turnInThread(T, false);
    const workspace = ensureTaskWorkspace(owned.id, T);
    const scope = { botId: owned.id, botName: owned.name, threadId: T, workspaceRoot: workspace };
    // the revoke's walk holds a pending window on the parent while the card is written (opened as the card lands: the store's own append would drain it before it is read)
    const cards: Message[] = [];
    const windowed = Object.assign(Object.create(dataStore) as Store, { appendMessage: (thread: string, row: Omit<Message, "id" | "at">) => { if (row.text?.startsWith("Saved file")) pendingWindow(); const message = { id: randomUUID(), at: Date.now(), parentId: "u1", ...row } as Message; appendMessage(thread, message); cards.push(message); return message; } });
    const publisher = createOutputPublisher({ dataDir: DATA_DIR, database, store: windowed, artifactScopes: () => [scope], turnOfRun: () => (running ? `prov-${T}` : undefined) });
    expect(publisher.beforeDispatch({ botId: owned.id, threadId: T, runId: randomUUID(), workspaceRoot: realpathSync(workspace), managed: true })).toBe(true);
    mkdirSync(join(workspace, "outputs"), { recursive: true });
    writeFileSync(join(workspace, "outputs", "dog-Biscuit-notes.md"), "notes");
    await publisher.publishTerminalOutputs({ type: "turn.completed", ok: true, threadId: T, eventId: randomUUID() } as never);
    const card = cards.find(message => message.text?.startsWith("Saved file"));
    expect(card?.turnId).toBe(running ? `prov-${T}` : undefined);
    expect(stateOf(T, card!.id)).toBe(running ? "checking" : "shown");
    expect(sessionRow(T), "Murage's card never advances the turn's session").toEqual(session);
  });

  it("a lifecycle card that quotes revoked content is withheld itself; the owner's turn is untouched", () => {
    const T = "lifecycle-quotes-revoked";
    appendMessage(E, owner("e1"));
    appendMessage(E, { id: "e2", role: "bot", kind: "text", text: "secret", at: Date.now(), parentId: "e1", turnId: "run-turn" });
    new WritetimeFixture(database()).denyLine(E, lsnOf(E, "e2"), 77); // the run's reply was forgotten (its job is gone)
    appendMessage(T, owner("u1"));
    appendMessage(T, { ...card("running"), parentId: "u1" });
    const turn = ownerTurn(T, "direct");
    const session = sessionRow(T);
    updateMessage(T, { ...card("completed", {}, "secret"), parentId: "u1" });
    expectOwnerTurnUntouched(T, turn, session);
    expect(drainRevokeMarker(database()).pending).toBe(false);
    expect(denyLookup(database(), { threadId: T, lines: [{ messageId: "card", author: "generated" }] }, CONTENT).get("card")?.state, "the card quoting the forgotten reply is withheld").toBe("withheld");
    expectOwnerTurnUntouched(T, turn, session);
    expect(denyLookup(database(), { threadId: T, lines: [{ messageId: "u1", author: "owner" }] }, CONTENT).get("u1")?.state).toBe("shown");
  });

  it("an engine's own generated line still carries its turn and inherits its pending parent", () => {
    const T = "engine-line";
    const R = pendingParent();
    appendMessage(T, owner("u1"));
    const turn = ownerTurn(T, "direct");
    const reply: Message = { id: "r1", role: "bot", kind: "text", text: "hel", at: Date.now(), parentId: "u1", turnId: "provider-turn" };
    appendMessage(T, reply);
    updateMessage(T, { ...reply, text: "hello" }); // streamed growth inside its turn
    const at = lsnOf(T, "r1");
    expect(sessionRow(T).l, "the reply advanced its own session").toBe(at);
    expect(database().prepare("SELECT since_lsn AS s FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?").get(T, R), "the turn is held from the reply that carried it, above its prompt's head (1.0.2 Keep all P0)").toEqual({ s: at });
    expect(at).toBeGreaterThan(turn.turnLsn);
    expect(denyLookup(database(), { threadId: T, lines: [{ messageId: "r1", author: "generated" }] }, CONTENT).get("r1")?.state).toBe("checking");
  });

  // The same bot's earlier turn (never closed: a dispatch supersedes it) and the newer one its next dispatch opened, both open while the
  // newer prompt is built. A late line of the earlier turn used to merge the two (runningTurnFor over every open turn of the member) and so
  // made the newer turn an inherit child at the older turn's position: its prompt read "checking" and the dispatch was refused.
  /** bot-a's earlier turn (provider turn prov-1, handed p1, its reply r0 written) and its newer turn (prov-2, session s-own); then the
   * forget of p1 starts walking. */
  function twoTurns(T: string): { older: TurnLineage; newer: TurnLineage } {
    appendMessage(P, owner("p1"));
    appendMessage(T, owner("u1"));
    const older = openTurnLineage(database(), { threadId: T, turnId: memberTurnId("bot-a") });
    opened.push(older);
    addTurnParents(older, [{ kind: "line", threadId: P, messageId: "p1" }]);
    bindProviderTurn(older, "prov-1");
    appendMessage(T, { id: "r0", role: "bot", kind: "text", text: "earlier reply", at: Date.now(), parentId: "u1", turnId: "prov-1" });
    appendMessage(T, owner("u2", { parentId: "r0" }));
    const newer = openTurnLineage(database(), { threadId: T, turnId: memberTurnId("bot-a") });
    opened.push(newer);
    tx(() => writeSessionLineage(database(), { threadId: T, driverInstance: "claude", nativeSession: "s-own" }, newer));
    bindProviderTurn(newer, "prov-2");
    pendingWindow(); // the forget of p1 starts walking while both turns are open
    return { older, newer };
  }
  const turnCarries = (T: string) => [...new Set(database().prepare("SELECT c.child_ref AS ref FROM memory_lineage_carry c JOIN memory_thread_no k ON k.no=c.child_thread_no WHERE k.thread_id=? AND c.child_kind=1").all(T).map(row => String((row as { ref: string }).ref)))].sort();
  const promptShown = (T: string, turn: TurnLineage) => refsLookup(database(), [{ kind: "prefix", threadId: T, headLsn: turn.turnLsn }], CONTENT);

  for (const kind of ["stop", "error"] as const) it(`a ${kind} line written while the same bot has two open turns makes neither turn a child and causes no refusal`, () => {
    const T = `two-turns-${kind}`;
    const { older, newer } = twoTurns(T);
    const before = turnCarries(T);
    const session = sessionRow(T);
    // the line the event fold writes for the earlier provider turn's end (index.ts pushMessage stamps every such chip)
    const tool = kind === "stop" ? { name: TURN_STOPPED_NOTE, ok: true } : { name: "error: the engine stopped answering", ok: false };
    appendMessage(T, murageLine({ id: `late-${kind}`, role: "bot" as const, kind: "activity" as const, at: Date.now(), parentId: "u2", turnId: "prov-1", tool }));
    expect(turnCarries(T), "no turn was made a child").toEqual(before);
    expect(promptShown(T, newer), "the newer prompt still reads shown: no refusal").toEqual({ state: "shown" });
    expect(promptShown(T, older)).toEqual({ state: "shown" });
    expect(count("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=? AND since_lsn<=?", T, String(newer.turnLsn)), "no hold on either prompt").toBe(0);
    expect(count("SELECT count(*) AS n FROM memory_deny_session WHERE thread_id=?", T), "no deny_session").toBe(0);
    expect(sessionRow(T), "the line advanced no session").toEqual(session);
    // it still rests on what the turn it reports on was shown, as its own refs: held itself while that revoke walks
    expect(denyLookup(database(), { threadId: T, lines: [{ messageId: `late-${kind}`, author: "generated" }] }, CONTENT).get(`late-${kind}`)?.state).toBe("checking");
  });

  it("a line no turn id names, written while the same bot has two open turns, is attached to neither (no merge of the bot's open turns)", () => {
    const T = "two-turns-unnamed";
    const { newer } = twoTurns(T);
    const before = turnCarries(T);
    const session = sessionRow(T);
    appendMessage(T, { id: "unnamed", role: "bot", kind: "activity", at: Date.now(), parentId: "u2", tool: { name: "error: provider stop is unconfirmed", ok: false } });
    expect(turnCarries(T)).toEqual(before);
    expect(promptShown(T, newer)).toEqual({ state: "shown" });
    expect(count("SELECT count(*) AS n FROM memory_deny_pending WHERE thread_id=? AND since_lsn<=?", T, String(newer.turnLsn))).toBe(0);
    expect(sessionRow(T)).toEqual(session);
  });

  // The "Saved file" card (output-publication.ts) is written after turn.completed, while the bot's turn lineage is still open, with no turn
  // id: unmarked, writerTurnFor attached it to the member's one open turn and moved that turn's session past the reply, so a later hold
  // marked the session and the next dispatch read MEMORY_CONTEXT_REVOKED or reset. Marked, it is Murage's line and advances nothing.
  for (const marked of [true, false]) it(`a "Saved file" row written after turn.completed ${marked ? "does not advance" : "unmarked would advance"} the turn's session`, () => {
    const T = `saved-file-${marked ? "marked" : "unmarked"}`;
    appendMessage(T, owner("u1"));
    const turn = openTurnLineage(database(), { threadId: T, turnId: memberTurnId("bot-a") });
    opened.push(turn);
    tx(() => writeSessionLineage(database(), { threadId: T, driverInstance: "claude", nativeSession: "s-own" }, turn));
    bindProviderTurn(turn, "prov-1");
    appendMessage(T, { id: "r1", role: "bot", kind: "text", text: "done", at: Date.now(), parentId: "u1", turnId: "prov-1" });
    const session = sessionRow(T);
    expect(session.l, "the reply advanced its own session").toBe(lsnOf(T, "r1"));
    // turn.completed has been folded; the publication finishes afterwards and announces the saved file
    const row = { id: "saved", role: "bot" as const, kind: "text" as const, text: "Saved file: report.md", artifactIds: ["a1"], at: Date.now(), parentId: "r1" };
    appendMessage(T, marked ? murageLine(row) : row);
    if (marked) expect(sessionRow(T), "the saved-file row advanced no session").toEqual(session);
    else expect(sessionRow(T).l, "the unmarked row is taken for the turn's engine output").toBe(lsnOf(T, "saved"));
  });

  it("with two open turns an engine line inherits through the exact turn its provider turn names, never the earlier one", () => {
    const T = "two-turns-engine";
    const R = pendingParent();
    appendMessage(P, owner("p2", { parentId: "p1" }));
    appendMessage(T, owner("u1"));
    const older = openTurnLineage(database(), { threadId: T, turnId: memberTurnId("bot-a") });
    opened.push(older);
    addTurnParents(older, [{ kind: "line", threadId: P, messageId: "p2" }]);
    bindProviderTurn(older, "prov-1");
    appendMessage(T, owner("u2", { parentId: "u1" }));
    const newer = openTurnLineage(database(), { threadId: T, turnId: memberTurnId("bot-a") });
    opened.push(newer);
    tx(() => writeSessionLineage(database(), { threadId: T, driverInstance: "claude", nativeSession: "s-own" }, newer));
    addTurnParents(newer, [{ kind: "line", threadId: P, messageId: "p1" }]);
    bindProviderTurn(newer, "prov-2");
    expect(older.turnLsn).toBeLessThan(newer.turnLsn);
    const reply: Message = { id: "r2", role: "bot", kind: "text", text: "new", at: Date.now(), parentId: "u2", turnId: "prov-2" };
    appendMessage(T, reply);
    updateMessage(T, { ...reply, text: "newer reply" });
    expect(turnCarries(T), "the newer turn is the reply's turn child, the earlier is not").toEqual([turnChildRef(newer.turnLsn)]);
    expect(sessionRow(T).l, "the reply advanced its own session").toBe(lsnOf(T, "r2"));
    expect(database().prepare("SELECT since_lsn AS s FROM memory_deny_pending WHERE thread_id=? AND revoke_id=?").get(T, R), "held from the newer turn's reply, above its prompt's head (1.0.2 Keep all P0)").toEqual({ s: lsnOf(T, "r2") });
    expect(promptShown(T, older), "the earlier prompt is not held").toEqual({ state: "shown" });
    expect(denyLookup(database(), { threadId: T, lines: [{ messageId: "r2", author: "generated" }] }, CONTENT).get("r2")?.state).toBe("checking");
  });
});
