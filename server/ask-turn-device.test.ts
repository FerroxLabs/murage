// 1.0.9 share and ask: the asking phone is keyed per turn (generation), and a queued start is one attempt at admission whose
// busy refusal puts its rows back in the queue in place. One test (or one group) per invariant of the queued-start design:
// I1 nothing committed is dropped, I2 order per thread, I3 never two turns on a thread, I4 the reply goes to the asking phone,
// I5 one stuck thread never blocks another, I6 every path releases its hold and timers, I7 no line twice in the transcript.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskTurnDevices, classifyStartRefusal, OCCUPIED_REFUSALS, PREPARE_DEADLINE_MS, runQueuedStart, TRANSIENT_REFUSALS } from "./ask-turn-device.ts";
import { _resetQueuedStarts, drainSteeredMessages, queuedStartPending, START_REQUEUE } from "./steer-queue.ts";
import { sendStore } from "./send-store.ts";
import type { Message } from "./store.ts";

describe("AskTurnDevices", () => {
  it("each turn takes only its own device, once", () => {
    const devices = new AskTurnDevices();
    devices.set("gen-a", "thread-1", "dev-a");
    devices.set("gen-b", "thread-1", "dev-b");
    expect(devices.take("gen-a")).toBe("dev-a");
    expect(devices.take("gen-a")).toBeUndefined();
    expect(devices.take("gen-b")).toBe("dev-b");
  });
  it("a thread's deletion drops every turn it had", () => {
    const devices = new AskTurnDevices();
    devices.set("gen-a", "thread-1", "dev-a");
    devices.set("gen-c", "thread-2", "dev-c");
    devices.forgetThreads(["thread-1"]);
    expect(devices.take("gen-a")).toBeUndefined();
    expect(devices.take("gen-c")).toBe("dev-c");
  });
});

describe("classifyStartRefusal", () => {
  it("every occupied or transient code waits; a bare conflict waits only while the thread is held; anything else fails", () => {
    for (const code of [...OCCUPIED_REFUSALS, ...TRANSIENT_REFUSALS]) expect(classifyStartRefusal({ status: 409, code }, false), code).toBe("wait");
    expect(classifyStartRefusal({ status: 503, code: "DATABASE_BUSY" }, false)).toBe("wait");
    expect(classifyStartRefusal({ status: 409 }, true)).toBe("wait");
    expect(classifyStartRefusal(Object.assign(new Error("this thread or its group is already working"), { status: 409 }), true)).toBe("wait");
    // a conflict of its own (an effort the engine no longer offers) with the thread free is not retried for ever
    expect(classifyStartRefusal({ status: 409 }, false)).toBe("fail");
    expect(classifyStartRefusal({ status: 409, code: "draft_only_engine" }, true)).toBe("fail");
    expect(classifyStartRefusal({ status: 403 }, true)).toBe("fail");
    expect(classifyStartRefusal(new Error("prompt building failed"), true)).toBe("fail");
    expect(classifyStartRefusal(undefined, true)).toBe("fail");
  });

  it("runQueuedStart: admitted is started, a busy refusal is START_REQUEUE with no could-not-start, a failure is shown once", async () => {
    const failed: unknown[] = [];
    expect(await runQueuedStart({ start: async () => undefined, occupied: () => false, onFail: (e) => failed.push(e) })).toBe("started");
    expect(await runQueuedStart({ start: async () => { throw Object.assign(new Error("busy"), { status: 409 }); }, occupied: () => true, onFail: (e) => failed.push(e) })).toBe(START_REQUEUE);
    expect(failed).toEqual([]);
    expect(await runQueuedStart({ start: async () => { throw new Error("no engine"); }, occupied: () => true, onFail: (e) => failed.push(e) })).toBe("failed");
    expect(failed).toHaveLength(1);
    // an occupancy read that throws is treated as held (never written off), and a throwing onFail never rejects
    expect(await runQueuedStart({ start: async () => { throw { status: 409 }; }, occupied: () => { throw new Error("x"); }, onFail: () => {} })).toBe(START_REQUEUE);
    expect(await runQueuedStart({ start: async () => { throw new Error("no"); }, occupied: () => false, onFail: () => { throw new Error("y"); } })).toBe("failed");
  });
});

// ── the drain and the start together, in miniature ─────────────────────────────────────────────────────────────────────────
// The real drainSteeredMessages and send store, the real runQueuedStart, and startTurn in miniature: an optional await before admission
// (the writer gate or a thread prepare), then the busy check and admission in one tick. A turn holds its thread for runMs, then frees
// it and drains (as a turn's end does in the server). The fake bot's busy flag never shows the run (it lags in the server too).

type Refusal = { status?: number; code?: string; message?: string };
let seq = 0;
const accept = (input: Record<string, unknown>) => {
  seq += 1;
  const r = sendStore.accept({ kind: "bot", fingerprint: `q${seq}`, status: "queued", ...input } as never);
  if (r.kind !== "new") throw new Error("not new");
  return r.row;
};
const ask = (text: string, device: string, threadId = "t-1", ownerId = "bot-1") =>
  accept({ ownerId, threadId, text, origin: "unproven", via: "ask-intent", queueOnly: true, viaDevice: device });
const owner = (text: string, threadId = "t-1", ownerId = "bot-1") => accept({ ownerId, threadId, text });

const world = (bots: Array<[string, string]>, opts: { runMs?: (prompt: string) => number; bareBusy?: boolean; buildThrowsFor?: string; fill?: Promise<void> } = {}) => {
  const messages: Message[] = [];
  const store = {
    messages,
    bot: (id: string) => { const b = bots.find(([botId]) => botId === id); return b ? { id: b[0], threadId: b[1], busy: false } as never : null; },
    appendMessage: (threadId: string, message: object, id?: string) => {
      const full = { id: id ?? `m${messages.length}`, at: Date.now(), threadId, ...message } as unknown as Message;
      messages.push(full);
      return full;
    },
    messageById: (_threadId: string, id: string) => messages.find((m) => m.id === id),
    patchMessage: () => null,
  };
  const devices = new AskTurnDevices();
  const heldBy = new Map<string, string>();
  const refusals = new Map<string, Refusal[]>();
  const gates = new Map<string, Promise<void>>();
  const attempts: string[] = [];
  const ran: string[] = [];
  const pushes: Array<[string, string]> = [];
  const inFlight = new Map<string, number>();
  let maxInFlight = 0;
  let gen = 0;
  const admit = async (threadId: string, prompt: string, device: string | null) => {
    attempts.push(prompt);
    inFlight.set(threadId, (inFlight.get(threadId) ?? 0) + 1);
    maxInFlight = Math.max(maxInFlight, inFlight.get(threadId)!);
    try {
      const gate = gates.get(prompt);
      if (gate) { gates.delete(prompt); await gate; }
      // from here to admission nothing awaits: the busy check and the take are one tick
      const refusal = refusals.get(prompt)?.shift();
      if (refusal) throw Object.assign(new Error(refusal.message ?? "refused"), refusal);
      if (heldBy.has(threadId)) throw Object.assign(new Error("this thread or its group is already working"), opts.bareBusy ? { status: 409 } : { status: 409, code: "thread_busy" });
      const g = `gen-${++gen}`;
      heldBy.set(threadId, g);
      if (device) devices.set(g, threadId, device);
      ran.push(prompt);
      setTimeout(() => { heldBy.delete(threadId); pushes.push([prompt, devices.take(g) ?? "none"]); drain(); }, opts.runMs?.(prompt) ?? 1_000);
    } finally {
      inFlight.set(threadId, inFlight.get(threadId)! - 1);
    }
  };
  const held = (threadId: string) => heldBy.has(threadId);
  const run = (_b: string, threadId: string, prompt: string, _m: unknown, _x: string[], batch: { viaDevice: string | null }) => runQueuedStart({
    // the thread fill startTurn waits on before admission (store.prepareThread); the queued path bounds it
    ...(opts.fill ? { prepare: () => opts.fill! } : {}),
    start: async () => {
      if (opts.buildThrowsFor === prompt) throw new Error("prompt building failed");
      return admit(threadId, prompt, batch.viaDevice);
    },
    occupied: () => held(threadId),
    onFail: (err) => { store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: `error: queued message could not start: ${String(err)}`, ok: false } }); },
  });
  const drain = () => drainSteeredMessages(store as never, run as never, undefined, undefined, (_b, threadId) => held(threadId));
  return {
    store, drain, attempts, ran, pushes, held,
    maxInFlight: () => maxInFlight,
    refuse: (prompt: string, ...shapes: Refusal[]) => refusals.set(prompt, shapes),
    gate: (prompt: string) => { let open!: () => void; gates.set(prompt, new Promise<void>((r) => { open = r; })); return () => open(); },
    /** Another turn (a routine, a delegation, the owner typing) takes the thread outside the queue. */
    hold: (threadId: string) => heldBy.set(threadId, "outside"),
    /** ...and ends, draining as every turn end does. */
    release: (threadId: string) => { heldBy.delete(threadId); drain(); },
    couldNotStart: () => messages.filter((m) => /could not start/.test(JSON.stringify(m))),
    userLines: (threadId = "t-1") => messages.filter((m) => m.role === "user" && (m as unknown as { threadId: string }).threadId === threadId).map((m) => m.text),
  };
};

describe("queued starts: the seven invariants", () => {
  beforeEach(() => { vi.useFakeTimers(); sendStore.reset(); _resetQueuedStarts(); });
  afterEach(() => { _resetQueuedStarts(); vi.useRealTimers(); });

  describe("I1: a committed line is never dropped; only a failure of its own says could-not-start", () => {
    it("the gap: a turn that takes the thread while the start waits on the writer gate gets a bare 409; the line waits and runs", async () => {
      const w = world([["bot-1", "t-1"]], { bareBusy: true });
      const open = w.gate("ask-a");
      ask("ask-a", "dev-a");
      w.drain();
      await vi.advanceTimersByTimeAsync(10);
      w.hold("t-1"); // checked free, then taken before admission
      open();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(w.ran).toEqual([]);
      expect(w.couldNotStart()).toEqual([]);
      expect(sendStore.queuedRows("t-1", "bot").map((r) => r.text)).toEqual(["ask-a"]); // back in the queue, words kept for the chip
      w.release("t-1");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(w.ran).toEqual(["ask-a"]);
      expect(w.pushes).toEqual([["ask-a", "dev-a"]]);
      expect(w.couldNotStart()).toEqual([]);
    });

    const shapes: Array<[string, Refusal]> = [
      ...[...OCCUPIED_REFUSALS].map((code): [string, Refusal] => [code, { status: 409, code }]),
      ...[...TRANSIENT_REFUSALS].map((code): [string, Refusal] => [code, { status: code === "DATABASE_BUSY" ? 503 : 409, code }]),
    ];
    for (const [name, shape] of shapes) {
      it(`a ${name} refusal waits and is tried again until it starts`, async () => {
        const w = world([["bot-1", "t-1"]]);
        w.refuse("ask-a", shape, shape, shape);
        ask("ask-a", "dev-a");
        w.drain();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(w.attempts).toEqual(["ask-a", "ask-a", "ask-a", "ask-a"]);
        expect(w.ran).toEqual(["ask-a"]);
        expect(w.couldNotStart()).toEqual([]);
      });
    }

    it("a refusal of its own, a bare conflict on a free thread, and a throw while building are each shown once; the next line still runs", async () => {
      for (const [prompt, shape] of [["ask-x", { status: 403, message: "no engine" }], ["ask-y", { status: 409, message: "effort is not offered" }]] as const) {
        sendStore.reset(); _resetQueuedStarts();
        const w = world([["bot-1", "t-1"]]);
        w.refuse(prompt, shape);
        ask(prompt, "dev-a"); ask("ask-next", "dev-b");
        w.drain();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(w.couldNotStart()).toHaveLength(1);
        expect(w.ran).toEqual(["ask-next"]);
        expect(w.userLines()).toEqual([prompt, "ask-next"]); // the failed line stays in the transcript
      }
      sendStore.reset(); _resetQueuedStarts();
      const w = world([["bot-1", "t-1"]], { buildThrowsFor: "ask-a" });
      ask("ask-a", "dev-a"); ask("ask-b", "dev-b");
      w.drain();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(w.couldNotStart()).toHaveLength(1);
      expect(w.ran).toEqual(["ask-b"]);
    });
  });

  it("I2: a re-queued line keeps its place: it runs before every line accepted after it, and its row keeps its seq", async () => {
    const w = world([["bot-1", "t-1"]]);
    const open = w.gate("ask-a");
    const a = ask("ask-a", "dev-a");
    w.drain();
    await vi.advanceTimersByTimeAsync(10);
    w.hold("t-1"); // another turn takes the thread while A waits before admission: A is refused
    open();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.attempts).toEqual(["ask-a"]);
    const lineA = w.store.messages.find((m) => m.text === "ask-a")!;
    const back = sendStore.bySeq(a.seq)!;
    expect(back.status).toBe("queued");
    expect(back.existingMessageId).toBe(lineA.id);
    expect(back.via).toBe("ask-intent");
    expect(back.viaDevice).toBe("dev-a");
    owner("o1"); owner("o2"); ask("ask-b", "dev-b");
    w.drain();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.ran).toEqual([]); // nothing passes A while the thread is held
    w.release("t-1");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.ran).toEqual(["ask-a", "o1\no2", "ask-b"]);
    expect(w.userLines()).toEqual(["ask-a", "o1", "o2", "ask-b"]);
  });

  it("I2: while a drained batch is being started the thread reports a start in flight (a new send queues behind it)", async () => {
    const w = world([["bot-1", "t-1"]]);
    const open = w.gate("ask-a");
    ask("ask-a", "dev-a");
    w.drain();
    expect(queuedStartPending("t-1")).toBe(true);
    owner("o1");
    w.drain();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.attempts).toEqual(["ask-a"]); // o1 is not drained into the gap
    open();
    await vi.advanceTimersByTimeAsync(10);
    expect(queuedStartPending("t-1")).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.ran).toEqual(["ask-a", "o1"]);
  });

  it("I3: one start in flight per thread, and a line behind a running turn is never tried against it", async () => {
    const w = world([["bot-1", "t-1"]], { runMs: (p) => (p === "ask-a" ? 70_000 : 1_000) });
    ask("ask-a", "dev-a"); owner("o1"); ask("ask-b", "dev-b");
    w.drain();
    await vi.advanceTimersByTimeAsync(30_000);
    w.drain(); w.drain();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.ran).toEqual(["ask-a"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.ran).toEqual(["ask-a", "o1", "ask-b"]);
    expect(w.attempts).toEqual(w.ran); // no attempt was refused: none overlapped a running turn
    expect(w.maxInFlight()).toBe(1);
  });

  it("I4: each reply goes to the phone whose line started that turn, across a re-queue and an owner line between", async () => {
    const w = world([["bot-1", "t-1"]]);
    const open = w.gate("ask-a");
    ask("ask-a", "dev-a");
    w.drain();
    await vi.advanceTimersByTimeAsync(10);
    w.hold("t-1");
    open();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(w.attempts).toEqual(["ask-a"]); // refused once, re-queued
    owner("o1"); ask("ask-b", "dev-b");
    w.release("t-1");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(w.pushes).toEqual([["ask-a", "dev-a"], ["o1", "none"], ["ask-b", "dev-b"]]);
  });

  it("I5: a thread held for good never blocks another thread, and its own line waits (never written off)", async () => {
    const w = world([["bot-1", "t-1"], ["bot-2", "t-2"]]);
    w.hold("t-1");
    ask("ask-a", "dev-a");
    ask("ask-s", "dev-s", "t-2", "bot-2");
    w.drain();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(w.ran).toEqual(["ask-s"]);
    expect(w.pushes).toEqual([["ask-s", "dev-s"]]);
    expect(sendStore.queuedRows("t-1", "bot").map((r) => r.text)).toEqual(["ask-a"]);
    expect(w.couldNotStart()).toEqual([]);
    expect(w.attempts.filter((p) => p === "ask-a")).toEqual([]); // the held thread is watched, never hammered with starts
    expect(vi.getTimerCount()).toBe(1); // one look-again timer for t-1, nothing else
  });

  describe("I6: every path ends its hold and its timers", () => {
    const settled = async (w: ReturnType<typeof world>) => {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(queuedStartPending("t-1")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      void w;
    };
    it("success", async () => { const w = world([["bot-1", "t-1"]]); ask("ask-a", "d"); w.drain(); await settled(w); expect(w.ran).toEqual(["ask-a"]); });
    it("busy, then started", async () => {
      const w = world([["bot-1", "t-1"]]);
      w.hold("t-1"); ask("ask-a", "d"); w.drain();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(vi.getTimerCount()).toBe(1); // the one retry timer, watching
      w.release("t-1");
      await settled(w);
      expect(w.ran).toEqual(["ask-a"]);
    });
    it("busy, then the owner cancels the waiting line", async () => {
      const w = world([["bot-1", "t-1"]]);
      w.hold("t-1"); const a = ask("ask-a", "d"); w.drain();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sendStore.cancel("bot-1", sendStore.bySeq(a.seq)!.queueId)).not.toBeNull();
      await settled(w);
      expect(w.ran).toEqual([]);
    });
    it("failure", async () => { const w = world([["bot-1", "t-1"]]); w.refuse("ask-a", { status: 403 }); ask("ask-a", "d"); w.drain(); await settled(w); expect(w.couldNotStart()).toHaveLength(1); });
    it("throw while building", async () => { const w = world([["bot-1", "t-1"]], { buildThrowsFor: "ask-a" }); ask("ask-a", "d"); w.drain(); await settled(w); expect(w.couldNotStart()).toHaveLength(1); });
  });

  it("I7: however many times a batch is re-queued, each of its lines is in the transcript once", async () => {
    const w = world([["bot-1", "t-1"]]);
    const busy = { status: 409, code: "thread_limit" };
    w.refuse("o1\no2", busy, busy, busy, busy, busy);
    owner("o1"); owner("o2"); ask("ask-a", "dev-a");
    w.refuse("ask-a", busy, busy);
    w.drain();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.ran).toEqual(["o1\no2", "ask-a"]);
    expect(w.userLines()).toEqual(["o1", "o2", "ask-a"]);
  });
});

describe("queued starts: the thread fill before admission is bounded", () => {
  beforeEach(() => { vi.useFakeTimers(); sendStore.reset(); _resetQueuedStarts(); });
  afterEach(() => { _resetQueuedStarts(); vi.useRealTimers(); });
  const filled = () => { let done!: () => void; const fill = new Promise<void>((r) => { done = r; }); return { fill, done }; };

  it("a fill that never finishes: the line goes back in place after the deadline, later lines keep their order, nothing runs twice", async () => {
    const f = filled();
    const w = world([["bot-1", "t-1"]], { fill: f.fill });
    const a = ask("ask-a", "dev-a");
    ask("ask-b", "dev-b");
    w.drain();
    await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE_MS - 1_000);
    expect(queuedStartPending("t-1")).toBe(true); // still waiting inside the deadline
    expect(w.attempts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_050); // just past the deadline; the 200 ms retry has not fired yet
    // deadline passed: both rows are back in the queue, same seq, and the thread is not pinned
    const rows = sendStore.queuedRows("t-1", "bot");
    expect(rows.map((r) => r.text)).toEqual(["ask-a", "ask-b"]);
    expect(rows[0]).toMatchObject({ seq: a.seq, via: "ask-intent", viaDevice: "dev-a", origin: "unproven" });
    expect(w.couldNotStart()).toEqual([]);
    expect(w.ran).toEqual([]);
    expect(w.attempts).toEqual([]);
    // the fill finally completes: the lines run in order, each once
    f.done();
    await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE_MS * 2);
    expect(w.ran).toEqual(["ask-a", "ask-b"]);
    expect(w.attempts).toEqual(["ask-a", "ask-b"]);
    expect(w.userLines()).toEqual(["ask-a", "ask-b"]);
    expect(w.pushes).toEqual([["ask-a", "dev-a"], ["ask-b", "dev-b"]]);
    expect(w.couldNotStart()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a fill that completes after the deadline admits nothing from the abandoned attempt", async () => {
    const f = filled();
    const w = world([["bot-1", "t-1"]], { fill: f.fill });
    ask("ask-a", "dev-a");
    w.drain();
    await vi.advanceTimersByTimeAsync(PREPARE_DEADLINE_MS + 50); // timed out; the 200 ms retry has not fired yet
    expect(sendStore.queuedRows("t-1", "bot").map((r) => r.text)).toEqual(["ask-a"]);
    f.done(); // the abandoned attempt's fill completes
    await vi.advanceTimersByTimeAsync(10);
    expect(w.attempts).toEqual([]); // the abandoned attempt never reached admission
    expect(w.ran).toEqual([]);
    expect(sendStore.queuedRows("t-1", "bot").map((r) => r.text)).toEqual(["ask-a"]); // and left the row alone
    await vi.advanceTimersByTimeAsync(5_000); // the retry is the only attempt
    expect(w.attempts).toEqual(["ask-a"]);
    expect(w.ran).toEqual(["ask-a"]);
    expect(w.userLines()).toEqual(["ask-a"]);
  });

  it("a fill that finishes inside the deadline starts at once and leaves no timer behind", async () => {
    const f = filled();
    const w = world([["bot-1", "t-1"]], { fill: f.fill });
    ask("ask-a", "dev-a");
    w.drain();
    await vi.advanceTimersByTimeAsync(5_000);
    f.done();
    await vi.advanceTimersByTimeAsync(10);
    expect(w.ran).toEqual(["ask-a"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the timeout is a coded wait refusal, and the wiring bounds the fill on the queued path only", () => {
    expect(classifyStartRefusal({ code: "prepare_timeout" }, false)).toBe("wait");
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    const drain = source.slice(source.indexOf("function drainQueuedSends() {"), source.indexOf("// ── live screen"));
    expect(drain).toMatch(/prepare: \(\) => store\.prepareThread\(threadId\)/);
    expect(source).toMatch(/if \(turnThread\) await store\.prepareThread\(turnThread\);/); // direct sends keep the unbounded wait
  });
});

// The server wiring: the refusals startTurn raises when the thread is taken carry codes, and the drain uses the one-attempt start.
describe("index.ts wiring", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
  it("every busy refusal before admission carries an occupied or transient code", () => {
    expect(source).toMatch(/directThreadBusy\(botId,threadId\)\) throw Object\.assign\(new Error\("this thread or its group is already working"\), \{ status: 409, code: "thread_busy" \}\)/);
    expect(source).toMatch(/activeGroupTurnForBot\(botId\)\) throw Object\.assign\(new Error\("this thread or its group is already working"\), \{ status: 409, code: "room_busy" \}\)/);
    expect(source).toMatch(/Engine setup is finishing\. Try again shortly\."\), \{ status: 409, code: "engine_starting" \}/);
    expect(source).toMatch(/PROVIDER_BANK_FENCE_ERROR\), \{ status: 409, code: "provider_fenced" \}/);
    expect(source).toMatch(/code: "files_restoring"/);
    expect(source).toMatch(/code:"thread_limit"/);
  });
  it("the drain starts each batch once through runQueuedStart, and a new send waits behind a start in flight", () => {
    const drain = source.slice(source.indexOf("function drainQueuedSends() {"), source.indexOf("// ── live screen"));
    expect(drain).toMatch(/return runQueuedStart\(\{/);
    expect(drain).toMatch(/occupied: \(\) => directThreadBusy\(botId, threadId\) \|\| Boolean\(activeGroupTurnForBot\(botId\)\)/);
    expect(drain).toMatch(/\(botId, threadId\) => directThreadBusy\(botId, threadId\),\n  \);/);
    expect(source).toMatch(/sendStore\.blockedByEarlier\(threadId, row\.seq\) \|\| queuedStartPending\(threadId\)/);
  });
});
