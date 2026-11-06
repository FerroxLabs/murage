// U4 S3: a stored row is checked at the one decoder (rowToMessage) and the one encoder (storedJson) in transcript-seq.ts, so a
// done-when line or a diagnostic planted straight into the database file (a restored backup, an older build, a hand edit) never
// comes back out of any store read: a redelivered event's stable id, an insert before a row, or the screen frames an unloaded
// append prunes and broadcasts. Every entry point here exists on the base, so these fail there by assertion.
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import * as mdb from "./message-db.ts";
import { Store, type Message, type StoreChange } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { rowToMessage, storedJson } from "./transcript-seq.ts";

const SECRET = () => `use ${"AKIA"}${"ABCDEFGHIJKLMNOP"} to upload`; // secret-scan: fixture
const selection = () => ({ instanceId: "fixture", model: "fixture-model" });
const handoffRow = (doneWhen: string): Omit<Message, "id" | "at"> => ({ role: "bot", kind: "activity", tool: { name: "Delegated to @Helper", doneWhen } });

/** Writes the row's JSON straight into the database, past every store and message-db write. */
function plant(threadId: string, id: string, edit: (message: Record<string, unknown>) => void): void {
  const row = database().prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(threadId, id) as { json: string };
  const message = JSON.parse(row.json) as Record<string, unknown>;
  edit(message);
  database().prepare("UPDATE messages SET json=? WHERE thread_id=? AND id=?").run(JSON.stringify(message), threadId, id);
  // the plant really landed: the raw column holds the value the reads below must not return
  const raw = (database().prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(threadId, id) as { json: string }).json;
  expect(raw).toContain("AKIA");
}
const plantDoneWhen = (threadId: string, id: string) => plant(threadId, id, (m) => { m.tool = { ...(m.tool as object), doneWhen: SECRET() }; });

beforeEach(() => removeTempDirSync(DATA_DIR));

describe("the stored-row decoder and encoder", () => {
  it("rowToMessage drops a secret-shaped or over-long done-when line and a foreign diagnostic", () => {
    const bad = { id: "m1", at: 1, role: "bot", kind: "activity", turnId: "t1", tool: { name: "Delegated to @Helper", doneWhen: SECRET(), diagnostic: { version: 1, junk: "AKIA" } } };
    const read = rowToMessage({ json: JSON.stringify(bad) });
    expect(read.tool?.doneWhen).toBeUndefined();
    expect(read.tool?.diagnostic).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain("AKIA");
    expect(rowToMessage({ json: JSON.stringify({ ...bad, tool: { name: "x", doneWhen: "y".repeat(281) } }) }).tool?.doneWhen).toBeUndefined();
    expect(rowToMessage({ json: JSON.stringify({ ...bad, tool: { name: "x", doneWhen: "a]b" } }) }).tool?.doneWhen).toBe("a)b");
  });
  it("storedJson never encodes a secret-shaped done-when line", () => {
    const bad = { id: "m1", at: 1, role: "bot", kind: "activity", tool: { name: "Delegated to @Helper", doneWhen: SECRET() } } as Message;
    expect(storedJson(bad)).not.toContain("AKIA");
    expect(JSON.parse(storedJson(bad)).tool.doneWhen).toBeUndefined();
    expect(JSON.parse(storedJson({ ...bad, tool: { name: "x", doneWhen: "the PR is open" } })).tool.doneWhen).toBe("the PR is open");
  });
});

describe("a planted done-when line in the database file", () => {
  it("is not returned by a redelivered event's stable id, on an unloaded or a loaded thread", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    store.appendMessage(threadId, { role: "user", kind: "text", text: "hi" });
    const row = store.appendMessage(threadId, handoffRow("the PR is open"), "stable-handoff-1");
    plantDoneWhen(threadId, row.id);
    mdb.closeMessageDb();
    // unloaded: appendUnloaded reads the held row by key
    const unloaded = new Store(selection);
    const replay = unloaded.appendMessage(threadId, handoffRow("other"), "stable-handoff-1");
    expect(replay.id).toBe(row.id);
    expect(replay.tool?.doneWhen).toBeUndefined();
    expect(JSON.stringify(replay)).not.toContain("AKIA");
    // loaded: the transcript in memory was filled from the same decoder
    unloaded.messagesFor(threadId);
    const again = unloaded.appendMessage(threadId, handoffRow("other"), "stable-handoff-1");
    expect(again.tool?.doneWhen).toBeUndefined();
  });

  it("is not returned by insertMessageBefore with that stable id", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    const first = store.appendMessage(threadId, { role: "user", kind: "text", text: "hi" });
    const row = store.appendMessage(threadId, handoffRow("the PR is open"), "stable-handoff-2");
    plantDoneWhen(threadId, row.id);
    mdb.closeMessageDb();
    const replay = new Store(selection).insertMessageBefore(threadId, first.id, handoffRow("other"), "stable-handoff-2");
    expect(replay.id).toBe(row.id);
    expect(replay.tool?.doneWhen).toBeUndefined();
    expect(JSON.stringify(replay)).not.toContain("AKIA");
  });

  it("is not in the screen frames an unloaded screen append prunes and broadcasts", () => {
    const store = new Store(selection);
    const { threadId } = store.createBot({}, { seedMessages: false });
    store.appendMessage(threadId, { role: "user", kind: "text", text: "hi" });
    const frames = [1, 2, 3, 4].map((n) => store.appendMessage(threadId, { role: "bot", kind: "screen", png: `frame-${n}` }));
    plantDoneWhen(threadId, frames[0]!.id);
    mdb.closeMessageDb();
    const unloaded = new Store(selection);
    const changes: StoreChange[] = [];
    unloaded.onChange((change) => changes.push(change));
    unloaded.appendMessage(threadId, { role: "bot", kind: "screen", png: "frame-5" });
    const patches = changes.filter((c): c is Extract<StoreChange, { type: "message.patch" }> => c.type === "message.patch");
    expect(patches.map((p) => p.message.id)).toContain(frames[0]!.id);
    expect(JSON.stringify(patches)).not.toContain("AKIA");
    // and the pruned frame written back is checked too
    const stored = mdb.readThread(threadId, join(DATA_DIR, `messages-${threadId}.json`)).messages.find((m) => m.id === frames[0]!.id);
    expect(stored?.tool?.doneWhen).toBeUndefined();
    const raw = (database().prepare("SELECT json FROM messages WHERE thread_id=? AND id=?").get(threadId, frames[0]!.id) as { json: string }).json;
    expect(raw).not.toContain("AKIA");
  });
});
