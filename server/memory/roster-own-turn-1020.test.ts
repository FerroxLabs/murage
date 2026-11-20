// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1020 CTXSTOP-ROSTER: a No-limits team lead asked to "build a team" creates bots in a new team mid-turn (index.ts create_bot:
// createBot, patchBot, setChiefOfStaff "section"). Those roster changes add authority and narrow nobody's, yet they ended every
// receipt on the machine ("memory receipts revoked scope=global cause=roster-reconcile") and the running turn was refused with
// LEDGER_REFUSAL_LINE. Real roster saves through the Store (persistMemoryRoster), real receipts, real continuation checks.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { Store } from "../store.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { assertMemoryAccess, ensureScope, memoryAccess, revalidateMemoryAccess, type MemoryRoster } from "./policy.ts";
import { memoryState, setMemoryMode } from "./repository.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { recordMemorySettlement } from "./settlement.ts";
import { continuationMemoryRevoked, filterDirectReplay, resetSessionHolds } from "./disclosures.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { markSessionKnown } from "./testing/legacy-file-model.ts";
import { authorityParts } from "./authority-epoch.ts";
import { prepareRecallContextSync, maintainRecallViewSlice } from "./recall-view.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { resetDataRootsForTest } from "../data-roots.ts";
import * as searchCompatibility from "../testing/search-index-compat.ts";

beforeEach(async () => { closeDatabase(); await searchCompatibility.stopSearchIndex?.(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetDataRootsForTest(); thawRootSetWritesForTest(true); resetSessionHolds(); });
afterEach(() => { thawRootSetWritesForTest(false); vi.restoreAllMocks(); });

function revokeLines() {
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { const line = args.map(String).join(" "); if (line.includes("memory receipts revoked")) lines.push(line); });
  return lines;
}
const receiptState = (bundleId: string) => database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundleId)?.state;
const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
function drain() {
  for (let n = 0; n < 100; n++) {
    const work = claimMemoryJob("own-turn-roster");
    if (!work) return;
    const result = captureWork(work);
    publishMemoryWork(work, "own-turn-roster", result);
    if (result.status === "complete") refreshMemoryCheckpoint(work.id);
  }
}

/** A warm lead in its own team with a delivered session (roster-scoped-revokes.test.ts world()). */
function world(engine = "claude") {
  const store = new Store(() => ({ instanceId: engine, model: "fixture" }));
  const lead = store.createBot({ name: "Director", section: "Agency" });
  store.setChiefOfStaff(lead.id, undefined, "section");
  setMemoryMode("active");
  const threadId = lead.threadId;
  const roster = (): MemoryRoster => store;
  const registry = new InternalCapabilities();
  const access = () => {
    const generation = registry.begin(lead.id, threadId);
    const token = registry.mint({ botId: lead.id, threadId, generation, depth: 0, kind: "memory", skillAuthoring: false });
    prepareRecallContextSync(lead.id, threadId, store);
    const a = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, roster);
    while (!maintainRecallViewSlice(a.view)) { /* fixture preparation */ }
    return a;
  };
  const session = "S-1";
  const resets: string[] = [];
  const receipts: string[] = [];
  const turn = async (n: number) => {
    const allowance = LineageAllowance.turn();
    store.appendMessage(threadId, { role: "user", kind: "text", text: `Plan lead ${n} please.`, origin: "desktop" } as never);
    recordMemorySettlement(threadId, `t${n}`, "working");
    drain();
    const a = access();
    const why: { reason?: string } = {};
    if (n > 1 && continuationMemoryRevoked(allowance, threadId, engine, session, a, why)) resets.push(why.reason ?? "-");
    filterDirectReplay(allowance, threadId, store.activePath(threadId) as never, a, new Set());
    const bundle = await buildMemoryBundle(`lead ${n}`, a, bridge, { allowance });
    const receipt = new MemoryDispatchReceipt(bundle, a, engine);
    receipt.sessionStarted(session); receipt.accepted(); receipts.push(bundle.bundleId);
    markSessionKnown(threadId, engine, session, lead.id);
    const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: "", turnId: `t${n}`, from: { botId: lead.id, name: "Director", color: "x" } } as never);
    receipt.output(reply.id);
    store.patchMessage(threadId, reply.id, { text: `Lead ${n} gets a pitch.` } as never);
    store.markTerminalAssistantMessage(threadId, `t${n}`, "completed");
    drain();
    return a;
  };
  /** What index.ts create_bot does for a team lead's new bot (the non-staged No-limits path). */
  const leadCreates = (name: string, section: string, wantsLead: boolean) => {
    const created = store.createBot({ name, title: "Specialist", description: "Writes pitches.", section }, { seedMessages: false });
    store.patchBot(created.id, { composio: false, autoApprove: false, fullAccess: false, noLimits: false, approvePeerComms: false, computer: "off", createdByBotId: lead.id });
    if (wantsLead) store.setChiefOfStaff(created.id, undefined, "section");
    return created;
  };
  return { store, lead, threadId, turn, resets, receipts, access, leadCreates };
}

/** MAIN ruling C1 integration (fableclose-b/c1): on dev/1020q-int every scope row a new bot adds moves the recall authority epoch, and a
 * handle issued before the move is re-certified, never read as it is (MAIN RULING 2026-11-17T19:46Z, policy.ts revalidateMemoryAccess; the
 * production readers of a running turn all go through it: bundle.ts, disclosures.ts, lineageReaderAudience). An own turn keeps its context
 * when that re-certification succeeds: it rethrows MEMORY_CONTEXT_REVOKED on any policy, deletion, grant, deny or principal change. */
const ownTurnAccess = (live: ReturnType<typeof memoryAccess>) => revalidateMemoryAccess(live);

// The continuation reset count is not asserted: on this base the warm-session fixture already resets on turn 2 with
// "cold-withhold-unproven" before any roster change (roster-scoped-revokes.test.ts "a warm session keeps holding" fails the same way
// at f8f3a5a9c1). What refuses a turn here is a revoked receipt, a policy revision or a hard epoch move, and those are asserted.
it("W-A1: a lead turn that builds a new team of 3 bots (one elected its lead) mid-turn keeps its own receipts and context", async () => {
  const w = world(), lines = revokeLines();
  for (let n = 1; n <= 3; n++) await w.turn(n);
  const live = w.access();
  const before = memoryState().policyRevision, stamp = authorityParts()?.hard;
  const made = [w.leadCreates("Pitch Lead", "Pitch Team", true), w.leadCreates("Pitch Writer", "Pitch Team", false), w.leadCreates("Pitch Checker", "Pitch Team", false)];
  expect(made.map(bot => w.store.bot(bot.id)?.section)).toEqual(["Pitch Team", "Pitch Team", "Pitch Team"]);
  expect(w.store.bot(made[0].id)?.chiefOfStaff).toBe(true);
  expect(lines.filter(line => line.includes("scope=global"))).toEqual([]);
  // the elected bot's own (empty) threads end alone
  expect(lines.some(line => line.includes("scope=thread cause=roster-narrowed count=0"))).toBe(true);
  expect(memoryState().policyRevision).toBe(before);
  expect(authorityParts()?.hard).toBe(stamp);
  for (const id of w.receipts) expect(receiptState(id)).toBe("delivered");
  expect(() => assertMemoryAccess(ownTurnAccess(live))).not.toThrow();
  await w.turn(4);
  for (const id of w.receipts) expect(receiptState(id)).toBe("delivered");
});

it("W-A2: electing or moving a bot that HAS a past is still an audience change: every receipt ends under a new policy revision", async () => {
  const w = world(), lines = revokeLines();
  for (let n = 1; n <= 2; n++) await w.turn(n);
  const live = w.access();
  const other = w.leadCreates("Old Hand", "Pitch Team", false);
  w.store.appendMessage(other.threadId, { role: "user", kind: "text", text: "earlier work in this seat", origin: "desktop" } as never);
  const before = memoryState().policyRevision;
  w.store.setChiefOfStaff(other.id, undefined, "section");
  expect(lines.some(line => line.includes("scope=global"))).toBe(true);
  expect(memoryState().policyRevision).toBeGreaterThan(before);
  for (const id of w.receipts) expect(receiptState(id)).toBe("revoked");
  expect(() => assertMemoryAccess(live)).toThrow("MEMORY_CONTEXT_REVOKED");
  // an audience change is never re-certified: the production re-certification refuses it too (not only the epoch check)
  expect(() => revalidateMemoryAccess(live)).toThrow("MEMORY_CONTEXT_REVOKED");
});

// 1020 ROSTER (Sean-reported, MAIN lane roster-1020): a section move no longer ends every receipt; it ends the moved bot's threads, its rooms and
// partitioned sharers only (roster-library-create-1020.test.ts W1-W4, which also keep the room-member narrowing global). The "section"
// case of W-A3 now asserts that scoped ending; the workspace-Chief case stays a global audience change, unchanged.
it("W-A3b: moving a no-past bot to another team ends only its own threads; the lead's receipts and handle hold", async () => {
  const w = world(), lines = revokeLines();
  await w.turn(1);
  const live = w.access();
  const fresh = w.leadCreates("Pitch Writer", "Pitch Team", false);
  const before = memoryState().policyRevision;
  w.store.patchBot(fresh.id, { section: "Other Team" });
  expect(lines.filter(line => line.includes("scope=global"))).toEqual([]);
  expect(lines.some(line => line.includes("scope=thread cause=roster-narrowed"))).toBe(true);
  expect(memoryState().policyRevision).toBe(before);
  for (const id of w.receipts) expect(receiptState(id)).toBe("delivered");
  // the lead's own session holds; see roster-library-create-1020.test.ts W1 for the open re-certification of a pre-move handle
  void live;
  await w.turn(2);
  for (const id of w.receipts) expect(receiptState(id)).toBe("delivered");
});

it("W-A3: making a no-past bot the workspace Chief still ends every receipt", async () => {
  for (const change of ["workspace-chief"] as const) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetDataRootsForTest(); resetSessionHolds();
    const w = world(), lines = revokeLines();
    await w.turn(1);
    const live = w.access();
    const fresh = w.leadCreates("Pitch Writer", "Pitch Team", false);
    const before = memoryState().policyRevision;
    w.store.setChiefOfStaff(fresh.id, undefined, "workspace");
    expect(lines.some(line => line.includes("scope=global")), change).toBe(true);
    expect(memoryState().policyRevision, change).toBeGreaterThan(before);
    for (const id of w.receipts) expect(receiptState(id), change).toBe("revoked");
    expect(() => assertMemoryAccess(live), change).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(() => revalidateMemoryAccess(live), change).toThrow("MEMORY_CONTEXT_REVOKED");
    vi.restoreAllMocks();
  }
});

// 1.0.20 A-4: the live line was `scope=global cause=roster-reconcile count=25`, which only reconcileMemoryRoster writes (package publish
// store.ts preparePackageAddition().publish, boot). The same warm lead, the same own-turn team build, then a hired package team (new
// bots and their room) published through the real Store batch: nothing narrows, so no receipt may end, and the reconcile names no rule.
it("W-A4: a hired package team published after an own-turn team build ends no receipt (reconcile path, live cause string)", async () => {
  const w = world();
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { const line = args.map(String).join(" "); if (/memory receipts revoked|roster audience change/.test(line)) lines.push(line); });
  for (let n = 1; n <= 3; n++) await w.turn(n);
  const live = w.access();
  w.leadCreates("Pitch Lead", "Pitch Team", true);
  w.leadCreates("Pitch Writer", "Pitch Team", false);
  const before = memoryState().policyRevision;
  const template = w.store.bot(w.lead.id)!;
  const hired = ["Greeter", "Host"].map(name => {
    const id = crypto.randomUUID(), threadId = crypto.randomUUID();
    const bot = structuredClone(template) as any;
    Object.assign(bot, { id, threadId, name, section: "Guest Team", tasks: [], resumeCursors: {}, alwaysAllow: [], composio: false, browser: false, computer: "off", autoApprove: false });
    for (const key of ["chiefOfStaff", "chiefScope", "createdByBotId", "packageImportReceipt"]) delete bot[key];
    return bot;
  });
  const roomTemplate = { id: crypto.randomUUID(), threadId: crypto.randomUUID(), name: "Guest Team", section: "Guest Team", memberIds: hired.map(bot => bot.id), createdAt: Date.now() } as any;
  const batch = w.store.preparePackageAddition(hired, [roomTemplate]);
  batch.publish();
  expect(w.store.bot(hired[0].id)?.section).toBe("Guest Team");
  expect(lines.filter(line => line.includes("scope=global"))).toEqual([]);
  expect(lines.filter(line => line.includes("cause=roster-reconcile"))).toEqual([]);
  expect(memoryState().policyRevision).toBe(before);
  for (const id of w.receipts) expect(receiptState(id)).toBe("delivered");
  expect(() => assertMemoryAccess(ownTurnAccess(live))).not.toThrow();
});


// 1.0.20 A-4: when the reconcile emitter does end every receipt, its line says which rule did it (rule and entry kind, never an id), next to
// the live `cause=roster-reconcile` line. A hired bot whose id already has a notebook scope (a reused id) is rule 7: an audience change.
it("W-A4c: a reconcile that ends every receipt names its rule beside the live cause=roster-reconcile line", async () => {
  const w = world();
  const lines: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { const line = args.map(String).join(" "); if (/memory receipts revoked|roster audience change/.test(line)) lines.push(line); });
  for (let n = 1; n <= 2; n++) await w.turn(n);
  const bot = structuredClone(w.store.bot(w.lead.id)!) as any;
  Object.assign(bot, { id: crypto.randomUUID(), threadId: crypto.randomUUID(), name: "Reused", section: "Guest Team", tasks: [], resumeCursors: {}, alwaysAllow: [], composio: false, browser: false, computer: "off", autoApprove: false });
  for (const key of ["chiefOfStaff", "chiefScope", "createdByBotId", "packageImportReceipt"]) delete bot[key];
  ensureScope("bot", bot.id);
  w.store.preparePackageAddition([bot], []).publish();
  const at = lines.findIndex(line => line.includes("scope=global cause=roster-reconcile"));
  expect(at, lines.join("\n")).toBeGreaterThan(0);
  expect(lines[at - 1]).toBe("[memory] roster audience change cause=roster-reconcile rule=7-bot-reused");
  expect(lines.join("\n")).not.toContain(bot.id);
  for (const id of w.receipts) expect(receiptState(id)).toBe("revoked");
});
