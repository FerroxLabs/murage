// Isolated ACP peer + HTTP fixture. Never uses an installed engine or the owner's data.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import type { Message } from "../../store.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { openSse } from "../../testing/sse.ts";
import { launchVerificationServer } from "../../../scripts/control-murage.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";
import { ApprovalDeliveryError, denyAutomaticApproval, watchApprovalRequest } from "./approval-delivery.ts";

const peer = vi.hoisted(() => ({
  child: null as ChildProcessByStdio<Writable, Readable, Readable> | null,
  mode: "callback" as "callback" | "throw" | "dead" | "hold" | "hold-error" | "accepted-error",
  failures: 0, attempts: 0, delivered: 0, request: "",
  late: null as (() => void) | null,
  afterWrite: null as (() => void) | null,
  promptId: undefined as unknown,
  responses: [] as Array<{ id: unknown; result: unknown }>,
}));
vi.mock("../../procs.ts", async original => {
  const actual = await original<typeof import("../../procs.ts")>();
  return { ...actual, spawnCli: (...args: Parameters<typeof actual.spawnCli>) => {
    const child = actual.spawnCli(...args);
    if (!args[1].some(arg => arg.endsWith("fake-acp-cli.ts"))) return child;
    peer.child = child;
    let buffer = "";
    child.stdout.on("data", chunk => {
      buffer += String(chunk);
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { if (JSON.parse(line).method === "session/request_permission") peer.request = line; } catch {}
      }
    });
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: string, done: (error?: Error | null) => void) => {
      const message = JSON.parse(String(chunk));
      if (message.method === "session/prompt") peer.promptId = message.id;
      if (!message.result?.outcome) return write(chunk, done);
      peer.responses.push(message);
      peer.attempts++;
      if (peer.failures-- > 0) {
        const error = Object.assign(new Error("secret command must never be logged"), { code: "EPIPE" });
        if (peer.mode === "throw") throw error;
        if (peer.mode === "accepted-error") return write(chunk, () => { peer.delivered++; done(error); });
        if (peer.mode === "hold-error") { peer.late = () => done(error); return false; }
        if (peer.mode === "hold") {
          peer.late = () => { write(chunk, error => { if (!error) peer.delivered++; done(error); }); };
          return false;
        }
        if (peer.mode === "dead") child.stdin.destroy();
        queueMicrotask(() => done(error));
        return false;
      }
      return write(chunk, error => {
        if (!error) peer.delivered++;
        done(error);
        const afterWrite = peer.afterWrite;
        peer.afterWrite = null;
        afterWrite?.();
      });
    }) as typeof child.stdin.write;
    return child;
  } };
});

const FAKE_CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const SUPPORT: AcpSupport = {
  driverKind: "approvalDelivery108", displayName: "Approval fixture", defaultCli: process.execPath,
  models: { default: "fixture", options: [{ id: "fixture", label: "Fixture" }] },
  nativeSource: "approval-fixture.acp", loginNote: "Fixture only",
  spawnArgs: () => ["--experimental-strip-types", FAKE_CLI],
  pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
};

describe("1.0.8 ACP approval delivery", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  const threadId = "approval-delivery-108";
  beforeEach(async () => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "murage-approval-108-"));
    Object.assign(peer, { child: null, mode: "callback", failures: 0, attempts: 0, delivered: 0, request: "", late: null, afterWrite: null, promptId: undefined, responses: [] });
    instance = await createAcpDriver(SUPPORT).create({
      instanceId: "approval-108", displayName: "Approval fixture", enabled: true,
      environment: { FAKE_ACP_MODE: "permission" }, config: { cli: process.execPath, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  });
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    vi.restoreAllMocks();
    await removeTempDir(scratch);
  });
  const open = async () => {
    await instance.adapter.sendTurn({ threadId, text: "fixture approval", cwd: scratch });
    const event = await recorder.until(e => e.type === "request.opened");
    if (event.type !== "request.opened" || !event.requestId) throw new Error("Missing approval");
    return event.requestId;
  };
  const answer = (requestId: string) => instance.adapter.respondToRequest(threadId, requestId, { behavior: "allow" });
  const repeat = () => peer.child!.stdout.emit("data", Buffer.from(peer.request + "\n"));
  const resolved = () => recorder.events.filter(e => e.type === "request.resolved");

  it("synchronous write failures preserve the card and resolver, without duplicate native cards", async () => {
    const requestId = await open();
    peer.mode = "throw"; peer.failures = 3;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = answer(requestId).catch(error => error);
    repeat();
    expect(await failure).toMatchObject({ status: 503, reason: "EPIPE", terminal: false });
    expect(peer.attempts).toBe(3);
    expect(peer.delivered).toBe(0);
    expect(resolved()).toEqual([]);
    expect(instance.adapter.hasSession(threadId)).toBe(true);
    repeat();
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(1);
    const logs = warning.mock.calls.filter(([line]) => String(line).startsWith("acp approval delivery"));
    expect(logs).toEqual([[`acp approval delivery thread=${threadId} request=${requestId} error=EPIPE`]]);
    // Retrying the SAME card proves its resolver survived all three errors.
    expect(await answer(requestId)).toBe("allowed-once");
    expect(peer.delivered).toBe(1);
    expect(resolved()).toHaveLength(1);
  });

  it("retries a pre-acceptance failure and coalesces concurrent answers into one delivery", async () => {
    const requestId = await open();
    peer.mode = "throw"; peer.failures = 1;
    const first = answer(requestId);
    const second = answer(requestId);
    repeat();
    expect(await Promise.all([first, second])).toEqual(["allowed-once", "allowed-once"]);
    expect(peer.attempts).toBe(2);
    expect(peer.delivered).toBe(1);
    expect(resolved()).toHaveLength(1);
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(1);
  });

  it.each(["callback", "accepted-error"] as const)("no resend after an accepted write that errors (%s)", async mode => {
    const requestId = await open();
    peer.mode = mode; peer.failures = 1;
    await expect(answer(requestId)).rejects.toMatchObject({ reason: "EPIPE", terminal: true });
    await recorder.until(e => e.type === "turn.completed" && !e.ok);
    expect(await answer(requestId)).toBe("unavailable");
    expect(peer.responses).toHaveLength(1);
    expect(peer.attempts).toBe(1);
    expect(peer.delivered).toBe(mode === "accepted-error" ? 1 : 0);
    expect(resolved()).toEqual([]);
  });

  it("same id with different params opens no second card and cancels the pending RPC once", async () => {
    const requestId = await open();
    const conflicting = JSON.parse(peer.request);
    conflicting.params.toolCall.rawInput = { command: "different command" };
    peer.child!.stdout.emit("data", Buffer.from(JSON.stringify(conflicting) + "\n"));
    await recorder.until(e => e.type === "turn.completed" && !e.ok);
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(1);
    expect(peer.responses).toEqual([{ jsonrpc: "2.0", id: conflicting.id, result: { outcome: { outcome: "cancelled" } } }]);
    expect(await answer(requestId)).toBe("unavailable");
  });

  it("same id with conflicting params during an accepted Allow never sends cancellation", async () => {
    const requestId = await open();
    peer.mode = "hold"; peer.failures = 1;
    const allowed = answer(requestId).catch(error => error);
    const conflicting = JSON.parse(peer.request);
    conflicting.params.toolCall.rawInput = { command: "different command" };
    peer.child!.stdout.emit("data", Buffer.from(JSON.stringify(conflicting) + "\n"));
    expect(await allowed).toMatchObject({ terminal: true });
    await recorder.until(e => e.type === "turn.completed" && !e.ok);
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(1);
    expect(peer.responses).toHaveLength(1);
    expect(resolved()).toEqual([]);
  });

  it("Stop after a missing callback never cancels the uncertain RPC or records a denial", async () => {
    const requestId = await open();
    peer.mode = "hold"; peer.failures = 1;
    await expect(answer(requestId)).rejects.toMatchObject({ reason: "delivery_pending" });
    await instance.adapter.interruptTurn(threadId);
    await recorder.until(e => e.type === "turn.completed");
    expect(peer.responses).toHaveLength(1);
    expect(resolved()).toEqual([]);
  });

  it("keeps the card pending under backpressure until the write callback succeeds", async () => {
    const requestId = await open();
    peer.mode = "hold"; peer.failures = 1;
    const pending = answer(requestId);
    expect(peer.attempts).toBe(1);
    expect(peer.delivered).toBe(0);
    expect(resolved()).toEqual([]);
    expect(peer.late).not.toBeNull();
    peer.late!();
    expect(await pending).toBe("allowed-once");
    expect(peer.attempts).toBe(1);
    expect(peer.delivered).toBe(1);
    expect(resolved()).toHaveLength(1);
  });

  it("a dead stream visibly ends the turn within the delivery bound", async () => {
    const requestId = await open();
    peer.mode = "dead"; peer.failures = 1;
    const started = Date.now();
    await expect(answer(requestId)).rejects.toMatchObject({ status: 503, terminal: true });
    await recorder.until(e => e.type === "turn.completed", 2100);
    expect(Date.now() - started).toBeLessThan(2100);
    expect(peer.attempts).toBe(1);
    expect(recorder.events.some(e => e.type === "item.started" && e.title === "The engine stopped before approval delivery could be confirmed.")).toBe(true);
    expect(resolved().some(e => e.type === "request.resolved" && e.behavior === "allow")).toBe(false);
    expect(await answer(requestId)).toBe("unavailable");
    expect(instance.adapter.hasSession(threadId)).toBe(false);
  });

  it.each(["Stop", "normal end"] as const)("%s withdraws an untouched card without an approval failure notice", async ending => {
    await open();
    if (ending === "Stop") await instance.adapter.interruptTurn(threadId);
    else peer.child!.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: peer.promptId, result: { stopReason: "end_turn" } }) + "\n"));
    await recorder.until(e => e.type === "turn.completed");
    expect(resolved()).toHaveLength(1);
    expect(resolved()[0]).toMatchObject({ behavior: "deny", source: "system" });
    expect(recorder.events.some(e => e.type === "item.started" && e.itemId?.startsWith("approval-undelivered-"))).toBe(false);
  });

  it("Deny cancels Allow retries during backoff", async () => {
    const requestId = await open();
    peer.mode = "throw"; peer.failures = 1;
    const allowed = answer(requestId).catch(error => error);
    // The write threw before acceptance, leaving only the retry timer outstanding.
    await Promise.resolve();
    expect(await instance.adapter.respondToRequest(threadId, requestId, { behavior: "deny" })).toBe("rejected");
    expect(await allowed).toBeInstanceOf(ApprovalDeliveryError);
    expect(peer.responses).toHaveLength(2);
    expect(peer.responses[1]).toMatchObject({ result: { outcome: { optionId: "reject" } } });
    expect(peer.delivered).toBe(1);
    expect(resolved()).toHaveLength(1);
    expect(resolved()[0]).toMatchObject({ behavior: "deny", source: "user" });
  });

  it("Deny stops the turn when an Allow write is uncertain", async () => {
    const requestId = await open();
    peer.mode = "hold"; peer.failures = 1;
    const allowed = answer(requestId).catch(error => error);
    await expect(instance.adapter.respondToRequest(threadId, requestId, { behavior: "deny" })).rejects.toMatchObject({ terminal: true });
    expect(await allowed).toBeInstanceOf(ApprovalDeliveryError);
    await recorder.until(e => e.type === "turn.completed" && !e.ok);
    expect(peer.attempts).toBe(1);
    expect(peer.delivered).toBe(0);
    expect(recorder.events.some(e => e.type === "item.started" && e.itemId?.startsWith("approval-undelivered-"))).toBe(true);
    expect(resolved()).toEqual([]);
    expect(peer.responses).toHaveLength(1);
  });

  it("a timed out write stays pending without retry and accepts its late callback", async () => {
    const requestId = await open();
    peer.mode = "hold"; peer.failures = 1;
    await expect(answer(requestId)).rejects.toMatchObject({ reason: "delivery_pending", terminal: false, message: "Your earlier answer is still being delivered." });
    await expect(answer(requestId)).rejects.toMatchObject({ reason: "delivery_pending" });
    expect(peer.attempts).toBe(1);
    expect(resolved()).toEqual([]);
    expect(instance.adapter.hasSession(threadId)).toBe(true);
    peer.late!();
    await recorder.until(e => e.type === "request.resolved");
    expect(peer.delivered).toBe(1);
    expect(resolved()[0]).toMatchObject({ behavior: "allow" });
  });

  it("a late write error is terminal and cannot resend or record a denial", async () => {
    const requestId = await open();
    peer.mode = "hold-error"; peer.failures = 1;
    await expect(answer(requestId)).rejects.toMatchObject({ reason: "delivery_pending", terminal: false });
    peer.late!();
    await recorder.until(e => e.type === "turn.completed" && !e.ok);
    expect(resolved()).toEqual([]);
    expect(await answer(requestId)).toBe("unavailable");
    expect(peer.responses).toHaveLength(1);
    expect(peer.attempts).toBe(1);
  });

  it("a successful write clears the ask before a racing Stop can cancel its RPC", async () => {
    const requestId = await open();
    let stopped: Promise<unknown> | undefined;
    peer.afterWrite = () => { stopped = instance.adapter.interruptTurn(threadId); };
    await expect(answer(requestId)).rejects.toMatchObject({ reason: "engine_stopped" });
    await stopped;
    await recorder.until(e => e.type === "turn.completed");
    expect(peer.responses).toHaveLength(1);
    expect(peer.responses[0]).toMatchObject({ result: { outcome: { optionId: "allow-once" } } });
    expect(await answer(requestId)).toBe("unavailable");
  });

  it("automatic denial catches write rejection and visibly stops the turn", async () => {
    const requestId = await open();
    peer.mode = "throw"; peer.failures = 3;
    const notice = vi.fn();
    const stop = vi.fn(() => instance.adapter.interruptTurn(threadId));
    await expect(denyAutomaticApproval(
      () => instance.adapter.respondToRequest(threadId, requestId, { behavior: "deny" }),
      stop, () => instance.adapter.hasSession(threadId), notice,
    )).resolves.toBeUndefined();
    expect(notice).toHaveBeenCalledWith("The denial could not be delivered. This turn is being stopped.");
    expect(stop).toHaveBeenCalledOnce();
    await recorder.until(e => e.type === "turn.completed");
    expect(instance.adapter.hasSession(threadId)).toBe(false);
  });

  it("terminal automatic approval failure cannot publish a fallback card", async () => {
    const requestId = await open();
    const opened = recorder.events.find(e => e.type === "request.opened")!;
    const request = watchApprovalRequest(opened, listener => instance.adapter.onEvent(listener));
    peer.mode = "dead"; peer.failures = 1;
    const error = await answer(requestId).catch(error => error);
    expect(error).toMatchObject({ terminal: true });
    expect(request.live()).toBe(false);
    expect(request.canFallback(error)).toBe(false);
    request.dispose();
  });

  it("permission expiry during backoff prevents further Allow retries and denies", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const requestId = await open();
    const expire = timers.mock.calls.find(([, ms]) => ms === 15 * 60_000)?.[0];
    peer.mode = "throw"; peer.failures = 1;
    const allowed = answer(requestId).catch(error => error);
    await Promise.resolve();
    (expire as () => void)();
    expect(await allowed).toBeInstanceOf(ApprovalDeliveryError);
    await recorder.until(e => e.type === "request.resolved");
    expect(peer.responses).toHaveLength(2);
    expect(peer.responses[1]).toMatchObject({ result: { outcome: { optionId: "reject" } } });
    expect(resolved()[0]).toMatchObject({ behavior: "deny", source: "timeout" });
  });

  it("permission expiry during an accepted write error never denies the uncertain Allow", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const requestId = await open();
    const expire = timers.mock.calls.find(([, ms]) => ms === 15 * 60_000)?.[0];
    peer.mode = "hold-error"; peer.failures = 1;
    const allowed = answer(requestId).catch(error => error);
    (expire as () => void)();
    peer.late!();
    expect(await allowed).toMatchObject({ terminal: true });
    await recorder.until(e => e.type === "turn.completed" && !e.ok);
    expect(peer.responses).toHaveLength(1);
    expect(resolved()).toEqual([]);
  });

  it("a definite delivery miss rearms the deny deadline after it fires in flight", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const requestId = await open();
    const deadlines = () => timers.mock.calls.filter(([, ms]) => ms === 15 * 60_000);
    peer.mode = "throw"; peer.failures = 3;
    const denied = instance.adapter.respondToRequest(threadId, requestId, { behavior: "deny" }).catch(error => error);
    (deadlines()[0][0] as () => void)();
    expect(await denied).toMatchObject({ terminal: false });
    expect(resolved()).toEqual([]);
    expect(deadlines()).toHaveLength(2);
    (deadlines()[1][0] as () => void)();
    await recorder.until(e => e.type === "request.resolved");
    expect(resolved()[0]).toMatchObject({ behavior: "deny", source: "timeout" });
  });

  it("permission expiry stops a still uncertain Allow without another response", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const requestId = await open();
    const expire = timers.mock.calls.find(([, ms]) => ms === 15 * 60_000)?.[0];
    peer.mode = "hold"; peer.failures = 1;
    await expect(answer(requestId)).rejects.toMatchObject({ reason: "delivery_pending" });
    (expire as () => void)();
    await recorder.until(e => e.type === "turn.completed" && !e.ok);
    expect(peer.attempts).toBe(1);
    expect(peer.responses).toHaveLength(1);
    expect(resolved()).toEqual([]);
  });

  it.each(["allow", "deny"] as const)("the normal %s path writes once and resolves once", async behavior => {
    const requestId = await open();
    expect(await instance.adapter.respondToRequest(threadId, requestId, { behavior })).toBe(behavior === "allow" ? "allowed-once" : "rejected");
    expect(peer.attempts).toBe(1);
    expect(peer.delivered).toBe(1);
    expect(resolved()).toHaveLength(1);
    expect(resolved()[0]).toMatchObject({ behavior, source: "user" });
    await recorder.until(e => e.type === "turn.completed");
  });
});

describe("automatic approval request lifetime", () => {
  const opened = { type: "request.opened", providerInstanceId: "provider", threadId: "thread", turnId: "turn", requestId: "request" } as RuntimeEvent;
  it.each([
    { type: "request.resolved", turnId: "turn", requestId: "request" },
    { type: "turn.completed", turnId: "turn" },
    { type: "turn.started", turnId: "next-turn" },
    { type: "turn.started", turnId: "next-turn", providerInstanceId: "next-provider" },
  ])("suppresses fallback after $type", ending => {
    let observe!: (event: RuntimeEvent) => void;
    const dispose = vi.fn();
    const request = watchApprovalRequest(opened, listener => { observe = listener; return dispose; });
    expect(request.canFallback(new ApprovalDeliveryError("EPIPE", false))).toBe(true);
    observe({ ...opened, ...ending } as RuntimeEvent);
    expect(request.canFallback(new ApprovalDeliveryError("EPIPE", false))).toBe(false);
    request.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("ignores other requests and turns but suppresses terminal failures", () => {
    let observe!: (event: RuntimeEvent) => void;
    const request = watchApprovalRequest(opened, listener => { observe = listener; return () => {}; });
    observe({ ...opened, type: "request.resolved", requestId: "other" } as RuntimeEvent);
    observe({ ...opened, type: "turn.completed", turnId: "other" } as RuntimeEvent);
    expect(request.canFallback(new ApprovalDeliveryError("EPIPE", false))).toBe(true);
    expect(request.canFallback(new ApprovalDeliveryError("engine_stopped", true))).toBe(false);
    request.dispose();
  });
});

it("the real approval API returns 503 and preserves the card until the fake ACP peer accepts a retry", async () => {
  // Patch only this isolated server child's fake-engine transport and config.
  const instrumentationSource = `
    // The server child does not inherit the Vitest worker's in-memory hook.
    // Use the same test-only seam so this transport fixture needs no shipped bwrap.
    process.env.NODE_ENV = 'test';
    globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
    const cp = (await import('node:child_process')).default;
    const spawn = cp.spawn;
    cp.spawn = function(command, args, options) {
      const child = spawn(command, args, options);
      if (/powershell|pwsh/i.test(String(command))) {
        const t0 = Date.now(); const e = options?.env ?? {};
        console.log('[diag] ps spawn', t0, JSON.stringify({ cwd: options?.cwd, PATH: String(e.PATH ?? e.Path ?? '').slice(0, 160), LOCALAPPDATA: e.LOCALAPPDATA, USERPROFILE: e.USERPROFILE, PSModulePath: e.PSModulePath, TEMP: e.TEMP, n: Object.keys(e).length }));
        child.once('exit', (c, s) => console.log('[diag] ps exit', Date.now() - t0, 'ms', c, s));
      }
      if (!args?.includes(${JSON.stringify(FAKE_CLI)})) return child;
      const write = child.stdin.write.bind(child.stdin);
      let failures = 3;
      child.stdin.write = function(chunk, done) {
        // Only JSON-RPC lines are the peer's; on Windows the job launcher's own
        // start frame goes down the same stdin first and must pass untouched.
        let message;
        try { message = JSON.parse(String(chunk)); } catch { return write(chunk, done); }
        if (message.result?.outcome && failures-- > 0) {
          throw Object.assign(new Error('fixture write failure'), { code: 'EPIPE' });
        }
        return write(chunk, done);
      };
      return child;
    };
    (await import('node:module')).syncBuiltinESMExports();
    const { createAcpDriver } = await import(${JSON.stringify(new URL("./core.ts", import.meta.url).href)});
    const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL("../builtIn.ts", import.meta.url).href)});
    BUILT_IN_DRIVERS.push(createAcpDriver({
      driverKind: 'approvalDelivery108', displayName: 'Approval fixture', defaultCli: process.execPath,
      models: { default: 'fixture', options: [{ id: 'fixture', label: 'Fixture' }] },
      nativeSource: 'approval-fixture.acp', loginNote: 'Fixture only',
      spawnArgs: () => ['--experimental-strip-types', ${JSON.stringify(FAKE_CLI)}],
      pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true
    }));
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'config.json'), JSON.stringify({ instances: {
      approval: { driver: 'approvalDelivery108', environment: { FAKE_ACP_MODE: 'permission' }, config: { cli: process.execPath, fullAuto: false } }
    }}));
  `;
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  const stream = await openSse(fixture.info.url + "/api/events");
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const post = (path: string, body: unknown) => fetch(fixture.info.url + path, { method: "POST", headers, body: JSON.stringify(body) });
    const created = await post("/api/bots", { name: "Approval fixture", modelSelection: { instanceId: "approval", model: "fixture" } });
    expect(created.ok).toBe(true);
    const { bot } = await created.json() as { bot: { id: string; threadId: string } };
    const patched = await fetch(fixture.info.url + `/api/bots/${bot.id}`, { method: "PATCH", headers, body: JSON.stringify({ autoApprove: false, autoReview: "off", computer: "off" }) });
    expect(patched.ok).toBe(true);
    await stream.until(frame => frame.kind === "hello");
    expect((await post(`/api/bots/${bot.id}/messages`, { text: "Ask for fixture approval", threadId: bot.threadId })).ok).toBe(true);
    // The card opens after the shell environment check, whose Windows budget
    // (CHECK_WINDOWS_MS, a cold PowerShell on a CI runner) is 10 s by itself.
    const diagT0 = Date.now();
    const opened = await stream.until(frame => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.card?.requestId, 55_000).catch((error: unknown) => {
      // A runner failure must be readable from the job log alone: every frame
      // the stream carried, and the end of the fixture server's own log.
      console.error(`[approval fixture frames]\n${stream.frames.map(frame => JSON.stringify(frame).slice(0, 1500)).join("\n")}`);
      try { console.error(`[fixture server log, last 12000 bytes]\n${readFileSync(fixture.info.logPath, "utf8").slice(-12000)}`); } catch { /* no log yet */ }
      throw error;
    });
    console.error(`[diag] card after ${Date.now() - diagT0}ms ${JSON.stringify(opened.message.card).slice(0, 1200)}`);
    const requestId = opened.message.card.requestId;
    const respond = () => post(`/api/threads/${bot.threadId}/respond`, { requestId, behavior: "allow" });
    const failed = await respond();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: "Your approval could not be delivered. The request is still waiting; please try again." });
    const messages = await (await fetch(fixture.info.url + `/api/threads/${bot.threadId}/messages`, { headers })).json() as { messages: Message[] };
    const pending = messages.messages.find(message => message.card?.requestId === requestId)?.card;
    expect(pending).toBeDefined();
    if (!pending) throw new Error("Missing pending approval card");
    expect(pending.answered).toBeUndefined();
    expect(pending.dismissed).not.toBe(true);
    expect((await respond()).ok).toBe(true);
    const delivered = await (await fetch(fixture.info.url + `/api/threads/${bot.threadId}/messages`, { headers })).json() as { messages: Message[] };
    expect(delivered.messages.find(message => message.card?.requestId === requestId)?.card?.answered).toBe("allow");
  } finally {
    try { console.error(`[diag server]\n${readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => /\[diag\]|approvals:/.test(line)).join("\n")}`); } catch { /* no log yet */ }
    stream.close();
    await fixture.close();
  }
}, 110000);

it.runIf(process.platform === "win32")("diag: PowerShell probe time, real env against the fixture's env", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  const { powerShellEnvProbe } = await import("../../engine-env.ts");
  const ps = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const go = (label: string, env: NodeJS.ProcessEnv, timeout = 60_000) => {
    const start = Date.now();
    const result = spawnSync(ps, ["-NoProfile", "-Command", powerShellEnvProbe("a".repeat(32))], { env, timeout, windowsHide: true, input: "", maxBuffer: 1024 * 1024 });
    console.error(`[diag probe] ${label}: ${Date.now() - start}ms status=${result.status} err=${(result.error as { code?: string } | undefined)?.code ?? ""} out=${result.stdout?.length} stderr=${String(result.stderr).slice(0, 300)}`);
  };
  const fresh = (name: string) => {
    const root = mkdtempSync(join(tmpdir(), `diag-${name}-`));
    mkdirSync(join(root, "tmp"));
    return { SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT, HOME: root, USERPROFILE: root, APPDATA: join(root, "AppData", "Roaming"), LOCALAPPDATA: join(root, "AppData", "Local"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"), PATH: "" } as NodeJS.ProcessEnv;
  };
  go("real env 1", process.env); go("real env 2", process.env);
  const a = fresh("a"); go("fixture env cold", a); go("fixture env warm 2", a); go("fixture env warm 3", a);
  const b = fresh("b"); go("fixture env killed at 10s", b, 10_000); go("fixture env after kill", b);
  const c = fresh("c"); go("fixture env + real LOCALAPPDATA", { ...c, LOCALAPPDATA: process.env.LOCALAPPDATA });
  const d = fresh("d"); go("fixture env + PSModulePath", { ...d, PSModulePath: process.env.PSModulePath });
}, 300_000);
