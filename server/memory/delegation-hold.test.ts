// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DELEGATION-HOLD-1015 (F1, F2). A home bot-to-bot ask moved the pair room to the asker's section whenever the two bots sat in different
// sections, and the memory policy read a room's section as an audience fact, so every ask ended every memory receipt on the machine and the
// marker walk held replies "checking" (Sean's 3-bot design chat on 1.0.13: Finch in Dev Shop, Sable in Sean's Office, Kessler in Operations).
// F1: the pair room keeps its section; only a room whose section matches neither member is re-homed, once. F2: a DM pair room's section is
// placement only, never an audience fact. Positive controls: every fact an access rule reads still revokes.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { Store, type BotRecord, type GroupRecord } from "../store.ts";
import { getOrCreateChannel } from "../comms-visibility.ts";
import { closeMessageDb } from "../message-db.ts";
import { bindHumanThread, linkHumanBinding, observeVerifiedHuman, resolveHumanBinding } from "../human-principals.ts";
import { backgroundMemoryScopes, memoryAccess, ownerReaderScopeSets, persistMemoryRoster, type MemoryRoster } from "./policy.ts";
import { memoryState, setMemoryMode } from "./repository.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { resetSessionHolds } from "./disclosures.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { _resetPending, queueDelegation } from "../delegations.ts";
import { dispatchHandoff } from "../handoff-dispatch.ts";
import { _resetOwnerMigration } from "../pending-delegations-schema.ts";
import { heldNotices } from "../testing/handoff-turn.ts";
import { ownerWorld } from "../testing/handoff-worlds.ts";

beforeEach(async () => { closeMessageDb(); closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); thawRootSetWritesForTest(true); resetSessionHolds(); });
afterEach(() => { thawRootSetWritesForTest(false); vi.restoreAllMocks(); closeMessageDb(); });

const policyRevision = () => memoryState().policyRevision;
function globalRevokes() {
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { const line = args.map(String).join(" "); if (line.includes("memory receipts revoked") && line.includes("scope=global")) lines.push(line); });
  return lines;
}
/** A live receipt citing nothing, as a warm session holds: a global revoke flips it. */
function liveReceipt(threadId: string) {
  const state = memoryState(), id = `receipt-${threadId}`;
  database().prepare("INSERT INTO memory_disclosures VALUES(?,?,?,?,'[]','[]','[]',?,?,0,'delivered',?)").run(id, threadId, "claude", `S-${threadId}`, state.policyRevision, state.deletionEpoch, Date.now());
  return id;
}
const receiptState = (id: string) => database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(id)?.state;

/** Sean's shape: three bots in three sections, Kessler shared into two more. The Store saves its roster through persistMemoryRoster. */
function world() {
  const store = new Store(() => ({ instanceId: "claude", model: "fixture" }));
  const finch = store.createBot({ name: "Finch", section: "Dev Shop" });
  const sable = store.createBot({ name: "Sable", section: "Sean's Office" });
  const kessler = store.createBot({ name: "Kessler", section: "Operations" });
  setMemoryMode("active");
  return { store, finch, sable, kessler };
}

describe("F1: a pair room stays where it is", () => {
  it("T1: two bots in different sections ask each other 4 times: no global revoke, no policy bump, the room section never moves", () => {
    const { store, finch, sable } = world();
    const room = getOrCreateChannel(store, finch, sable);
    expect(room.section).toBe("Dev Shop");
    const receipts = [liveReceipt(finch.threadId), liveReceipt(sable.threadId)];
    const lines = globalRevokes(), before = policyRevision();
    for (let n = 0; n < 4; n++) {
      const [from, target] = n % 2 === 0 ? [sable, finch] : [finch, sable];
      const again = getOrCreateChannel(store, from, target);
      expect(again.id).toBe(room.id);
      expect(again.section).toBe("Dev Shop");
    }
    expect(store.group(room.id)?.section).toBe("Dev Shop");
    expect(policyRevision()).toBe(before);
    expect(lines).toEqual([]);
    for (const id of receipts) expect(receiptState(id)).toBe("delivered");
  });

  it("T2: a stale pair room (its section matches neither member) is re-homed once to the asker's section and ends no receipt", () => {
    const { store, finch, kessler } = world();
    const stale = store.createGroup("Finch ⇄ Kessler", [finch.id, kessler.id], true, "Old Team");
    const receipt = liveReceipt(finch.threadId);
    const lines = globalRevokes(), before = policyRevision();
    expect(getOrCreateChannel(store, kessler, finch).section).toBe("Operations");
    // the reverse ask finds a room that now matches a member and leaves it alone
    expect(getOrCreateChannel(store, finch, kessler).section).toBe("Operations");
    expect(getOrCreateChannel(store, kessler, finch).section).toBe("Operations");
    expect(store.group(stale.id)?.section).toBe("Operations");
    expect(policyRevision()).toBe(before);
    expect(lines).toEqual([]);
    expect(receiptState(receipt)).toBe("delivered");
  });

  it("T2: a pair room with a dmAudience is never re-homed", () => {
    const { store, finch, sable } = world();
    const dmAudience = { kind: "team", teamId: "team-x" } as const;
    const tagged = store.createGroup("Finch ⇄ Sable", [finch.id, sable.id], true, "Elsewhere", undefined, dmAudience);
    const found = getOrCreateChannel(store, finch, sable, finch.threadId, { kind: "team", team: "team-x" } as never);
    expect(found.id).toBe(tagged.id);
    expect(store.group(tagged.id)?.section).toBe("Elsewhere");
  });
});

/** Every reader's scope set, judged live against the store's own roster (filterPartitionScopes reads executionStore(), which is this store):
 * each bot on its direct chat, its tasks and every room it is in, as an owner turn and as a turn nobody proved is the owner's; a person-bound
 * task; the owner reader sets pins use; background scopes. */
function readers(store: Store, person: ReturnType<typeof resolveHumanBinding>, personThread: string) {
  const roster = () => ({ bots: store.bots, groups: store.groups } as unknown as MemoryRoster);
  const out: Record<string, string> = {};
  const one = (botId: string, thread: string, mode: "owner" | "not-owner" | "person") => {
    const key = `${botId}|${thread}|${mode}`;
    try {
      const registry = new InternalCapabilities(); registry.begin(botId, thread, "g", mode === "person" ? person : undefined);
      const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false, ...(mode === "not-owner" ? { notOwnerAudience: true } : {}), ...(mode === "person" ? { humanPrincipal: person } : {}) });
      out[key] = JSON.stringify([...memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, roster).scopeIds].sort());
    } catch (error) { out[key] = `ERR:${(error as Error).message}`; }
    out[`${key}|bg`] = JSON.stringify([...backgroundMemoryScopes(botId, thread, roster())].sort());
  };
  for (const bot of store.bots) {
    const threads = [bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId), ...store.groups.filter(group => group.memberIds.includes(bot.id)).flatMap(group => [group.threadId, ...(group.tasks ?? []).map(task => task.threadId)])];
    for (const thread of new Set(threads)) {
      if (thread === personThread) { one(bot.id, thread, "person"); continue; }
      one(bot.id, thread, "owner"); one(bot.id, thread, "not-owner");
    }
  }
  out.ownerSets = JSON.stringify(ownerReaderScopeSets(roster()).map(set => ({ room: set.room, ids: [...set.scopeIds].sort() })));
  return out;
}

function fullWorld() {
  const w = world(), { store, finch, sable, kessler } = w;
  // a partitioned bot, task threads, a person-bound task, two plain non-dm rooms (Design, Launch). The tagged pairs hold unpartitioned
  // bots and "team-ops" is a bare tag, so they pin section-independence of the audience tags, not partitioned team or project access.
  const pell = store.createBot({ name: "Pell", section: "Operations" }) as BotRecord;
  pell.partitionedAt = 1;
  store.createTask(finch.id, "spec", false); store.createTask(pell.id, "ops", false);
  const personTask = store.createTask(sable.id, "guest", false)!;
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId: "guest" });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  const person = resolveHumanBinding(binding);
  bindHumanThread(personTask.threadId, person);
  const design = store.createGroup("Design", [finch.id, sable.id, kessler.id], false, "Dev Shop");
  const project = store.createGroup("Launch", [finch.id, kessler.id, pell.id], false, "Operations");
  // every dmAudience kind, and the plain home pair rooms Sean's chat made
  const pairs: GroupRecord[] = [
    getOrCreateChannel(store, finch, sable),
    getOrCreateChannel(store, finch, kessler),
    store.createGroup("Pell ⇄ Kessler", [pell.id, kessler.id], true, "Operations"),
    store.createGroup("Finch ⇄ Kessler (team)", [finch.id, kessler.id], true, "Operations", undefined, { kind: "team", teamId: "team-ops" }),
    store.createGroup("Finch ⇄ Kessler (project)", [finch.id, kessler.id], true, "Operations", undefined, { kind: "project", groupId: project.id }),
    store.createGroup("Finch ⇄ Sable (room)", [finch.id, sable.id], true, "Dev Shop", undefined, { kind: "room", groupId: design.id }),
    store.createGroup("Pell ⇄ Kessler (isolated)", [pell.id, kessler.id], true, "Operations", undefined, { kind: "isolated" }),
  ];
  return { ...w, pell, design, project, pairs, person, personThread: personTask.threadId };
}

describe("F2: a DM pair room's section is not an audience fact", () => {
  it("T3: every roster that differs only in a dm room's section gives every reader the same scopes, with no revoke", () => {
    const w = fullWorld();
    const baseline = readers(w.store, w.person, w.personThread);
    // no reader may fail: an ERR string would compare equal to itself and hide a broken reader
    expect(Object.entries(baseline).filter(([, value]) => value.startsWith("ERR:"))).toEqual([]);
    // every owner turn on a bot's own chat and on every pair room it sits in reads a real, nonempty scope set
    const ownerReads = [...w.store.bots.map(bot => `${bot.id}|${bot.threadId}|owner`), ...w.pairs.flatMap(pair => pair.memberIds.map(id => `${id}|${pair.threadId}|owner`))];
    for (const key of ownerReads) expect(JSON.parse(baseline[key] ?? "[]").length, key).toBeGreaterThan(0);
    const { sable } = w;
    const receipts = [liveReceipt(w.finch.threadId), liveReceipt(sable.threadId), liveReceipt(w.design.threadId)];
    const lines = globalRevokes(), before = policyRevision();
    for (const pair of w.pairs) {
      for (const section of ["Sean's Office", "Smart Trader", "", "Dev Shop"]) {
        w.store.patchGroup(pair.id, { section });
        expect(readers(w.store, w.person, w.personThread), `${pair.name} -> ${section || "(none)"}`).toEqual(baseline);
      }
    }
    expect(policyRevision()).toBe(before);
    expect(lines).toEqual([]);
    for (const id of receipts) expect(receiptState(id)).toBe("delivered");
  });

  it.each(["non-dm room section", "dm member", "dm audience", "dm flag", "bot section"])("T3 control: a %s change is still an audience change", change => {
    const w = fullWorld(), { sable } = w;
    const receipt = liveReceipt(w.finch.threadId);
    const before = policyRevision();
    const next = structuredClone({ bots: w.store.bots, groups: w.store.groups }) as unknown as MemoryRoster;
    const pair = next.groups.find(group => group.id === w.pairs[0]!.id)!;
    if (change === "non-dm room section") next.groups.find(group => group.id === w.design.id)!.section = "Sean's Office";
    if (change === "dm member") pair.memberIds = [w.finch.id, w.kessler.id];
    if (change === "dm audience") pair.dmAudience = { kind: "team", teamId: "team-x" };
    if (change === "dm flag") pair.dm = false;
    if (change === "bot section") next.bots.find(bot => bot.id === sable.id)!.section = "Operations";
    persistMemoryRoster(next, () => undefined);
    expect(policyRevision()).toBeGreaterThan(before);
    expect(receiptState(receipt)).toBe("revoked");
  });
});

// T7 on the fake engine: the real hand-off dispatch path (handoff-dispatch.ts getOrCreateChannel and mirrorExchange) for Sean's chain,
// asks both ways, with memory on and live receipts. It proves no ask revokes memory; the fake only records turn starts, so reply
// delivery, the send fence and recovery are the real-engine T7 on a data copy, owed to the 1.0.15 release gate.
describe("T7 (fake engine): Finch, Sable and Kessler ask each other both ways and no ask revokes memory", () => {
  beforeEach(() => { _resetPending(); _resetOwnerMigration(); heldNotices.splice(0); });
  afterEach(() => { _resetOwnerMigration(); _resetPending(); });

  it("two rounds of asks both ways across three sections: every turn starts, no global revoke, no policy bump, no receipt flip", async () => {
    const w = ownerWorld("owner");
    const finch = w.from, sable = w.target;
    w.store.patchBot(finch.id, { name: "Finch", section: "Dev Shop" });
    w.store.patchBot(sable.id, { name: "Sable", section: "Sean's Office" });
    const kessler = w.store.createBot({ name: "Kessler", section: "Operations" });
    // Can talk to: everyone (three sections, so the section rule alone reaches nobody); a plain home ask carries no team tag
    for (const bot of [finch, sable, kessler]) bot.messageAllow = { mode: "all" };
    setMemoryMode("active");
    const receipts = [liveReceipt(finch.threadId), liveReceipt(sable.threadId), liveReceipt(kessler.threadId)];
    const flips = () => Number(database().prepare("SELECT count(*) AS n FROM memory_receipt_flips").get()!.n);
    const flipsBefore = flips(), lines = globalRevokes(), before = policyRevision();
    const ask = async (from: BotRecord, to: BotRecord, message: string) => {
      const queued = queueDelegation(w.bus, from, { toBotId: to.id, message, depth: 0 }, 2);
      expect(queued.result).toBe("ok");
      const id = queued.id!;
      await dispatchHandoff(id, { bus: w.bus, approvalBus: w.approvalBus });
      return id;
    };
    const ids: string[] = [];
    for (let round = 0; round < 2; round++) {
      ids.push(await ask(finch, sable, `round ${round}: what does the brief say?`));
      ids.push(await ask(finch, kessler, `round ${round}: what can ops ship?`));
      // the reverse asks: an ask sent the other way used to move each pair room to the asker's section
      ids.push(await ask(sable, finch, `round ${round}: the brief says ship Friday`));
      ids.push(await ask(kessler, finch, `round ${round}: ops can ship Thursday`));
    }
    expect(w.couldNotStart).toEqual([]);
    expect(w.held).toEqual([]);
    expect(w.turns.map(turn => turn.id)).toEqual(ids);
    const pairs = w.store.groups.filter(group => group.dm);
    expect(pairs.map(pair => [pair.name, pair.section]).sort()).toEqual([["Finch ⇄ Kessler", "Dev Shop"], ["Finch ⇄ Sable", "Dev Shop"]]);
    expect(policyRevision()).toBe(before);
    expect(lines).toEqual([]);
    expect(flips()).toBe(flipsBefore);
    for (const id of receipts) expect(receiptState(id)).toBe("delivered");
  });
});
