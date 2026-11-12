// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { appendMessage, closeMessageDb, setActiveLeaf } from "./message-db.ts";
import * as branches from "./branch-store.ts";
import * as principals from "./human-principals.ts";
import * as recallPolicy from "./memory/policy.ts";
import * as lineageWrites from "./memory/lineage-write.ts";
import * as remembered from "./memory/replay-lineage.ts";
import { beginOutsideTurn, turnEmailDerived, turnOutsideRead } from "./email/external-marks.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { ensureScope, memoryAccess, packLoan, recallThreads, reconcileMemoryRoster, type MemoryRoster, type PackLoanTurn } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { setExecutionStore } from "./execution-audience.ts";
import { closeTurnLineage, currentTurnLineage, openTurnLineage, writeSessionLineage } from "./memory/lineage-write.ts";
import { beginTurnLineage } from "./steer-lineage.ts";
import { readDelegationPack, envelopeBytes, CALLS_LINE, NOT_ACTIVE_LINE, UNRECORDED_LINE, releaseDelegationPacks, THREAD_ENVELOPE_BUDGET, threadRecallRoute, type PackReleaseHost, type ThreadRecallState } from "./thread-recall.ts";
import type { DelegationPack } from "./delegation-pack/types.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

let roster: MemoryRoster;
let bots: BotRecord[];
const db = () => database();
const put = (thread: string, id: string, text = id, parentId: string | null = null, extra: Partial<Message> = {}) =>
  appendMessage(thread, { id, role: "bot", kind: "text", text, at: 1000, parentId, ...extra });
const pack = (extra: Partial<DelegationPack> = {}): DelegationPack => ({
  id: "pack", delegation_id: "job", source_thread_id: "source", source_bot_id: "sable", target_bot_id: "ember",
  destination_thread_id: "destination", refs: ["lent"], prepared: [], cut_at: 1000, created_at: 1000, ...extra,
});
function save(p = pack()) {
  db().prepare("INSERT OR REPLACE INTO delegation_packs VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    p.id, p.delegation_id, p.source_thread_id, p.source_bot_id, p.target_bot_id, p.destination_thread_id,
    JSON.stringify(p.refs), JSON.stringify(p.prepared), p.cut_at, p.created_at);
}
function rig(notOwnerAudience = false) {
  const registry = new InternalCapabilities();
  registry.begin("ember", "destination", "g");
  const token = registry.mint({ botId: "ember", threadId: "destination", generation: "g", depth: 0, kind: "memory", skillAuthoring: false, ...(notOwnerAudience ? { notOwnerAudience: true as const } : {}) });
  const claim = registry.resolve(`Bearer ${token}`)!;
  const access = () => memoryAccess(registry, claim, () => roster);
  const turn = openTurnLineage(db(), { threadId: "destination", turnId: "pack-turn" });
  const lineage = beginTurnLineage({ threadId: "destination", botId: "ember", roots: { roots: new Set(), over: false }, instanceId: "claude", generation: "g", turn, startGeneration: 0, shown: [], withheldNow: () => false });
  const state: ThreadRecallState = { calls: 0, released: new Map(), sealed: false };
  const loanTurn: PackLoanTurn = { generation: "g", driverKind: "claude", delegationId: "job", isUnattended: () => false };
  const host: PackReleaseHost = {
    claim, access, lineage: () => lineage, active: () => registry.isActive(claim), ownerGeneration: () => "g", state: () => state,
    seal: vi.fn(), turn: () => loanTurn,
  };
  const render = (ids = ["pack"]) => releaseDelegationPacks(ids, host);
  const call = async (tool: "thread_read" | "thread_list" | "thread_search", body: unknown, change: () => void = () => {}) => {
    let response: any;
    await threadRecallRoute(tool, body, access(), { ...host, state: () => host.state(), ownerGeneration: () => host.ownerGeneration(), seal: () => host.seal(), yield: async () => { change(); }, respond: (status, result) => { response = { status, body: result }; } });
    return response;
  };
  return { host, state, lineage, loanTurn, registry, access, render, call };
}

beforeEach(() => {
  vi.restoreAllMocks();
  let turn; while ((turn = currentTurnLineage("destination"))) closeTurnLineage(turn);
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  roster = { bots: [{ id: "sable", name: "Sable", threadId: "source", tasks: [{ threadId: "source" }] },
    { id: "ember", name: "Ember", threadId: "destination", tasks: [{ threadId: "destination" }] }], groups: [] };
  bots = roster.bots as BotRecord[];
  setExecutionStore({ bot: (id: string) => bots.find(bot => bot.id === id), bots, groups: [] } as unknown as Store);
  reconcileMemoryRoster(roster); setMemoryMode("active");
  put("source", "lent", "The restaurant is Juniper.");
  put("source", "unlent", "The private next line.", "lent");
  put("destination", "own", "Ember's own line.");
  db().prepare("INSERT INTO pending_delegations(id,source_thread_id,to_bot_id,from_bot_id,phase,item,origin,target_thread_id,started_at) VALUES('job','source','ember','sable','started','{}','owner','destination',1)").run();
  save();
});
afterAll(() => { closeMessageDb(); closeDatabase(); setExecutionStore({ bot: () => undefined, bots: [], groups: [] } as unknown as Store); });
useOutsideStoreFixture();

describe("delegation loan and release", () => {
  it("T-LENT-ONLY: releases only lent pairs and keeps ordinary recall private, including a stale released ID", async () => {
    const r = rig();
    expect([...packLoan(pack(), r.access(), r.loanTurn)!.ids]).toEqual(["lent"]);
    const result = r.render()!;
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]!.text).toContain("The restaurant is Juniper.");
    expect(result.parts[0]!.text).not.toContain("The private next line.");
    expect(result.parts[0]!.lineageOf).toEqual([{ kind: "line", threadId: "source", messageId: "lent" }]);
    expect(result.bindings[0]!.refs.map(ref => ref.id)).toEqual(["lent"]);
    expect(Object.isFrozen(result.bindings[0]!.refs[0])).toBe(true);
    expect(r.state.released.has("lent")).toBe(false);
    expect(recallThreads(r.access())).toEqual(["destination"]);
    expect((await r.call("thread_list", {})).body.threads.map((t: any) => t.threadId)).toEqual(["destination"]);
    expect((await r.call("thread_read", { message_id: "lent", direction: "around" })).body.status).toBe("not-reachable");
    r.state.released.set("own", "destination");
    expect((await r.call("thread_read", { message_id: "own", direction: "around" })).body.rows).toHaveLength(1);
    // A stale entry must still meet planRead's set.includes guard. Removing it changes the status even though release filters again.
    r.state.released.set("lent", "source");
    expect((await r.call("thread_read", { message_id: "lent", direction: "around" })).body).toEqual({ rows: [], status: "not-reachable" });
    expect(db().prepare("SELECT prepared FROM delegation_packs WHERE id='pack'").get()!.prepared).toBe("[]");
  });

  it.each([
    ["excluded source", () => db().prepare("INSERT OR REPLACE INTO memory_scope_bindings VALUES('memory-owner-settings',?,'system','owner-settings',0,'granted',?)").run(ensureScope("conversation", "destination"), JSON.stringify({ excludedThreadIds: ["source"] }))],
    ["isolated destination", () => { bots[1]!.partitionedAt = 1; bots[1]!.tasks![0]!.sharedWork = { teamId: "team", quarantined: true } as any; }],
    ["isolated source", () => { bots[0]!.partitionedAt = 1; bots[0]!.tasks![0]!.sharedWork = { teamId: "team", quarantined: true } as any; }],
    ["partition mismatch", () => { bots[0]!.partitionedAt = 1; bots[0]!.tasks![0]!.channelProjectDesk = { groupId: "project" } as any; }],
    ["room source", () => { roster.groups.push({ id: "room", threadId: "source", memberIds: ["sable", "ember"] }); }],
    ["unattended source", (r: ReturnType<typeof rig>) => { r.loanTurn.isUnattended = () => true; }],
    ["other generation", (r: ReturnType<typeof rig>) => { r.loanTurn.generation = "other"; }],
    ["ended delegation", (r: ReturnType<typeof rig>) => { r.loanTurn.delegationId = undefined; }],
    ["Antigravity", (r: ReturnType<typeof rig>) => { r.loanTurn.driverKind = "antigravity"; }],
  ] as const)("T-LOAN: %s alone refuses a previously accepted loan", (_name, change) => {
    const r = rig();
    expect(r.render()?.lines).toBe(1);
    change(r);
    expect(r.render()).toBeNull();
  });

  it.each(["target_bot_id", "destination_thread_id"] as const)("T-LOAN: foreign pack id with another %s", field => {
    const r = rig();
    save(pack({ id: "foreign" }));
    expect(r.render(["foreign"])?.lines).toBe(1);
    save(pack({ id: "foreign", [field]: "other" }));
    expect(r.render(["foreign"])).toBeNull();
  });

  it("T-LOAN: the same id in another thread is never a candidate", () => {
    const r = rig();
    put("elsewhere", "lent", "Other thread secret.");
    expect(r.render()?.lines).toBe(1);
    db().prepare("DELETE FROM messages WHERE thread_id='source' AND id='lent'").run();
    expect(r.render()).toBeNull();
  });

  it("T-LOAN: a fresh access and loan are required again at release", () => {
    const r = rig();
    expect(r.render()?.lines).toBe(1);
    let calls = 0;
    r.host.access = () => ++calls === 1 ? r.access() : null;
    expect(r.render()).toBeNull();
  });

  it("T-LOAN: a loan is rechecked after the initial judgment", () => {
    const r = rig();
    expect(r.render()?.lines).toBe(1);
    let calls = 0;
    r.host.access = () => {
      if (++calls === 2) db().prepare("UPDATE delegation_packs SET target_bot_id='other' WHERE id='pack'").run();
      return r.access();
    };
    expect(r.render()).toBeNull();
  });

  it("T-LOAN: an unproven audience never borrows owner context", () => {
    expect(rig().render()?.lines).toBe(1);
    expect(rig(true).render()).toBeNull();
  });

  it.each(["source", "destination"])("T-LOAN: a changed %s principal refuses the loan", thread => {
    const r = rig();
    expect(r.render()?.lines).toBe(1);
    const original = principals.threadHumanPrincipal;
    vi.spyOn(principals, "threadHumanPrincipal").mockImplementation((id, db) => id === thread
      ? { personId: "person", bindingId: "binding", revision: 1 } : original(id, db));
    expect(r.render()).toBeNull();
  });

  it.each([false, undefined])("T-BRANCH: membership %s is not proof of membership", membership => {
    const r = rig();
    expect(r.render()?.lines).toBe(1);
    const original = branches.branchRows;
    vi.spyOn(branches, "branchRows").mockImplementation((thread, leaf) => ({ ...original(thread, leaf), contains: () => membership }));
    expect(r.render()).toBeNull();
  });

  it("T-BRANCH: a rebuilt render checks the current source branch", () => {
    const r = rig();
    expect(r.render()?.lines).toBe(1);
    put("source", "fork", "A different branch.");
    setActiveLeaf("source", "fork");
    expect(r.render()).toBeNull();
  });

  it("T-REPLAY: requires the delegated anchor on the destination branch after queue cleanup", () => {
    const r = rig();
    put("destination", "anchor", "Delegated note", "own", { automation: { kind: "delegation" }, packId: "pack" } as Partial<Message>);
    const mrow = Number(db().prepare("SELECT rowid AS mrow FROM messages WHERE thread_id='destination' AND id='anchor'").get()!.mrow);
    r.loanTurn.delegationId = undefined;
    r.loanTurn.anchor = { messageId: "anchor", mrow };
    db().prepare("DELETE FROM pending_delegations").run();
    expect(r.render()?.bindings[0]!.anchor).toEqual({ messageId: "anchor", mrow });
    setActiveLeaf("destination", "own");
    expect(r.render()).toBeNull();
  });

  it("T-BUDGET: final fences fit and an oversized row is dropped whole", () => {
    const r = rig();
    put("source", "short", "Kept whole.", "unlent");
    save(pack({ refs: ["short"] }));
    expect(r.render()?.parts[0]!.text).toContain("Kept whole.");
    const long = "界<<".repeat(6000);
    put("source", "large", long, "short");
    save(pack({ refs: ["large"] }));
    expect(r.render()).toBeNull();
    put("source", "newest", "Newest whole.", "large");
    save(pack({ refs: ["short", "large", "newest"] }));
    const result = r.render()!;
    expect(result.bindings[0]!.refs.map(ref => ref.id)).toEqual(["newest"]);
    expect(Buffer.byteLength(result.parts.map(part => part.text).join("\n\n"))).toBeLessThanOrEqual(THREAD_ENVELOPE_BUDGET);
  });

  it("T-BUDGET: newest-first replay shares one budget and considers at most three packs", () => {
    const r = rig();
    r.loanTurn.delegationId = undefined;
    const anchors = new Map<string, { messageId: string; mrow: number }>();
    let sourceParent = "unlent", destinationParent = "own";
    for (let i = 0; i < 4; i++) {
      const id = `p${i}`, ref = `r${i}`, anchor = `a${i}`;
      put("source", ref, String(i).repeat(11000), sourceParent); sourceParent = ref;
      put("destination", anchor, "Delegated note", destinationParent, { automation: { kind: "delegation" }, packId: id } as Partial<Message>); destinationParent = anchor;
      save(pack({ id, delegation_id: `j${i}`, refs: [ref] }));
      anchors.set(id, { messageId: anchor, mrow: Number(db().prepare("SELECT rowid AS mrow FROM messages WHERE thread_id='destination' AND id=?").get(anchor)!.mrow) });
    }
    r.host.turn = id => ({ ...r.loanTurn, anchor: anchors.get(id) });
    const result = r.render(["p3", "p2", "p1", "p0"])!;
    expect(result.bindings.map(binding => binding.packId)).toEqual(["p3", "p2"]);
    expect(Buffer.byteLength(result.parts.map(part => part.text).join("\n\n"))).toBeLessThanOrEqual(THREAD_ENVELOPE_BUDGET);
    // With small rows the same discovery list still excludes the fourth pack.
    for (let i = 0; i < 4; i++) save(pack({ id: `p${i}`, delegation_id: `j${i}`, refs: ["lent"] }));
    expect(r.render(["p3", "p2", "p1", "p0"])!.bindings.map(binding => binding.packId)).toEqual(["p3", "p2", "p1"]);
  });

  it("T-FORGET: a forgotten candidate is skipped on the next render", () => {
    const r = rig();
    expect(r.render()?.lines).toBe(1);
    db().prepare("INSERT INTO memory_tombstones VALUES('forgot','source','message:source:lent',1,NULL,1,'owner-forget',1)").run();
    expect(r.render()).toBeNull();
  });

  it("T-FORGET-UNKNOWN: unavailable forget state releases nothing", () => {
    const r = rig();
    expect(r.render()?.lines).toBe(1);
    vi.spyOn(remembered, "forgottenMessageSources").mockImplementation(() => { throw new Error("fixture unavailable"); });
    expect(r.render()).toBeNull();
  });

  it("T-MARK: email formatting and the outside mark follow retained rows", () => {
    const r = rig();
    beginOutsideTurn("destination", "claude", "g", false);
    put("source", "mail", "Restaurant from email.", "unlent", { externalContent: "email" });
    save(pack({ refs: ["mail"] }));
    expect(turnEmailDerived("destination")).toBe(false);
    const result = r.render()!;
    expect(result.parts[0]!.text).toContain("kind=email-derived");
    expect(turnEmailDerived("destination")).toBe(true);
    expect(turnOutsideRead("destination")).not.toBeNull();
  });

  it("the source preflight and read persistence can each refuse a release", () => {
    const r = rig();
    expect(r.render()?.lines).toBe(1);
    const sources = r.lineage.sources;
    r.lineage.sources = "over";
    expect(r.render()).toBeNull();
    r.lineage.sources = sources;
    expect(r.render()?.lines).toBe(1);
    vi.spyOn(lineageWrites, "recordTurnReads").mockReturnValue(false);
    expect(r.render()).toBeNull();
  });

  it("T-SEAL: a pack and an ordinary read share one seal", async () => {
    const r = rig();
    expect(r.render()?.lines).toBe(1);
    r.state.released.set("own", "destination");
    expect((await r.call("thread_read", { message_id: "own", direction: "around" })).body.rows).toHaveLength(1);
    expect(r.host.seal).toHaveBeenCalledTimes(1);
  });

  it("T-SEAL: a failed seal releases no part or parents", () => {
    const r = rig();
    r.host.seal = () => { throw new Error("fixture seal refusal"); };
    expect(r.render()).toBeNull();
    expect(r.lineage.turn.parents).toEqual([]);
    r.host.seal = vi.fn();
    expect(r.render()?.lines).toBe(1);
  });

  it("T-SESSION-RESUMED: retained refs become session reads and turn parents", () => {
    const r = rig();
    transaction(tx => writeSessionLineage(tx, { threadId: "destination", driverInstance: "claude", nativeSession: "session" }, r.lineage.turn));
    expect(r.lineage.turn.parents).toEqual([]);
    expect(r.render()?.lines).toBe(1);
    expect(r.lineage.turn.parents).toContainEqual({ kind: "line", threadId: "source", messageId: "lent" });
    expect(db().prepare("SELECT 1 FROM memory_lineage_carry WHERE child_kind=2").get()).toBeTruthy();
  });

  it("suppression and the last resort each omit an eligible pack", () => {
    const r = rig();
    expect(r.render()?.lines).toBe(1);
    r.host.packSuppressed = true;
    expect(r.render()).toBeNull();
    r.host.packSuppressed = undefined;
    r.host.memoryLastResort = true;
    expect(r.render()).toBeNull();
  });
});


// Each fixture uses an isolated database and a stub generation host. Dispatch wiring belongs to slice 6b.
function older(count = 200, words: (i: number) => string = i => `line ${i}`) {
  let parent: string | null = null;
  const all = Array.from({ length: count }, (_, i) => `older-${i}`);
  all.forEach((id, i) => { put("source", id, words(i), parent, i % 2 ? { externalContent: "email" } : {}); parent = id; });
  save(pack({ refs: all.slice(-160) }));
  const r = rig();
  const initial = r.render()!;
  expect(initial).not.toBeNull();
  r.state.pack = { bindings: initial.bindings, turn: r.host.turn };
  const page = (cursor = all.at(-40)!, limit?: number, change?: () => void) =>
    r.call("thread_read", { message_id: cursor, direction: "before", ...(limit ? { limit } : {}) }, change);
  return { ...r, all, initial, page };
}
function pageRows(body: { context: string }): Array<{ messageId: string; text: string; truncated?: boolean }> {
  expect(typeof body.context).toBe("string");
  if (!body.context) return [];
  const start = body.context.indexOf('{"rows":');
  const end = body.context.lastIndexOf(']}') + 2;
  return JSON.parse(body.context.slice(start, end)).rows;
}
const pageIds = (body: { context: string }) => pageRows(body).map(row => row.messageId);
const prepared = () => JSON.parse(String(db().prepare("SELECT prepared FROM delegation_packs WHERE id='pack'").get()!.prepared));
const forget = (id: string) => db().prepare("INSERT INTO memory_tombstones VALUES(?, 'source', ?,1,NULL,1,'owner-forget',1)").run(`forgot-${id}`, `message:source:${id}`);

describe("older delegation context", () => {
  it("T-OLDER-READ: bounded lent metadata, newest page zero, and unchanged small-pack bytes", () => {
    const r = older();
    expect(readDelegationPack("pack")!.refs).toEqual(r.all.slice(40));
    expect(r.initial.bindings[0]!.refs.map(ref => ref.id)).toEqual(r.all.slice(160));
    expect(r.initial.parts[0]!.text).toContain('"older_lines":true');
    // Fence nonces are random on every render; all other bytes must be identical.
    const stable = (text: string) => text.replace(/id=[0-9a-f]{16}/g, "id=<nonce>");
    const text = stable(r.initial.parts[0]!.text).replace(',"older_lines":true', '');
    save(pack({ refs: r.all.slice(160) }));
    expect(stable(r.render()!.parts[0]!.text)).toBe(text);
    save(pack({ refs: r.all.slice(39) })); expect(readDelegationPack("pack")).toBeNull();
    save(pack({ refs: r.all.slice(40), prepared: [r.all[0]!] })); expect(readDelegationPack("pack")).toBeNull();
    save(pack({ refs: r.all.slice(40), prepared: r.all.slice(40) })); expect(readDelegationPack("pack")!.prepared).toHaveLength(160);
    save(pack({ refs: r.all.slice(40), prepared: [...r.all.slice(40), r.all[40]!] })); expect(readDelegationPack("pack")).toBeNull();
  });

  it("T-OLDER-PAGE: 200-line source pages only its lent 160, appends exact frozen bindings and prepares a union", async () => {
    const r = older();
    const bindings = r.state.pack!.bindings;
    let cursor = r.all[160]!;
    const ordinary = vi.spyOn(recallPolicy, "recallThreads").mockReturnValue([]);
    expect(recallThreads(r.access())).toEqual([]);
    for (const start of [120, 80, 40]) {
      const result = await r.page(cursor);
      if (start === 120) ordinary.mockRestore();
      expect(result.status).toBe(200);
      expect(pageIds(result.body)).toEqual(r.all.slice(start, start + 40));
      expect(result.body.more).toBe(start !== 40);
      expect(r.state.pack!.bindings).toBe(bindings);
      const binding = bindings.at(-1)!;
      expect(binding.page).toBe(true);
      expect(binding.refs.map(ref => ref.id)).toEqual(pageIds(result.body));
      expect(Object.isFrozen(binding)).toBe(true); expect(Object.isFrozen(binding.refs)).toBe(true);
      expect(binding.refs.every(Object.isFrozen)).toBe(true);
      cursor = pageIds(result.body)[0]!;
    }
    expect(prepared()).toEqual([...r.all.slice(120, 160), ...r.all.slice(80, 120), ...r.all.slice(40, 80)]);
    expect(r.state.released.size).toBe(0);
    expect((await r.page(cursor)).body).toEqual({ context: "", more: false, notice: "No older lines were lent for this job. Ask Sable if you need more." });
    expect(bindings).toHaveLength(4);
    expect(recallThreads(r.access())).toEqual(["destination"]);
  });

  it("T-OLDER-PAGE: repeated cursors, limit one, and shared call 13 refusal", async () => {
    const r = older();
    for (let i = 0; i < 12; i++) {
      const result = await r.page(undefined, 1);
      expect(pageIds(result.body)).toEqual([r.all[159]]); expect(result.body.more).toBe(true);
    }
    expect(r.state.pack!.bindings).toHaveLength(13);
    expect(prepared()).toEqual([r.all[159]]);
    expect((await r.page()).body.error).toBe(CALLS_LINE);
  });

  it("T-OLDER-PAGE: three bound packs, first binding wins a source-pair cursor collision", async () => {
    const r = older();
    save(pack({ id: "second", delegation_id: "job-second", refs: [r.all[50]!, r.all[180]!] }));
    save(pack({ id: "third", delegation_id: "job-third", refs: [r.all[60]!, r.all[100]!] }));
    for (const id of ["second", "third"]) db().prepare("INSERT INTO pending_delegations(id,source_thread_id,to_bot_id,from_bot_id,phase,item,origin,target_thread_id,started_at) VALUES(?,'source','ember','sable','started','{}','owner','destination',1)").run(`job-${id}`);
    r.host.turn = id => ({ ...r.loanTurn, delegationId: id === "pack" ? "job" : `job-${id}` });
    r.state.pack!.turn = r.host.turn;
    const result = r.render(["second", "pack", "third"])!;
    expect(result.bindings).toHaveLength(3);
    r.state.pack!.bindings = result.bindings;
    expect(pageIds((await r.page(r.all[180]!)).body)).toEqual([r.all[50]]);
    expect(pageIds((await r.page(r.all[160]!)).body)).toEqual(r.all.slice(120, 160));
    expect(pageIds((await r.page(r.all[100]!)).body)).toEqual([r.all[60]]);
  });

  it("T-OLDER-PAGE: after, around, unserved and unbound ids keep ordinary reachability", async () => {
    const r = older();
    expect(pageIds((await r.page()).body)).toHaveLength(40);
    for (const [id, direction] of [[r.all[160], "after"], [r.all[160], "around"], [r.all[70], "before"], [r.all[0], "before"]]) {
      expect((await r.call("thread_read", { message_id: id, direction })).body).toEqual({ rows: [], status: "not-reachable" });
    }
    r.state.pack!.bindings = [];
    expect((await r.page()).body).toEqual({ rows: [], status: "not-reachable" });
  });

  it("T-OLDER-REFILL: forgotten nearest window refills, oversized rows stay whole, and more requires a readable fitting row", async () => {
    const r = older(200, i => i === 119 ? "large".repeat(20000) : `line ${i}`);
    for (let i = 120; i < 160; i++) forget(r.all[i]!);
    for (let i = 40; i < 118; i++) forget(r.all[i]!);
    const result = await r.page();
    expect(pageIds(result.body)).toEqual([r.all[118]]);
    expect(result.body.more).toBe(false); expect(result.body.unavailable).toBe(119);
    expect(pageRows(result.body)[0]!.truncated).toBeUndefined();
    expect((await r.page(r.all[118]!)).body).toMatchObject({ context: "", more: false });
    forget(r.all[118]!);
    expect((await r.page()).body).toMatchObject({ context: "", more: false });
  });

  it.each(["stop", "replacement", "state replacement", "seal", "reads"])("T-OLDER-RACE: %s during yield appends and prepares nothing", async failure => {
    const r = older();
    expect(pageIds((await r.page(undefined, 1)).body)).toEqual([r.all[159]]);
    db().prepare("UPDATE delegation_packs SET prepared='[]'").run();
    const n = r.state.pack!.bindings.length;
    const result = await r.page(undefined, undefined, () => {
      if (failure === "stop") r.registry.begin("ember", "destination", "stopped");
      if (failure === "replacement") r.host.ownerGeneration = () => "replacement";
      if (failure === "state replacement") r.host.state = () => ({ ...r.state });
      if (failure === "seal") { r.state.sealed = false; r.host.seal = () => { throw new Error("seal"); }; }
      if (failure === "reads") vi.spyOn(lineageWrites, "recordTurnReads").mockReturnValue(false);
    });
    expect(result).toEqual({ status: 409, body: { error: failure === "seal" || failure === "reads" ? UNRECORDED_LINE : NOT_ACTIVE_LINE } });
    expect(r.state.pack!.bindings).toHaveLength(n); expect(prepared()).toEqual([]);
  });

  it("T-OLDER-RACE: prepared write failure warns but sends the already released page", async () => {
    const r = older();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    db().exec("CREATE TRIGGER refuse_prepared BEFORE UPDATE OF prepared ON delegation_packs BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    expect(pageIds((await r.page()).body)).toEqual(r.all.slice(120, 160));
    expect(r.state.pack!.bindings).toHaveLength(2); expect(prepared()).toEqual([]);
    expect(warn).toHaveBeenCalledWith("[deleg.pack.prepared_unrecorded] count=1");
  });

  it("T-OLDER-REPLAY: a fresh session renders page zero only and loans pages through the live delegated anchor", async () => {
    const first = older();
    await first.page();
    closeTurnLineage(first.lineage.turn);
    put("destination", "anchor", "Delegated note", "own", { automation: { kind: "delegation" }, packId: "pack" } as Partial<Message>);
    db().prepare("DELETE FROM pending_delegations").run();
    const r = rig();
    r.loanTurn.delegationId = undefined;
    r.loanTurn.anchor = { messageId: "anchor", mrow: Number(db().prepare("SELECT rowid AS mrow FROM messages WHERE thread_id='destination' AND id='anchor'").get()!.mrow) };
    const initial = r.render()!;
    expect(initial.bindings[0]!.refs.map(ref => ref.id)).toEqual(first.all.slice(160));
    r.state.pack = { bindings: initial.bindings, turn: r.host.turn };
    const read = () => r.call("thread_read", { message_id: first.all[160], direction: "before" });
    expect(pageIds((await read()).body)).toEqual(first.all.slice(120, 160));
    setActiveLeaf("destination", "own");
    const n = r.state.pack.bindings.length;
    expect(pageIds((await read()).body)).toEqual([]);
    expect(r.state.pack.bindings).toHaveLength(n);
  });

  it("T-OLDER-SIZE: escaped Unicode and email whole rows fit the full envelope and the real proxy", async () => {
    const r = older(200, i => i < 160 ? '\\"界🙂'.repeat(500) : `line ${i}`);
    let answer: any;
    const stub = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(answer)); });
    await new Promise<void>(resolve => stub.listen(0, "127.0.0.1", resolve));
    const address = stub.address() as { port: number };
    const child = spawn(process.execPath, ["--experimental-strip-types", "server/drivers/memory-proxy.ts"], {
      env: { ...process.env, MURAGE_HARNESS_URL: `http://127.0.0.1:${address.port}`, MURAGE_MEMORY_TOKEN: "fixture" }, stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      let cursor = r.all[160]!;
      for (let i = 0; i < 3; i++) {
        answer = (await r.page(cursor)).body;
        const rows = pageRows(answer);
        expect(rows.length).toBeGreaterThan(0); expect(rows.length).toBeLessThan(40);
        expect(envelopeBytes(answer)).toBeLessThanOrEqual(THREAD_ENVELOPE_BUDGET);
        expect(rows.every(row => !row.truncated && row.text.includes('界🙂'))).toBe(true);
        expect(answer.context).toContain("kind=email-derived");
        const reply = new Promise<any>((resolve, reject) => {
          let text = "";
          const timer = setTimeout(() => { child.stdout.off("data", receive); reject(new Error("proxy timeout")); }, 5000);
          const receive = (chunk: Buffer) => { text += chunk.toString(); if (text.includes("\n")) { clearTimeout(timer); child.stdout.off("data", receive); resolve(JSON.parse(text.trim())); } };
          child.stdout.on("data", receive);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(256), method: "tools/call", params: { name: "thread_read", arguments: { message_id: cursor, direction: "before" } } }) + "\n");
        const rpc = await reply;
        expect(rpc.result.isError).toBe(false); expect(JSON.parse(rpc.result.content[0].text)).toEqual(answer);
        cursor = rows[0]!.messageId;
      }
    } finally { child.kill(); await new Promise<void>(resolve => stub.close(() => resolve())); }
  });
});
