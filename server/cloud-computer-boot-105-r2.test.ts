// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLOUD-COMPUTER-BOOT-105 section 7 (lanes/release105/designs/CLOUD-COMPUTER-BOOT-105.md): the record of prompts on cloud computers is never
// missing (an unreadable one stays unknown through any crash or failed write), and a turn reads only its own prompt's work.
import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const atomicControl = vi.hoisted(() => ({ failLedger: false, failAfterWrite: false, existedAtWrite: [] as boolean[] }));
vi.mock("./atomic.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./atomic.ts")>();
  const fs = await import("node:fs");
  return {
    ...real,
    writeFileAtomic: (path: string, data: string | Uint8Array, options?: { mode?: number; syncDir?: boolean }) => {
      if (path.endsWith("cloud-computer-turns.json")) {
        atomicControl.existedAtWrite.push(fs.existsSync(path));
        if (atomicControl.failLedger) throw new Error("disk full");
        if (atomicControl.failAfterWrite) { real.writeFileAtomic(path, data, options); throw new Error("directory sync failed"); }
      }
      return real.writeFileAtomic(path, data, options);
    },
  };
});

import {
  _cloudComputerIdle, _cloudComputerTiming, _resetCloudComputerTurns, accountOf, CLOUD_COMPUTER_TURNS_FILE, CLOUD_COMPUTER_TURNS_UNREADABLE,
  CLOUD_COMPUTER_UNKNOWN_REFUSAL, cloudComputerEntries, cloudComputerUnknown, cloudTurnFinished, cloudTurnStrict, configureCloudComputerLines, recoverCloudComputerTurns, stopCloudTurn,
} from "./cloud-computer-turns.ts";
import { DATA_DIR, ensureDirs } from "./config.ts";
import type { ProviderInstance } from "./contracts.ts";
import { BoxAgentDriver } from "./drivers/boxagent.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";

const TOKEN = "box-test-token";
const BOX = "box-1";
const ledger = () => join(DATA_DIR, CLOUD_COMPUTER_TURNS_FILE);
const aside = () => join(DATA_DIR, CLOUD_COMPUTER_TURNS_UNREADABLE);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A scripted box: prompt statuses (the last repeats), the events listed before and after the POST, and the POST's answer. */
interface Box { statuses: Record<string, string[]>; before: unknown[]; after: unknown[]; postBody: unknown; postBodies?: unknown[]; posted: boolean; calls: string[] }
let box: Box;
let previousFetch: typeof fetch;
function installBox(partial: Partial<Box> = {}): void {
  box = { statuses: {}, before: [], after: [], postBody: { promptRun: { id: "p2" } }, posted: false, calls: [], ...partial };
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https:\/\/ascii\.dev\/api\/box\/v1/, "");
    const method = String(init?.method ?? "GET").toUpperCase();
    box.calls.push(`${method} ${url}`);
    if (method === "POST" && url.endsWith("/interrupt")) return json({ ok: true });
    if (method === "POST" && url.endsWith("/prompt")) { box.posted = true; return json(box.postBodies?.shift() ?? box.postBody); }
    const prompt = /\/prompts\/([^/]+)$/.exec(url);
    if (prompt) {
      const list = box.statuses[prompt[1]!];
      if (!list) return json({ error: "not found" }, 404);
      const status = list.length > 1 ? list.shift()! : list[0]!;
      return json({ promptRun: { status, result: status === "finished" ? "new work" : undefined } });
    }
    if (url.endsWith("/events")) return json({ events: box.posted ? box.after : box.before });
    if (url === "/boxes") return json({ boxes: [{ id: BOX }] });
    return json({ error: `unexpected ${method} ${url}` }, 404);
  }) as typeof fetch;
}
const posts = () => box.calls.filter((c) => c.startsWith("POST") && c.endsWith("/prompt")).length;

let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
const driver = async () => {
  instance = await BoxAgentDriver.create({ instanceId: "box-r2", displayName: "Box", environment: { BOX_TOKEN: TOKEN }, enabled: true, config: { pollMs: 0 } });
  recorder = recordEvents(instance.adapter);
};
const send = (threadId: string) => instance!.adapter.sendTurn({ threadId, text: "go", integrations: { computer: { boxId: BOX } } } as never);

beforeEach(() => {
  ensureDirs();
  rmSync(ledger(), { force: true });
  rmSync(aside(), { force: true });
  _resetCloudComputerTurns();
  _cloudComputerTiming({ pauseMs: 0 });
  atomicControl.failLedger = false;
  atomicControl.failAfterWrite = false;
  atomicControl.existedAtWrite.splice(0);
  previousFetch = globalThis.fetch;
});
afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  await _cloudComputerIdle();
  globalThis.fetch = previousFetch;
  atomicControl.failLedger = false;
  atomicControl.failAfterWrite = false;
});
const threadText = (threadId: string) => JSON.stringify(recorder!.events.filter((e) => (e as { threadId?: string }).threadId === threadId));

describe("7.1 the record is never missing", () => {
  it("R1: the new record cannot be written: the bad record stays in place, sends are refused, and a restart still finds it unknown", async () => {
    installBox({});
    writeFileSync(ledger(), "{not json");
    atomicControl.failLedger = true;
    expect(cloudComputerUnknown()).toBeDefined();
    // the record was never moved away before its replacement was written (a crash at that point would have left no record at all)
    expect(atomicControl.existedAtWrite).toEqual([true]);
    expect(readFileSync(ledger(), "utf8")).toBe("{not json");
    expect(readFileSync(aside(), "utf8")).toBe("{not json");
    await driver();
    await expect(send("thread-a")).rejects.toThrow(CLOUD_COMPUTER_UNKNOWN_REFUSAL);
    expect(posts()).toBe(0);
    // a restart (the process died after the failed write): still unknown, never an empty record
    _resetCloudComputerTurns();
    _cloudComputerTiming({ pauseMs: 0 });
    atomicControl.failLedger = false;
    expect(cloudComputerUnknown()).toMatchObject({ cleared: [] });
    expect(JSON.parse(readFileSync(ledger(), "utf8"))).toMatchObject({ version: 1, entries: [], unknown: { cleared: [] } });
  });

  it("R2: the record is gone but an unreadable one was set aside: unknown from that file's time, and the box is cleared before its first prompt", async () => {
    installBox({ statuses: { p2: ["finished"] } });
    writeFileSync(aside(), "{not json");
    const old = (Date.now() - 3_600_000) / 1000;
    utimesSync(aside(), old, old);
    const unknown = cloudComputerUnknown();
    expect(unknown).toBeDefined();
    expect(Math.abs(unknown!.since - old * 1000)).toBeLessThan(2_000);
    expect(existsSync(ledger())).toBe(true);
    await driver();
    await send("thread-a");
    const order = box.calls.filter((c) => c.endsWith("/interrupt") || (c.startsWith("POST") && c.endsWith("/prompt")));
    expect(order).toEqual([`POST /boxes/${BOX}/interrupt`, `POST /boxes/${BOX}/prompt`]);
  });
});

describe("7.2 a turn reads only its own prompt's work", () => {
  it("R3: after a restart cleared old work on the box, a trailing unnamed event and one naming the old prompt never reach the new turn", async () => {
    installBox({ statuses: { p1: ["finished"], p2: ["running", "running", "finished"] } });
    writeFileSync(ledger(), JSON.stringify({ version: 1, entries: [{ turnId: "t1", boxId: BOX, threadId: "thread-old", promptId: "p1", owner: "a-process-that-died", state: "running", at: 1_000, account: accountOf(TOKEN) }] }));
    box.after = [
      { id: "late-1", type: "response", text: "OLD WORK FROM BEFORE" },
      { id: "late-2", type: "response", promptId: "p1", text: "OLD NAMED WORK" },
      { id: "late-3", type: "complete" },
    ];
    await driver();
    const sent = await send("thread-new");
    const done = await recorder!.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    const seen = JSON.stringify(recorder!.events);
    expect(seen).not.toContain("OLD WORK FROM BEFORE");
    expect(seen).not.toContain("OLD NAMED WORK");
    expect(done).toMatchObject({ ok: true });
    const replies = recorder!.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies).toMatchObject([{ text: "new work", origin: "engine" }]);
  });

  it("R4: a 2xx that names no prompt is not followed: the turn ends with the reason, nothing listed is read, and the box is fenced", async () => {
    installBox({ postBody: { ok: true, type: "prompt.queued" } });
    box.after = [{ id: "a1", type: "response", text: "SOMEONE ELSE'S WORK" }, { id: "a2", type: "complete" }];
    await driver();
    const sent = await send("thread-a");
    const done = await recorder!.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect(done).toMatchObject({ ok: false });
    expect(recorder!.events.some((e) => e.type === "runtime.error" && /without naming it/.test(String((e as { message?: string }).message)))).toBe(true);
    expect(JSON.stringify(recorder!.events)).not.toContain("SOMEONE ELSE'S WORK");
    expect(cloudComputerEntries()).toMatchObject([{ turnId: sent.turnId, state: "fenced", promptId: null }]);
  });
});

describe("7.4 Astra round 1", () => {
  it("R6: the quarantine outlives the boot recovery: the next turn reads no unnamed event; after it ends by its own status the box streams again", async () => {
    installBox({ statuses: { p1: ["finished"], p2: ["running", "finished"], p3: ["running", "finished"] }, postBodies: [{ promptRun: { id: "p2" } }, { promptRun: { id: "p3" } }] });
    writeFileSync(ledger(), JSON.stringify({ version: 1, entries: [{ turnId: "t1", boxId: BOX, threadId: "thread-old", promptId: "p1", owner: "a-process-that-died", state: "running", at: 1_000, account: accountOf(TOKEN) }] }));
    configureCloudComputerLines(() => true);
    await recoverCloudComputerTurns({ token: () => TOKEN });
    expect(cloudComputerEntries()).toEqual([]);                                         // confirmed and its line written: nothing left on record
    box.after = [{ id: "late-1", type: "response", text: "OLD WORK FROM BEFORE" }];
    await driver();
    const second = await send("thread-b");
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    expect(threadText("thread-b")).not.toContain("OLD WORK FROM BEFORE");
    const third = await send("thread-c");
    box.after = [{ id: "late-1", type: "response", text: "OLD WORK FROM BEFORE" }, { id: "c-1", type: "response", text: "streamed live" }];
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === third.turnId);
    expect(recorder!.events.some((e) => e.type === "content.delta" && (e as { threadId?: string }).threadId === "thread-c" && /streamed live/.test(String((e as { delta?: string }).delta)))).toBe(true);
  });

  it("R7: two turns on one box: neither reads the other's unnamed output", async () => {
    installBox({ statuses: { pa: ["running"], pb: ["running"] }, postBodies: [{ promptRun: { id: "pa" } }, { promptRun: { id: "pb" } }] });
    await driver();
    const a = await send("thread-a");
    const b = await send("thread-b");
    box.after = [{ id: "u-1", type: "response", text: "UNNAMED OUTPUT" }, { id: "a-1", type: "response", promptId: "pa", text: "a own" }, { id: "b-1", type: "response", promptId: "pb", text: "b own" }];
    box.statuses.pa = ["running", "finished"];
    box.statuses.pb = ["running", "finished"];
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === a.turnId);
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === b.turnId);
    expect(threadText("thread-a")).not.toContain("UNNAMED OUTPUT");
    expect(threadText("thread-b")).not.toContain("UNNAMED OUTPUT");
    expect(threadText("thread-a")).toContain("a own");
    expect(threadText("thread-b")).toContain("b own");
  });

  it("R11: a second send latches both turns strict before its POST; one ending and leaving the record does not unlatch the other", async () => {
    installBox({ statuses: { pa: ["running"], pb: ["running"] }, postBodies: [{ promptRun: { id: "pa" } }, { promptRun: { id: "pb" } }] });
    await driver();
    const a = await send("thread-a");
    const b = await send("thread-b");
    cloudTurnFinished(a.turnId, "ended");                                               // A ends and leaves the record before B reads anything
    expect(cloudComputerEntries().map((e) => e.turnId)).toEqual([b.turnId]);
    expect(cloudTurnStrict(b.turnId)).toBe(true);
  });

  it("R12: a Stop whose marks cannot be written leaves the prompt on record, so the next send checks it before posting", async () => {
    installBox({ statuses: { pa: ["running"] }, postBodies: [{ promptRun: { id: "pa" } }, { promptRun: { id: "pb" } }] });
    await driver();
    const a = await send("thread-a");
    atomicControl.failLedger = true;                                                    // the `stopping` and `fenced` writes both fail
    await instance!.adapter.interruptTurn("thread-a");
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === a.turnId);
    await _cloudComputerIdle();
    // section 8 F6: the unwritten mark does not skip the Stop: the box (no other turn on it) is still interrupted under the lock
    expect(box.calls).toContain(`POST /boxes/${BOX}/interrupt`);
    atomicControl.failLedger = false;
    box.calls.splice(0);
    await send("thread-b").catch(() => {});
    const read = box.calls.findIndex((c) => c.includes("/prompts/pa"));
    const post = box.calls.findIndex((c) => c.startsWith("POST") && c.endsWith("/prompt"));
    expect(read).toBeGreaterThanOrEqual(0);
    if (post >= 0) expect(read).toBeLessThan(post);
  });

  it("R14 (section 8 F7): a Stop whose mark was not written, of a prompt that then ended by its own status, reports it confirmed", async () => {
    installBox({ statuses: { pa: ["running"] }, postBodies: [{ promptRun: { id: "pa" } }] });
    await driver();
    const a = await send("thread-a");
    atomicControl.failLedger = true;                                                    // the `stopping` mark is not written
    const stop = stopCloudTurn(a.turnId, TOKEN);
    atomicControl.failLedger = false;
    cloudTurnFinished(a.turnId, "ended");                                               // its own terminal status removes it before the Stop's job runs
    expect(cloudComputerEntries()).toEqual([]);
    expect(await stop).toBe(true);
  });

  it("R13: on a strict turn an unnamed event is not written to that thread's native trace", async () => {
    installBox({ statuses: { p1: ["finished"], p2: ["running", "finished"] } });
    writeFileSync(ledger(), JSON.stringify({ version: 1, entries: [{ turnId: "t1", boxId: BOX, threadId: "thread-old", promptId: "p1", owner: "a-process-that-died", state: "running", at: 1_000, account: accountOf(TOKEN) }] }));
    box.after = [{ id: "late-1", type: "response", text: "OLD TRACE TEXT" }];
    await driver();
    const sent = await send("thread-trace");
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    const trace = join(DATA_DIR, "native", "thread-trace.ndjson");
    expect(existsSync(trace) ? readFileSync(trace, "utf8") : "").not.toContain("OLD TRACE TEXT");
  });

  it("R8: the new record's rename lands but its directory sync throws: stuck this run, and unknown at the next start", async () => {
    installBox({});
    writeFileSync(ledger(), "{not json");
    atomicControl.failAfterWrite = true;
    expect(cloudComputerUnknown()).toBeDefined();
    await driver();
    await expect(send("thread-a")).rejects.toThrow(CLOUD_COMPUTER_UNKNOWN_REFUSAL);
    expect(posts()).toBe(0);
    atomicControl.failAfterWrite = false;
    _resetCloudComputerTurns();
    _cloudComputerTiming({ pauseMs: 0 });
    expect(cloudComputerUnknown()).toMatchObject({ cleared: [] });
  });

  it("R9: a prompt id that is not a non-empty string is not followed", async () => {
    installBox({ postBody: { promptRun: { id: 42 } } });
    box.after = [{ id: "a1", type: "response", text: "SOMEONE ELSE'S WORK" }];
    await driver();
    const sent = await send("thread-a");
    const done = await recorder!.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect(done).toMatchObject({ ok: false });
    expect(JSON.stringify(recorder!.events)).not.toContain("SOMEONE ELSE'S WORK");
    expect(cloudComputerEntries()).toMatchObject([{ turnId: sent.turnId, state: "fenced", promptId: null }]);
  });

  it("R10: a record that cannot be looked up is not absent: the send is refused and the record is left alone; an unreadable set-aside with no record is unknown", async () => {
    installBox({});
    symlinkSync(ledger(), ledger());                                                   // stat: ELOOP, not ENOENT
    await driver();
    await expect(send("thread-a")).rejects.toThrow(CLOUD_COMPUTER_UNKNOWN_REFUSAL);
    expect(posts()).toBe(0);
    expect(lstatSync(ledger()).isSymbolicLink()).toBe(true);
    rmSync(ledger(), { force: true });
    _resetCloudComputerTurns();
    _cloudComputerTiming({ pauseMs: 0 });
    symlinkSync(aside(), aside());
    expect(cloudComputerUnknown()).toBeDefined();
  });
});
