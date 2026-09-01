// `Store.visibleThreadIds()` and the SQL that consumes it.
//
// Kept out of store.test.ts and message-db.test.ts on purpose: these two
// pieces only mean anything together. The set is the definition of "visible"
// in the shape a WHERE clause can take, and the reason it has to reach the
// WHERE clause at all is LIMIT — which is a property of the query, not of the
// store, and cannot be shown from either side alone.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb, insertMessage, searchMessages } from "./message-db.ts";
import { Store, type Message } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
let seq = 0;
const msg = (text: string): Message => ({
  id: `m${++seq}`,
  role: "user",
  kind: "text",
  text,
  at: Date.now() + seq,
});

describe("visibleThreadIds", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    seq = 0;
  });

  it("holds every conversation the sidebar shows, and neither of the two it does not", () => {
    const store = new Store(selection);
    const open = store.createBot({ name: "Open" }, { seedMessages: false });
    const secret = store.createBot({ name: "Secret" }, { seedMessages: false });
    store.patchBot(secret.id, { hidden: true });
    const room = store.createGroup("Room", [open.id]);
    const dm = store.createGroup("Open ⇄ Secret", [open.id, secret.id], true);

    const ids = new Set(store.visibleThreadIds());
    expect(ids.has(open.threadId)).toBe(true);
    expect(ids.has(room.threadId)).toBe(true);

    // the hidden bot, and the bot⇄bot channel the harness auto-creates
    expect(ids.has(secret.threadId)).toBe(false);
    expect(ids.has(dm.threadId)).toBe(false);
  });

  it("keeps a room whose every member is hidden, because the sidebar does", () => {
    // plan-security.md §5 proposed excluding these. The sidebar filters
    // rooms on `dm` alone, so excluding them would leave a conversation
    // visible in the sidebar that search cannot find — and would make this
    // disagree with visibleToCompanion, which answers per frame.
    const store = new Store(selection);
    const secret = store.createBot({ name: "Secret" }, { seedMessages: false });
    const room = store.createGroup("Secret's room", [secret.id]);
    store.patchBot(secret.id, { hidden: true });
    expect(store.visibleThreadIds()).toContain(room.threadId);
    expect(store.visibleThreadIds()).not.toContain(secret.threadId);
  });

  it("follows task threads to their owner, on both bots and rooms", () => {
    const store = new Store(selection);
    const open = store.createBot({ name: "Open" }, { seedMessages: false });
    const secret = store.createBot({ name: "Secret" }, { seedMessages: false });
    const openTask = store.createTask(open.id, "delegated work");
    const secretTask = store.createTask(secret.id, "quiet work");
    store.patchBot(secret.id, { hidden: true });
    const room = store.createGroup("Room", [open.id]);
    const roomTask = store.createGroupTask(room.id, "second topic");

    const ids = new Set(store.visibleThreadIds());
    // A delegation lands in a task thread. That is where the interesting
    // transcript is, so following the owner is the whole point.
    expect(ids.has(openTask!.threadId)).toBe(true);
    expect(ids.has(roomTask!.threadId)).toBe(true);
    expect(ids.has(secretTask!.threadId)).toBe(false);
  });

  it("keeps a room the user emptied of members", () => {
    const store = new Store(selection);
    const empty = store.createGroup("Just me", []);
    expect(store.visibleThreadIds()).toContain(empty.threadId);
  });
});

describe("searchMessages scoping", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    seq = 0;
  });

  it("applies the scope before LIMIT, so a full page stays a full page", () => {
    // The bug a post-filter has and this does not, and the ordering is the
    // whole test: the matches the caller MAY see are the OLDEST, and a
    // busier conversation it may not see sits on top of them. `ORDER BY at
    // DESC LIMIT 5` then returns five rows that are all invisible, and a
    // filter applied afterwards returns ZERO — a search that looks like it
    // missed, on a query that matches three times.
    for (let i = 0; i < 3; i++) insertMessage("t-open", msg(`beacon open ${i}`));
    for (let i = 0; i < 10; i++) insertMessage("t-hidden", msg(`beacon hidden ${i}`));

    const scoped = searchMessages("beacon", 5, ["t-open"]);
    expect(scoped).toHaveLength(3);
    expect(new Set(scoped.map((hit) => hit.threadId))).toEqual(new Set(["t-open"]));

    // and unscoped still sees everything, so the scope is doing the work
    expect(searchMessages("beacon", 40)).toHaveLength(13);
  });

  it("reads an empty set as 'nothing is visible', never as 'no restriction'", () => {
    insertMessage("t-hidden", msg("beacon"));
    expect(searchMessages("beacon", 40, [])).toEqual([]);
    // absent is still the unrestricted form — the distinction this argument
    // exists to make
    expect(searchMessages("beacon", 40)).toHaveLength(1);
  });

  it("still accepts a single thread id, and a set of one means the same thing", () => {
    insertMessage("t-a", msg("beacon a"));
    insertMessage("t-b", msg("beacon b"));
    expect(searchMessages("beacon", 40, "t-a").map((h) => h.threadId)).toEqual(["t-a"]);
    expect(searchMessages("beacon", 40, ["t-a"]).map((h) => h.threadId)).toEqual(["t-a"]);
    expect(searchMessages("beacon", 40, "missing")).toEqual([]);
  });

  it("takes a scope far larger than SQLite's bind-parameter ceiling", () => {
    // 100 bots × task threads makes the set unbounded, so it is bound as one
    // JSON parameter rather than expanded into IN (?, ?, …). Expansion would
    // throw here — at runtime, on a big workspace, in the path whose job is
    // to not leak.
    const scope = Array.from({ length: 40_000 }, (_, i) => `t-${i}`);
    insertMessage("t-39999", msg("beacon deep"));
    insertMessage("t-outside", msg("beacon outside"));
    const hits = searchMessages("beacon", 40, scope);
    expect(hits.map((hit) => hit.threadId)).toEqual(["t-39999"]);
  });
});
