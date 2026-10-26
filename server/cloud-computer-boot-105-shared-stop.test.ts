// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLOUD-COMPUTER-BOOT-105 section 8 (Grok r4): a box can carry two watched turns, and its interrupt is box-wide. A Stop on one turn
// interrupts the box only from stopCloudTurn, under the box lock, when no other turn on the box still needs it; otherwise it only reads,
// and the box is cleared once its last live turn has left. The other turn's prompt runs on to its own end.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _cloudComputerIdle, _cloudComputerTiming, _resetCloudComputerTurns, accountOf, CLOUD_COMPUTER_TURNS_FILE, CLOUD_COMPUTER_TURNS_UNREADABLE, cloudComputerEntries,
  _seedCloudComputerEntry, cloudComputerLineText, OWED_MAX_FAILURES, configureCloudComputerLines, recoverCloudComputerTurns, type CloudTurnEntry,
} from "./cloud-computer-turns.ts";
import { DATA_DIR, ensureDirs } from "./config.ts";
import type { ProviderInstance } from "./contracts.ts";
import { BoxAgentDriver } from "./drivers/boxagent.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";

const TOKEN = "box-test-token";
const BOX = "box-1";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A box as the API shows it: each prompt's status (box-wide interrupt: every running prompt reads `interrupted` after it). */
interface Box { statuses: Record<string, string>; ids: string[]; calls: string[]; interruptFails?: number; holdPost?: Promise<void>; postStarted?: () => void }
let box: Box;
let previousFetch: typeof fetch;
function installBox(partial: Partial<Box> = {}): void {
  box = { statuses: {}, ids: ["pa", "pb"], calls: [], ...partial };
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https:\/\/ascii\.dev\/api\/box\/v1/, "");
    const method = String(init?.method ?? "GET").toUpperCase();
    box.calls.push(`${method} ${url}`);
    if (method === "POST" && url.endsWith("/interrupt")) {
      if (box.interruptFails) { box.interruptFails--; return json({ error: "unavailable" }, 503); }
      for (const [id, status] of Object.entries(box.statuses)) if (status === "running") box.statuses[id] = "interrupted";
      return json({ ok: true });
    }
    if (method === "POST" && url.endsWith("/prompt")) {
      const id = box.ids.shift()!;
      box.statuses[id] = "running";
      if (id === "pb" && box.holdPost) { box.postStarted?.(); await box.holdPost; }
      return json({ promptRun: { id } });
    }
    const prompt = /\/prompts\/([^/]+)$/.exec(url);
    if (prompt) {
      const status = box.statuses[prompt[1]!];
      if (!status) return json({ error: "not found" }, 404);
      return json({ promptRun: { status, result: status === "finished" ? `${prompt[1]} own work` : undefined } });
    }
    if (url.endsWith("/events")) return json({ events: [] });
    if (url === "/boxes") return json({ boxes: [{ id: BOX }] });
    return json({ error: `unexpected ${method} ${url}` }, 404);
  }) as typeof fetch;
}
const interrupts = () => box.calls.filter((c) => c.endsWith("/interrupt")).length;

let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
const driver = async () => {
  instance = await BoxAgentDriver.create({ instanceId: "box-shared", displayName: "Box", environment: { BOX_TOKEN: TOKEN }, enabled: true, config: { pollMs: 0 } });
  recorder = recordEvents(instance.adapter);
};
const send = (threadId: string) => instance!.adapter.sendTurn({ threadId, text: "go", integrations: { computer: { boxId: BOX } } } as never);
const completed = (turnId: string) => recorder!.until((e) => e.type === "turn.completed" && e.turnId === turnId) as unknown as Promise<{ ok: boolean; stopReason: string | null }>;

beforeEach(() => {
  ensureDirs();
  rmSync(join(DATA_DIR, CLOUD_COMPUTER_TURNS_FILE), { force: true });
  rmSync(join(DATA_DIR, CLOUD_COMPUTER_TURNS_UNREADABLE), { force: true });
  _resetCloudComputerTurns();
  _cloudComputerTiming({ pauseMs: 0 });
  previousFetch = globalThis.fetch;
});
afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  await _cloudComputerIdle();
  globalThis.fetch = previousFetch;
});

describe("section 8: a Stop of one turn on a box another turn is using", () => {
  it("S1: Stop A while B runs: nothing interrupts B, B ends by its own status with its own work; then the box is cleared and A confirmed", async () => {
    installBox();
    await driver();
    const a = await send("thread-a");
    const b = await send("thread-b");
    box.calls.splice(0);
    await instance!.adapter.interruptTurn("thread-a");
    expect(await completed(a.turnId)).toMatchObject({ ok: true, stopReason: "cancelled" });
    await _cloudComputerIdle();                                                         // A's Stop has run its course under the lock
    expect(interrupts()).toBe(0);
    // with no interrupt possible, one status reading and no more: the Stop does not hold the box lock through a run of reads
    expect(box.calls.filter((c) => c.endsWith("/prompts/pa"))).toHaveLength(1);
    expect(box.statuses.pb).toBe("running");
    expect(cloudComputerEntries().find((e) => e.turnId === a.turnId)).toMatchObject({ state: "fenced" });
    box.statuses.pb = "finished";
    expect(await completed(b.turnId)).toMatchObject({ ok: true, stopReason: null });
    expect(JSON.stringify(recorder!.events.filter((e) => (e as { turnId?: string }).turnId === b.turnId))).toContain("pb own work");
    await _cloudComputerIdle();                                                         // the Stop owed on the box, once B left
    expect(interrupts()).toBe(1);
    expect(cloudComputerEntries()).toEqual([]);
  });

  it("S2: Stop A while B's send holds the box lock: no interrupt is sent after B's prompt while B runs", async () => {
    let release!: () => void;
    let started!: () => void;
    const postStarted = new Promise<void>((resolve) => { started = resolve; });
    installBox({ holdPost: new Promise<void>((resolve) => { release = resolve; }), postStarted: () => started() });
    await driver();
    const a = await send("thread-a");
    const sendingB = send("thread-b");
    await postStarted;                                                                  // B's POST is out, under the lock
    await instance!.adapter.interruptTurn("thread-a");
    release();
    const b = await sendingB;
    await completed(a.turnId);
    await _cloudComputerIdle();
    expect(interrupts()).toBe(0);
    expect(box.statuses.pb).toBe("running");
    box.statuses.pb = "finished";
    expect(await completed(b.turnId)).toMatchObject({ ok: true, stopReason: null });
    await _cloudComputerIdle();                                                         // Grok r5 Low: the owed Stop is carried out once B left
    expect(interrupts()).toBe(1);
    expect(cloudComputerEntries()).toEqual([]);
  });

  it("S8 (Grok r5): the owed clear fails once: the Stop stays owed and is tried again until the box confirms it", async () => {
    _cloudComputerTiming({ pauseMs: 0, sleep: async () => {} });
    installBox({ interruptFails: 1 });
    await driver();
    const a = await send("thread-a");
    const b = await send("thread-b");
    await instance!.adapter.interruptTurn("thread-a");
    await completed(a.turnId);
    await _cloudComputerIdle();
    box.statuses.pb = "finished";
    await completed(b.turnId);
    for (let i = 0; i < 200 && cloudComputerEntries().length; i++) { await _cloudComputerIdle(); await new Promise((r) => setImmediate(r)); }
    expect(interrupts()).toBe(2);                                                       // the failed one, then the retry
    expect(cloudComputerEntries()).toEqual([]);
  });

  it("S9 (Grok r6): another account's row on the box does not hold back the owed Stop: this account's prompt is stopped, the other's row is left for its own token", async () => {
    _cloudComputerTiming({ pauseMs: 0, sleep: async () => {} });
    installBox();
    await driver();
    const a = await send("thread-a");
    const b = await send("thread-b");
    _seedCloudComputerEntry({ turnId: "other", boxId: BOX, threadId: "thread-other", promptId: "px", owner: "a-process-that-died", state: "fenced", at: 1, account: accountOf("another-account-key") });
    await instance!.adapter.interruptTurn("thread-a");
    await completed(a.turnId);
    await _cloudComputerIdle();
    box.statuses.pb = "finished";
    await completed(b.turnId);
    for (let i = 0; i < 20; i++) { await _cloudComputerIdle(); await new Promise((r) => setImmediate(r)); }
    expect(interrupts()).toBe(1);                                                       // once, and no retry chain for the other account's row
    expect(cloudComputerEntries().map((e) => e.turnId)).toEqual(["other"]);
  });

  it("S10 (Grok r7): two accounts each Stop a turn while a third turn holds the box: both Stops stay owed, and each account's prompt is cleared with its own token", async () => {
    _cloudComputerTiming({ pauseMs: 0, sleep: async () => {} });
    installBox({ ids: ["pa", "pb", "pc"] });
    await driver();                                                                     // account one: A and C
    const second = await BoxAgentDriver.create({ instanceId: "box-shared-2", displayName: "Box 2", environment: { BOX_TOKEN: "box-test-token-2" }, enabled: true, config: { pollMs: 0 } });
    const secondRecorder = recordEvents(second.adapter);
    try {
      const a = await send("thread-a");
      const b = await second.adapter.sendTurn({ threadId: "thread-b", text: "go", integrations: { computer: { boxId: BOX } } } as never);
      const c = await send("thread-c");
      await instance!.adapter.interruptTurn("thread-a");
      await completed(a.turnId);
      await _cloudComputerIdle();
      await second.adapter.interruptTurn("thread-b");
      await secondRecorder.until((e) => e.type === "turn.completed" && e.turnId === b.turnId);
      await _cloudComputerIdle();
      expect(interrupts()).toBe(0);                                                     // C still needs the box
      expect(cloudComputerEntries().filter((e) => e.state === "fenced").map((e) => e.account).sort()).toEqual([accountOf(TOKEN), accountOf("box-test-token-2")].sort());
      box.statuses.pc = "finished";
      await completed(c.turnId);
      for (let i = 0; i < 20; i++) { await _cloudComputerIdle(); await new Promise((r) => setImmediate(r)); }
      expect(cloudComputerEntries()).toEqual([]);                                       // A's prompt was not left behind by B's later Stop
      expect(box.statuses.pa).toBe("interrupted");
      expect(box.statuses.pb).toBe("interrupted");
    } finally {
      secondRecorder.stop();
      await second.dispose();
    }
  });

  it("S11 (Grok r7): the owed clear keeps failing: it stops after OWED_MAX_FAILURES tries, the row stays fenced, and the next send clears it", async () => {
    _cloudComputerTiming({ pauseMs: 0, sleep: async () => {} });
    installBox({ ids: ["pa", "pb", "pc"], interruptFails: 1_000 });
    await driver();
    const a = await send("thread-a");
    const b = await send("thread-b");
    await instance!.adapter.interruptTurn("thread-a");
    await completed(a.turnId);
    await _cloudComputerIdle();
    box.statuses.pb = "finished";
    await completed(b.turnId);
    for (let i = 0; i < 200; i++) { await _cloudComputerIdle(); await new Promise((r) => setImmediate(r)); }
    expect(interrupts()).toBe(OWED_MAX_FAILURES);                                      // a fixed number of tries, then no more
    expect(cloudComputerEntries().map((e) => [e.turnId, e.state])).toEqual([[a.turnId, "fenced"]]);
    box.interruptFails = 0;
    await send("thread-c");                                                             // the next send settles the fenced row first
    await _cloudComputerIdle();
    expect(interrupts()).toBe(OWED_MAX_FAILURES + 1);
    expect(cloudComputerEntries().map((e) => e.turnId)).not.toContain(a.turnId);
  });

  it("S3: Stop A after B already ended: the box is interrupted once, under the lock, and A is confirmed", async () => {
    installBox();
    await driver();
    const a = await send("thread-a");
    const b = await send("thread-b");
    box.statuses.pb = "finished";
    await completed(b.turnId);
    await instance!.adapter.interruptTurn("thread-a");
    await completed(a.turnId);
    await _cloudComputerIdle();
    expect(interrupts()).toBe(1);
    expect(cloudComputerEntries()).toEqual([]);
  });

  it("S4: both turns stopped together: one interrupt, both confirmed", async () => {
    installBox();
    await driver();
    const a = await send("thread-a");
    const b = await send("thread-b");
    await instance!.adapter.stopAll!();
    await completed(a.turnId);
    await completed(b.turnId);
    await _cloudComputerIdle();
    expect(interrupts()).toBe(1);
    expect(cloudComputerEntries()).toEqual([]);
  });

  // F8: the process died mid-Stop. What is on disk is the `stopping` (or `fenced`) entry of a process that is gone; the next start's recovery
  // (C1) confirms it by its own status, interrupting the box only when that prompt still runs.
  const crashLeft = (rows: Array<Partial<CloudTurnEntry>>) => writeFileSync(join(DATA_DIR, CLOUD_COMPUTER_TURNS_FILE), JSON.stringify({ version: 1, entries: rows.map((r, n) => ({
    turnId: `t${n + 1}`, boxId: BOX, threadId: `thread-${n + 1}`, promptId: `p${n + 1}`, owner: "a-process-that-died", state: "stopping", at: 1_000, account: accountOf(TOKEN), ...r })) }));
  const lines: Array<{ threadId: string; text: string }> = [];
  const writer = () => { lines.splice(0); configureCloudComputerLines((entry, text) => { lines.push({ threadId: entry.threadId, text }); return true; }); };

  it("S5 (F8): crash after the mark, before the interrupt: the restart interrupts once, confirms, and writes the one 'nothing carries on' line", async () => {
    installBox({ statuses: { p1: "running" } });
    crashLeft([{ state: "stopping" }]);
    writer();
    expect(await recoverCloudComputerTurns({ token: () => TOKEN })).toEqual({ confirmed: 1, fenced: 0 });
    await _cloudComputerIdle();
    expect(interrupts()).toBe(1);
    expect(cloudComputerEntries()).toEqual([]);
    expect(lines).toEqual([{ threadId: "thread-1", text: cloudComputerLineText("restart-stopped") }]);
  });

  it("S6 (F8): crash after the interrupt landed: the restart reads it ended and sends no interrupt", async () => {
    installBox({ statuses: { p1: "interrupted" } });
    crashLeft([{ state: "stopping" }]);
    writer();
    expect(await recoverCloudComputerTurns({ token: () => TOKEN })).toEqual({ confirmed: 1, fenced: 0 });
    expect(interrupts()).toBe(0);
    expect(cloudComputerEntries()).toEqual([]);
  });

  it("S7 (F8): crash with a Stop owed on a shared box (A fenced by its Stop, B still running): the restart clears both with one interrupt", async () => {
    installBox({ statuses: { p1: "running", p2: "running" } });
    crashLeft([{ state: "fenced", lineOwed: "unconfirmed" }, { state: "running" }]);
    writer();
    expect(await recoverCloudComputerTurns({ token: () => TOKEN })).toEqual({ confirmed: 1, fenced: 0 });
    await _cloudComputerIdle();
    expect(interrupts()).toBe(1);
    expect(cloudComputerEntries()).toEqual([]);
  });
});
