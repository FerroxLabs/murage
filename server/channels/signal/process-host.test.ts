// @ts-expect-error Synthetic ESM runtime pin helper.
import { pinSyntheticTree } from "../../../scripts/fixtures/signal-runtime-tree.mjs";
// @ts-expect-error Synthetic test evidence helper is an ESM JavaScript module.
import { writeTestEvidence, syntheticSyncProof } from "../../../scripts/fixtures/signal-evidence.mjs";
import { removeTempDirSync } from "../../testing/cleanup.ts";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { z } from "zod";
import { SignalProcessHost, MAX_FRAME_BYTES, verifyRuntimePin, type HostOptions, type SpawnChild } from "./process-host.ts";
import type { ProcessHost, RpcRequest, RuntimePin } from "./types.ts";
import { createSignalStorageGuard, signalStorageRoots, windowsSecurityRead } from "./storage.ts";
import { currentUserSid, ownerOnlyVerdict, windowsAclRestrict } from "../../win-acl.ts";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const mocked = { ...actual, promises: await import("node:fs/promises"),
    writeFileSync: vi.fn(actual.writeFileSync), appendFileSync: vi.fn(actual.appendFileSync),
    writeSync: vi.fn(actual.writeSync), writevSync: vi.fn(actual.writevSync), writeFile: vi.fn(actual.writeFile),
    appendFile: vi.fn(actual.appendFile), write: vi.fn(actual.write), writev: vi.fn(actual.writev),
    createWriteStream: vi.fn(actual.createWriteStream) };
  return { ...mocked, default: mocked };
});
vi.mock("node:fs/promises", { spy: true });

const aci = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const number = "+12025550123";
const roots: string[] = [];
const hosts: SignalProcessHost[] = [];
class FakeChild extends EventEmitter {
  pid = 123;
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes: any[] = [];
  kills: string[] = [];
  autoExit = true;
  answer: (req: any) => unknown = (req) => req.method === "version" ? { version: "fixture" }
    : req.method === "listAccounts" ? [{ number, aci }] : {};
  stdin = new Writable({ write: (chunk, _encoding, done) => {
    const req = JSON.parse(chunk.toString());
    this.writes.push(req);
    const result = this.answer(req);
    if (result !== undefined) queueMicrotask(() => this.frame({ jsonrpc: "2.0", id: req.id, result }));
    done();
  } });
  frame(value: unknown) { this.stdout.write(JSON.stringify(value) + "\n"); }
  kill(signal = "SIGTERM") {
    this.kills.push(signal);
    if (this.autoExit || signal === "SIGKILL") queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}
function fixture(overrides: Partial<HostOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "signal-b5-")); roots.push(root);
  for (const dir of ["auth/data", "tmp", "log"]) mkdirSync(join(root, "signal", dir), { recursive: true, mode: 0o700 });
  const index = join(root, "signal/auth/data/accounts.json");
  const account = join(root, "signal/auth/data/not-the-number");
  writeFileSync(index, JSON.stringify({ accounts: [{ path: "not-the-number", uuid: aci, number }] }), { mode: 0o600 });
  writeFileSync(account, JSON.stringify({ storage: { deviceId: 2 }, privateKey: "secret" }), { mode: 0o600 });
  mkdirSync(join(root,"channels/signal"),{recursive:true,mode:0o700});
  writeFileSync(join(root,"channels/signal/connection.json"),JSON.stringify({version:1,connectionId:"fixture",generation:1,enabled:false,paused:true,revoking:false,binding:null,account:null}),{mode:0o600});
  const children: FakeChild[] = [];
  const spawnChild = vi.fn<SpawnChild>(() => { const child = new FakeChild(); children.push(child); return child; });
  const events: unknown[] = [];
  const check = vi.fn(async () => ({ state: "ok" as const }));
  const options: HostOptions = {
    dataDir: root, storage: { check, repair: check },
    // Isolated fake children have synthetic PIDs; prove the fake process set explicitly.
    park: { fence: { lease: () => "fixture-lease", discover: () => true, host: () => "fixture", boot: () => "fixture", uptime: () => 1, start: () => "123" } },
    // Synthetic contract exercises host mechanics only; G0 remains a merge gate.
    rpc: { contracts: { subscribeReceive: { params: z.strictObject({}), result: z.strictObject({}) } } },
    verifyRuntime: vi.fn(async () => ({ java: "/bundled/bin/java", jar: "/bundled/signal-cli.jar", version: "fixture" })),
    spawnChild, onEvent: (e) => events.push(e), ...overrides,
  };
  const host = new SignalProcessHost(options); hosts.push(host);
  const start = (generation = 1) => host.spawn({ generation, account: number });
  return { root, index, account, children, spawnChild, host, start, options, check, events };
}
const send: RpcRequest<"send"> = { jsonrpc: "2.0", id: "send", method: "send", params: { noteToSelf: true, message: "hi" } };
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    const stopping = host.stop();
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(5001);
    await stopping;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) removeTempDirSync(root);
});

describe("Signal child host", () => {
  it("B5 compiles against frozen B0 ProcessHost", () => {
    const host: ProcessHost = fixture().host;
    expect(host.generation).toBe(0);
    const program = ts.createProgram([
      "server/channels/signal/rpc.ts", "server/channels/signal/process-host.ts",
      "server/channels/signal/rpc.test.ts", "server/channels/signal/process-host.test.ts",
    ], { strict: true, noUnusedLocals: true, noUnusedParameters: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true });
    expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
  });
  it("T-ACCOUNTS selects the indexed path and reads deviceId before spawn; kills number filename assumption", async () => {
    const f = fixture();
    f.spawnChild.mockImplementation(() => {
      // A child saving in place must not influence this generation's pre-spawn read.
      writeFileSync(f.account, JSON.stringify({ storage: { deviceId: 3 } }));
      const child = new FakeChild(); f.children.push(child); return child;
    });
    await f.start();
    expect(f.host.identity).toEqual({ ownAci: aci, ownDeviceId: 2, number });
    expect(f.children[0].writes.map(r => r.method)).toEqual(["version", "listAccounts", "subscribeReceive"]);
    await f.host.stop();
    await expect(f.start(2)).rejects.toThrow("identity-mismatch");
    expect(f.spawnChild).toHaveBeenCalledTimes(1);
  });
  it.each([[], [{ path: "not-the-number", uuid: aci, number }, { path: "second", uuid: other, number }]].map(accounts => [accounts]))(
    "T-ACCOUNTS rejects account index cardinality %j before spawn", async (accounts) => {
      const good = fixture(); await good.start();
      const bad = fixture(); writeFileSync(bad.index, JSON.stringify({ accounts }));
      await expect(bad.start()).rejects.toThrow("identity-unavailable");
      expect(bad.spawnChild).not.toHaveBeenCalled();
    });
  it.each([undefined, 0, -1, 2.5, "2"])("T-ACCOUNTS rejects deviceId %s before spawn", async (deviceId) => {
    const good = fixture(); await good.start();
    const bad = fixture(); writeFileSync(bad.account, JSON.stringify({ storage: { deviceId } }));
    await expect(bad.start()).rejects.toThrow("identity-unavailable");
    expect(bad.spawnChild).not.toHaveBeenCalled();
  });
  it.each([[], [{ number, aci }, { number, aci: other }], [{ number, aci: "not-a-uuid" }], [{ number, aci: other }]].map(accounts => [accounts]))(
    "T-ACCOUNTS rejects live identity %j before subscribing", async (accounts) => {
      const good = fixture(); await good.start();
      const bad = fixture(); bad.spawnChild.mockImplementation(() => {
        const child = new FakeChild(); const original = child.answer;
        child.answer = req => req.method === "listAccounts" ? accounts : original(req);
        bad.children.push(child); return child;
      });
      await expect(bad.start()).rejects.toThrow("identity-unavailable");
      expect(bad.children[0].writes.some(r => r.method === "subscribeReceive")).toBe(false);
    });
  it("T-ACCOUNTS rejects escaping paths and symlinks instead of reading them", async () => {
    const good = fixture(); await good.start();
    const bad = fixture(); writeFileSync(bad.index, JSON.stringify({ accounts: [{ path: "../outside", uuid: aci, number }] }));
    await expect(bad.start()).rejects.toThrow("identity-unavailable");
    writeFileSync(bad.index, JSON.stringify({ accounts: [{ path: "link", uuid: aci, number }] }));
    symlinkSync(bad.account, join(bad.root, "signal/auth/data/link"));
    await expect(bad.start()).rejects.toThrow("identity-unavailable");
    expect(bad.spawnChild).not.toHaveBeenCalled();
  });
  it("T-PIN checks storage and runtime on every spawn; mismatch never spawns", async () => {
    const f = fixture(); await f.start(); await f.host.stop();
    vi.mocked(f.options.verifyRuntime).mockRejectedValueOnce(new Error("secret path"));
    await expect(f.start(2)).rejects.toThrow("needs-update");
    expect(f.spawnChild).toHaveBeenCalledTimes(1);
    expect(f.check.mock.calls.length).toBeGreaterThanOrEqual(3);
    f.check.mockResolvedValueOnce({ state: "blocked", reason: "storage-owner", scope: "signal", path: f.root } as any);
    await expect(f.start(3)).rejects.toThrow("storage-owner");
    expect(f.spawnChild).toHaveBeenCalledTimes(1);
  });
  it.each(["signal-cli.jar", "jre/bin/java", "native/libsignal_jni.so", "lib/extra.jar"])("T-PIN rejects modified %s bytes before spawn; kills warn-and-spawn", async (changed) => {
    const f = fixture(); const runtimeDir = join(f.root, "runtime");
    const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
    for (const dir of ["lib", "jre/bin", "native"]) mkdirSync(join(runtimeDir, dir), { recursive: true });
    for (const file of ["signal-cli.jar", "lib/signal-network-fixture.jar", "jre/bin/java", "native/libsignal_jni.so"]) writeFileSync(join(runtimeDir, file), "fixture");
    writeFileSync(join(runtimeDir, "native/libsqlitejdbc.so"), "fixture sqlite");
    writeFileSync(join(runtimeDir, "jre/release"), 'JAVA_RUNTIME_VERSION="25.0.1+1"\nIMPLEMENTOR="Eclipse Adoptium"\n');
    const record = pinSyntheticTree(runtimeDir, "linux-x64");
    const pin: RuntimePin = { contract: "murage-signal-runtime-pin/1.0", signalCliVersion: "fixture", rateLimitNotSentProof: null,
      g0: null,
      releaseInputs: Object.fromEntries(["linux-x64", "win32-x64", "darwin-arm64"].map(target => [target, { layout: "prelinked-jre", url: `https://example.test/${target}.tar.gz`, sha256: hash("fixture") }])) as RuntimePin["releaseInputs"],
      signalNetwork: { coordinate: "com.github.turasa:signal-network", version: "fixture", sha256: hash("fixture"), syncProof: structuredClone(syntheticSyncProof) }, targets: { "linux-x64": record, "win32-x64": record, "darwin-arm64": record },
    };
    writeTestEvidence(pin, join(runtimeDir, "g0"));
    f.options.verifyRuntime = () => verifyRuntimePin({ runtimeDir, pin, target: "linux-x64" });
    await f.start(); await f.host.stop();
    writeFileSync(join(runtimeDir, changed), "modified");
    await expect(f.start(2)).rejects.toThrow("needs-update");
    expect(f.spawnChild).toHaveBeenCalledTimes(1);
  });
  it("T-PIN rejects a different live version before identity or receive", async () => {
    const good = fixture(); await good.start();
    const bad = fixture(); bad.spawnChild.mockImplementation(() => {
      const child = new FakeChild(); child.answer = () => ({ version: "other" }); bad.children.push(child); return child;
    });
    await expect(bad.start()).rejects.toThrow("needs-update");
    expect(bad.children[0].writes.map(r => r.method)).toEqual(["version"]);
  });
  it("T-ENV uses only the allowlist and hardened JVM arguments", async () => {
    const f = fixture({ platform: "win32", environment: { SystemRoot: "C:\\Windows", HOME: "/private", PATH: "/hostile", ANTHROPIC_API_KEY: "secret", JAVA_TOOL_OPTIONS: "-javaagent:evil", _JAVA_OPTIONS: "evil", JDK_JAVA_OPTIONS: "evil", CLASSPATH: "evil" } });
    await f.start();
    const [java, args, options] = f.spawnChild.mock.calls[0];
    expect(java).toBe("/bundled/bin/java");
    expect(options.env).toEqual({ HOME: join(f.root, "signal"), TMPDIR: join(f.root, "signal/tmp"), PATH: "/bundled/bin", SystemRoot: "C:\\Windows" });
    expect(args).toEqual(expect.arrayContaining(["-XX:-UsePerfData", "-XX:-HeapDumpOnOutOfMemoryError", "-XX:+DisableAttachMechanism", "--receive-mode", "manual", "--ignore-attachments", "--ignore-stories", "-a", number]));
    expect(options.shell).toBe(false);
    expect(args).not.toContain("--send-read-receipts");
    expect(args).not.toContain("--verbose");
  });
  it("T-SEND-SCHEMA invalid request and cancellation write zero bytes", async () => {
    const f = fixture(); await f.start(); const child = f.children[0];
    child.answer = () => ({ timestamp: 123, results: [{ recipientAddress: { uuid: aci, number }, type: "SUCCESS" }] });
    await f.host.request(send, { generation: 1, spawnToken: f.host.spawnToken, beforeWrite: () => true });
    const count = child.writes.length;
    await expect(f.host.request({ ...send, params: { ...send.params, recipient: other } } as any, { generation: 1, spawnToken: f.host.spawnToken })).rejects.toThrow("invalid-request");
    await expect(f.host.request({ ...send, id: "cancelled" }, { generation: 1, spawnToken: f.host.spawnToken, beforeWrite: () => false })).rejects.toThrow("cancelled");
    await expect(f.host.request(send, { generation: 0, spawnToken: f.host.spawnToken })).rejects.toThrow("offline");
    expect(child.writes).toHaveLength(count);
  });
  it("T-HOST fences old child callbacks and rejects pending requests on stop", async () => {
    const f = fixture(); const received = vi.fn(); f.host.onNotification(received); await f.start();
    const old = f.children[0]; old.answer = () => undefined;
    const pending = f.host.request(send, { generation: 1, spawnToken: f.host.spawnToken }); const rejected = expect(pending).rejects.toThrow("offline");
    await f.host.stop(); await rejected; await f.start(2);
    const notification = { jsonrpc: "2.0", method: "receive", params: { envelope: { message: "secret" } } };
    f.children[1].frame(notification); expect(received).toHaveBeenCalledTimes(1);
    old.frame(notification); old.emit("exit", 1, null); expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0][0].generation).toBe(2);
  });
  it("T-HOST isolates late responses when a caller reuses a request ID", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.start(); const child = f.children[0]; child.answer = () => undefined;
    const first = f.host.request(send, { generation: 1, spawnToken: f.host.spawnToken }); const rejected = expect(first).rejects.toThrow("timeout");
    const oldId = child.writes.at(-1).id;
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    const second = f.host.request(send, { generation: 1, spawnToken: f.host.spawnToken }); const newId = child.writes.at(-1).id;
    expect(newId).not.toBe(oldId);
    const result = { timestamp: 123, results: [{ recipientAddress: { uuid: aci, number }, type: "SUCCESS" }] };
    const settled = vi.fn(); void second.then(settled);
    child.frame({ jsonrpc: "2.0", id: oldId, result }); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    child.frame({ jsonrpc: "2.0", id: newId, result });
    expect(await second).toEqual({ jsonrpc: "2.0", id: send.id, result });
  });
  it.each(["crash", "explicit"])("T-HOST rejects stale per-spawn tokens after %s replacement; kills reused spawn token", async restart => {
    vi.useFakeTimers(); const f = fixture(); await f.start();
    const generation = f.host.generation;
    const staleToken = f.host.spawnToken;
    if (restart === "crash") {
      f.children[0].emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(5000);
    } else { await f.host.stop(); await f.start(generation); }
    const child = f.children[1];
    const result = { timestamp: 123, results: [{ recipientAddress: { uuid: aci, number }, type: "SUCCESS" }] };
    child.answer = () => result;
    expect(f.host.generation).toBe(generation);
    const spawnToken = f.host.spawnToken;
    await expect(f.host.request(send, { generation, spawnToken })).resolves.toHaveProperty("result", result);
    const writes = child.writes.length;
    await expect(f.host.request(send, { generation, spawnToken: staleToken })).rejects.toThrow("offline");
    expect(child.writes).toHaveLength(writes);
    expect(spawnToken).not.toBe(staleToken);
    expect(f.events).toContainEqual(expect.objectContaining({ kind: "ready", generation, spawnToken }));
    const received = vi.fn(); f.host.onNotification(received);
    child.frame({ jsonrpc: "2.0", method: "receive", params: {} });
    expect(received.mock.calls[0][0]).toHaveProperty("spawnToken", spawnToken);
    f.children[0].frame({ jsonrpc: "2.0", method: "receive", params: {} });
    expect(received).toHaveBeenCalledTimes(1);
    expect(f.host.confirmOwnDevice(3, generation, staleToken)).toBe(false);
    expect(child.kills).toEqual([]);
  });
  it("T-HOST rejects absent and foreign spawn tokens; kills optional token bypass", async () => {
    const f = fixture(); await f.start(); const otherHost = fixture(); await otherHost.start();
    const request = { jsonrpc: "2.0" as const, id: 9, method: "version" as const, params: {} };
    await expect(f.host.request(request, { generation: 1, spawnToken: f.host.spawnToken })).resolves.toHaveProperty("result.version", "fixture");
    const writes = f.children[0].writes.length;
    await expect(f.host.request(request, { generation: 1 })).rejects.toThrow("offline");
    await expect(f.host.request(request, { generation: 1, spawnToken: otherHost.host.spawnToken })).rejects.toThrow("offline");
    expect(f.children[0].writes).toHaveLength(writes);
  });
  it("T-HOST blocks subscription without a G0 contract; synthetic success is not runtime evidence", async () => {
    const good = fixture(); await good.start();
    const bad = fixture({ rpc: {} });
    const received = vi.fn(); bad.host.onNotification(received);
    bad.spawnChild.mockImplementation(() => {
      const child = new FakeChild(); const answer = child.answer;
      child.answer = req => { child.frame({ jsonrpc: "2.0", method: "receive", params: {} }); return answer(req); };
      bad.children.push(child); return child;
    });
    await expect(bad.start()).rejects.toThrow("needs-update");
    expect(bad.events).not.toContainEqual(expect.objectContaining({ kind: "ready" }));
    expect(received).not.toHaveBeenCalled();
    expect(bad.children[0].writes.some(req => req.method === "subscribeReceive")).toBe(false);
  });
  it("T-MODES rechecks files created during preparation before spawn; kills missing DACL check", async () => {
    const good = fixture(); await good.start();
    const bad = fixture();
    bad.check.mockResolvedValueOnce({ state: "ok" }).mockResolvedValueOnce({
      state: "blocked", reason: "storage-permissions", scope: "signal", path: bad.root,
    } as any);
    await expect(bad.start()).rejects.toThrow("storage-permissions");
    expect(bad.spawnChild).not.toHaveBeenCalled();
  });
  it("T-HOST stop during the pre-spawn runtime check prevents later activation", async () => {
    const good = fixture(); await good.start();
    let finish!: (value: Awaited<ReturnType<HostOptions["verifyRuntime"]>>) => void;
    const f = fixture({ verifyRuntime: () => new Promise(resolve => { finish = resolve; }) });
    const starting = f.start(); const rejected = expect(starting).rejects.toThrow("offline");
    while (!finish) await Promise.resolve();
    await f.host.stop(); finish({ java: "/bundled/bin/java", jar: "/bundled/signal-cli.jar", version: "fixture" });
    await rejected; expect(f.spawnChild).not.toHaveBeenCalled();
  });
  it("T-HOST crash during startup retries with backoff instead of reporting an identity fault", async () => {
    vi.useFakeTimers(); const f = fixture();
    f.spawnChild.mockImplementationOnce(() => {
      const child = new FakeChild(); child.answer = req => {
        if (req.method === "listAccounts") { queueMicrotask(() => child.emit("exit", 1, null)); return undefined; }
        return { version: "fixture" };
      }; f.children.push(child); return child;
    });
    await expect(f.start()).rejects.toThrow("offline");
    expect(f.events).not.toContainEqual(expect.objectContaining({ kind: "blocked" }));
    await vi.advanceTimersByTimeAsync(5000); expect(f.children).toHaveLength(2);
    expect(f.host.identity?.ownDeviceId).toBe(2);
    f.children[1].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(9999); expect(f.children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(f.children).toHaveLength(3);
  });
  it("T-HOST startup silence terminates and retries without an invalid blocked reason", async () => {
    vi.useFakeTimers(); const f = fixture();
    f.spawnChild.mockImplementationOnce(() => { const child = new FakeChild(); child.answer = () => undefined; f.children.push(child); return child; });
    const starting = f.start(); const rejected = expect(starting).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    expect(f.events).not.toContainEqual(expect.objectContaining({ kind: "blocked" }));
    await vi.advanceTimersByTimeAsync(5000); expect(f.children).toHaveLength(2);
  });
  it("T-HOST permits receive after identity even before the subscription response", async () => {
    const f = fixture(); const received = vi.fn(); f.host.onNotification(received);
    const notification = { jsonrpc: "2.0", method: "receive", params: {} };
    f.spawnChild.mockImplementation(() => {
      const child = new FakeChild(); const answer = child.answer;
      child.answer = req => { child.frame(notification); return answer(req); };
      f.children.push(child); return child;
    });
    await f.start(); expect(received).toHaveBeenCalledTimes(1);
  });
  it("T-ACCOUNTS first own-device evidence must match the pre-spawn device ID", async () => {
    const good = fixture(); await good.start(); expect(good.host.confirmOwnDevice(2, 1, good.host.spawnToken)).toBe(true);
    const bad = fixture(); await bad.start(); const spawnToken = bad.host.spawnToken;
    expect(bad.host.confirmOwnDevice(3, 1, spawnToken)).toBe(false);
    expect(bad.events).toContainEqual({ kind: "blocked", reason: "identity-unavailable", generation: 1 });
    await expect(bad.host.request(send, { generation: 1, spawnToken })).rejects.toThrow("offline");
    expect(bad.children[0].kills).toEqual(["SIGTERM"]);
  });
  it("T-HOST caps lines in bytes, accepts fragmented UTF-8, and drops unknown notifications", async () => {
    const f = fixture(); const received = vi.fn(); f.host.onNotification(received); await f.start();
    const child = f.children[0]; const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "receive", params: "é" }) + "\n");
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    child.stdout.write(bytes.subarray(0, split)); child.stdout.write(bytes.subarray(split));
    expect(received.mock.calls[0][0].notification.params).toBe("é");
    child.frame({ jsonrpc: "2.0", method: "secret-method", params: "secret" });
    expect(received).toHaveBeenCalledTimes(1);
    child.stdout.write(Buffer.alloc(MAX_FRAME_BYTES + 1, 65));
    expect(child.kills).toEqual(["SIGTERM"]);
  });
  it("T-NOLOG observes logging and filesystem sinks; kills log-frame-on-drop and write-stderr", async () => {
    const f = fixture(); await f.start(); const child = f.children[0];
    const snapshot = () => readdirSync(f.root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
      .map(entry => { const path = join(entry.parentPath, entry.name); return [path, readFileSync(path).toString("base64")]; });
    const before = snapshot();
    const logs = ["log", "warn", "error", "info", "debug", "trace"] as const;
    const logging = logs.map(method => vi.spyOn(console, method).mockImplementation(() => {}));
    const output = [vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(process.stderr, "write").mockImplementation(() => true)];
    const sinks = [fs.writeFileSync, fs.appendFileSync, fs.writeSync, fs.writevSync, fs.writeFile, fs.appendFile,
      fs.write, fs.writev, fs.createWriteStream, fsPromises.writeFile, fsPromises.appendFile, fsPromises.open];
    for (const sink of sinks) vi.mocked(sink).mockClear();
    try {
      child.frame({ jsonrpc: "2.0", method: "receive", params: "private-note-canary" });
      child.frame({ jsonrpc: "2.0", method: "unknown", params: "private-note-canary" });
      child.stdout.write('{"secret":"private-note-canary"}\nprivate-note-canary\n');
      child.stderr.write("private-stderr-canary".repeat(1000));
      expect(f.host.stderrBytes).toBe(4096);
      for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
      for (const sink of [...logging, ...output]) expect(sink).not.toHaveBeenCalled();
      expect(JSON.stringify(f.events)).not.toMatch(/private-note-canary|private-stderr-canary/);
      // r3.1 requires a durable exact-child exit record. It contains protocol metadata only.
      const controlPath=join(f.root,"recovery-quarantine/signal-park-control/control.json");
      const running=JSON.parse(readFileSync(controlPath,"utf8"));
      await f.host.stop();
      expect(snapshot().filter(([path])=>path!==controlPath)).toEqual(before.filter(([path])=>path!==controlPath));
      expect(JSON.parse(readFileSync(controlPath,"utf8"))).toEqual({...running,seq:running.seq+1,child:{...running.child,state:"exited"}});
      expect(JSON.stringify(vi.mocked(fs.writeFileSync).mock.calls)).not.toMatch(/private-note-canary|private-stderr-canary/);
      for (const sink of sinks.filter(sink=>sink!==fs.writeFileSync)) expect(sink).not.toHaveBeenCalled();
      for (const sink of [...logging, ...output]) expect(sink).not.toHaveBeenCalled();
    } finally { for (const sink of [...logging, ...output]) sink.mockRestore(); }
  });
  it("T-BACKPRESSURE pauses within a buffered batch at 50, resumes, and suspends liveness", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.start(); let count = 0;
    f.host.onNotification(() => { if (++count === 50) f.host.pauseReading(); });
    const line = JSON.stringify({ jsonrpc: "2.0", method: "receive", params: {} }) + "\n";
    f.children[0].stdout.write(line.repeat(51)); expect(count).toBe(50);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.children[0].kills).toEqual([]);
    expect(f.events).toContainEqual({ kind: "blocked", reason: "storage-slow", generation: 1 });
    f.host.resumeReading(); expect(count).toBe(51);
    await vi.advanceTimersByTimeAsync(30_000); expect(f.children[0].kills).toEqual([]);
  });
  it("T-BACKPRESSURE disk-full pause keeps the child and reports disk-full", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.start();
    f.host.pauseReading("disk-full"); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.events).toContainEqual({ kind: "blocked", reason: "disk-full", generation: 1 });
    expect(f.children[0].kills).toEqual([]);
  });
  it("T-HOST three missed pings terminate, escalate, and respawn with identity checks and backoff", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.start(); const child = f.children[0];
    await vi.advanceTimersByTimeAsync(30_000); expect(child.kills).toEqual([]);
    child.answer = () => undefined; child.autoExit = false;
    await vi.advanceTimersByTimeAsync(90_000); expect(child.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000); expect(child.kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5000); expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(4999); expect(f.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(f.children).toHaveLength(2);
    expect(f.children[1].writes.map(r => r.method)).toEqual(["version", "listAccounts", "subscribeReceive"]);
  });
  it("T-HOST request timeout never replays a send", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.start(); f.children[0].answer = () => undefined;
    const pending = f.host.request(send, { generation: 1, spawnToken: f.host.spawnToken }); const rejected = expect(pending).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    expect(f.children[0].writes.filter(r => r.method === "send")).toHaveLength(1);
  });
  it("T-HOST enforces 120 seconds of silence even when timer ticks were delayed", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.start();
    await vi.advanceTimersByTimeAsync(30_000); expect(f.children[0].kills).toEqual([]);
    vi.setSystemTime(Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(30_000); expect(f.children[0].kills).toEqual(["SIGTERM"]);
  });
  it("T-HOST rotates logs before spawn, clears JVM crash files, and respawns only when idle", async () => {
    vi.useFakeTimers(); let idle = false; const f = fixture({ isIdle: () => idle });
    const log = join(f.root, "signal/log/signal-cli.log"); const crash = join(f.root, "signal/tmp/hs_err_123.log");
    writeFileSync(log, Buffer.alloc(2 * 1024 * 1024)); writeFileSync(crash, "private");
    await f.start(); expect(existsSync(log + ".1")).toBe(false); expect(existsSync(crash)).toBe(false);
    await f.host.stop(); writeFileSync(log, Buffer.alloc(2 * 1024 * 1024 + 1, 65)); await f.start(2);
    expect(readFileSync(log + ".1")).toHaveLength(2 * 1024 * 1024 + 1);
    if (process.platform !== "win32") {
      expect(statSync(log).mode & 0o777).toBe(0o600);
      expect(statSync(log + ".1").mode & 0o777).toBe(0o600);
    }
    writeFileSync(log, Buffer.alloc(8 * 1024 * 1024 + 1));
    await vi.advanceTimersByTimeAsync(30_000); expect(f.children[1].kills).toEqual([]);
    idle = true; await vi.advanceTimersByTimeAsync(30_000);
    expect(f.children[1].kills).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5000); expect(f.children).toHaveLength(3);
  });
  it.skipIf(process.platform !== "win32")("T-MODES real Windows DACLs protect fresh and rotated logs (requires Windows runner)", async () => {
    const f = fixture(); const connectionId = "b5-dacl-fixture";
    mkdirSync(join(f.root, "channels/signal", connectionId), { recursive: true });
    expect(windowsAclRestrict(f.root)).toBe(true);
    f.options.storage = createSignalStorageGuard({ dataDir: f.root, connectionId });
    const roots = signalStorageRoots(f.root, connectionId);
    const log = join(f.root, "signal/log/signal-cli.log");
    const sid = currentUserSid(); expect(sid).not.toBeNull();
    const verdict = async (path: string) => {
      const rows = await windowsSecurityRead(roots); expect(rows).not.toBeNull();
      return ownerOnlyVerdict(rows!.find(row => row.path === path)!.sddl!, sid!);
    };
    await f.start(); expect(await verdict(log)).toBe("owner-only");
    await f.host.stop(); writeFileSync(log, Buffer.alloc(2 * 1024 * 1024 + 1));
    await f.start(2);
    expect(await verdict(log)).toBe("owner-only");
    expect(await verdict(log + ".1")).toBe("owner-only");
    // Removing the post-prepare guard leaves a newly created log's DACL inherited.
  }, 60_000);
});
it('RED17 RED31 actual spawn entry refuses incomplete discovery before storage or child creation',async()=>{
 const f=fixture({park:{fence:{lease:()=> 'fixture-lease',discover:()=>false}}});
 await expect(f.start()).rejects.toThrow();expect(f.check).not.toHaveBeenCalled();expect(f.spawnChild).not.toHaveBeenCalled();
});
it('RED17 actual spawn entry refuses a tracked live child before storage or another launch',async()=>{
 const f=fixture();const {ParkFs}=await import('./park-fs.ts'),{beginSignalChild,publishSignalChild}=await import('./park-fence.ts');
 const io=new ParkFs(f.root),probes={...f.options.park!.fence,alive:()=>true,start:()=> '123'};
 const token=beginSignalChild(io,1,probes);publishSignalChild(io,token,123,probes);f.options.park!.fence=probes;
 await expect(f.start()).rejects.toThrow();expect(f.check).not.toHaveBeenCalled();expect(f.spawnChild).not.toHaveBeenCalled();
});
it('RED19 exact child exit publication fault emits a typed custody hold and never respawns or inspects storage',async()=>{
 vi.useFakeTimers();const f=fixture();await f.start();const checks=f.check.mock.calls.length;let stopped=false;
 f.options.park!.after=(op,path)=>{if(op==='write'&&path.endsWith('control.json')&&JSON.parse(readFileSync(path,'utf8')).child.state==='exited'){stopped=true;throw new Error('EXIT_SAVE');}};
 f.children[0].emit('exit',1,null);await vi.advanceTimersByTimeAsync(10000);hosts.splice(hosts.indexOf(f.host),1);expect(stopped).toBe(true);expect(f.check).toHaveBeenCalledTimes(checks);expect(f.spawnChild).toHaveBeenCalledOnce();
 expect(f.events).toContainEqual(expect.objectContaining({kind:'blocked',reason:'kept-check',preservation:{progress:'durability',canLink:false,canKeepBoth:false}}));
 await expect(f.host.stop()).rejects.toMatchObject({code:'kept-check',preservation:{canLink:false}});
});
it('RED19 spawn retry rebarriers prior child control before any storage inspection',async()=>{
 const f=fixture();await f.start();await f.host.stop();const checks=f.check.mock.calls.length;f.options.park!.sync=()=>{throw new Error('RETRY_BARRIER');};
 await expect(f.start()).rejects.toThrow();expect(f.check).toHaveBeenCalledTimes(checks);expect(f.spawnChild).toHaveBeenCalledOnce();
});
