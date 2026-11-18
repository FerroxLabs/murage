import { useOutsideStoreFixture } from "../../testing/outside-store-fixture.ts";
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
import { ApprovalDeliveryError, ApprovalNoLongerOpenError, denyAutomaticApproval, watchApprovalRequest } from "./approval-delivery.ts";

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
  pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true, fluxReach: () => "elsewhere" as const
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

  const repeatedPeer = async (twice: "1" | "replay", identified: boolean | object = false, nextCall?: object) => {
    recorder.stop();
    await instance.dispose();
    instance = await createAcpDriver(SUPPORT).create({
      instanceId: "approval-108", displayName: "Approval fixture", enabled: true,
      environment: { FAKE_ACP_MODE: "permission", FAKE_ACP_PERMISSION_TWICE: twice,
        ...(identified ? { FAKE_ACP_PERMISSION_TOOLCALL: JSON.stringify(typeof identified === "object" ? identified : { toolCallId: "macro-call-1", kind: "execute", title: "echo hi", rawInput: { command: "echo hi" } }) } : {}),
        ...(nextCall ? { FAKE_ACP_PERMISSION_TOOLCALL_NEXT: JSON.stringify(nextCall) } : {}),
      },
      config: { cli: process.execPath, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  it.each(["allow", "deny"] as const)("GH-19: a replay after delivered %s stops visibly without a second card or native answer", async behavior => {
    await repeatedPeer("replay");
    const requestId = await open();
    expect(await instance.adapter.respondToRequest(threadId, requestId, { behavior })).toBe(behavior === "allow" ? "allowed-once" : "rejected");
    const ending = await recorder.until(e => e.type === "turn.completed" || (e.type === "request.opened" && e.requestId !== requestId));
    expect(ending).toMatchObject({ type: "turn.completed", ok: false, stopReason: "approval_request_replayed" });
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(1);
    expect(recorder.events.some(e => e.type === "runtime.error" && e.message.includes("already answered"))).toBe(true);
    expect(resolved()).toHaveLength(1);
    expect(resolved()[0]).toMatchObject({ behavior, source: "user" });
    expect(peer.responses).toHaveLength(1);
    expect(await answer(requestId)).toBe("unavailable");
  });

  it("GH-19: the same command with a new native id still needs its own Allow", async () => {
    await repeatedPeer("1");
    const first = await open();
    expect(await answer(first)).toBe("allowed-once");
    const next = await recorder.until(e => e.type === "request.opened" && e.requestId !== first);
    if (next.type !== "request.opened" || !next.requestId) throw new Error("Missing second approval");
    expect(peer.responses).toHaveLength(1);
    expect(resolved()).toHaveLength(1);
    expect(await answer(first)).toBe("unavailable");
    expect(await answer(next.requestId)).toBe("allowed-once");
    expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(peer.responses).toHaveLength(2);
    expect(peer.responses.map(response => response.id)).toEqual([9001, 9002]);
  });

  it("GH-19: an answered tool call cannot reopen under a new RPC id", async () => {
    await repeatedPeer("1", true);
    const requestId = await open();
    expect(await answer(requestId)).toBe("allowed-once");
    const ending = await recorder.until(e => e.type === "turn.completed" || (e.type === "request.opened" && e.requestId !== requestId));
    expect(ending).toMatchObject({ type: "turn.completed", ok: false, stopReason: "approval_request_replayed" });
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(1);
    expect(peer.responses).toHaveLength(1);
  });

  // OpenCode asks twice inside one tool call (external_directory, then bash or
  // edit) under the same toolCallId and a new RPC id. That second, different ask
  // is not a replay: it opens its own card and the turn goes on after its Allow.
  it("GH-19: a different ask under an answered toolCallId opens its own card and the turn continues", async () => {
    await repeatedPeer("1", true, { toolCallId: "macro-call-1", kind: "execute", title: "printf next", rawInput: { command: "printf next" } });
    const first = await open();
    expect(await answer(first)).toBe("allowed-once");
    const next = await recorder.until(e => e.type === "turn.completed" || (e.type === "request.opened" && e.requestId !== first));
    expect(next).toMatchObject({ type: "request.opened" });
    if (next.type !== "request.opened" || !next.requestId) throw new Error("Missing second ask's approval");
    expect(next.summary).toContain("printf next");
    expect(recorder.events.some(e => e.type === "runtime.error")).toBe(false);
    expect(await answer(next.requestId)).toBe("allowed-once");
    expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(2);
    expect(resolved()).toHaveLength(2);
    expect(peer.responses.map(response => response.id)).toEqual([9001, 9002]);
  });

  it("GH-19: a different ask under a toolCallId whose card is still open opens its own card", async () => {
    await repeatedPeer("1", true);
    const first = await open();
    const write = vi.spyOn(peer.child!.stdin, "write").mockImplementation(((_chunk: unknown, done?: (error?: Error | null) => void) => {
      queueMicrotask(() => done?.(null));
      return true;
    }) as Writable["write"]);
    const other = JSON.parse(peer.request);
    other.id = 9050;
    other.params.toolCall = { ...other.params.toolCall, title: "printf other", rawInput: { command: "printf other" } };
    peer.child!.stdout.emit("data", Buffer.from(JSON.stringify(other) + "\n"));
    const next = await recorder.until(e => e.type === "turn.completed" || (e.type === "request.opened" && e.requestId !== first));
    expect(next).toMatchObject({ type: "request.opened" });
    if (next.type !== "request.opened" || !next.requestId) throw new Error("Missing second ask's approval");
    expect(await answer(next.requestId)).toBe("allowed-once");
    expect(await answer(first)).toBe("allowed-once");
    expect(resolved()).toHaveLength(2);
    expect(write.mock.calls.map(([chunk]) => JSON.parse(String(chunk))).filter(m => m.result?.outcome).map(m => m.id)).toEqual([9050, 9001]);
    peer.child!.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: peer.promptId, result: { stopReason: "end_turn" } }) + "\n"));
    expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  // The pair OpenCode's ACP layer builds for one bash call outside the bot's
  // folder: title = the permission name, rawInput = its metadata, one shared
  // toolCallId (shape written from OpenCode's source, not a captured trace).
  it("GH-19: an OpenCode external_directory ask then its bash ask under one toolCallId are two cards and one ok turn", async () => {
    await repeatedPeer("1",
      { toolCallId: "call_fixture_1", status: "pending", title: "external_directory", kind: "other", rawInput: { filepath: "/fixture-outside/notes.txt", parentDir: "/fixture-outside" }, locations: [] },
      { toolCallId: "call_fixture_1", status: "pending", title: "bash", kind: "execute", rawInput: { command: "ls /fixture-outside" }, locations: [] });
    const first = await open();
    expect(await answer(first)).toBe("allowed-once");
    const next = await recorder.until(e => e.type === "turn.completed" || (e.type === "request.opened" && e.requestId !== first));
    expect(next).toMatchObject({ type: "request.opened" });
    if (next.type !== "request.opened" || !next.requestId) throw new Error("Missing the bash ask's approval");
    expect(await answer(next.requestId)).toBe("allowed-once");
    expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(recorder.events.some(e => e.type === "runtime.error")).toBe(false);
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(2);
    expect(resolved().map(e => e.type === "request.resolved" && e.behavior)).toEqual(["allow", "allow"]);
    expect(peer.responses.map(response => response.id)).toEqual([9001, 9002]);
  });

  // Letting a second, different ask through must not forget the first: after
  // both asks of one tool call are answered, a repeat of either is still a replay.
  it.each(["first", "second"] as const)("GH-19: after two different answered asks under one toolCallId, a replay of the %s is still blocked", async which => {
    await repeatedPeer("1", true);
    const first = await open();
    const write = vi.spyOn(peer.child!.stdin, "write").mockImplementation(((_chunk: unknown, done?: (error?: Error | null) => void) => {
      queueMicrotask(() => done?.(null));
      return true;
    }) as Writable["write"]);
    const answersSent = () => write.mock.calls.map(([chunk]) => JSON.parse(String(chunk))).filter(m => m.result?.outcome).map(m => m.id);
    expect(await answer(first)).toBe("allowed-once");
    const firstAsk = JSON.parse(peer.request);
    const secondAsk = JSON.parse(peer.request);
    secondAsk.id = 9050;
    secondAsk.params.toolCall = { ...secondAsk.params.toolCall, title: "printf other", rawInput: { command: "printf other" } };
    peer.child!.stdout.emit("data", Buffer.from(JSON.stringify(secondAsk) + "\n"));
    const second = await recorder.until(e => e.type === "turn.completed" || (e.type === "request.opened" && e.requestId !== first));
    expect(second).toMatchObject({ type: "request.opened" });
    if (second.type !== "request.opened" || !second.requestId) throw new Error("Missing second ask's approval");
    expect(await answer(second.requestId)).toBe("allowed-once");
    expect(answersSent()).toEqual([9001, 9050]);
    const replay = which === "first" ? firstAsk : secondAsk;
    replay.id = 9060;
    peer.child!.stdout.emit("data", Buffer.from(JSON.stringify(replay) + "\n"));
    const ending = await recorder.until(e => e.type === "turn.completed" || (e.type === "request.opened" && e.requestId !== first && e.requestId !== second.requestId));
    expect(ending).toMatchObject({ type: "turn.completed", ok: false, stopReason: "approval_request_replayed" });
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(2);
    expect(recorder.events.some(e => e.type === "runtime.error" && e.message.includes("already answered"))).toBe(true);
    expect(resolved()).toHaveLength(2);
    expect(answersSent()).toEqual([9001, 9050]);
  });

  it("GH-19: a different tool call can reuse an answered RPC id but still needs its own Allow", async () => {
    await repeatedPeer("1", true);
    const first = await open();
    const write = vi.spyOn(peer.child!.stdin, "write").mockImplementation(((_chunk: unknown, done?: (error?: Error | null) => void) => {
      queueMicrotask(() => done?.(null));
      return true;
    }) as Writable["write"]);
    expect(await answer(first)).toBe("allowed-once");
    const nextCall = JSON.parse(peer.request);
    nextCall.params.toolCall.toolCallId = "macro-call-2";
    peer.child!.stdout.emit("data", Buffer.from(JSON.stringify(nextCall) + "\n"));
    const next = await recorder.until(e => e.type === "request.opened" && e.requestId !== first);
    if (next.type !== "request.opened" || !next.requestId) throw new Error("Missing next call's approval");
    expect(resolved()).toHaveLength(1);
    expect(await answer(next.requestId)).toBe("allowed-once");
    expect(resolved()).toHaveLength(2);
    expect(write.mock.calls.filter(([chunk]) => JSON.parse(String(chunk)).result?.outcome)).toHaveLength(2);
    peer.child!.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: peer.promptId, result: { stopReason: "end_turn" } }) + "\n"));
    expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true });
  });

  it("GH-19: a duplicate while Allow is in flight neither opens a card nor sends a second answer", async () => {
    const requestId = await open();
    peer.mode = "hold"; peer.failures = 1;
    const allowed = answer(requestId);
    repeat();
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(1);
    expect(peer.responses).toHaveLength(1);
    expect(resolved()).toEqual([]);
    peer.late!();
    expect(await allowed).toBe("allowed-once");
    expect(await recorder.until(e => e.type === "turn.completed")).toMatchObject({ ok: true });
    expect(peer.responses).toHaveLength(1);
  });

  it("GH-19: the same tool call under a new RPC id cannot open another card while Allow is in flight", async () => {
    await repeatedPeer("1", true);
    const requestId = await open();
    peer.mode = "hold"; peer.failures = 1;
    const allowed = answer(requestId).catch(error => error);
    const duplicate = JSON.parse(peer.request);
    duplicate.id = 9002;
    peer.child!.stdout.emit("data", Buffer.from(JSON.stringify(duplicate) + "\n"));
    const ending = await recorder.until(e => e.type === "turn.completed" || (e.type === "request.opened" && e.requestId !== requestId));
    expect(ending).toMatchObject({ type: "turn.completed", ok: false, stopReason: "approval_request_conflict" });
    expect(await allowed).toMatchObject({ terminal: true });
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(1);
    expect(peer.responses).toHaveLength(1);
    expect(resolved()).toEqual([]);
  });

  it("GH-19: an answered id reused for changed arguments cannot obtain another approval", async () => {
    const requestId = await open();
    // Acknowledge transport delivery but keep the fixture peer from ending the
    // turn, then inject the conflicting request after that delivery has settled.
    const write = vi.spyOn(peer.child!.stdin, "write").mockImplementation(((_chunk: unknown, done: (error?: Error | null) => void) => {
      queueMicrotask(() => done(null));
      return true;
    }) as Writable["write"]);
    expect(await answer(requestId)).toBe("allowed-once");
    const conflicting = JSON.parse(peer.request);
    conflicting.params.toolCall.rawInput = { command: "different command" };
    peer.child!.stdout.emit("data", Buffer.from(JSON.stringify(conflicting) + "\n"));
    const ending = await recorder.until(e => e.type === "turn.completed" || (e.type === "request.opened" && e.requestId !== requestId));
    expect(ending).toMatchObject({ type: "turn.completed", ok: false, stopReason: "approval_request_conflict" });
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(1);
    expect(write.mock.calls.filter(([chunk]) => JSON.parse(String(chunk)).result?.outcome)).toHaveLength(1);
  });

  it("R1 synchronous write throws are terminal and never duplicate the card or grant", async () => {
    const requestId = await open();
    peer.mode = "throw"; peer.failures = 3;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = answer(requestId).catch(error => error);
    repeat();
    expect(await failure).toMatchObject({ status: 503, reason: "EPIPE", terminal: true });
    await recorder.until(e => e.type === "turn.completed" && !e.ok);
    expect(peer.attempts).toBe(1); expect(peer.delivered).toBe(0);
    expect(resolved()).toEqual([]);
    expect(await answer(requestId)).toBe("unavailable");
    expect(recorder.events.filter(e => e.type === "request.opened")).toHaveLength(1);
    expect(warning.mock.calls.filter(([line]) => String(line).startsWith("acp approval delivery")))
      .toEqual([[`acp approval delivery thread=${threadId} request=${requestId} error=EPIPE`]]);
  });

  it("R1 concurrent answers share an uncertain write failure without retry", async () => {
    const requestId = await open();
    peer.mode = "throw"; peer.failures = 1;
    const first = answer(requestId).catch(error => error);
    const second = answer(requestId).catch(error => error);
    repeat();
    for (const failure of await Promise.all([first, second])) expect(failure).toMatchObject({ reason: "EPIPE", terminal: true });
    expect(peer.attempts).toBe(1); expect(peer.delivered).toBe(0);
    expect(resolved()).toEqual([]);
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

  it("R1 Deny cannot contradict an Allow whose synchronous write threw", async () => {
    const requestId = await open();
    peer.mode = "throw"; peer.failures = 1;
    const allowed = answer(requestId).catch(error => error);
    await Promise.resolve();
    const denied = await instance.adapter.respondToRequest(threadId, requestId, { behavior: "deny" }).catch(error => error);
    expect(denied).toMatchObject({ terminal: true });
    expect(await allowed).toBeInstanceOf(ApprovalDeliveryError);
    expect(peer.responses).toHaveLength(1); expect(peer.delivered).toBe(0);
    expect(resolved()).toEqual([]);
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
    // The terminal write failure already ended this turn; the helper must
    // neither send a second denial nor stop a later turn.
    expect(notice).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
    expect(peer.attempts).toBe(1);
    expect(recorder.events.some(e => e.type === "item.started" && e.title === "The engine stopped before approval delivery could be confirmed.")).toBe(true);
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

  // GROK-STOPPED F1/F4 (1.0.10): a permission card has no deadline. Fake timers cross the old 15-minute
  // bound and a day more; a restored deny timer of any length up to that resolves the request and fails here.
  // Astra r2 F4: the fake clock is installed BEFORE the request opens, so a deny timer armed while it opens is a
  // fake one and fires here. shouldAdvanceTime lets the real process start-up run on the fake clock.
  it("an unanswered card survives past 15 minutes and a day on fake timers, then the owner's Allow lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    let requestId = "";
    try {
      requestId = await open();
      await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(resolved()).toEqual([]);
      expect(peer.responses).toHaveLength(0);
    } finally { vi.useRealTimers(); }
    expect(await answer(requestId)).toBe("allowed-once");
    expect(peer.responses).toHaveLength(1);
    expect(resolved()[0]).toMatchObject({ behavior: "allow", source: "user" });
    await recorder.until(e => e.type === "turn.completed");
  });

  it("Stop during Allow backoff ends the retries without a second Allow", async () => {
    const requestId = await open();
    peer.mode = "throw"; peer.failures = 1;
    const allowed = answer(requestId).catch(error => error);
    await Promise.resolve();
    await instance.adapter.interruptTurn(threadId);
    expect(await allowed).toBeInstanceOf(Error);
    await recorder.until(e => e.type === "turn.completed");
    expect(peer.responses.filter(r => (r.result as { outcome?: { optionId?: string } }).outcome?.optionId === "allow-once")).toHaveLength(1);
  });

  it("a Deny racing an accepted write error never contradicts the uncertain Allow", async () => {
    const requestId = await open();
    peer.mode = "hold-error"; peer.failures = 1;
    const allowed = answer(requestId).catch(error => error);
    const denied = instance.adapter.respondToRequest(threadId, requestId, { behavior: "deny" }).catch(error => error);
    peer.late!();
    expect(await allowed).toMatchObject({ terminal: true });
    await denied;
    await recorder.until(e => e.type === "turn.completed" && !e.ok);
    expect(peer.responses).toHaveLength(1);
    expect(resolved()).toEqual([]);
  });

  it("R1 a synchronous Deny write throw ends the card without resending", async () => {
    const requestId = await open();
    peer.mode = "throw"; peer.failures = 3;
    await expect(instance.adapter.respondToRequest(threadId, requestId, { behavior: "deny" }))
      .rejects.toMatchObject({ reason: "EPIPE", terminal: true });
    await recorder.until(e => e.type === "turn.completed" && !e.ok);
    expect(resolved()).toEqual([]); expect(peer.attempts).toBe(1);
    expect(await instance.adapter.respondToRequest(threadId, requestId, { behavior: "deny" })).toBe("unavailable");
  });

  it("Stop with a still uncertain Allow ends the turn without another response", async () => {
    const requestId = await open();
    peer.mode = "hold"; peer.failures = 1;
    await expect(answer(requestId)).rejects.toMatchObject({ reason: "delivery_pending" });
    await instance.adapter.interruptTurn(threadId);
    await recorder.until(e => e.type === "turn.completed");
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
  // OpenMausBot b873f461e (#1170): an engine that answers `unavailable` no longer holds the ask, so a card could never be answered.
  it("never falls back to a card for an ask the engine no longer holds, even while the request looks live", () => {
    const request = watchApprovalRequest(opened, () => () => {});
    expect(request.live()).toBe(true);
    expect(request.canFallback(new ApprovalNoLongerOpenError())).toBe(false);
    // a write that failed before the engine took it still hands the ask to the owner
    expect(request.canFallback(new ApprovalDeliveryError("EPIPE", false))).toBe(true);
    request.dispose();
  });
});

it("the real approval API returns 503 and records terminal failed delivery without a retry or grant", async () => {
  // Patch only this isolated server child's fake-engine transport and config.
  const instrumentationSource = `
    // The server child does not inherit the Vitest worker's in-memory hook.
    // Use the same test-only seam so this transport fixture needs no shipped bwrap.
    process.env.NODE_ENV = 'test';
    globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
    const awaitFs = await import('node:fs');
    const cp = (await import('node:child_process')).default;
    const spawn = cp.spawn;
    cp.spawn = function(command, args, options) {
      const child = spawn(command, args, options);
      if (!args?.includes(${JSON.stringify(FAKE_CLI)})) return child;
      const write = child.stdin.write.bind(child.stdin);
      let failures = 3;
      const fs = awaitFs;
      child.stdin.write = function(chunk, done) {
        // Only JSON-RPC lines are the peer's; on Windows the job launcher's own
        // start frame goes down the same stdin first and must pass untouched.
        let message;
        try { message = JSON.parse(String(chunk)); } catch { return write(chunk, done); }
        if (message.result?.outcome) fs.appendFileSync(process.env.MURAGE_DATA_DIR+'/outcome-writes.jsonl',JSON.stringify({phase:'attempt'})+'\\n');
        if (message.result?.outcome && failures-- > 0) {
          throw Object.assign(new Error('fixture write failure'), { code: 'EPIPE' });
        }
        if(message.result?.outcome?.outcome==='selected')fs.appendFileSync(process.env.MURAGE_DATA_DIR+'/outcome-writes.jsonl',JSON.stringify({phase:'grant'})+'\\n');
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
      pickAuthMethod: () => null, authFailure: 'continue', isAuthenticated: () => true,
      fluxReach: () => 'elsewhere'
    }));
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR, 'config.json'), JSON.stringify({ instances: {
      approval: { driver: 'approvalDelivery108', environment: { FAKE_ACP_MODE: 'permission-edit-file' }, config: { cli: process.execPath, fullAuto: false } }
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
    // A file edit, not a command: a command's card waits for the shell environment
    // check, and PowerShell in this fixture's bare environment outlasts both Windows
    // budgets (10 s + 30 s, against 0.5 s on a real one). Delivery is the same for both.
    // MAIN RULING INT-CONFLICT-DEFAULT a2a2ea007c 9537dc8215: the reviewed display card exposes a host requestHandle; retain every native R1 delivery assertion.
    const opened = await stream.until(frame => frame.kind === "message" && frame.threadId === bot.threadId && frame.message?.card?.requestHandle, 30_000).catch((error: unknown) => {
      // A runner failure must be readable from the job log alone: every frame
      // the stream carried, and the end of the fixture server's own log.
      console.error(`[approval fixture frames]\n${stream.frames.map(frame => JSON.stringify(frame).slice(0, 1500)).join("\n")}`);
      try { console.error(`[fixture server log, last 12000 bytes]\n${readFileSync(fixture.info.logPath, "utf8").slice(-12000)}`); } catch { /* no log yet */ }
      throw error;
    });
    const requestHandle = opened.message.card.requestHandle;
    const messageId = opened.message.id;
    expect(requestHandle).toBe(`p.${messageId}`);
    expect(opened.message.card.requestId).toBeUndefined();
    const respond = () => post(`/api/threads/${bot.threadId}/respond`, { requestHandle, action: "allow" });
    const failed = await respond();
    expect(failed.status).toBe(503);
    // MAIN RULING 2026-11-14 R1: synchronous write throw is terminal; retry premise (1d0085e067) superseded
    expect(await failed.json()).toMatchObject({ error: expect.stringMatching(/could not be delivered|delivery/i) });
    const messages = await (await fetch(fixture.info.url + `/api/threads/${bot.threadId}/messages`, { headers })).json() as { messages: Message[] };
    const pending = messages.messages.find(message => message.id === messageId)?.card;
    expect(pending).toBeDefined();
    if (!pending) throw new Error("Missing pending approval card");
    // MAIN RULING 2026-11-14 R1: synchronous write throw is terminal; retry premise (1d0085e067) superseded
    expect(pending.answered).toMatch(/could not be delivered/);
    // MAIN RULING 2026-11-14 R1: synchronous write throw is terminal; retry premise (1d0085e067) superseded
    expect(pending.dismissed).toBe(true);
    // MAIN RULING 2026-11-14 R1: synchronous write throw is terminal; retry premise (1d0085e067) superseded
    expect((await respond()).ok).toBe(false);
    const delivered = await (await fetch(fixture.info.url + `/api/threads/${bot.threadId}/messages`, { headers })).json() as { messages: Message[] };
    // MAIN RULING INT-CONFLICT-DEFAULT a2a2ea007c 9537dc8215: find the same durable card by host message id, preserving the terminal failed-delivery assertion.
    // MAIN RULING 2026-11-14 R1: synchronous write throw is terminal; retry premise (1d0085e067) superseded
    expect(delivered.messages.find(message => message.id === messageId)?.card?.answered).toMatch(/could not be delivered/);
    const outcomes = readFileSync(join(fixture.info.dataDir, "outcome-writes.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(outcomes.filter(row => row.phase === "attempt")).toHaveLength(1);
    expect(outcomes.filter(row => row.phase === "grant")).toHaveLength(0);
  } finally {
    stream.close();
    await fixture.close();
  }
}, 60000);

// Adapter turns in this suite use an isolated durable store.
useOutsideStoreFixture();


it("R1 a proven pre-entry miss may retry before one concrete approval write", async () => {
  const { Writable } = await import("node:stream");
  const { deliverApproval, writeAcpResponse } = await import("./approval-delivery.ts");
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _encoding, done) { chunks.push(String(chunk)); done(); } });
  let preparations = 0;
  const result = await deliverApproval(done => {
    if (++preparations === 1) done(Object.assign(new Error("preparation failed"), { code: "EPIPE" }), false);
    else writeAcpResponse(stream, { jsonrpc: "2.0", id: 1, result: { outcome: { outcome: "selected", optionId: "allow-once" } } }, done);
  }, () => true, new AbortController().signal);
  expect(result).toEqual({ ok: true });
  expect(preparations).toBe(2); expect(chunks).toHaveLength(1);
  stream.destroy();
});
