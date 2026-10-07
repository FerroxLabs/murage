// A warm engine (and its signed-in MCP browser) was dropped on almost every
// message with `memory continuation reset … reason=memory-changed`. Cause: the
// settle-time screenshot of a browser turn lands after the owner's follow-up
// and is spliced in behind it (Store.insertMessageAfter). That splice went
// through mdb.appendMessage, which moved the STORED leaf to the screenshot: a
// branch change to memory (captureBranchChange retires the follow-up and
// revokes every receipt of the thread), and the next ordinary append, parented
// on the real leaf, read as a second one. Nothing the engine was told changed.
// These turns run the real pipeline (Store messages, settlement, capture jobs,
// checkpoint refresh, frame receipts on one native session); every real
// invalidation below still ends the session.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { Store } from "../store.ts";
import { captureWork } from "./chunks.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { refreshMemoryCheckpoint } from "./consolidate.ts";
import { memoryAccess, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { MemoryDispatchReceipt } from "./dispatch.ts";
import { recordMemorySettlement } from "./settlement.ts";
import { continuationMemoryRevoked } from "./disclosures.ts";
import { ownerMemoryTicket, correctMemory, pinMemory } from "./authority.ts";
import { forgetMemory } from "./forget.ts";
import type { MemoryBundle } from "../../shared/memory.ts";

const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

function drain() {
  for (let n = 0; n < 100; n++) {
    const work = claimMemoryJob("churn");
    if (!work) return;
    const result = captureWork(work);
    publishMemoryWork(work, "churn", result);
    if (result.status === "complete") refreshMemoryCheckpoint(work.id);
  }
}

function world() {
  const store = new Store(() => ({ instanceId: "claude", model: "fixture" }));
  const bot = store.createBot(); store.patchBot(bot.id, { name: "Sable" });
  setMemoryMode("active");
  const threadId = bot.threadId;
  const roster = (): MemoryRoster => ({ bots: store.bots, groups: store.groups } as unknown as MemoryRoster);
  const registry = new InternalCapabilities();
  const access = () => {
    const generation = registry.begin(bot.id, threadId);
    const token = registry.mint({ botId: bot.id, threadId, generation, depth: 0, kind: "memory", skillAuthoring: false });
    return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, roster);
  };
  let pendingScreen: (() => void) | undefined;
  const prompts: string[] = [];
  /** The owner's message, then (late) the previous turn's settle-time screenshot. */
  const send = (n: number) => {
    const prompt = w.store.appendMessage(threadId, { role: "user", kind: "text", text: `Please open item ${n} on the Zoom page.`, origin: "desktop" } as never);
    prompts.push(prompt.id);
    pendingScreen?.(); pendingScreen = undefined;
    recordMemorySettlement(threadId, `t${n}`, "working");
    drain();
  };
  /** Dispatch on `session`: frame receipt, a browser tool, the streamed reply
   * marked terminal, the screenshot captured at settle (landing after the
   * next send when `late`), then the worker's pass. */
  const turn = async (n: number, session: string, late = true): Promise<MemoryBundle> => {
    const a = access();
    const bundle = await buildMemoryBundle(`item ${n}`, a, bridge);
    const receipt = new MemoryDispatchReceipt(bundle, a, "claude");
    receipt.sessionStarted(session); receipt.accepted();
    const turnId = `t${n}`;
    const tool = store.appendMessage(threadId, { role: "bot", kind: "activity", turnId, tool: { name: "mcp__browser__browser_click", summary: "click" } } as never);
    store.patchMessage(threadId, tool.id, { tool: { name: "mcp__browser__browser_click", ok: true } } as never);
    const reply = store.appendMessage(threadId, { role: "bot", kind: "text", text: "", turnId, from: { botId: bot.id, name: "Sable", color: "x" } } as never);
    receipt.output(reply.id);
    store.patchMessage(threadId, reply.id, { text: `Item ${n} is open.` } as never);
    store.markTerminalAssistantMessage(threadId, turnId, "completed");
    const leaf = store.activePath(threadId).at(-1)?.id;
    const screen = () => { store.insertMessageAfter(threadId, leaf, { role: "bot", kind: "screen", png: "AAAA", mime: "image/png" } as never); };
    if (late) pendingScreen = screen; else screen();
    drain();
    return bundle;
  };
  const revoked = (session: string) => { const why: { reason?: string } = {}; const result = continuationMemoryRevoked(threadId, "claude", session, access(), why); return { result, why: why.reason }; };
  const w = { store, bot, threadId, access, send, turn, revoked, prompts };
  return w;
}

/** Two turns on one session, then the third turn's continuation check. */
async function twoTurns(late = true) {
  const w = world();
  w.send(1); await w.turn(1, "S1", late);
  w.send(2); expect(w.revoked("S1")).toEqual({ result: false, why: undefined });
  const second = await w.turn(2, "S1", late);
  w.send(3);
  return { w, second };
}

it("(a) consecutive normal turns keep the session, with the settle-time screenshot landing before or after the next send", async () => {
  for (const late of [false, true]) {
    const { w } = await twoTurns(late);
    expect(w.revoked("S1")).toEqual({ result: false, why: undefined });
    for (let n = 3; n <= 6; n++) { await w.turn(n, "S1", late); w.send(n + 1); expect(w.revoked("S1").result).toBe(false); }
    // nothing on the thread was retired or revoked by a screenshot splice
    expect(database().prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state='revoked'").get()!.n).toBe(0);
    expect(database().prepare("SELECT count(*) AS n FROM memory_sources WHERE kind='text' AND state!='active'").get()!.n).toBe(0);
    closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  }
});

it("(b) the owner edits a memory the session was shown: reset", async () => {
  const { w, second } = await twoTurns();
  const record = second.recordVersions.find(r => !r.id.startsWith("checkpoint:"))!;
  correctMemory(ownerMemoryTicket(), record.id, record.version, "Item 2 was closed, not opened.");
  expect(w.revoked("S1")).toEqual({ result: true, why: expect.stringMatching(/^memory-changed/) });
});

it("(c) the owner forgets a memory the session was shown, or a source it rests on: reset", async () => {
  for (const kind of ["record", "source"] as const) {
    const { w, second } = await twoTurns();
    const target = kind === "record" ? second.recordVersions.find(r => !r.id.startsWith("checkpoint:"))!.id : second.sourceVersions[0].id;
    forgetMemory(ownerMemoryTicket(), { kind, id: target });
    expect(w.revoked("S1")).toEqual({ result: true, why: expect.stringMatching(/^memory-changed/) });
    closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  }
});

it("(c2) a tombstone on one disclosed source revision, with no global counter moving: reset", async () => {
  const { w, second } = await twoTurns();
  const source = second.sourceVersions[0];
  // the revision check itself, not the global revocation that forget also does
  const meta = database().prepare("SELECT deletion_epoch FROM memory_meta").get()!;
  database().prepare("INSERT INTO memory_tombstones VALUES('t-1','source',?,?,NULL,?,'owner-forget',1)").run(source.id, source.revision, meta.deletion_epoch);
  expect(w.revoked("S1")).toEqual({ result: true, why: expect.stringMatching(/^memory-changed/) });
});

it("(d) a message the session was shown is edited, or withheld by a real branch change: reset", async () => {
  {
    const { w } = await twoTurns();
    // the owner edits the first prompt in place: its captured source gets a new revision
    w.store.patchMessage(w.threadId, w.prompts[0], { text: "Never mind item 1." } as never);
    expect(w.revoked("S1")).toEqual({ result: true, why: expect.stringMatching(/^memory-changed/) });
  }
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  {
    const { w } = await twoTurns();
    // a real edit-and-resend: branchMessage forks the first prompt, so the later turns leave the active path
    const before = w.store.activePath(w.threadId).map(m => m.id);
    expect(before).toContain(w.prompts[1]);
    const fork = w.store.branchMessage(w.threadId, w.prompts[0], "A different first question.", "desktop");
    expect(fork).not.toBeNull();
    const after = w.store.activePath(w.threadId).map(m => m.id);
    expect(after).toContain(fork!.id);
    expect(after).not.toContain(w.prompts[0]);
    expect(after).not.toContain(w.prompts[1]);
    expect(w.revoked("S1")).toEqual({ result: true, why: expect.stringMatching(/^memory-changed/) });
  }
});

it("(e) a policy revision or deletion epoch move: reset", async () => {
  {
    const { w, second } = await twoTurns();
    const record = second.recordVersions.find(r => !r.id.startsWith("checkpoint:"))!;
    pinMemory(ownerMemoryTicket(), record.id, record.version, true);  // policy revision only
    expect(w.revoked("S1")).toEqual({ result: true, why: expect.stringMatching(/^memory-changed/) });
  }
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  {
    const { w } = await twoTurns();
    database().exec("UPDATE memory_meta SET deletion_epoch=deletion_epoch+1 WHERE id=1");
    expect(w.revoked("S1")).toEqual({ result: true, why: expect.stringMatching(/^memory-changed/) });
  }
});
