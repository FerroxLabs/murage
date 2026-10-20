// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LINEAGE-DESIGN-S6 test 31, the revocation matrix: every writer of a classified (Murage-voice) row writes into a project's room while a
// member's turn runs there; the owner then revokes that turn's input (a line of another conversation), and the revoke's walk finishes. Each
// bot-facing reader (replay: botMessages + botRowOf, as index.ts replayLines builds its lines; the room window: botWindow; project reads:
// readProjectPage with a bot reader) gives the reading bot each classified row absent or as its fixed-copy projection, never a stored word,
// and the human viewer (the door's human viewer, the owner's page) the row as stored. The real writers, the real message database, the real
// lineage write, revoke commit and walk. A control engine reply of the same turn proves the revoke reached the turn; the owner's message
// in the room proves the door still shows what it should.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { botMessages, botRowOf, botRows, botViewer, botWindow, fixedCopy, type Viewer } from "./bot-read.ts";
import { BrowserExtensionApprovals } from "./browser-extension-approvals.ts";
import { BrowserExtensionSetup } from "./browser-extension-setup.ts";
import { RowSink, writeActivityRow, writeBotRow } from "./bot-egress.ts";
import { mirrorExchange, mirrorMurageLine, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { setExecutionStore } from "./execution-audience.ts";
import { appendMessage, closeMessageDb, readMessage, updateMessage } from "./message-db.ts";
import { setMemoryCaptureRoster } from "./memory/capture-scope.ts";
import { denyLookup } from "./memory/deny-read.ts";
import { addTurnParents, bindProviderTurn, closeTurnLineage, memberTurnId, openTurnLineage, writeSessionLineage } from "./memory/lineage-write.ts";
import type { TurnLineage } from "./memory/lineage-types.ts";
import { drainRevokeMarker } from "./memory/memory-revocation.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { commitRevoke } from "./memory/revoke-commit.ts";
import { CONTENT, WritetimeFixture } from "./memory/testing/writetime-fixture.ts";
import { murageLine } from "./murage-line.ts";
import { status } from "./murage-status.ts";
import { isMurageVoice } from "./murage-voice.ts";
import { createOutputPublisher } from "./output-publication.ts";
import { cancelPeerApprovalsFor, requestEventLimitApproval, requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import { OWNER_PAGE, readProjectPage } from "./project-memory-tools.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { ROOM_REPLY_CHECKING, ROOM_REPLY_FORGOTTEN, ROOM_REPLY_WITHHELD } from "./room-context.ts";
import { Store, type BotRecord, type Message } from "./store.ts";
import { ensureTaskWorkspace } from "./workspace.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const CANARY = "Biscuit";
const P = "matrix-input", L = "launch-chat", PROV = "prov-matrix";
const NOW = 1_790_000_000_000;
type Roster = MemoryRoster & { bots: Array<MemoryRoster["bots"][number] & { name: string }> };
const roster: Roster = {
  bots: [
    { id: "dax", name: "Dax", threadId: "dax-direct", section: "Sales", tasks: [{ threadId: "dax-desk", channelProjectDesk: { groupId: "launch" } }] },
    { id: "finch", name: "Finch", threadId: "finch-direct", section: "Ops" },
  ],
  groups: [{ id: "launch", threadId: L, memberIds: ["dax", "finch"], channelProject: { goal: "Launch" } }],
};
const READER = botViewer("dax");
const HUMAN: Viewer = { kind: "human" };
const DAX = { botId: "dax", threadId: "dax-desk" };
const FINCH = { botId: "finch", name: "Finch", color: "blue" };
const finch = { id: "finch", name: "Finch", color: "blue", threadId: "finch-direct", alwaysAllow: [] } as unknown as BotRecord;
const dax = { id: "dax", name: "Dax", color: "red", threadId: "dax-direct", alwaysAllow: [] } as unknown as BotRecord;

let head = "u1";
let at = NOW;
/** The ids each writer wrote into the room, in order, by writer. */
const written = new Map<string, string[]>();
let writer = "";
function land(thread: string, row: Omit<Message, "id" | "at">, id?: string): Message {
  const message = { id: id ?? randomUUID(), at: ++at, ...(thread === L ? { parentId: head } : {}), ...row } as Message;
  appendMessage(thread, message);
  if (thread === L) { head = message.id; written.set(writer, [...(written.get(writer) ?? []), message.id]); }
  return message;
}
const store = { appendMessage: land, messageById: () => undefined, patchMessage: () => null, patchGroup: () => undefined, groupByThread: () => undefined, group: () => undefined, bot: () => undefined };
const turnOf = (thread: string) => (thread === L ? PROV : undefined);
const as = (name: string, work: () => void) => { writer = name; work(); };

/** Every writer of a classified row, run for real into the room while finch's turn runs there. */
function writeEveryClassifiedRow(): void {
  as("lifecycle card", () => {
    land(L, { role: "bot", kind: "routine.run", text: "Running", routineRun: { runId: "run-1", routineId: "routine-1", routineName: "Daily check", status: "running", executionThreadId: "run-thread" } } as Omit<Message, "id" | "at">, "card");
    updateMessage(L, { ...readMessage(L, "card")!, text: "Completed", routineRun: { runId: "run-1", routineId: "routine-1", routineName: "Daily check", status: "completed", executionThreadId: "run-thread", summary: `Checked ${CANARY}'s vet page` } } as Message);
  });
  as("status rows (bot-egress sinks)", () => {
    const sink = new RowSink(store);
    writeBotRow(sink, L, { turnId: PROV }, status("withheld"));
    writeActivityRow(sink, L, { turnId: PROV }, status("request_finished"), true);
  });
  as("room Murage line (mirrorMurageLine)", () => mirrorMurageLine({ store, broadcast: () => {} } as unknown as CommsBus, { id: "launch", threadId: L } as never, status("withheld"), { kind: "failure" }));
  as("legacy status text", () => { land(L, { role: "bot", kind: "text", text: `Queued for ${CANARY}`, actorKind: "murage", murage: { kind: "status" }, turnId: PROV } as Omit<Message, "id" | "at">); });
  as("image approval line and card", () => {
    const prompt = `A portrait of the owner's dog ${CANARY}`;
    land(L, murageLine({ role: "bot", kind: "activity", tool: { name: "Making an image without asking (level)", ok: true, imageRecord: { summary: "1 image", prompt } }, turnId: PROV } as Omit<Message, "id" | "at">));
    land(L, murageLine({ role: "bot", kind: "options", card: { title: "Approve image generation", subtitle: "One image", held: prompt, options: ["Allow", "Deny"], requestId: "image-1", tool: "generate_image" }, turnId: PROV } as Omit<Message, "id" | "at">));
  });
  as("voice note replay", () => { land(L, murageLine({ role: "bot", kind: "text", text: `Spoken: ${CANARY} is fine`, artifactIds: ["a2"], from: FINCH } as Omit<Message, "id" | "at">)); });
  as("browser approval card", () => {
    const approvals = new BrowserExtensionApprovals({ store, broadcast: () => {} } as unknown as ApprovalBus, { turnOf });
    void approvals.ask({ bot: finch, threadId: L, bindingId: "binding", generation: 1, digest: "a".repeat(64), summary: `Type "${CANARY}" into the search box`, waitMs: 60_000 }).catch(() => {});
    approvals.cancelBinding("binding");
  });
  as("peer approval and event-limit cards", () => {
    const bus = { store, broadcast: () => {}, turnOf } as unknown as ApprovalBus;
    void Promise.resolve(requestPeerApproval(bus, finch, dax, `Tell them the owner's dog is ${CANARY}`, "ask_bot", L)).catch(() => {});
    void Promise.resolve(requestEventLimitApproval(bus, finch, "handoff", 3, "ev-1", L, "Dax")).catch(() => {});
    cancelPeerApprovalsFor("finch");
  });
  as("browser setup card", () => {
    const setup = new BrowserExtensionSetup({ store: { ...store, keyedCards: () => [], keyedCardsEverywhere: () => [], newestMatching: () => ({ id: "u1" }), bots: () => [], groups: () => [] } as never, owner: () => finch, startHelper: async () => undefined, status: () => ({ profiles: [], bindings: [] }), optIn: () => {}, continueTask: async () => {}, turnOf });
    setup.request("finch", L, `I need your signed-in browser to read ${CANARY}'s vet page`);
  });
  as("legacy hand-off line (mirrorExchange, no source row)", () => {
    land("quiet-source", { role: "user", kind: "text", text: "quiet" } as Omit<Message, "id" | "at">, "q1");
    try { mirrorExchange({ store, broadcast: () => {}, turnOf } as unknown as CommsBus, finch, dax, `Tell them the owner's dog is ${CANARY}`, { id: "launch", threadId: L } as never, "quiet-source", undefined, "question", { sourceMessageId: undefined }); }
    catch { /* the target-side chip needs the full audience store, which this matrix does not build; the room line is written first */ }
  });
}

let turn: TurnLineage;
const roomRows = (): Message[] => (database().prepare("SELECT json FROM messages WHERE thread_id=? ORDER BY rowid").all(L) as Array<{ json: string }>).map(row => JSON.parse(row.json) as Message);
const classified = () => roomRows().filter(row => isMurageVoice(row));
const replay = (viewer: Viewer, rows: Message[]) => {
  const shown = new Map(botMessages(database(), viewer, L, rows).map(row => [row.id, row]));
  return rows.flatMap(row => { const door = shown.get(row.id); const source = door && botRowOf(door, viewer); return source ? [source] : []; });
};
const windowOf = (viewer: Viewer, rows: Message[]) => botWindow(database(), viewer, L, rows, () => false, 10_000).window;
const projectPage = (reader: typeof DAX | typeof OWNER_PAGE) => (readProjectPage(database(), roster, "launch", { limit: 50 }, reader).result.body as { messages?: Array<{ id: string; text: string }> }).messages ?? [];

beforeAll(() => {
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setExecutionStore({ bot: (id: string) => roster.bots.find(bot => bot.id === id) } as unknown as Store);
  setMemoryCaptureRoster(() => roster);
  setMemoryMode("active");
  reconcileMemoryRoster(roster);
  channelToProjectRows(database(), { groupId: "launch", bulletin: "", leadBotId: "finch", now: NOW });
  new WritetimeFixture(database()).cert(true);
  database().exec("UPDATE memory_scopes SET audience='[]' WHERE json_type(audience)<>'array'");
  // the input finch's turn is handed (another conversation's line), the owner's message in the room, the turn, its reply
  appendMessage(P, { id: "p1", role: "user", kind: "text", text: `The dog is ${CANARY}`, at: ++at });
  appendMessage(L, { id: "u1", role: "user", kind: "text", text: "What did the vet say?", at: ++at });
  turn = openTurnLineage(database(), { threadId: L, turnId: memberTurnId("finch") });
  database().exec("BEGIN IMMEDIATE");
  writeSessionLineage(database(), { threadId: L, driverInstance: "claude", nativeSession: "s-matrix" }, turn);
  database().exec("COMMIT");
  addTurnParents(turn, [{ kind: "line", threadId: P, messageId: "p1" }]);
  bindProviderTurn(turn, PROV);
  writer = "engine reply (control)";
  land(L, { role: "bot", kind: "text", text: `The vet says ${CANARY} is fine.`, from: FINCH, turnId: PROV } as Omit<Message, "id" | "at">, "r1");
  writeEveryClassifiedRow();
});
afterAll(() => { closeTurnLineage(turn); setExecutionStore(undefined as never); closeMessageDb(); closeDatabase(); });

describe("test 31: the revocation matrix", () => {
  it("every writer wrote a classified row into the room, and before the revoke the bot reads the turn's reply", () => {
    const byWriter = [...written].filter(([name]) => name !== "engine reply (control)");
    for (const [name, ids] of byWriter) expect(ids.map(id => isMurageVoice(readMessage(L, id))).some(Boolean), name).toBe(true);
    expect(byWriter.map(([name]) => name).length).toBeGreaterThanOrEqual(10);
    expect(replay(READER, roomRows()).map(row => row.text)).toContain(`The vet says ${CANARY} is fine.`);
    expect(projectPage(DAX).map(line => line.id)).toContain("r1");
  });

  it("revoking the producing turn's input withholds the turn's own reply from the bot (the control), and not the owner's message", () => {
    commitRevoke(database(), { kind: "line", threadId: P, messageIds: ["p1"], cause: "hide" });
    expect(drainRevokeMarker(database()).pending).toBe(false);
    const state = (id: string) => denyLookup(database(), { threadId: L, lines: [{ messageId: id, author: "generated" }] }, CONTENT).get(id)?.state;
    expect(state("r1")).toBe("withheld");
    expect(replay(READER, roomRows()).map(row => row.id)).not.toContain("r1");
    expect(replay(READER, roomRows()).map(row => row.id), "the owner's message is still read").toContain("u1");
  });

  for (const reader of ["replay", "room window", "project read"] as const) it(`${reader}: the bot reads each classified row absent or as its fixed copy, never a stored word`, () => {
    const rows = roomRows();
    const read: Array<{ id: string; text: string }> = reader === "replay" ? replay(READER, rows) : reader === "room window" ? windowOf(READER, rows) as Array<{ id: string; text: string }> : projectPage(DAX);
    expect(read.map(row => row.id), "the owner's message is still read").toContain("u1");
    // the revoked turn's reply is not read: absent from every bot reader, the project page included (fix/103-lineage-read: the door judges
    // every page row and no stand-in passes unjudged, so a line the lineage withholds is left out)
    const reply = read.find(row => row.id === "r1");
    expect(reply, "the revoked turn's reply is not read").toBeUndefined();
    expect(JSON.stringify(read), "no stored word of a classified row or of the revoked turn reaches the bot").not.toContain(CANARY);
    for (const row of classified()) {
      const line = read.find(entry => entry.id === row.id);
      // a project page stands a line the lineage withholds in as Murage's withheld line (a fixed copy too); every other reader, the projection
      const fixed = reader === "project read" ? [fixedCopy(row), ROOM_REPLY_WITHHELD, ROOM_REPLY_CHECKING, ROOM_REPLY_FORGOTTEN] : [fixedCopy(row)];
      if (line) expect(line.text, `${reader}: ${row.id} (${row.kind}) shows only fixed copy`).toBeOneOf(fixed);
    }
  });

  it("the human viewer reads every row as stored through the door: replay, room window and the owner's project page", () => {
    const rows = roomRows();
    expect(botMessages(database(), HUMAN, L, rows)).toEqual(rows);
    expect(botRows(database(), HUMAN, L, rows).map(row => [row.id, row.text])).toEqual(rows.map(row => [row.id, row.text ?? ""]));
    expect(windowOf(HUMAN, rows)).toEqual(rows);
    const owner = new Map(projectPage(OWNER_PAGE).map(line => [line.id, line.text]));
    // the owner's page keeps its own presentation (rule 4): a line the room's lineage withholds after the revoke reads as its withheld line
    // there, any other line as stored; no classified line is dropped from it
    const onPage = rows.filter(entry => entry.kind === "text" && isMurageVoice(entry));
    expect(onPage.length).toBeGreaterThanOrEqual(3);
    for (const row of onPage) expect(owner.get(row.id), `owner page: ${row.id}`).toBeOneOf([row.text, ROOM_REPLY_WITHHELD]);
    expect(owner.get("u1")).toBe("What did the vet say?");
  });

  it("a saved-file card (the output publisher) naming the turn whose input is revoked: the bot reads it absent or as its projection, the human as stored", async () => {
    const dataStore = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
    const owned = dataStore.createBot();
    const T = owned.threadId;
    appendMessage(T, { id: "o1", role: "user", kind: "text", text: "Save the notes", at: ++at });
    appendMessage(P, { id: "p2", role: "user", kind: "text", text: `Notes on ${CANARY}`, at: ++at, parentId: "p1" });
    const own = openTurnLineage(database(), { threadId: T, turnId: memberTurnId(owned.id) });
    addTurnParents(own, [{ kind: "line", threadId: P, messageId: "p2" }]);
    bindProviderTurn(own, `prov-${T}`);
    const workspace = ensureTaskWorkspace(owned.id, T);
    const cards: Message[] = [];
    const landing = Object.assign(Object.create(dataStore) as Store, { appendMessage: (thread: string, row: Omit<Message, "id" | "at">) => { const message = { id: randomUUID(), at: ++at, parentId: "o1", ...row } as Message; appendMessage(thread, message); cards.push(message); return message; } });
    const publisher = createOutputPublisher({ dataDir: DATA_DIR, database, store: landing, artifactScopes: () => [{ botId: owned.id, botName: owned.name, threadId: T, workspaceRoot: workspace }], turnOfRun: () => `prov-${T}` });
    expect(publisher.beforeDispatch({ botId: owned.id, threadId: T, runId: randomUUID(), workspaceRoot: realpathSync(workspace), managed: true })).toBe(true);
    mkdirSync(join(workspace, "outputs"), { recursive: true });
    writeFileSync(join(workspace, "outputs", `dog-${CANARY}-notes.md`), "notes");
    await publisher.publishTerminalOutputs({ type: "turn.completed", ok: true, threadId: T, eventId: randomUUID() } as never);
    const card = cards.find(message => message.text?.startsWith("Saved file"));
    expect(card?.turnId).toBe(`prov-${T}`);
    commitRevoke(database(), { kind: "line", threadId: P, messageIds: ["p2"], cause: "hide" });
    expect(drainRevokeMarker(database()).pending).toBe(false);
    const rows = [readMessage(T, "o1")!, readMessage(T, card!.id)!];
    const viewer = botViewer(owned.id);
    const shown = botMessages(database(), viewer, T, rows);
    const window = botWindow(database(), viewer, T, rows, () => false, 100).window;
    for (const read of [shown, window]) {
      expect(JSON.stringify(read.filter(row => row.id === card!.id))).not.toContain(CANARY);
      const line = read.find(row => row.id === card!.id);
      if (line) expect(line.text).toBe(fixedCopy(rows[1]));
    }
    expect(botMessages(database(), HUMAN, T, rows)).toEqual(rows);
    closeTurnLineage(own);
  });

});
