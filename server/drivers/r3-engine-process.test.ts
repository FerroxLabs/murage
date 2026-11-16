import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { createLedgerLease } from "../ledger-refusal.ts";
import * as procs from "../procs.ts";
import { fixtureBoundTurn } from "../testing/mcp-admission-fixture.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { PiDriver } from "./pi.ts";
import { createAcpDriver } from "./acp/core.ts";
import { writeAcpResponse } from "./acp/approval-delivery.ts";
import { HERMES_BOUND_ASK_HOOK_SOURCE, HERMES_BOUND_ASK_FRAME, hermesAcpSupport } from "./acp/hermes.ts";
import * as native from "./engine-input.ts";

vi.mock("node:child_process", async original => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));
type Engine = "AGY" | "PI" | "HERMES";
let root: string, gate: string, instance: ProviderInstance | undefined;
let f: ReturnType<typeof consumingFixture> | undefined;
let children: ChildProcess[];
let revokedWire: boolean;
let physicalWrites: Array<{ bytes: string; revoked: boolean }>;
type Row = { pid: number; event: string; detail?: any };
const journal = (): Row[] => existsSync(`${gate}.journal`) ? readFileSync(`${gate}.journal`, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
function consumingAnswer(bytes: string): boolean {
  if (bytes === "late-1" || bytes === "late-2") return true;
  try {
    const frame = JSON.parse(bytes);
    return frame.code === "allow" || frame.decision === "allow"
      || frame.value === '{"code":"allow"}' || frame.result?.outcome?.optionId === "allow-once";
  } catch { return false; }
}
beforeEach(() => {
  ensureDirs();
  root = mkdtempSync(join(tmpdir(), "r3-engines-"));
  gate = join(root, "accept");
  mkdirSync(join(root, "home")); mkdirSync(join(root, "work"));
  writeFileSync(join(root, "work", "ordinary.txt"), "ordinary\n");
  children = [];
  revokedWire = false; physicalWrites = [];
  const socketWrite = Socket.prototype.write;
  vi.spyOn(Socket.prototype, "write").mockImplementation(function (this: Socket, ...args: any[]) {
    physicalWrites.push({ bytes: String(args[0]), revoked: revokedWire });
    return Reflect.apply(socketWrite, this, args);
  });
  const spawn = procs.spawnCli;
  vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
    const child = spawn(...args); children.push(child);
    if (child.stdin && !(child.stdin instanceof Socket)) {
      const write = child.stdin.write;
      vi.spyOn(child.stdin, "write").mockImplementation(function (...values: any[]) {
        physicalWrites.push({ bytes: String(values[0]), revoked: revokedWire });
        return Reflect.apply(write, child.stdin, values);
      });
    }
    return child;
  });
  vi.stubEnv("FAKE_R3_BARRIER", gate);
  vi.stubEnv("MURAGE_ACP_POOL", "0");
});
afterEach(async () => {
  // Unblock on assertion failure before disposing the exact fixture instance.
  writeFileSync(`${gate}.release`, "cleanup");
  try { await instance?.dispose(); }
  finally {
    instance = undefined;
    for (const child of children) if (child.exitCode === null && child.signalCode === null) procs.killCliTree(child);
    f?.close(); f = undefined;
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await removeTempDir(root);
  }
});
async function create(engine: Engine) {
  const file = engine === "AGY" ? "fake-agy-cli.ts" : engine === "PI" ? "fake-pi-cli.ts" : "fake-acp-cli.ts";
  const cli = fileURLToPath(new URL(`../testing/${file}`, import.meta.url)); chmodSync(cli, 0o755);
  vi.stubEnv("FAKE_AGY_RUN_HOOKS", "1");
  vi.stubEnv("FAKE_PI_MODE", "gate");
  vi.stubEnv("FAKE_PI_GATE_CALL", JSON.stringify({ tool: "read", input: { path: join(root, "work", "ordinary.txt") } }));
  vi.stubEnv("FAKE_R3_HERMES_HOOK", HERMES_BOUND_ASK_HOOK_SOURCE);
  const driver = engine === "AGY" ? AntigravityDriver : engine === "PI" ? PiDriver : createAcpDriver({
    driverKind: "hermesAgent", fluxReach: () => "elsewhere", displayName: "R3 Hermes", defaultCli: cli, nativeSource: "r3.hermes",
    models: { default: "", options: [] }, loginNote: "fixture", spawnArgs: () => [],
    pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
    normalizeAsk: hermesAcpSupport.normalizeAsk,
  });
  instance = await driver.create({ instanceId: `r3-${engine}`, displayName: engine, enabled: true,
    environment: { HOME: join(root, "home") }, config: { cli, fullAuto: true } });
  return recordEvents(instance.adapter);
}

describe("R3 real engine acceptance windows", () => {
  for (const engine of ["AGY", "PI", "HERMES"] as const) {
    for (const boundary of ["REVOKE-WINDOW", "LATE-OUTPUT-AFTER-STOP"] as const) {
    for (const revoke of [true, false]) {
      it(`T-R3-${engine}-${boundary}${revoke ? "" : "-CONTROL"}`, async () => {
        vi.stubEnv("FAKE_R3_REVOKE", revoke ? "1" : "0");
        const records = await create(engine);
        const threadId = `r3-${engine}`;
        let lease: ReturnType<typeof createLedgerLease>;
        f = consumingFixture(undefined, { threadId, onRefused: verdict => lease.onLedgerRefused(verdict) });
        const interrupt = vi.fn(async (turnId: string) => {
          const stopped = instance!.adapter.interruptTurn(threadId, turnId);
          // interruptTurn synchronously requests Stop before its first await.
          writeFileSync(`${gate}.release`, "revoked");
          const result = await stopped;
          return result?.closeConfirmed === true;
        });
        const quarantine = vi.fn(), settle = vi.fn();
        lease = createLedgerLease(f.binding.identity, { seal: f.replace, interrupt, settle, present: vi.fn(), quarantine });
        let attachedEarly = false;
        instance!.adapter.onEvent(e => { if (e.type === "turn.started" && e.threadId === threadId && !attachedEarly) { attachedEarly = true; lease.attach(e.turnId!); } });
        const writes: Array<{ sink: string; bytes: string; revoked: boolean }> = [];
        let revoked = false;
        const release = native.releaseNativeAnswer;
        vi.spyOn(native, "releaseNativeAnswer").mockImplementation((binding, sink, bytes, write) =>
          release(binding, sink, bytes, () => { writes.push({ sink, bytes, revoked }); return write(); }));
        const sent = await instance!.adapter.sendTurn(fixtureBoundTurn({ threadId, text: "hello", cwd: join(root, "work"),
          releaseBinding: f.binding, askLevel: engine === "AGY" ? (true as const) : undefined, routeAsks: true }));
        if (!attachedEarly) lease.attach(sent.turnId);
        if (engine === "PI") {
          const opened = await records.until(e => e.type === "request.opened" && e.requestId === "ask-host");
          if (opened.type !== "request.opened") throw Error("missing Pi card");
          await instance!.adapter.respondToRequest(threadId, opened.requestId!, { behavior: "allow" });
        }
        await expect.poll(() => existsSync(`${gate}.waiting`)).toBe(true);
        const pid = Number(readFileSync(`${gate}.waiting`, "utf8"));
        const child = children.find(child => child.pid === pid)!;
        expect(child, "barrier belongs to the adapter's original engine process").toBeDefined();
        expect(child.exitCode).toBeNull();
        expect(journal().filter(row => row.event === "accepted")).toEqual([]);
        const receipt = journal().find(row => row.event === "received")!;
        if (engine === "AGY") expect(JSON.parse(receipt.detail)).toEqual({ decision: "allow" });
        else if (engine === "PI") expect(receipt.detail.value).toBe('{"code":"allow"}');
        else expect(receipt.detail).toBe(HERMES_BOUND_ASK_FRAME);
        const sink = engine === "AGY" ? "codex:hook-socket" : engine === "PI" ? "pi:answer" : "acp:approval";
        const laterWrite = vi.fn();
        const beforeRevoke = records.events.length;
        if (revoke) {
          revoked = true; revokedWire = true;
          if (boundary === "REVOKE-WINDOW") {
            f.flip();
            // Demand a new release to run the real retained-ledger refusal path.
            expect(() => native.releaseNativeAnswer(f!.binding, sink, "late-1", laterWrite)).toThrow("MEMORY_CONTEXT_REVOKED");
            expect(() => native.releaseNativeAnswer(f!.binding, sink, "late-2", laterWrite)).toThrow("MEMORY_CONTEXT_REVOKED");
            expect(laterWrite).not.toHaveBeenCalled();
            if (engine === "HERMES") {
              for (const id of [9391, 9392]) {
                const done = vi.fn();
                writeAcpResponse(child.stdin, { jsonrpc: "2.0", id,
                  result: { outcome: { outcome: "selected", optionId: "allow-once" } } }, done, undefined, f.binding);
                expect(done).toHaveBeenCalledWith(expect.objectContaining({ code: "MEMORY_CONTEXT_REVOKED" }), false);
              }
            }
            await lease.teardownConfirmed;
            expect(lease.state).toBe("settled");
            expect(settle).toHaveBeenCalledWith("memory-refused", expect.any(Object));
          } else expect(await interrupt(sent.turnId)).toBe(true);
          expect(interrupt).toHaveBeenCalledExactlyOnceWith(sent.turnId);
        } else {
          writeFileSync(`${gate}.release`, "control");
          if (engine === "HERMES") {
            const opened = await records.until(e => e.type === "request.opened");
            if (opened.type !== "request.opened") throw Error("missing card");
            await instance!.adapter.respondToRequest(threadId, opened.requestId!, { behavior: "allow" });
          }
        }
        await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
        await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: procs.CLI_TERM_GRACE_MS + 5000 }).toBe(true);
        expect(journal().filter(row => row.event === "output-attempt")).toHaveLength(1);
        expect(journal().every(row => row.pid === pid)).toBe(true);
        if (engine !== "AGY") expect(journal().filter(row => row.event === "callback-attempt")).toHaveLength(2);
        if (revoke) {
          expect(JSON.stringify(records.events)).not.toContain("R3-LATE-OUTPUT");
          expect(writes.filter(row => row.revoked && consumingAnswer(row.bytes))).toEqual([]);
          expect(physicalWrites.filter(row => row.revoked && consumingAnswer(row.bytes))).toEqual([]);
          expect(journal().filter(row => row.event === "tool-ran")).toHaveLength(engine === "HERMES" ? 0 : 1);
          expect(records.events.slice(beforeRevoke).filter(e => e.type === "request.opened").length).toBeLessThanOrEqual(engine === "HERMES" ? 1 : 0);
          if (engine === "AGY") {
            const callbacks = journal().filter(row => row.event === "callback");
            expect(callbacks).toHaveLength(2);
            expect(callbacks.every(row => !String(row.detail).includes('"decision":"allow"'))).toBe(true);
          }
        } else {
          expect(JSON.stringify(records.events)).toContain("R3-LATE-OUTPUT");
          expect(interrupt).not.toHaveBeenCalled();
          expect(f.refusals).toBe(0);
          expect(journal().filter(row => row.event === "tool-ran")).toHaveLength(1);
        }
        expect(quarantine).not.toHaveBeenCalled();
      }, 30_000);
    }
    }
  }

  for (const scenario of ["AFTER-REVOKE", "AFTER-REVOKE-CONTROL", "PASSTHROUGH-CONTROL"] as const) {
    it(`T-R3-PI-FILTER-${scenario}`, async () => {
      const passthrough = scenario === "PASSTHROUGH-CONTROL";
      vi.stubEnv("FAKE_R3_FILTER", passthrough ? "passthrough" : "partial");
      const records = await create("PI");
      // Hold only the stop's scheduling, not its result: run the already queued
      // in-process callback before the adapter's abort/kill reaches the child.
      let lease: ReturnType<typeof createLedgerLease>;
      let releaseStop!: () => void;
      const callbackFinished = new Promise<void>(resolve => { releaseStop = resolve; });
      f = consumingFixture(undefined, { threadId: "r3-filter", onRefused: verdict => lease.onLedgerRefused(verdict) });
      lease = createLedgerLease(f.binding.identity, { seal: f.replace, settle: vi.fn(), present: vi.fn(), quarantine: vi.fn(),
        interrupt: async id => { await callbackFinished; return (await instance!.adapter.interruptTurn("r3-filter", id))?.closeConfirmed === true; } });
      let attachedEarly = false;
      instance!.adapter.onEvent(e => { if (e.type === "turn.started" && e.threadId === "r3-filter" && !attachedEarly) { attachedEarly = true; lease.attach(e.turnId!); } });
      const sent = await instance!.adapter.sendTurn(fixtureBoundTurn({ threadId: "r3-filter", cwd: join(root, "work"), text: "hello", releaseBinding: f.binding }));
      if (!attachedEarly) lease.attach(sent.turnId);
      try {
        const opened = await records.until(e => e.type === "request.opened" && e.requestId === "ask-host");
        if (opened.type !== "request.opened") throw Error("missing Pi card");
        await instance!.adapter.respondToRequest("r3-filter", opened.requestId!, { behavior: "allow" });
        await expect.poll(() => existsSync(`${gate}.waiting`)).toBe(true);
        const pid = Number(readFileSync(`${gate}.waiting`, "utf8"));
        const child = children.find(child => child.pid === pid)!;
        expect(child).toBeDefined();
        let statusAtExit: string | undefined;
        child.once("exit", () => {
          const status = journal().find(row => row.event === "filter-enter")?.detail?.status;
          if (status && existsSync(status)) statusAtExit = readFileSync(status, "utf8");
        });
        if (scenario === "AFTER-REVOKE") {
          f.flip();
          expect(() => native.releaseNativeAnswer(f!.binding, "pi:answer", "late", vi.fn())).toThrow("MEMORY_CONTEXT_REVOKED");
        }
        writeFileSync(`${gate}.release`, "invoke original callback");
        await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
        const entered = journal().find(row => row.event === "filter-enter")!;
        expect(entered.pid).toBe(pid);
        if (passthrough) {
          expect(existsSync(`${gate}.accepted`)).toBe(true);
          expect(journal().filter(row => row.event === "filter-return")).toHaveLength(1);
        } else {
          expect(child.signalCode).toBe("SIGKILL");
          expect(statusAtExit).toBe("refuse.pi.filter");
          expect(existsSync(`${gate}.accepted`)).toBe(false);
          expect(journal().filter(row => row.event === "filter-return" || row.event === "output-attempt")).toEqual([]);
          expect(JSON.stringify(records.events)).not.toContain(".env");
        }
      } finally { releaseStop(); }
      const completed = await records.until(e => e.type === "turn.completed" && e.turnId === sent.turnId);
      expect(completed).toMatchObject(passthrough ? { ok: true } : { ok: false, stopReason: "memory-refused" });
    }, 30_000);
  }
});
