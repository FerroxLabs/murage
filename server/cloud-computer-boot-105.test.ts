// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLOUD-COMPUTER-BOOT-105 C0-C7 (lanes/release105/designs/CLOUD-COMPUTER-BOOT-105.md): a prompt a dead process left on a cloud computer is confirmed
// done there by its own status (stopped first when it still runs), or fenced: nothing reads it, and nothing new is sent to that box until it is
// confirmed. The owner reads one line saying only what is established. Against a scripted fake of the box API.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _cloudComputerIdle, _cloudComputerTiming, _resetCloudComputerTurns, accountOf, CLOUD_COMPUTER_BUSY_REFUSAL, CLOUD_COMPUTER_FENCED_REFUSAL, CLOUD_COMPUTER_TURNS_FILE,
  CLOUD_COMPUTER_TURNS_UNREADABLE, CLOUD_COMPUTER_UNKNOWN_REFUSAL, cloudComputerEntries, cloudComputerLineText, cloudComputerUnknown, configureCloudComputerLines,
  _seedCloudComputerEntry, recoverCloudComputerTurns, type CloudTurnEntry,
} from "./cloud-computer-turns.ts";
import { DATA_DIR, ensureDirs } from "./config.ts";
import type { ProviderInstance } from "./contracts.ts";
import { BoxAgentDriver } from "./drivers/boxagent.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";

const TOKEN = "box-test-token";
const BOX = "box-1";
const ledger = () => join(DATA_DIR, CLOUD_COMPUTER_TURNS_FILE);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A box as the API shows it: prompt statuses (each read takes the next, the last repeats), what an interrupt does, and the listed events. */
interface FakeBox {
  statuses: Record<string, string[]>;
  afterInterrupt?: Record<string, string>;
  interrupt: number | "throw";
  boxes: string[] | "throw";
  events: unknown[];
  post: number | "throw";
  down: boolean;
  calls: string[];
  /** resolves the interrupt call (a held interrupt keeps the box job open) */
  holdInterrupt?: Promise<void>;
}
let box: FakeBox;
let previousFetch: typeof fetch;
function installBox(partial: Partial<FakeBox> = {}): FakeBox {
  box = { statuses: {}, interrupt: 200, boxes: [BOX], events: [], post: 200, down: false, calls: [], ...partial };
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https:\/\/ascii\.dev\/api\/box\/v1/, "");
    const method = String(init?.method ?? "GET").toUpperCase();
    box.calls.push(`${method} ${url}`);
    if (box.down) throw new TypeError("fetch failed");
    if (method === "POST" && url.endsWith("/interrupt")) {
      if (box.holdInterrupt) await box.holdInterrupt;
      if (box.interrupt === "throw") throw new TypeError("fetch failed");
      if (box.interrupt === 200) for (const [id, after] of Object.entries(box.afterInterrupt ?? {})) box.statuses[id] = [after];
      return json(box.interrupt === 200 ? { ok: true } : { error: "nope" }, box.interrupt);
    }
    if (method === "POST" && url.endsWith("/prompt")) {
      if (box.post === "throw") throw new TypeError("fetch failed");
      if (box.post !== 200) return json({ error: "refused" }, box.post);
      box.statuses.p2 ??= ["running", "finished"];
      return json({ promptRun: { id: "p2" } });
    }
    const prompt = /\/prompts\/([^/]+)$/.exec(url);
    if (prompt) {
      const list = box.statuses[prompt[1]!];
      if (!list) return json({ error: "not found" }, 404);
      const status = list.length > 1 ? list.shift()! : list[0]!;
      return json({ promptRun: { status, result: status === "finished" ? "new work" : undefined } });
    }
    if (url.endsWith("/events")) return json({ events: box.events });
    if (url === "/boxes") return box.boxes === "throw" ? json({ error: "x" }, 500) : json({ boxes: box.boxes.map((id) => ({ id })) });
    return json({ error: `unexpected ${method} ${url}` }, 404);
  }) as typeof fetch;
  return box;
}
const interrupts = () => box.calls.filter((c) => c.endsWith("/interrupt")).length;
const posts = () => box.calls.filter((c) => c.startsWith("POST") && c.endsWith("/prompt")).length;

function seed(entries: Array<Partial<CloudTurnEntry>>, raw?: string) {
  const full = entries.map((e, n) => ({ turnId: `t${n + 1}`, boxId: BOX, threadId: `thread-${n + 1}`, promptId: "p1", owner: "a-process-that-died", state: "running", at: 1_000, account: accountOf(TOKEN), ...e }));
  writeFileSync(ledger(), raw ?? JSON.stringify({ version: 1, entries: full }));
}
const lines: Array<{ threadId: string; text: string; id: string }> = [];
const writer = () => configureCloudComputerLines((entry, text, id) => { if (!lines.some((l) => l.id === id)) lines.push({ threadId: entry.threadId, text, id }); return true; });

let instance: ProviderInstance | undefined;
let recorder: EventRecorder | undefined;
const driver = async () => {
  instance = await BoxAgentDriver.create({ instanceId: "box-boot", displayName: "Box", environment: { BOX_TOKEN: TOKEN }, enabled: true, config: { pollMs: 0 } });
  recorder = recordEvents(instance.adapter);
  return instance;
};
const send = (threadId: string) => instance!.adapter.sendTurn({ threadId, text: "go", integrations: { computer: { boxId: BOX } } } as never);

beforeEach(() => {
  ensureDirs();
  rmSync(ledger(), { force: true });
  rmSync(join(DATA_DIR, CLOUD_COMPUTER_TURNS_UNREADABLE), { force: true });
  _resetCloudComputerTurns();
  _cloudComputerTiming({ pauseMs: 0 });
  lines.splice(0);
  previousFetch = globalThis.fetch;
});
afterEach(async () => {
  recorder?.stop();
  await instance?.dispose();
  instance = undefined;
  await _cloudComputerIdle();
  globalThis.fetch = previousFetch;
});

describe("C1/C2 boot: a prompt a dead process left on the box", () => {
  it("still running: interrupted, confirmed by its own status, one 'nothing carries on' line; a second boot adds nothing", async () => {
    installBox({ statuses: { p1: ["running"] }, afterInterrupt: { p1: "cancelled" } });
    seed([{ state: "running" }]);
    writer();
    expect(await recoverCloudComputerTurns({ token: () => TOKEN })).toEqual({ confirmed: 1, fenced: 0 });
    expect(interrupts()).toBe(1);
    expect(cloudComputerEntries()).toEqual([]);
    expect(lines).toEqual([{ threadId: "thread-1", text: cloudComputerLineText("restart-stopped"), id: "cloud-computer-restart:t1" }]);
    await recoverCloudComputerTurns({ token: () => TOKEN });
    expect(lines).toHaveLength(1);
  });

  it("already finished on the box: confirmed with no interrupt sent", async () => {
    installBox({ statuses: { p1: ["finished"] } });
    seed([{ state: "running" }]);
    writer();
    await recoverCloudComputerTurns({ token: () => TOKEN });
    expect(interrupts()).toBe(0);
    expect(cloudComputerEntries()).toEqual([]);
    expect(lines.map((l) => l.text)).toEqual([cloudComputerLineText("restart-stopped")]);
  });

  it("the box cannot be reached: fenced, one 'could not confirm' line, and every send to it is refused with no prompt posted", async () => {
    installBox({ down: true });
    seed([{ state: "running" }]);
    writer();
    expect(await recoverCloudComputerTurns({ token: () => TOKEN })).toEqual({ confirmed: 0, fenced: 1 });
    expect(cloudComputerEntries()).toMatchObject([{ turnId: "t1", state: "fenced", lineWritten: true }]);
    expect(lines.map((l) => l.text)).toEqual([cloudComputerLineText("restart-unconfirmed")]);
    await driver();
    await expect(send("thread-new")).rejects.toThrow(CLOUD_COMPUTER_FENCED_REFUSAL);
    expect(posts()).toBe(0);
    expect(lines).toHaveLength(1);
  });

  it("the box comes back: the next send confirms the old prompt first, takes the listed events as seen, and never reads them as its work", async () => {
    installBox({ down: true });
    seed([{ state: "running" }]);
    writer();
    await recoverCloudComputerTurns({ token: () => TOKEN });
    box.down = false;
    box.statuses.p1 = ["running"];
    box.afterInterrupt = { p1: "interrupted" };
    box.events = [{ id: "old-1", type: "response", text: "OLD WORK FROM BEFORE" }];
    box.calls.splice(0);
    await driver();
    const sent = await send("thread-new");
    const order = box.calls.filter((c) => c.endsWith("/interrupt") || (c.startsWith("POST") && c.endsWith("/prompt")));
    expect(order).toEqual([`POST /boxes/${BOX}/interrupt`, `POST /boxes/${BOX}/prompt`]);
    box.events = [{ id: "old-1", type: "response", text: "OLD WORK FROM BEFORE" }, { id: "new-1", type: "response", text: "new work" }];
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect(JSON.stringify(recorder!.events)).not.toContain("OLD WORK FROM BEFORE");
    expect(cloudComputerEntries()).toEqual([]);
    expect(lines).toHaveLength(1);                                                     // no second line for the same prompt
  });

  it("the status stays running after the interrupt: fenced (fail closed)", async () => {
    installBox({ statuses: { p1: ["running"] } });
    seed([{ state: "running" }]);
    await recoverCloudComputerTurns({ token: () => TOKEN });
    expect(cloudComputerEntries()).toMatchObject([{ state: "fenced", lineOwed: "restart-unconfirmed" }]);
  });

  it("an interrupt 404 confirms only when the same account's list no longer holds the box", async () => {
    installBox({ statuses: { p1: ["running"] }, interrupt: 404, boxes: [BOX] });
    seed([{ state: "running" }]);
    await recoverCloudComputerTurns({ token: () => TOKEN });
    expect(cloudComputerEntries()).toMatchObject([{ state: "fenced" }]);
    box.boxes = ["another-box"];
    await recoverCloudComputerTurns({ token: () => TOKEN });
    expect(cloudComputerEntries()).toMatchObject([{ state: "stopped", lineOwed: "restart-stopped" }]);   // confirmed; its line waits for the writer
  });

  it("another account's token confirms nothing and sends no interrupt", async () => {
    installBox({ statuses: { p1: ["finished"] } });
    seed([{ state: "running", account: accountOf("someone-else") }]);
    await recoverCloudComputerTurns({ token: () => TOKEN });
    expect(box.calls).toEqual([]);
    expect(cloudComputerEntries()).toMatchObject([{ state: "fenced" }]);
  });

  it("no prompt id (the crash came during the POST): the interrupt waits until 60 s after the record, then confirms", async () => {
    let clock = 1_000 + 10_000;
    const waits: number[] = [];
    _cloudComputerTiming({ now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
    installBox({});
    seed([{ state: "sending", promptId: null, at: 1_000 }]);
    writer();
    await recoverCloudComputerTurns({ token: () => TOKEN });
    expect(waits).toEqual([50_000]);
    expect(interrupts()).toBe(1);
    expect(cloudComputerEntries()).toEqual([]);
    expect(lines.map((l) => l.text)).toEqual([cloudComputerLineText("restart-stopped")]);
  });

  it("an L5 entry (confirmed, line still owed) from the last run gets its line at the next boot", async () => {
    installBox({});
    seed([{ state: "stopped", lineOwed: "restart-stopped" }]);
    writer();
    await recoverCloudComputerTurns({ token: () => TOKEN });
    expect(box.calls).toEqual([]);
    expect(lines.map((l) => l.id)).toEqual(["cloud-computer-restart:t1"]);
    expect(cloudComputerEntries()).toEqual([]);
  });
});

describe("C0: an unreadable record is unknown, never empty", () => {
  it("a schema-invalid record is set aside; the box is cleared once (no-id rule from the file's time) before its first prompt", async () => {
    installBox({});
    seed([], JSON.stringify({ version: 1, entries: [{ turnId: "t1", boxId: BOX, state: "flying" }] }));
    let clock = Date.now() + 120_000;
    _cloudComputerTiming({ now: () => clock, sleep: async (ms) => { clock += ms; } });
    await driver();
    box.down = true;
    await expect(send("thread-a")).rejects.toThrow(CLOUD_COMPUTER_UNKNOWN_REFUSAL);
    expect(existsSync(join(DATA_DIR, CLOUD_COMPUTER_TURNS_UNREADABLE))).toBe(true);
    expect(readFileSync(join(DATA_DIR, CLOUD_COMPUTER_TURNS_UNREADABLE), "utf8")).toContain("flying");
    expect(posts()).toBe(0);
    box.down = false;
    box.calls.splice(0);
    await send("thread-a");
    expect(interrupts()).toBe(1);
    expect(posts()).toBe(1);
    expect(cloudComputerUnknown()?.cleared).toEqual([BOX]);
  });
});

describe("C3-C6 the driver's side", () => {
  it("the prompt is on disk before the POST reaches the box; a 500 or no answer fences it, a 422 clears it", async () => {
    installBox({ post: 500 });
    const inner = globalThis.fetch;
    let onDiskAtPost: unknown;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(init?.method).toUpperCase() === "POST" && String(input).endsWith("/prompt")) onDiskAtPost = JSON.parse(readFileSync(ledger(), "utf8")).entries;
      return inner(input, init);
    }) as typeof fetch;
    await driver();
    await expect(send("thread-a")).rejects.toThrow(/refused|box HTTP 500/);
    expect(onDiskAtPost).toMatchObject([{ state: "sending", boxId: BOX, threadId: "thread-a", promptId: null }]);
    expect(cloudComputerEntries()).toMatchObject([{ state: "fenced", promptId: null }]);
    rmSync(ledger(), { force: true }); _resetCloudComputerTurns(); _cloudComputerTiming({ pauseMs: 0 });
    box.post = "throw";
    await expect(send("thread-b")).rejects.toThrow();
    expect(cloudComputerEntries()).toMatchObject([{ state: "fenced" }]);
    rmSync(ledger(), { force: true }); _resetCloudComputerTurns(); _cloudComputerTiming({ pauseMs: 0 });
    box.post = 422;
    await expect(send("thread-c")).rejects.toThrow();
    expect(cloudComputerEntries()).toEqual([]);
  });

  it("a finished turn leaves nothing; a Stop the box does not confirm fences the box with the in-process line", async () => {
    installBox({});
    writer();
    await driver();
    const first = await send("thread-a");
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    expect(cloudComputerEntries()).toEqual([]);
    box.statuses.p2 = ["running"];
    const second = await send("thread-b");
    await instance!.adapter.interruptTurn("thread-b");
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    await _cloudComputerIdle();
    expect(cloudComputerEntries()).toMatchObject([{ turnId: second.turnId, state: "fenced", lineWritten: true }]);
    expect(lines).toEqual([{ threadId: "thread-b", text: cloudComputerLineText("unconfirmed"), id: `cloud-computer-unconfirmed:${second.turnId}` }]);
  });

  it("a watcher that fails fences its prompt (nothing watches it now)", async () => {
    installBox({ statuses: { p2: ["running"] }, events: [] });
    await driver();
    instance!.adapter.onEvent((event) => { if (event.type === "content.delta") throw new Error("listener broke"); });
    const sent = await send("thread-a");
    box.events = [{ id: "e1", type: "response", text: "hello" }];
    await recorder!.until((e) => e.type === "turn.completed" && e.turnId === sent.turnId);
    expect(cloudComputerEntries()).toMatchObject([{ turnId: sent.turnId, state: "fenced", lineOwed: "unconfirmed" }]);
  });

  it("old work on a box another live turn is using: the send is refused and no interrupt is sent", async () => {
    installBox({ statuses: { p2: ["running"] } });
    await driver();
    await send("thread-live");                                                         // live, watched, running
    _seedCloudComputerEntry({ turnId: "orphan", boxId: BOX, threadId: "thread-old", promptId: "p1", owner: "a-process-that-died", state: "running", at: 1, account: accountOf(TOKEN) });
    box.calls.splice(0);
    await expect(send("thread-new")).rejects.toThrow(CLOUD_COMPUTER_BUSY_REFUSAL);
    expect(interrupts()).toBe(0);
  });

  it("a recovery and a send on one box run one after the other: the prompt is posted only after the recovery's interrupt answered", async () => {
    let release!: () => void;
    installBox({ statuses: { p1: ["running"] }, afterInterrupt: { p1: "cancelled" }, holdInterrupt: new Promise<void>((resolve) => { release = resolve; }) });
    seed([{ state: "running" }]);
    await driver();
    const recovery = recoverCloudComputerTurns({ token: () => TOKEN });
    const sending = send("thread-new");
    await new Promise((r) => setTimeout(r, 20));
    expect(posts()).toBe(0);
    release();
    await recovery;
    await sending;
    const order = box.calls.filter((c) => c.endsWith("/interrupt") || (c.startsWith("POST") && c.endsWith("/prompt")));
    expect(order).toEqual([`POST /boxes/${BOX}/interrupt`, `POST /boxes/${BOX}/prompt`]);
  });
});

describe("S1 sites (the server is not loaded here)", () => {
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  it("the boot starts the recovery with the box token and configures the owner's line writer after the first health answer", () => {
    expect(index).toContain("void recoverCloudComputerTurns({ token: () => cfg.box?.token ?? process.env.BOX_TOKEN })");
    expect(index).toMatch(/configureCloudComputerLines\(\(entry, text, stableId\) => \{[\s\S]*?\}, startupWritesReady\(\)\);/);
    expect(index.indexOf("void recoverCloudComputerTurns(")).toBeLessThan(index.indexOf("const settleStartedHandoffs = async"));
  });
  it("the cancel's post-commit closes a held hand-off of the cancelled request", () => {
    const fn = index.slice(index.indexOf("function dropDelegationsOf("), index.indexOf("function admitRoomMember("));
    expect(fn).toContain("settleHeldOfEndedRequest(request.id, handoffSettleOptions({ bus: commsBus, approvalBus }))");
  });
});
