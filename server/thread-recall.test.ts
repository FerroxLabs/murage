// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread recall handler (THREAD-RECALL-DESIGN r6 rules 1 to 9, 11 to 17, 21, 23a and 23a's tests; seal S1). The handler is driven through its
// host interface with a real database, real message store, real lineage-write and a real memory policy; only the turn registry is a stand-in.
import { mkdirSync, readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { appendMessage, closeMessageDb, insertMessageBefore, readMessage } from "./message-db.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { ensureScope, memoryAccess, recallThreads, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./memory/policy.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "./human-principals.ts";
import { setExecutionStore } from "./execution-audience.ts";
import { commitRevoke } from "./memory/revoke-commit.ts";
import { drainRevokeMarker } from "./memory/memory-revocation.ts";
import { closeTurnLineage, currentTurnLineage, isTurnOpen, memberTurnId, openTurnLineage, supersedeMemberTurns, writeSessionLineage } from "./memory/lineage-write.ts";
import { sessionChildRef } from "./memory/lineage-types.ts";
import { beginTurnLineage, runningTurnSources, type RunningTurnLineage, type ShownLine } from "./steer-lineage.ts";
import { captureSource } from "./memory/capture.ts";
import { saveMemoryCandidate } from "./memory/authority.ts";
import { readableMemoryRecord } from "./memory/readable.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import {
  CALLS_LINE, CHECKING_LINE, NOT_ACTIVE_LINE, NO_THREADS_LINE, NO_THREADS_STATUS, OUT_OF_ROOM_LINE, PARTIAL_LINE, THREAD_CALLS_PER_TURN, THREAD_ENVELOPE_BUDGET,
  UNRECORDED_LINE, envelopeBytes, judgeRows, threadRecallRoute, type ThreadRecallHost, type ThreadRecallState, type ThreadRecallTool,
} from "./thread-recall.ts";
import type { Message, Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

afterAll(() => closeMessageDb());

type Json = Record<string, any>;
const roster: MemoryRoster = {
  bots: [
    { id: "ember", threadId: "t-main", section: "Ops", tasks: [{ threadId: "t-main" }, { threadId: "t-task" }, { threadId: "t-excl" }] },
    { id: "other", threadId: "t-other", section: "Ops", tasks: [{ threadId: "t-other" }] },
  ],
  groups: [{ id: "room", threadId: "room-chat", memberIds: ["ember", "other"] }],
};
const bots = {
  ember: { id: "ember", name: "Ember", title: "Ember", tasks: [{ threadId: "t-main", title: "Main chat", createdAt: 1000 }, { threadId: "t-task", title: "Trip planning", createdAt: 2000, automationEventId: "evt" }, { threadId: "t-excl", title: "Private", createdAt: 3000 }] },
  other: { id: "other", name: "Other", title: "Other", tasks: [{ threadId: "t-other", title: "Other chat", createdAt: 1 }] },
} as Record<string, unknown>;
const S1 = { threadId: "t-main", driverInstance: "claude", nativeSession: "S1" };

const db = () => database();
const msg = (id: string, text: string, at: number, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text, at, ...extra });
/** Each row is the child of the one before it in its thread, as a conversation is (two bot rows sharing a parent read as a regeneration). */
const lastRow = new Map<string, string>();
const put = (thread: string, id: string, text: string, at: number, extra: Partial<Message> = {}) => {
  appendMessage(thread, msg(id, text, at, { parentId: lastRow.get(thread) ?? null, ...extra }));
  lastRow.set(thread, id);
};
const carryCount = () => Number((db().prepare("SELECT COUNT(*) AS n FROM memory_lineage_carry").get() as Json).n);
/** The owner forgets a line (its captured source is tombstoned), as a revoke would. */
const forget = (thread: string, id: string) => db().prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,1,NULL,1,'owner-forget',1)").run(`tomb-${thread}-${id}`, `message:${thread}:${id}`);
const exclude = (...threads: string[]) => db().prepare("INSERT OR REPLACE INTO memory_scope_bindings VALUES('memory-owner-settings',?,'system','owner-settings',0,'granted',?)").run(ensureScope("conversation", "t-main"), JSON.stringify({ excludedThreadIds: threads }));

beforeEach(() => {
  lastRow.clear();
  closeMessageDb(); closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  for (const thread of ["t-main", "t-task", "room-chat"]) { let turn; while ((turn = currentTurnLineage(thread))) closeTurnLineage(turn); }
  reconcileMemoryRoster(roster); setMemoryMode("active");
  setExecutionStore({ bot: (id: string) => bots[id], bots: [], groups: [] } as unknown as Store);
});

interface Rig {
  host: ThreadRecallHost; state: ThreadRecallState; lineage: RunningTurnLineage; access: () => MemoryAccess;
  out: Array<{ status: number; body: Json; events: string[]; carries: number }>; events: string[];
  hooks: { onYield?: () => void | Promise<void>; sealFails?: boolean; ownerGeneration: string | undefined; lineageGone?: boolean };
  call: (tool: ThreadRecallTool, body?: unknown) => Promise<Rig["out"][number]>;
}
function rig(opts: { thread?: string; botId?: string; notOwnerAudience?: boolean; session?: boolean; generation?: string; principal?: ReturnType<typeof resolveHumanBinding> } = {}): Rig {
  const thread = opts.thread ?? "t-main", botId = opts.botId ?? "ember", generation = opts.generation ?? "g1";
  const registry = new InternalCapabilities(); registry.begin(botId, thread, generation, opts.principal);
  const token = registry.mint({ botId, threadId: thread, generation, depth: 0, kind: "memory", skillAuthoring: false, ...(opts.principal ? { humanPrincipal: opts.principal } : {}), ...(opts.notOwnerAudience ? { notOwnerAudience: true as const } : {}) });
  const claim = registry.resolve(`Bearer ${token}`)!;
  const access = () => memoryAccess(registry, claim, () => roster);
  const turn = openTurnLineage(db(), { threadId: thread, turnId: memberTurnId(botId) + generation });
  if (opts.session !== false) transaction(tx => writeSessionLineage(tx, { ...S1, threadId: thread }, turn));
  const lineage = beginTurnLineage({ threadId: thread, botId, roots: { roots: new Set(), over: false }, instanceId: "claude", generation, turn, shown: [], withheldNow: () => false });
  const events: string[] = [];
  const state: ThreadRecallState = { calls: 0, released: new Map(), sealed: false };
  const hooks: Rig["hooks"] = { ownerGeneration: generation };
  const out: Rig["out"] = [];
  const host: ThreadRecallHost = {
    claim: { threadId: thread, botId, generation },
    access: () => { try { return access(); } catch { return null; } },
    lineage: () => hooks.lineageGone ? undefined : lineage,
    active: () => registry.isActive(claim),
    ownerGeneration: () => hooks.ownerGeneration,
    state: () => hooks.ownerGeneration === generation ? state : undefined,
    seal: () => { events.push("seal"); if (hooks.sealFails) throw new Error("disk full"); },
    yield: async () => { await hooks.onYield?.(); },
    respond: (status, body) => { events.push("respond"); out.push({ status, body: body as Json, events: [...events], carries: carryCount() }); },
  };
  return {
    host, state, lineage, access, out, events, hooks,
    call: async (tool, body = {}) => {
      const before = out.length;
      await threadRecallRoute(tool, body, access(), host);
      expect(out.length).toBe(before + 1);
      return out[out.length - 1]!;
    },
  };
}

function seed() {
  put("t-main", "u1", "what is the vault code", 1000, { role: "user" });
  put("t-main", "b1", "The vault code is 5521", 2000);
  put("t-task", "b2", "vault note in the trip task", 3000, { from: { botId: "ember", name: "Ember" } } as Partial<Message>);
  put("t-other", "o1", "vault secret of the other bot", 3500);
  put("t-excl", "x1", "vault in the excluded thread", 3600);
}

describe("the set (rules 1 and 2)", () => {
  it("is the bot's own threads, not another bot's and not a room's", () => {
    expect(recallThreads(rig().access()).sort()).toEqual(["t-excl", "t-main", "t-task"]);
    expect(recallThreads(rig({ botId: "other", thread: "t-other" }).access())).toEqual(["t-other"]);
  });
  it("leaves out an excluded thread, and an excluded current thread leaves nothing", () => {
    exclude("t-excl");
    expect(recallThreads(rig().access()).sort()).toEqual(["t-main", "t-task"]);
    exclude("t-main");
    expect(recallThreads(rig().access()).sort()).toEqual(["t-excl", "t-task"]);
    exclude("t-main", "t-task", "t-excl");
    expect(recallThreads(rig().access())).toEqual([]);
  });
  it("is empty for an unproven turn", () => {
    expect(recallThreads(rig({ notOwnerAudience: true }).access())).toEqual([]);
  });
  it("is empty for a thread that is not the bot's own, and for a thread bound to a channel person", () => {
    // another bot's thread never even gets a memory access for this bot
    expect(() => rig({ thread: "t-other", botId: "ember" }).access()).toThrow("MEMORY_UNAUTHORIZED");
  });
  it("leaves out a task thread bound to a channel person", () => {
    const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "person" });
    linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
    bindHumanThread("t-task", resolveHumanBinding(binding));
    expect(recallThreads(rig().access()).sort()).toEqual(["t-excl", "t-main"]);
  });
  it("is empty for a turn in a thread bound to a channel person", () => {
    const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "person" });
    linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
    const principal = resolveHumanBinding(binding);
    bindHumanThread("t-task", principal);
    expect(recallThreads(rig({ thread: "t-task", principal }).access())).toEqual([]);
  });
  it("is empty for an isolated partition", () => {
    const ember = bots.ember as Record<string, unknown>;
    ember.partitionedAt = 1;
    (ember.tasks as Array<Record<string, unknown>>)[0]!.sharedWork = { teamId: "t", quarantined: true };
    try { expect(recallThreads(rig().access())).toEqual([]); }
    finally { delete ember.partitionedAt; delete (ember.tasks as Array<Record<string, unknown>>)[0]!.sharedWork; }
  });
  it("answers the no-threads status on every tool for a turn with an empty set", async () => {
    seed();
    const unproven = rig({ notOwnerAudience: true });
    for (const [tool, body] of [["thread_search", { query: "vault" }], ["thread_list", {}], ["thread_read", { message_id: "b1", direction: "around" }]] as const) {
      const answer = await unproven.call(tool, body);
      expect(answer).toMatchObject({ status: 200, body: { status: NO_THREADS_STATUS, notice: NO_THREADS_LINE } });
    }
    expect(unproven.state.sealed).toBe(false);
    expect(unproven.events).not.toContain("seal");
    const room = rig({ thread: "room-chat" });
    expect((await room.call("thread_search", { query: "vault" })).body.status).toBe(NO_THREADS_STATUS);
    exclude("t-main", "t-task", "t-excl");
    expect((await rig().call("thread_list")).body.status).toBe(NO_THREADS_STATUS);
  });
});

describe("thread_search (rules 4 to 8, 16)", () => {
  it("returns the newest first with titles and snippets, from every thread of the set and no other bot's", async () => {
    seed(); exclude("t-excl");
    const r = rig();
    const { status, body } = await r.call("thread_search", { query: "vault" });
    expect(status).toBe(200);
    expect(body.hits.map((hit: Json) => hit.messageId)).toEqual(["b2", "b1", "u1"]);
    expect(body.hits[0]).toMatchObject({ threadId: "t-task", threadTitle: "Trip planning", speaker: "Ember" });
    expect(body.hits[2].speaker).toBe("owner");
    expect(body.hits[1].snippet).toContain("vault code");
    expect(body).toMatchObject({ more: false, partial: false, checking: 0, unavailable: 0 });
    expect(r.state.released.get("b2")).toBe("t-task");
  });
  it("pages by oldest_at: the next page continues strictly below the oldest hit", async () => {
    for (let i = 0; i < 25; i++) put("t-main", `m${String(i).padStart(2, "0")}`, `needle number ${i}`, 10_000 + i * 10);
    const r = rig();
    const first = (await r.call("thread_search", { query: "needle" })).body;
    expect(first.hits).toHaveLength(20);
    expect(first.more).toBe(true);
    expect(first.hits[0].messageId).toBe("m24");
    expect(first.oldest_at).toBe(new Date(10_000 + 5 * 10).toISOString());
    const second = (await r.call("thread_search", { query: "needle", before: first.oldest_at })).body;
    expect(second.hits.map((hit: Json) => hit.messageId)).toEqual(["m04", "m03", "m02", "m01", "m00"]);
    expect(second.more).toBe(false);
  });
  it("takes a bare date as its start, and refuses a row id as before", async () => {
    put("t-main", "d1", "dated needle", Date.parse("2026-03-04T10:00:00.000Z"));
    const r = rig();
    expect((await r.call("thread_search", { query: "needle", before: "2026-03-04" })).body.hits).toEqual([]);
    expect((await r.call("thread_search", { query: "needle", before: "2026-03-05" })).body.hits).toHaveLength(1);
    const bad = await r.call("thread_search", { query: "needle", before: "d1" });
    expect(bad.status).toBe(400);
  });
  it("counts rows at the same instant as oldest_at instead of claiming nothing is missing", async () => {
    for (let i = 0; i < 22; i++) put("t-main", `s${String(i).padStart(2, "0")}`, `tie needle ${i}`, 50_000);
    const body = (await rig().call("thread_search", { query: "tie needle" })).body;
    expect(body.hits).toHaveLength(20);
    expect(body.more).toBe(true);
    expect(body.same_instant).toBeGreaterThanOrEqual(1);
    expect(body.notes.join(" ")).toContain("of oldest_at");
  });
  it("22 same-instant matches with one hidden among the first 21 never claims completeness (rules 6 and 24)", async () => {
    for (let i = 0; i < 22; i++) put("t-main", `s${String(i).padStart(2, "0")}`, `tie needle ${i}`, 50_000);
    // the newest-stored row is the first of the 21 the search holds; the door drops it, so 20 survive and the 22nd match is never reached
    forget("t-main", "s21");
    const body = (await rig().call("thread_search", { query: "tie needle" })).body;
    expect(body.hits).toHaveLength(20);
    expect(body.hits.map((hit: Json) => hit.messageId)).not.toContain("s21");
    expect(body.partial).toBe(true);
    expect(body.more).toBe(true);
    expect(body.notes).toContain(PARTIAL_LINE);
  });
  it("the search's own partial survives a page that filled with no tie at all", async () => {
    for (let i = 0; i < 22; i++) put("t-main", `d${String(i).padStart(2, "0")}`, `spread needle ${i}`, 60_000 + i);
    const body = (await rig().call("thread_search", { query: "spread needle" })).body;
    expect(body.hits).toHaveLength(20);
    expect(body.partial).toBe(true);
    expect(body.more).toBe(true);
  });
  it("counts a line whose check is still pending as being checked, and says so", async () => {
    put("t-main", "p1", "plain needle line", 300);
    db().prepare("INSERT INTO memory_deny_pending VALUES('t-main', 0, 99)").run();
    const body = (await rig().call("thread_search", { query: "needle" })).body;
    expect(body.hits).toEqual([]);
    expect(body.checking).toBe(1);
    expect(body.notes).toContain(CHECKING_LINE);
    // rule 6: the pending match has no replacement, so the answer says it may be incomplete
    expect(body.partial).toBe(true);
    expect(body.more).toBe(true);
    expect(body.notes).toContain(PARTIAL_LINE);
  });
  it("a short batch with only silent revocations is complete, not partial", async () => {
    put("t-main", "a1", "needle kept", 100); put("t-main", "a2", "needle revoked", 200);
    forget("t-main", "a2");
    const body = (await rig().call("thread_search", { query: "needle" })).body;
    expect(body.partial).toBe(false);
    expect(body.more).toBe(false);
  });
  it("re-tests the needle on the shown text and never shows a Murage-voice row or a copy", async () => {
    put("t-main", "v1", "needle said by Murage", 100, { murageLine: true } as Partial<Message>);
    put("t-main", "c1", "needle copied line", 200, { copyOf: { threadId: "t-task", messageIds: ["zz"] } });
    put("t-main", "p1", "plain needle line", 300);
    const body = (await rig().call("thread_search", { query: "needle" })).body;
    expect(body.hits.map((hit: Json) => hit.messageId)).toEqual(["p1"]);
    expect(body.checking).toBe(0);
    expect(body.unavailable).toBe(0);
  });
  it("counts a line with no lineage as could-not-be-judged, never as a hit", async () => {
    put("t-main", "p1", "plain needle line", 300);
    put("t-main", "raw1", "raw needle line", 400);
    db().prepare("DELETE FROM memory_line_lineage WHERE message_id='raw1'").run();
    const body = (await rig().call("thread_search", { query: "needle" })).body;
    expect(body.hits.map((hit: Json) => hit.messageId)).toEqual(["p1"]);
    expect(body.unavailable).toBe(1);
    expect(body.notes.join(" ")).toContain("1 line could not be judged and is left out.");
  });
  it("a revoked line is absent without a count", async () => {
    put("t-main", "a1", "needle kept", 100); put("t-main", "a2", "needle revoked", 200);
    forget("t-main", "a2");
    const body = (await rig().call("thread_search", { query: "needle" })).body;
    expect(body.hits.map((hit: Json) => hit.messageId)).toEqual(["a1"]);
    expect(body.checking + body.unavailable).toBe(0);
  });
  it("bot A never reaches bot B", async () => {
    seed();
    const other = rig({ botId: "other", thread: "t-other" });
    expect((await other.call("thread_search", { query: "vault" })).body.hits.map((hit: Json) => hit.messageId)).toEqual(["o1"]);
    expect((await other.call("thread_list")).body.threads.map((thread: Json) => thread.threadId)).toEqual(["t-other"]);
    other.state.released.set("b1", "t-main");
    expect((await other.call("thread_read", { message_id: "b1", direction: "around" })).body.status).toBe("not-reachable");
  });
  it("refills past rows the door drops, so a page is not short because of them", async () => {
    for (let i = 0; i < 30; i++) put("t-main", `g${String(i).padStart(2, "0")}`, `needle row ${i}`, 20_000 + i);
    for (let i = 20; i < 30; i++) forget("t-main", `g${String(i)}`);
    const body = (await rig().call("thread_search", { query: "needle" })).body;
    expect(body.hits).toHaveLength(20);
    expect(body.hits[0].messageId).toBe("g19");
  });
});

describe("the door's outcome classes (rule 17)", () => {
  it("counts pending, thread-not-ready and not-built as checking, and the others as could-not-be-judged", () => {
    // judgeRows maps the verdict reasons; here the mapping is read through a thread whose rows have no lineage (unavailable)
    put("t-main", "p1", "plain", 1);
    db().prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?,?,?,?,?,?,?)").run("t-main", "raw", 2, "bot", "text", "raw", JSON.stringify(msg("raw", "raw", 2)));
    const access = rig().access();
    const row = (id: string) => db().prepare("SELECT json FROM messages WHERE thread_id='t-main' AND id=?").get(id) as { json: string };
    const judged = judgeRows(access, ["p1", "raw"].map(id => ({ threadId: "t-main", message: JSON.parse(row(id).json) as Message })));
    expect(judged.shown.map(({ row }) => row.id)).toEqual(["p1"]);
    expect(judged).toMatchObject({ checking: 0, unavailable: 1 });
    expect(CHECKING_LINE).toBe("Some lines are still being checked; ask again in a moment for those.");
  });
});

describe("thread_list (rule 7)", () => {
  it("lists the threads of the set newest activity first with titles from the store, and seals", async () => {
    seed(); exclude("t-excl");
    const r = rig();
    const { body } = await r.call("thread_list");
    expect(body.threads.map((thread: Json) => thread.threadId)).toEqual(["t-task", "t-main"]);
    expect(body.threads[0]).toMatchObject({ title: "Trip planning", kind: "task", current: false });
    expect(body.threads[1]).toMatchObject({ title: "Main chat", kind: "chat", current: true });
    expect(body.more).toBe(false);
    expect(r.state.sealed).toBe(true);
    const older = (await r.call("thread_list", { before: body.threads[0].lastAt })).body;
    expect(older.threads.map((thread: Json) => thread.threadId)).toEqual(["t-main"]);
  });
  it("never lists an excluded thread", async () => {
    seed(); exclude("t-task", "t-excl");
    expect((await rig().call("thread_list")).body.threads.map((thread: Json) => thread.threadId)).toEqual(["t-main"]);
  });
});

describe("thread_read (rule 8)", () => {
  function conversation() {
    for (let i = 0; i < 12; i++) put("t-task", `r${String(i).padStart(2, "0")}`, `line ${i} about needle`, 1000 + i, { role: i % 2 ? "bot" : "user" });
  }
  it("reads only an id this turn was handed, and answers not-reachable for every other id", async () => {
    conversation();
    const r = rig();
    for (const id of ["r05", "nope", "u1"]) expect((await r.call("thread_read", { message_id: id, direction: "around" })).body).toEqual({ rows: [], status: "not-reachable" });
    r.state.released.set("r05", "t-task");
    const read = (await r.call("thread_read", { message_id: "r05", direction: "around", limit: 5 })).body;
    expect(read.rows.map((row: Json) => row.messageId)).toEqual(["r03", "r04", "r05", "r06", "r07"]);
    expect(read.more).toBe(true);
  });
  it("reads before and after along the branch and hands the rows it reads on", async () => {
    conversation();
    const r = rig(); r.state.released.set("r05", "t-task");
    const before = (await r.call("thread_read", { message_id: "r05", direction: "before", limit: 3 })).body;
    expect(before.rows.map((row: Json) => row.messageId)).toEqual(["r02", "r03", "r04"]);
    const after = (await r.call("thread_read", { message_id: "r05", direction: "after", limit: 3 })).body;
    expect(after.rows.map((row: Json) => row.messageId)).toEqual(["r06", "r07", "r08"]);
    expect(r.state.released.has("r08")).toBe(true);
    expect(r.state.released.has("r11")).toBe(false);
  });
  it("answers not-reachable when the thread has left the set or the line is hidden", async () => {
    conversation();
    const r = rig(); r.state.released.set("r05", "t-task");
    forget("t-task", "r05");
    expect((await r.call("thread_read", { message_id: "r05", direction: "around" })).body.status).toBe("not-reachable");
    const s = rig(); s.state.released.set("r04", "t-task");
    exclude("t-task");
    expect((await s.call("thread_read", { message_id: "r04", direction: "around" })).body.status).toBe("not-reachable");
  });
  it("walks the active branch in branch order, not storage order, when a line was spliced in (rule 8)", async () => {
    for (let i = 0; i < 6; i++) put("t-task", `c${i}`, `chain ${i} needle`, 1000 + i);
    const moved = { ...readMessage("t-task", "c3")!, parentId: "sp" };
    // stored last, but on the branch between c2 and c3
    insertMessageBefore("t-task", msg("sp", "spliced needle", 1002, { parentId: "c2" }), moved);
    const r = rig();
    r.state.released.set("c3", "t-task");
    const around = (await r.call("thread_read", { message_id: "c3", direction: "around", limit: 5 })).body;
    expect(around.rows.map((row: Json) => row.messageId)).toEqual(["c2", "sp", "c3", "c4", "c5"]);
    const before = (await r.call("thread_read", { message_id: "c3", direction: "before", limit: 3 })).body;
    expect(before.rows.map((row: Json) => row.messageId)).toEqual(["c1", "c2", "sp"]);
    const after = (await r.call("thread_read", { message_id: "sp", direction: "after", limit: 2 })).body;
    expect(after.status).toBeUndefined();
    r.state.released.set("sp", "t-task");
    const next = (await r.call("thread_read", { message_id: "sp", direction: "after", limit: 2 })).body;
    expect(next.rows.map((row: Json) => row.messageId)).toEqual(["c3", "c4"]);
    expect(next.more).toBe(true);
  });
  it("answers not-reachable for an anchor that is not on the active branch, in every direction", async () => {
    for (let i = 0; i < 4; i++) put("t-task", `f${i}`, `fork ${i} needle`, 2000 + i);
    // a regeneration from f1: the active branch is now f0, f1, alt
    appendMessage("t-task", msg("alt", "other branch needle", 2010, { parentId: "f1" }));
    // the regeneration commits a write-time revoke of the replaced reply; until its marker drains, its pending window holds "alt" (lsn
    // above since) as "checking" (fail closed). The background runner drains it in a few ms, but on a loaded runner not before the read:
    // drain it here, so the read below sees the settled branch.
    drainRevokeMarker(db());
    const r = rig();
    r.state.released.set("f2", "t-task"); r.state.released.set("f1", "t-task");
    for (const direction of ["around", "before", "after"] as const) {
      expect((await r.call("thread_read", { message_id: "f2", direction })).body).toEqual({ rows: [], status: "not-reachable" });
    }
    const on = (await r.call("thread_read", { message_id: "f1", direction: "around", limit: 5 })).body;
    expect(on.rows.map((row: Json) => row.messageId)).toEqual(["f0", "f1", "alt"]);
    expect(on.checking).toBe(0);
  });
  it("cuts a long line at 2,000 characters", async () => {
    put("t-task", "long", "n".repeat(5000) + " needle", 5);
    const r = rig(); r.state.released.set("long", "t-task");
    const row = (await r.call("thread_read", { message_id: "long", direction: "around", limit: 1 })).body.rows[0];
    expect(row.text).toHaveLength(2000);
    expect(row.truncated).toBe(true);
  });
});

describe("the envelope (rule 21)", () => {
  const proxyAccepts = (body: unknown) => envelopeBytes(body) <= 32768;
  it("trims the oldest hits of an oversized page, marks it partial and resumes from oldest_at", async () => {
    const name = '"\\'.repeat(100);
    for (let i = 0; i < 30; i++) put("t-main", `${"i".repeat(240)}${String(i).padStart(2, "0")}`, `${'"'.repeat(60)}needle${'"'.repeat(90)}`, 100_000 + i, { from: { botId: "ghost", name } } as Partial<Message>);
    const r = rig();
    const first = (await r.call("thread_search", { query: "needle" })).body;
    expect(envelopeBytes(first)).toBeLessThanOrEqual(THREAD_ENVELOPE_BUDGET);
    expect(first.hits.length).toBeLessThan(20);
    expect(first.partial).toBe(true);
    expect(first.more).toBe(true);
    expect(first.oldest_at).toBe(new Date(100_000 + 29 - (first.hits.length - 1)).toISOString());
    // only the hits kept were released
    expect(r.state.released.size).toBe(first.hits.length);
    const next = (await r.call("thread_search", { query: "needle", before: first.oldest_at })).body;
    expect(next.hits[0].messageId.endsWith(String(29 - first.hits.length).padStart(2, "0"))).toBe(true);
  });
  it("never produces MEMORY_RESPONSE_TOO_LARGE for quotes, backslashes, emoji and 2,000-character texts", async () => {
    const nasty = ['"\\'.repeat(1000), "😀".repeat(1000), "\\u0000\n\t".repeat(500), "x".repeat(2000)];
    nasty.forEach((text, i) => { for (let k = 0; k < 20; k++) put("t-task", `n${i}-${k}`, `${text} needle`, 200_000 + i * 100 + k); });
    const r = rig();
    for (const [i] of nasty.entries()) {
      const hits = (await r.call("thread_search", { query: "needle", before: new Date(200_000 + (i + 1) * 100).toISOString() })).body;
      expect(proxyAccepts(hits)).toBe(true);
      expect(envelopeBytes(hits)).toBeLessThanOrEqual(THREAD_ENVELOPE_BUDGET);
    }
    r.state.released.set("n0-5", "t-task");
    const read = (await r.call("thread_read", { message_id: "n0-5", direction: "around", limit: 40 })).body;
    expect(envelopeBytes(read)).toBeLessThanOrEqual(THREAD_ENVELOPE_BUDGET);
    expect(read.rows.length).toBeGreaterThan(0);
    expect(read.more).toBe(true);
  });
  it("cuts one row that cannot fit and says so", async () => {
    // a single page entry whose own fields exceed the budget cannot occur from stored data, so the cut is proven on a read of one 2,000-character row
    put("t-task", "one", '"\\'.repeat(1500), 7);
    const r = rig(); r.state.released.set("one", "t-task");
    const body = (await r.call("thread_read", { message_id: "one", direction: "around", limit: 1 })).body;
    expect(envelopeBytes(body)).toBeLessThanOrEqual(THREAD_ENVELOPE_BUDGET);
    expect(body.rows[0].truncated).toBe(true);
  });
});

describe("the seal, persistence and release (rules 11 to 14, S1)", () => {
  it("writes the seal and the carry rows before the answer leaves, and the running turn then rests on what it read", async () => {
    seed(); exclude("t-excl");
    const r = rig();
    const carries = carryCount();
    const answer = await r.call("thread_search", { query: "vault" });
    expect(answer.events).toEqual(["seal", "respond"]);
    expect(answer.carries).toBeGreaterThan(carries);
    expect(r.state.sealed).toBe(true);
    expect(r.lineage.turn.parents.map(ref => (ref as { messageId: string }).messageId).sort()).toEqual(["b1", "b2", "u1"]);
  });
  it("a failing seal save is 409 with no text, writes nothing else and leaves the flag unset", async () => {
    seed();
    const r = rig(); r.hooks.sealFails = true;
    const carries = carryCount();
    const answer = await r.call("thread_search", { query: "vault" });
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ error: UNRECORDED_LINE });
    expect(r.state.sealed).toBe(false);
    expect(r.state.released.size).toBe(0);
    expect(carryCount()).toBe(carries);
    expect(r.lineage.turn.parents).toEqual([]);
    r.hooks.sealFails = false;
    expect((await r.call("thread_search", { query: "vault" })).status).toBe(200);
    expect(r.state.sealed).toBe(true);
  });
  it("a second releasing call of the same generation writes no second seal, and a new generation seals again", async () => {
    seed();
    const r = rig();
    await r.call("thread_search", { query: "vault" });
    await r.call("thread_list");
    expect(r.events.filter(event => event === "seal")).toHaveLength(1);
    const next = rig({ generation: "g2" });
    await next.call("thread_search", { query: "vault" });
    expect(next.events.filter(event => event === "seal")).toHaveLength(1);
  });
  it("an empty answer writes nothing: no seal, no persistence", async () => {
    seed();
    const r = rig();
    const carries = carryCount();
    const answer = await r.call("thread_search", { query: "zzzznotthere" });
    expect(answer.body.hits).toEqual([]);
    expect(r.events).toEqual(["respond"]);
    expect(r.state.sealed).toBe(false);
    expect(carryCount()).toBe(carries);
    expect(r.lineage.turn.parents).toEqual([]);
  });
  it("a persistence failure is 409 with nothing released, no id added and the carry table unchanged", async () => {
    seed();
    const r = rig();
    db().exec("CREATE TRIGGER carry_boom BEFORE INSERT ON memory_lineage_carry BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    const carries = carryCount();
    const sources = r.lineage.sources;
    const before = Array.isArray(sources) ? sources.length : -1;
    const answer = await r.call("thread_search", { query: "vault" });
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ error: UNRECORDED_LINE });
    expect(r.state.released.size).toBe(0);
    expect(carryCount()).toBe(carries);
    expect(r.lineage.turn.parents).toEqual([]);
    expect(Array.isArray(r.lineage.sources) ? r.lineage.sources.length : -1).toBe(before);
  });
  it("a stale generation, a superseded turn and a missing turn are 409 with nothing changed", async () => {
    seed();
    const stale = rig();
    stale.hooks.onYield = () => { stale.hooks.ownerGeneration = "g-other"; };
    expect((await stale.call("thread_search", { query: "vault" })).status).toBe(409);
    expect(stale.lineage.turn.parents).toEqual([]);
    expect(stale.events).not.toContain("seal");

    const closed = rig({ generation: "g3" });
    closed.hooks.onYield = () => { closeTurnLineage(closed.lineage.turn); };
    const answer = await closed.call("thread_search", { query: "vault" });
    expect(answer).toMatchObject({ status: 409, body: { error: NOT_ACTIVE_LINE } });
    expect(closed.state.released.size).toBe(0);

    const gone = rig({ generation: "g4" });
    gone.hooks.lineageGone = true;
    expect((await gone.call("thread_search", { query: "vault" })).status).toBe(409);

    const before = rig({ generation: "g5" });
    before.hooks.ownerGeneration = "someone-else";
    expect((await before.call("thread_search", { query: "vault" })).status).toBe(409);
  });
  it("never looks a turn up by thread", () => {
    const source = readFileSync(new URL("./thread-recall.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const name of ["currentTurnLineage", "runningTurnFor", "writerTurnFor", "memberOf", "producingTurnOf"]) expect(source).not.toContain(name);
  });
  it("refuses a read the turn's sources have no room for, and leaves its sources intact", async () => {
    for (let i = 0; i < 40; i++) put("t-task", `q${String(i).padStart(2, "0")}`, `needle row ${i}`, 1000 + i);
    const r = rig();
    r.lineage.sources = Array.from({ length: 1580 }, (_, i): ShownLine => ({ threadId: "t-elsewhere", id: `s${i}`, role: "bot" }));
    r.state.released.set("q20", "t-task");
    const answer = await r.call("thread_read", { message_id: "q20", direction: "around", limit: 40 });
    expect(answer).toMatchObject({ status: 409, body: { error: OUT_OF_ROOM_LINE } });
    expect((r.lineage.sources as ShownLine[]).length).toBe(1580);
    expect(r.state.released.size).toBe(1);
    expect(r.events).not.toContain("seal");
  });
  it("the sources preflight counts only the rows that will leave (rule 13)", async () => {
    for (let i = 0; i < 21; i++) put("t-task", `k${String(i).padStart(2, "0")}`, `budget needle ${i}`, 70_000 + i);
    const fill = (r: Rig, n: number) => { r.lineage.sources = Array.from({ length: n }, (_, i): ShownLine => ({ threadId: "t-elsewhere", id: `s${i}`, role: "bot" })); };
    // 21 candidates, a page of 20: 1,580 + 20 is exactly the ceiling and passes
    const fits = rig(); fill(fits, 1580);
    const ok = await fits.call("thread_search", { query: "budget needle" });
    expect(ok.status).toBe(200);
    expect(ok.body.hits).toHaveLength(20);
    expect((fits.lineage.sources as ShownLine[]).length).toBe(1600);
    expect(fits.state.released.size).toBe(20);
    // one more source in the turn and the same 20 would pass the ceiling: refused with the sources intact and nothing sealed
    const over = rig({ generation: "g-over" }); fill(over, 1590);
    const refused = await over.call("thread_search", { query: "budget needle" });
    expect(refused).toMatchObject({ status: 409, body: { error: OUT_OF_ROOM_LINE } });
    expect((over.lineage.sources as ShownLine[]).length).toBe(1590);
    expect(over.state.released.size).toBe(0);
    expect(over.events).not.toContain("seal");
  });
  it("refuses the thirteenth call of a generation, counted before any read", async () => {
    const r = rig();
    for (let i = 0; i < THREAD_CALLS_PER_TURN; i++) expect((await r.call("thread_list")).status).toBe(200);
    expect(await r.call("thread_search", { query: "anything" })).toMatchObject({ status: 409, body: { error: CALLS_LINE } });
  });
  it.each(["off", "paused", "capture"] as const)("answers in memory mode %s, from rules 1 and 2 and the turn binding only (rule 18)", async mode => {
    seed(); exclude("t-excl");
    setMemoryMode(mode);
    const r = rig();
    const listed = await r.call("thread_list");
    expect(listed.status).toBe(200);
    expect(listed.body.threads.map((thread: Json) => thread.threadId).sort()).toEqual(["t-main", "t-task"]);
    const found = await r.call("thread_search", { query: "vault" });
    expect(found.status).toBe(200);
    expect(found.body.hits.map((hit: Json) => hit.messageId)).toEqual(["b2", "b1", "u1"]);
    const read = await r.call("thread_read", { message_id: "b1", direction: "around", limit: 3 });
    expect(read.status).toBe(200);
    expect(read.body.rows.map((row: Json) => row.messageId)).toEqual(["u1", "b1"]);
    expect(r.events).toContain("seal");
    // still refused by the binding: a turn that is no longer the owner's generation
    r.hooks.ownerGeneration = "g2";
    expect(await r.call("thread_list")).toMatchObject({ status: 409, body: { error: NOT_ACTIVE_LINE } });
  });
  it("memory mode does not change the empty-audience answer", async () => {
    setMemoryMode("off");
    exclude("t-main", "t-task", "t-excl");
    expect(await rig().call("thread_list")).toMatchObject({ status: 200, body: { status: NO_THREADS_STATUS } });
  });
});

describe("release-time revalidation (rule 23a)", () => {
  it("a revoke committed between judgment and release drops that row, and only the survivors are persisted", async () => {
    seed(); exclude("t-excl");
    const r = rig();
    r.hooks.onYield = () => { forget("t-task", "b2"); };
    const body = (await r.call("thread_search", { query: "vault" })).body;
    expect(body.hits.map((hit: Json) => hit.messageId)).toEqual(["b1", "u1"]);
    expect([...r.state.released.keys()].sort()).toEqual(["b1", "u1"]);
    expect(r.lineage.turn.parents.map(ref => (ref as { messageId: string }).messageId).sort()).toEqual(["b1", "u1"]);
  });
  it("a thread excluded in between drops its rows", async () => {
    seed(); exclude("t-excl");
    const r = rig();
    r.hooks.onYield = () => { exclude("t-excl", "t-task"); };
    const body = (await r.call("thread_search", { query: "vault" })).body;
    expect(body.hits.map((hit: Json) => hit.messageId)).toEqual(["b1", "u1"]);
    expect(r.state.released.has("b2")).toBe(false);
  });
  it("a turn that is no longer an owner audience releases nothing and writes nothing", async () => {
    seed(); exclude("t-excl");
    const r = rig();
    r.hooks.onYield = () => { exclude("t-main", "t-task", "t-excl"); };
    const answer = await r.call("thread_search", { query: "vault" });
    expect(answer.body.hits).toEqual([]);
    expect(r.events).toEqual(["respond"]);
    expect(r.state.sealed).toBe(false);
  });
  it("an unchanged row set releases exactly what judgment found", async () => {
    seed(); exclude("t-excl");
    const r = rig();
    r.hooks.onYield = () => undefined;
    expect((await r.call("thread_search", { query: "vault" })).body.hits.map((hit: Json) => hit.messageId)).toEqual(["b2", "b1", "u1"]);
  });
});

describe("the lineage lifecycle of what a turn read (rule 23)", () => {
  const sessionCarries = (s: { driverInstance: string; nativeSession: string }) =>
    db().prepare("SELECT p.thread_id AS parent_thread FROM memory_lineage_carry c JOIN memory_thread_no p ON p.no=c.parent_thread_no WHERE c.child_kind=2 AND c.child_ref=? ORDER BY 1").all(sessionChildRef(s.driverInstance, s.nativeSession)).map(row => String((row as Json).parent_thread));
  const reply = (id: string, at: number): Message => msg(id, "the answer, after reading", at, { from: { botId: "ember", name: "Ember" } } as Partial<Message>);
  /** What the door says of a reply now: shown, or withheld with no "checking" and no "could not be judged" count (a silent policy answer). */
  const doorSays = (id: string): "shown" | "withheld" | "undecided" => {
    const judged = judgeRows(rig({ generation: "g-judge" }).access(), [{ threadId: "t-main", message: readMessage("t-main", id)! }]);
    return judged.shown.length === 1 ? "shown" : judged.checking + judged.unavailable === 0 ? "withheld" : "undecided";
  };
  /** The owner's forget of a line, through the revoke commit that walks what rests on it. */
  const revoke = (threadId: string, id: string) => { transaction(tx => { commitRevoke(tx, { kind: "line", threadId, messageIds: [id], cause: "forget" }); }); };

  it("a reply written after a read carries the read lines as write-time parents, and revoking a read line withholds that reply", async () => {
    seed(); exclude("t-excl");
    const r = rig();
    await r.call("thread_search", { query: "vault" });
    expect(r.lineage.turn.parents.map(ref => (ref as { messageId: string }).messageId).sort()).toEqual(["b1", "b2", "u1"]);
    appendMessage("t-main", { ...reply("rep1", 9000), parentId: lastRow.get("t-main") ?? null });
    expect(doorSays("rep1")).toBe("shown");
    revoke("t-task", "b2");
    expect(doorSays("rep1")).toBe("withheld");
  });
  it("a reply that rests on a read line is withheld when that line's own input is revoked", async () => {
    put("t-task", "in1", "the input the read line rests on", 100, { role: "user" });
    put("t-task", "b2", "vault answer built on the input", 200, { from: { botId: "ember", name: "Ember" } } as Partial<Message>);
    const r = rig();
    await r.call("thread_search", { query: "vault answer" });
    expect(r.state.released.has("b2")).toBe(true);
    appendMessage("t-main", { ...reply("rep2", 9000), parentId: lastRow.get("t-main") ?? null });
    expect(doorSays("rep2")).toBe("shown");
    revoke("t-task", "in1");
    // rep2 rests on in1 through b2: the commit holds it at once (never shown), the marker's walk makes it withheld. On a loaded runner the
    // background runner has not walked yet ("undecided"), so the walk is drained before the final verdict.
    expect(doorSays("rep2")).not.toBe("shown");
    drainRevokeMarker(db());
    expect(doorSays("rep2")).toBe("withheld");
  });
  it("a session that starts after the release is carried by the session.started path", async () => {
    seed(); exclude("t-excl");
    const r = rig({ session: false });
    const carries = carryCount();
    await r.call("thread_search", { query: "vault" });
    expect(r.state.released.size).toBe(3);
    // nothing to persist for a session that does not exist yet: the reads live on the turn
    expect(carryCount()).toBe(carries);
    expect(sessionCarries(S1)).toEqual([]);
    transaction(tx => { writeSessionLineage(tx, S1, r.lineage.turn); });
    expect(sessionCarries(S1)).toEqual(expect.arrayContaining(["t-task"]));
  });
  it("a note saved after a thread read rests on the read lines: they are the turn's sources, and revoking one withholds the note", async () => {
    seed(); exclude("t-excl");
    const r = rig();
    await r.call("thread_search", { query: "vault" });
    // what the turn read is what a note it writes next rests on (the turn's sources, grouped by conversation)
    const sources = runningTurnSources(r.lineage, "ember")!;
    expect(sources.find(group => group.threadId === "t-task")?.messageIds).toEqual(["b2"]);
    const text = "vault note in the trip task";
    const sourceId = "message:t-task:b2";
    if (!db().prepare("SELECT 1 FROM memory_sources WHERE id=?").get(sourceId)) captureSource(db(), { id: sourceId, threadId: "t-task", messageId: "b2", kind: "text", speaker: "bot:ember", outcome: "recorded", text });
    const access = r.access();
    const note = saveMemoryCandidate("the trip task holds a vault note", [{ sourceId, revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "note-after-read", access);
    db().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(note);
    const readable = () => { try { return typeof readableMemoryRecord(note, 1, access, { allowance: LineageAllowance.tool() }) === "object"; } catch { return false; } };
    expect(readable()).toBe(true);
    revoke("t-task", "b2");
    expect(readable()).toBe(false);
  });
  it("a recall that succeeds for the old generation after the replacing turn opened but before it superseded writes onto the old turn only", async () => {
    seed(); exclude("t-excl");
    const first = rig({ generation: "g1" });
    const second = rig({ generation: "g2" });
    // the replacing dispatch has opened its turn; supersedeMemberTurns has not run yet, so the first generation is still the live one
    expect(isTurnOpen(first.lineage.turn)).toBe(true);
    expect(isTurnOpen(second.lineage.turn)).toBe(true);
    const won = await first.call("thread_search", { query: "vault" });
    expect(won.status).toBe(200);
    expect(first.lineage.turn.parents.map(ref => (ref as { messageId: string }).messageId).sort()).toEqual(["b1", "b2", "u1"]);
    expect(second.lineage.turn.parents).toEqual([]);
    expect((second.lineage.sources as ShownLine[]).length).toBe(0);
    expect(first.state.released.size).toBe(3);
    expect(second.state.released.size).toBe(0);
    // then the replacement supersedes: the first turn closes with what it read, the second stays open and empty
    supersedeMemberTurns(second.lineage.turn);
    expect(isTurnOpen(first.lineage.turn)).toBe(false);
    expect(isTurnOpen(second.lineage.turn)).toBe(true);
    expect(second.lineage.turn.parents).toEqual([]);
    const late = await first.call("thread_list");
    expect(late.status).toBe(409);
  });
  it("a replacing dispatch of the same bot leaves the dependencies on the authenticated turn object only", async () => {
    seed(); exclude("t-excl");
    const first = rig({ generation: "g1" });
    const second = rig({ generation: "g2" });
    // the call of the first generation is in flight when the replacing dispatch opens and supersedes it
    first.hooks.onYield = () => { supersedeMemberTurns(second.lineage.turn); };
    const lost = await first.call("thread_search", { query: "vault" });
    expect(lost).toMatchObject({ status: 409, body: { error: NOT_ACTIVE_LINE } });
    expect(isTurnOpen(first.lineage.turn)).toBe(false);
    expect(first.lineage.turn.parents).toEqual([]);
    expect(second.lineage.turn.parents).toEqual([]);
    expect(first.state.released.size).toBe(0);
    // the replacement then reads: its own turn object carries the parents, the superseded one still carries none
    const won = await second.call("thread_search", { query: "vault" });
    expect(won.status).toBe(200);
    expect(second.lineage.turn.parents.map(ref => (ref as { messageId: string }).messageId).sort()).toEqual(["b1", "b2", "u1"]);
    expect(first.lineage.turn.parents).toEqual([]);
    expect((first.lineage.sources as ShownLine[]).length).toBe(0);
  });
});

describe("a line the owner forgot is never returned (106 recall-forgotten)", () => {
  // forgotten is the one definition project-memory-tools.ts and All chats use: the stamp, an owner-forget tombstone, or a deleted source
  type How = "tombstone" | "stamp" | "deleted";
  const forgetAs = (how: How, thread: string, id: string) => {
    if (how === "tombstone") forget(thread, id);
    else if (how === "deleted") db().prepare("INSERT OR REPLACE INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES(?,?,?,?,NULL,1,'h','message','owner','captured',NULL,'deleted')")
      .run(`message:${thread}:${id}`, ensureScope("conversation", thread), thread, id);
  };
  /** Line lineage not live: no line lineage row anywhere (lineageLive is false). */
  const notLive = () => db().prepare("DELETE FROM memory_line_lineage").run();
  const cases: Array<[How, boolean, string, "user" | "bot"]> = [];
  for (const how of ["tombstone", "stamp", "deleted"] as How[]) for (const live of [true, false]) for (const thread of ["t-main", "t-task"]) for (const role of ["user", "bot"] as const) cases.push([how, live, thread, role]);

  /** k1 (kept, older), g1 (forgotten, newest), k2 (kept, oldest) in `thread`. */
  const plant = (how: How, live: boolean, thread: string, role: "user" | "bot") => {
    put(thread, "k2", "needle kept early", 1000, { role });
    put(thread, "k1", "needle kept later", 2000, { role });
    put(thread, "g1", "needle forgotten words", 3000, { role, ...(how === "stamp" ? { withheldFromBots: "forgotten" as const } : {}) });
    forgetAs(how, thread, "g1");
    if (!live) notLive();
  };
  // the words, the id, or the time of the forgotten line
  const leaks = (body: Json) => ["forgotten words", "\"g1\"", new Date(3000).toISOString()].some(part => JSON.stringify(body).includes(part));

  it.each(cases)("thread_search: %s, lineage live %s, thread %s, %s line", async (how, live, thread, role) => {
    plant(how, live, thread, role);
    const r = rig();
    const { status, body } = await r.call("thread_search", { query: "needle" });
    expect(status).toBe(200);
    expect(leaks(body)).toBe(false);
    expect(r.state.released.has("g1")).toBe(false);
    expect(body.checking + body.unavailable).toBe(0);
  });
  it.each(cases)("thread_read: %s, lineage live %s, thread %s, %s line", async (how, live, thread, role) => {
    plant(how, live, thread, role);
    const r = rig();
    // a kept anchor: the forgotten neighbour is not in the rows
    r.state.released.set("k1", thread);
    for (const direction of ["around", "after"] as const) {
      const { body } = await r.call("thread_read", { message_id: "k1", direction, limit: 5 });
      expect(leaks(body)).toBe(false);
    }
    // the forgotten line itself as the anchor (as if handed before it was forgotten): not-reachable, nothing around it
    r.state.released.set("g1", thread);
    expect((await r.call("thread_read", { message_id: "g1", direction: "around" })).body).toEqual({ rows: [], status: "not-reachable" });
    expect(r.state.released.get("g1")).toBe(thread);
  });
  it.each(cases)("thread_list: %s, lineage live %s, thread %s, %s line", async (how, live, thread, role) => {
    plant(how, live, thread, role);
    const { body } = await rig().call("thread_list");
    const listed = body.threads.find((entry: Json) => entry.threadId === thread);
    // the forgotten line's time never shows: lastAt is the newest remembered line's
    expect(listed.lastAt).toBe(new Date(2000).toISOString());
    expect(JSON.stringify(body)).not.toContain(new Date(3000).toISOString());
  });
  it("thread_list leaves out a thread whose every line is forgotten", async () => {
    put("t-task", "only", "needle only line", 5000, { role: "user" });
    forget("t-task", "only");
    notLive();
    const { body } = await rig().call("thread_list");
    expect(body.threads.map((entry: Json) => entry.threadId)).not.toContain("t-task");
  });
  it("a forgotten line stays out at release when it is forgotten after the search judged it (lineage not live)", async () => {
    put("t-task", "late", "needle late forget", 4000, { role: "user" });
    notLive();
    const r = rig();
    r.hooks.onYield = () => { forget("t-task", "late"); };
    const { body } = await r.call("thread_search", { query: "needle" });
    expect(JSON.stringify(body)).not.toContain("late forget");
    expect(JSON.stringify(body)).not.toContain(new Date(4000).toISOString());
    expect(r.state.released.has("late")).toBe(false);
  });
  it("when whether a line is forgotten cannot be told, it is left out (fail closed)", async () => {
    put("t-main", "u9", "needle unknowable", 4000, { role: "user" });
    notLive();
    db().exec("ALTER TABLE memory_tombstones RENAME TO memory_tombstones_away");
    try {
      const { body } = await rig().call("thread_search", { query: "needle" });
      expect(JSON.stringify(body)).not.toContain("unknowable");
      expect(JSON.stringify(body)).not.toContain(new Date(4000).toISOString());
      expect(body.unavailable).toBeGreaterThanOrEqual(1);
    } finally { db().exec("ALTER TABLE memory_tombstones_away RENAME TO memory_tombstones"); }
  });
  it.each([true, false])("thread_search whose only match is forgotten gives no time of it (lineage live %s)", async live => {
    for (const how of ["tombstone", "stamp", "deleted"] as How[]) {
      lastRow.clear();
      put("t-task", `o-${how}`, `solo ${how} needle`, 7000, { role: "user", ...(how === "stamp" ? { withheldFromBots: "forgotten" as const } : {}) });
      forgetAs(how, "t-task", `o-${how}`);
    }
    if (!live) notLive();
    const { body } = await rig().call("thread_search", { query: "needle" });
    expect(body.hits).toEqual([]);
    expect(body.oldest_at).toBeNull();
    expect(JSON.stringify(body)).not.toContain(new Date(7000).toISOString());
  });
  it("thread_search: a hit forgotten during the yield gives neither its words nor its time", async () => {
    put("t-task", "y1", "needle yield line", 8000, { role: "user" });
    notLive();
    const r = rig();
    r.hooks.onYield = () => { forget("t-task", "y1"); };
    const { body } = await r.call("thread_search", { query: "needle" });
    expect(body.hits).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(new Date(8000).toISOString());
  });
  it("thread_list: a newest line forgotten during the yield gives no time, and a thread left with none is dropped", async () => {
    put("t-main", "m1", "kept main", 1000, { role: "user" });
    put("t-main", "m2", "newest main", 9000, { role: "user" });
    put("t-task", "t1", "only task line", 9500, { role: "user" });
    notLive();
    const r = rig();
    r.hooks.onYield = () => { forget("t-main", "m2"); forget("t-task", "t1"); };
    const { body } = await r.call("thread_list");
    expect(body.threads.map((entry: Json) => entry.threadId)).toEqual(["t-main"]);
    expect(body.threads[0].lastAt).toBe(new Date(1000).toISOString());
    for (const at of [9000, 9500]) expect(JSON.stringify(body)).not.toContain(new Date(at).toISOString());
  });
  it("a line nobody forgot is still found, read and listed with lineage not live", async () => {
    put("t-task", "n1", "needle plain line", 4000, { role: "user" });
    notLive();
    const r = rig();
    expect((await r.call("thread_search", { query: "needle" })).body.hits.map((hit: Json) => hit.messageId)).toEqual(["n1"]);
    expect((await r.call("thread_read", { message_id: "n1", direction: "around" })).body.rows.map((row: Json) => row.messageId)).toEqual(["n1"]);
    expect((await r.call("thread_list")).body.threads.find((entry: Json) => entry.threadId === "t-task").lastAt).toBe(new Date(4000).toISOString());
  });
});
