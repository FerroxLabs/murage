// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// STOP-NONACP s4, muse-code (design r3 + r3.1, rows M1-M4, DT1, D3 write gate, D6 live dispose). Every dispose row asserts the events
// the recorder holds BEFORE `await instance.dispose()` resolves, plus the side effect (host spawns, turn/start writes, frames).
// Driven through the real SDK queue over mocked spawns, the same way the L12 rows in muse-code.test.ts are.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../contracts.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import * as procs from "../procs.ts";
import { checkMuseWrite, stdioTransport, MUSE_DEFAULT_MODEL, MuseCodeDriver, type MuseAdmission } from "./muse-code.ts";
import { createStopGate } from "./stop-gate.ts";
import { engineClosedLine } from "./stop-copy.ts";

type Frame = { id?: number; method: string; params: Record<string, any> };
type Intercept = (child: any, frame: Frame, callback: (error?: Error | null) => void) => boolean;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const CLOSED = engineClosedLine("Muse Code", null);

/** `holdModels`: the first model/list is never answered, so `initialModels` stays pending (ensureSession holds at its first await). */
const fixture = async (opts: { holdModels?: boolean; intercept?: Intercept } = {}) => {
  vi.spyOn(procs, "resolveEngineExecutable").mockReturnValue({ command: "/stop-nonacp-fixture", args: [] });
  const children: any[] = [];
  const events: RuntimeEvent[] = [];
  const stopped: any[] = [];
  let intercept = opts.intercept;
  let confirmation: ReturnType<typeof deferred<boolean>> | undefined;
  vi.spyOn(procs, "spawnCli").mockImplementation((_cli, args) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: undefined as any,
      pid: 20000 + children.length, exitCode: null as number | null, signalCode: null,
      frames: [] as Frame[], args, rootExited: false,
      send(...frames: unknown[]) { this.stdout.write(frames.map(f => JSON.stringify({ jsonrpc: "2.0", ...(f as object) }) + "\n").join("")); },
      ack(frame: Frame, result = {}) { this.send({ id: frame.id, result: { commandId: frame.params?.commandId, ...result } }); },
      exit(this: any) { this.rootExited = true; this.exitCode = 0; this.emit("exit", 0, null); },
      end(this: any) { if (!this.rootExited) this.exit(); this.stdout.end(); this.stderr.end(); this.emit("close", 0, null); },
    });
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const frame: Frame = JSON.parse(String(chunk)); child.frames.push(frame);
      if (intercept?.(child, frame, callback)) return;
      callback();
      if (frame.id === undefined) return;
      if (frame.method === "initialize") child.ack(frame, { grantedCapabilities: ["sessionMcp"] });
      else if (frame.method === "model/list") { if (!opts.holdModels) child.ack(frame, { models: [{ modelId: MUSE_DEFAULT_MODEL }, { modelId: "muse-wonder-1.0" }] }); }
      else if (frame.method === "session/start") child.ack(frame, { session: { sessionId: "s-1", modelId: frame.params.modelId } });
      else child.ack(frame);
    } });
    children.push(child);
    return child as unknown as ReturnType<typeof procs.spawnCli>;
  });
  vi.spyOn(procs, "awaitCliTreeStopped").mockImplementation(async child => {
    stopped.push(child);
    if (confirmation && !await confirmation.promise) return false;
    (child as any).end(); return true;
  });
  const instance = await MuseCodeDriver.create({ instanceId: "s4", displayName: "S4", enabled: true,
    environment: {}, config: MuseCodeDriver.decodeConfig({ cli: "stop-nonacp-fixture" }) });
  instance.adapter.onEvent(event => events.push(event));
  if (!opts.holdModels) await vi.waitFor(() => expect(instance.models.source).toBe("live"));
  const send = (extra = {}) => instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "s4", text: "PRIVATE-S4", ...extra });
  const hosts = () => children.filter(c => c.args[0] === "serve" && !c.args.includes("--no-session-log"));
  const host = () => hosts()[0];
  const started = async () => { await send(); await vi.waitFor(() => expect(host()?.frames.some((f: Frame) => f.method === "turn/start")).toBe(true)); return host(); };
  const completions = () => events.filter(e => e.type === "turn.completed");
  const turnEvents = () => events.filter(e => ["turn.started", "runtime.error", "turn.completed"].includes(e.type));
  return {
    instance, children, events, stopped, send, host, hosts, started, completions, turnEvents,
    intercept(fn: Intercept | undefined) { intercept = fn; },
    holdDeath() { confirmation = deferred<boolean>(); return confirmation; },
    writes: (method: string) => children.flatMap(c => c.frames as Frame[]).filter(f => f.method === method).length,
  };
};

/** Starts dispose and records whether dispose had already resolved when each turn.completed was emitted. */
const disposeAndWatch = (f: Awaited<ReturnType<typeof fixture>>) => {
  const seen = { resolved: false, completedBeforeResolve: [] as boolean[] };
  f.instance.adapter.onEvent(e => { if (e.type === "turn.completed") seen.completedBeforeResolve.push(!seen.resolved); });
  const done = f.instance.dispose().then(() => { seen.resolved = true; });
  return { seen, done };
};

describe("STOP-NONACP s4 muse-code", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("M1 dispose while initialModels is pending: no host, one turn.started, the engine-closed line, exit_before_result", async () => {
    const f = await fixture({ holdModels: true });
    await f.send();
    expect(f.hosts()).toHaveLength(0);
    const { seen, done } = disposeAndWatch(f);
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1));
    await done;
    expect(f.turnEvents()).toMatchObject([
      { type: "turn.started" },
      { type: "runtime.error", message: CLOSED },
      { type: "turn.completed", ok: false, stopReason: "exit_before_result" },
    ]);
    expect(seen.completedBeforeResolve).toEqual([true]);
    expect(f.hosts()).toHaveLength(0); // side effect: no host was ever spawned for the turn
    expect(f.writes("turn/start")).toBe(0);
  });

  it("M2 Stop in the same window (control): the stopped pair, no engine-closed line", async () => {
    const f = await fixture({ holdModels: true });
    await f.send();
    await f.instance.adapter.interruptTurn("s4");
    expect(f.turnEvents()).toMatchObject([
      { type: "turn.started" },
      { type: "turn.completed", ok: true, stopReason: "cancelled" },
    ]);
    expect(f.hosts()).toHaveLength(0);
    await f.instance.dispose();
    expect(f.completions()).toHaveLength(1); // dispose adds nothing after the Stop's ending
  });

  it("M3 a prompt written, turn in flight, dispose: the engine-closed line and exit_before_result, never interrupted", async () => {
    const f = await fixture();
    const child = await f.started();
    expect(child.frames.filter((fr: Frame) => fr.method === "turn/start")).toHaveLength(1);
    const { seen, done } = disposeAndWatch(f);
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1));
    await done;
    expect(seen.completedBeforeResolve).toEqual([true]); // recorded at emission: dispose had not resolved yet
    expect(f.turnEvents()).toMatchObject([
      { type: "turn.started" },
      { type: "runtime.error", message: CLOSED },
      { type: "turn.completed", ok: false, stopReason: "exit_before_result" },
    ]);
    expect(JSON.stringify(f.events)).not.toContain("interrupted");
    expect(child.frames.some((fr: Frame) => fr.method === "turn/interrupt")).toBe(false);
  });

  it("M3 stopFirst control: Stop first, then dispose: interrupted is kept (the Stop was asked)", async () => {
    const f = await fixture();
    f.intercept((child, frame, callback) => {
      if (frame.method !== "turn/interrupt") return false;
      callback(); child.ack(frame);
      const start = child.frames.find((fr: Frame) => fr.method === "turn/start");
      child.send({ method: "turn/completed", params: { sessionId: "s-1", turnId: start.params.commandId, terminal: "cancelled" } });
      return true;
    });
    await f.started();
    const stop = f.instance.adapter.interruptTurn("s4");
    const { done } = disposeAndWatch(f); // the dispose lands before the Stop has finished
    await stop; await done;
    expect(f.completions()).toMatchObject([{ ok: false, stopReason: "interrupted" }]);
    expect(f.events.filter(e => e.type === "runtime.error")).toHaveLength(0);
  });

  it("M3 stopFirst control: Stop asked, host never confirms the interrupt, dispose: interrupted still kept", async () => {
    const f = await fixture();
    f.intercept((_child, frame, callback) => { if (frame.method !== "turn/interrupt") return false; callback(); return true; }); // never answered
    await f.started();
    const stop = f.instance.adapter.interruptTurn("s4");
    await Promise.resolve();
    await f.instance.dispose(); // reaps the host: the unconfirmed turn ends interrupted because the owner asked
    await stop;
    expect(f.completions()).toMatchObject([{ ok: false, stopReason: "interrupted" }]);
    expect(f.events.filter(e => e.type === "runtime.error")).toHaveLength(0);
  }, 20_000);

  it("M4 a setup failure with no Stop shows its failure card through finish: one card, then ok:false, once", async () => {
    const f = await fixture({ intercept: (child, frame, callback) => {
      if (frame.method !== "session/start") return false;
      callback(); child.send({ id: frame.id, error: { code: -32000, message: "PRIVATE-SETUP-REFUSED" } }); return true;
    } });
    await f.send();
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1));
    expect(f.turnEvents().map(e => e.type)).toEqual(["turn.started", "runtime.error", "turn.completed"]);
    expect(f.turnEvents()[1]).toMatchObject({ type: "runtime.error", message: expect.any(String) });
    expect((f.turnEvents()[1] as any).message).not.toBe(CLOSED);
    expect(f.completions()).toMatchObject([{ ok: false, stopReason: "error" }]);
    expect(f.events.filter(e => e.type === "runtime.error")).toHaveLength(1);
    await f.instance.dispose();
    expect(f.completions()).toHaveLength(1);
  });

  it("M4 a host failure that began before a Stop keeps its failure card when the Stop lands during the host close", async () => {
    const f = await fixture({ intercept: (child, frame, callback) => {
      if (frame.method !== "session/start") return false;
      callback(); child.stdout.write("bad-json\n"); return true;
    } });
    const death = f.holdDeath();
    await f.send();
    await vi.waitFor(() => expect(f.stopped).toContain(f.host()));
    expect(f.completions()).toHaveLength(0);
    const stop = f.instance.adapter.interruptTurn("s4"); death.resolve(true); await stop;
    expect(f.completions()).toMatchObject([{ ok: false, stopReason: "error" }]);
    await f.instance.dispose();
  });

  it("USAGE-1 muse an asked Stop on a live turn: the host's cancelled terminal carries its usage to the interrupted ending", async () => {
    const f = await fixture();
    f.intercept((child, frame, callback) => {
      if (frame.method !== "turn/interrupt") return false;
      callback(); child.ack(frame);
      const start = child.frames.find((fr: Frame) => fr.method === "turn/start");
      child.send({ method: "turn/completed", params: { sessionId: "s-1", turnId: start.params.commandId, terminal: "cancelled", usage: { inputTokens: 30, outputTokens: 4, cachedTokens: 6 } } });
      return true;
    });
    await f.started();
    await f.instance.adapter.interruptTurn("s4");
    expect(f.completions()).toMatchObject([{ ok: false, stopReason: "interrupted", usage: { input: 30, output: 4, cachedInput: 6 } }]);
    await f.instance.dispose();
  });

  // USAGE-1 muse (MurageMain ruling B, 11-08): the last session/tokenUsage the host reported is kept on the turn and rides a Stop or dispose ending;
  // the host's own turn/completed usage still wins when it arrives. The kept rows report two usages so "last reported wins" is pinned too.
  const reportUsage = async (f: Awaited<ReturnType<typeof fixture>>, child: any) => {
    child.send({ method: "session/tokenUsage", params: { sessionId: "s-1", usage: { inputTokens: 10, outputTokens: 1 } } });
    child.send({ method: "session/tokenUsage", params: { sessionId: "s-1", usage: { inputTokens: 30, outputTokens: 4, cachedTokens: 6 } } });
    await vi.waitFor(() => expect(f.events.filter(e => e.type === "thread.token-usage.updated")).toHaveLength(2));
  };
  const cancelledTerminal = (usage?: Record<string, number>): Intercept => (child, frame, callback) => {
    if (frame.method !== "turn/interrupt") return false;
    callback(); child.ack(frame);
    const start = child.frames.find((fr: Frame) => fr.method === "turn/start");
    child.send({ method: "turn/completed", params: { sessionId: "s-1", turnId: start.params.commandId, terminal: "cancelled", ...(usage ? { usage } : {}) } });
    return true;
  };

  it("USAGE-1 muse an asked Stop whose cancelled terminal carries no usage: the last reported usage rides the interrupted ending", async () => {
    const f = await fixture();
    const child = await f.started();
    await reportUsage(f, child);
    f.intercept(cancelledTerminal());
    await f.instance.adapter.interruptTurn("s4");
    expect(f.completions()).toMatchObject([{ ok: false, stopReason: "interrupted", usage: { input: 30, output: 4, cachedInput: 6 } }]);
    await f.instance.dispose();
    expect(f.completions()).toHaveLength(1);
  });

  it("USAGE-1 muse dispose with a live turn: the engine-closing ending carries the last reported usage before dispose resolves", async () => {
    const f = await fixture();
    const child = await f.started();
    await reportUsage(f, child);
    const { seen, done } = disposeAndWatch(f);
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1));
    await done;
    expect(seen.completedBeforeResolve).toEqual([true]);
    expect(f.completions()).toMatchObject([{ ok: false, stopReason: "exit_before_result", usage: { input: 30, output: 4, cachedInput: 6 } }]);
    expect(f.events.filter(e => e.type === "runtime.error" && (e as any).message === CLOSED)).toHaveLength(1);
  });

  it("USAGE-1 muse no double count: the host's own turn/completed usage wins over the kept one, one usage", async () => {
    const f = await fixture();
    const child = await f.started();
    await reportUsage(f, child);
    f.intercept(cancelledTerminal({ inputTokens: 40, outputTokens: 5 }));
    await f.instance.adapter.interruptTurn("s4");
    expect(f.completions()).toHaveLength(1);
    expect((f.completions()[0] as any).usage).toEqual({ input: 40, output: 5 }); // the terminal's, not the kept {30, 4, 6}
    await f.instance.dispose();
    expect(f.completions()).toHaveLength(1);
  });

  it("USAGE-1 muse drain timeout: a host close that never confirms past the 200 ms deadline: the closing ending carries the last reported usage, once, before dispose resolves", async () => {
    vi.stubEnv("MURAGE_PROVIDER_CLOSE_MS", "200");
    const f = await fixture();
    const child = await f.started();
    await reportUsage(f, child);
    const death = f.holdDeath(); // the host close never confirms until released
    const { seen, done } = disposeAndWatch(f);
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1), { timeout: 3000 });
    expect(seen.resolved).toBe(false); // dispose is still waiting on the hung close
    expect(f.completions()).toMatchObject([{ ok: false, stopReason: "exit_before_result", usage: { input: 30, output: 4, cachedInput: 6 } }]);
    death.resolve(true);
    await done;
    expect(f.completions()).toHaveLength(1); // the late end of the host adds no second ending
  });

  it("M4b ordering: a setup failure that began before any Stop keeps its failure card (ok:false); a Stop or dispose mark that lands before the failure ends as the pair (Stop) or engine-closing (dispose)", async () => {
    const refuse = (held?: { child: any; frame: Frame }): Intercept => (child, frame, callback) => {
      if (frame.method !== "session/start") return false;
      callback();
      if (held) Object.assign(held, { child, frame }); else child.send({ id: frame.id, error: { code: -32000, message: "PRIVATE-SETUP-REFUSED" } });
      return true;
    };
    // failure first, no mark: its card, then ok:false
    const first = await fixture({ intercept: refuse() });
    await first.send();
    await vi.waitFor(() => expect(first.completions()).toHaveLength(1));
    expect(first.turnEvents().map(e => e.type)).toEqual(["turn.started", "runtime.error", "turn.completed"]);
    expect(first.completions()).toMatchObject([{ ok: false, stopReason: "error" }]);
    await first.instance.dispose();
    // the mark first, the failure after it
    for (const kind of ["Stop", "dispose"] as const) {
      const held: { child?: any; frame?: Frame } = {};
      const f = await fixture({ intercept: refuse(held as { child: any; frame: Frame }) });
      await f.send();
      await vi.waitFor(() => expect(held.child).toBeDefined());
      const marked = kind === "Stop" ? f.instance.adapter.interruptTurn("s4") : disposeAndWatch(f).done;
      held.child.send({ id: held.frame!.id, error: { code: -32000, message: "PRIVATE-SETUP-REFUSED" } });
      await marked;
      await vi.waitFor(() => expect(f.completions()).toHaveLength(1));
      if (kind === "Stop") {
        expect(f.completions()).toMatchObject([{ ok: true, stopReason: "cancelled" }]);
        expect(f.events.filter(e => e.type === "runtime.error")).toHaveLength(0);
      } else {
        expect(f.turnEvents()).toMatchObject([{ type: "turn.started" }, { type: "runtime.error", message: CLOSED }, { type: "turn.completed", ok: false, stopReason: "exit_before_result" }]);
      }
      await f.instance.dispose();
      expect(f.completions()).toHaveLength(1);
    }
  });

  it("DT1 dispose while ensureSession holds its first await after sendTurn returned, 200 ms deadline: one closing receipt before dispose resolves", async () => {
    vi.stubEnv("MURAGE_PROVIDER_CLOSE_MS", "200");
    const f = await fixture({ holdModels: true });
    await f.send();
    const { seen, done } = disposeAndWatch(f);
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1), { timeout: 2000 });
    await done;
    expect(seen.completedBeforeResolve).toEqual([true]); // recorded at emission: dispose had not resolved yet
    expect(f.completions()).toMatchObject([{ ok: false, stopReason: "exit_before_result" }]);
    expect(f.events.filter(e => e.type === "runtime.error" && (e as any).message === CLOSED)).toHaveLength(1);
    expect(f.hosts()).toHaveLength(0);
  });

  it("DT1 a host close that hangs past the 200 ms deadline: the closing receipt still arrives before dispose resolves", async () => {
    vi.stubEnv("MURAGE_PROVIDER_CLOSE_MS", "200");
    // session/start is never answered: ensureSession holds after sendTurn returned, with a host that exists
    const f = await fixture({ intercept: (_child, frame, callback) => frame.method === "session/start" ? (callback(), true) : false });
    await f.send();
    await vi.waitFor(() => expect(f.host()?.frames.some((fr: Frame) => fr.method === "session/start")).toBe(true));
    const death = f.holdDeath(); // the host close never confirms until released
    const { seen, done } = disposeAndWatch(f);
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1), { timeout: 3000 });
    expect(seen.resolved).toBe(false); // dispose is still waiting on the hung close
    expect(f.completions()).toMatchObject([{ ok: false, stopReason: "exit_before_result" }]);
    expect(f.events.filter(e => e.type === "runtime.error" && (e as any).message === CLOSED)).toHaveLength(1);
    expect(f.writes("turn/start")).toBe(0);
    death.resolve(true);
    await done;
    expect(f.completions()).toHaveLength(1); // the late end of the host adds no second ending
  });

  it("DT1 closed gate: a startup that resumes after dispose launches nothing", async () => {
    const f = await fixture({ holdModels: true });
    await f.send();
    await f.instance.dispose();
    expect(f.completions()).toHaveLength(1);
    expect(f.hosts()).toHaveLength(0);
    expect(f.writes("turn/start")).toBe(0);
    await expect(f.send()).rejects.toThrow(/shutting down/);
  });

  it("Stop before the transport write: no turn/start is written, the stopped pair", async () => {
    const f = await fixture();
    let stopCalled!: Promise<void>;
    await f.send({ beforeSubmit: () => { stopCalled = f.instance.adapter.interruptTurn("s4") as Promise<void>; } });
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1));
    await stopCalled;
    expect(f.writes("turn/start")).toBe(0);
    expect(f.turnEvents()).toMatchObject([
      { type: "turn.started" },
      { type: "turn.completed", ok: true, stopReason: "cancelled" },
    ]);
    await f.instance.dispose();
  });

  it("Dispose before the transport write: no turn/start is written, the engine-closed line", async () => {
    const f = await fixture();
    let disposed!: Promise<void>;
    await f.send({ beforeSubmit: () => { disposed = f.instance.dispose(); } });
    await vi.waitFor(() => expect(f.completions()).toHaveLength(1));
    expect(f.writes("turn/start")).toBe(0);
    expect(f.turnEvents()).toMatchObject([
      { type: "turn.started" },
      { type: "runtime.error", message: CLOSED },
      { type: "turn.completed", ok: false, stopReason: "exit_before_result" },
    ]);
    await disposed;
  });

  it("D3 a prompt frame is written only inside gate.launch; a closed gate refuses it and a control frame still goes", async () => {
    const writes: string[] = [];
    const child = { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable({
      write(chunk, _encoding, callback) { writes.push(String(chunk)); callback(); },
    }) } as unknown as ReturnType<typeof procs.spawnCli>;
    const gate = createStopGate({ engineName: "Muse Code", emit: () => {}, base: (threadId, turnId) => ({ threadId, turnId }) });
    const admissions = new Map<string, MuseAdmission>();
    const active = { turnId: "owner", nativeTurnId: "native" };
    const authority = { closed: false, generation: 1, observationRevision: 0, role: "session", phase: "ready", requestMcp: false,
      sessionId: "s-1", requested: MUSE_DEFAULT_MODEL, owner: "owner", receipts: new Set(), observations: new Map(), unsafeObserved: new Set(),
      selection: { model: MUSE_DEFAULT_MODEL, classification: "regular" }, state: { active } } as unknown as Parameters<typeof checkMuseWrite>[1];
    authority.state!.host = authority;
    const transport = stdioTransport(child, Promise.resolve(), admissions, (frame, submitting) => checkMuseWrite(frame, authority, true, id => id === MUSE_DEFAULT_MODEL ? "regular" : "unclassified", submitting), undefined, gate);
    const params = { sessionId: "s-1", input: [{ type: "text", text: "private prompt" }], commandId: "c-1" };
    const frame = (method: string, body: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: body }) + "\n";
    const entry = gate.enter("s4");
    const live = gate.enter("s4-live");
    admissions.set("c-1", { method: "turn/start", params: JSON.stringify(params), stopped: () => false, entry: live });
    await transport.write(frame("turn/start", params));
    expect(writes).toHaveLength(1);
    expect(live.live).toBe(true); // goLive happened at the write call
    gate.ask("s4"); // an asked Stop on one entry
    admissions.set("c-1", { method: "turn/start", params: JSON.stringify(params), stopped: () => false, entry });
    await expect(transport.write(frame("turn/start", params))).rejects.toThrow();
    expect(writes).toHaveLength(1); // refused at the gate: no bytes
    expect(entry.live).toBe(false);
    gate.close();
    admissions.set("c-1", { method: "turn/steer", params: JSON.stringify({ sessionId: "s-1", expectedTurnId: "native", input: [], commandId: "c-1" }), stopped: () => false, entry: live });
    await expect(transport.write(frame("turn/steer", { sessionId: "s-1", expectedTurnId: "native", input: [], commandId: "c-1" }))).rejects.toThrow();
    expect(writes).toHaveLength(1);
    // a control frame (interrupt) is not a prompt: it is still written on a closed gate
    admissions.set("c-2", { method: "turn/interrupt", params: JSON.stringify({ sessionId: "s-1", turnId: "native", commandId: "c-2" }), stopped: () => false });
    await transport.write(frame("turn/interrupt", { sessionId: "s-1", turnId: "native", commandId: "c-2" }));
    expect(writes).toHaveLength(2);
  });
});
