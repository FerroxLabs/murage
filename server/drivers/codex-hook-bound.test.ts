// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// LASTRESORT H1a r2.2 §6. All homes, sockets and ledgers are isolated fixtures.
import { HOOK_DENY_REASONS } from "./hook-control.ts";
import * as procs from "../procs.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import net from "node:net";
import { DATA_DIR, ensureDirs } from "../config.ts";
import { releaseHookCanon } from "../hook-safety.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CARD_ANSWERED_NOTE, DENY_TIMEOUT_NOTE, CODEX_HOOK_SCRIPT, HOOK_SCRIPT_DEADLINE_MS,
  CodexHookGate, HookDecisionTable, HOOK_ENV_VAR, HOOK_SCRIPT_FILE, hookCodeOf, hookEnvPathOf, hookSocketPath, writeHookFiles,
  type HookAnswer, type HookTurn,
} from "./codex-hook.ts";
import { createLedgerLease } from "../ledger-refusal.ts";
import { releaseNativeAnswer } from "./engine-input.ts";
import { consumingFixture } from "../testing/consuming-fixture.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { CodexDriver } from "./codex.ts";
import { fixtureBoundTurn, fixtureMountTurn } from "../testing/mcp-admission-fixture.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { resetIsolationCache } from "./isolation-cache.ts";
import type { ProviderInstance } from "../contracts.ts";

vi.mock("node:child_process", async original => (await import("../testing/exec-check-spy.ts")).withExecCheckSpy(await original()));
const FAKE_CLI = fileURLToPath(new URL("../testing/fake-codex-app-server.ts", import.meta.url));
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 10_000 });
const SECRET = "owner-private-sentinel-".repeat(200);
// Independent expectations: never use the implementation's table as the oracle.
const deny = (reason: string) => JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason,
} });
const UNCHECKED = deny("Murage could not check this call");
const POLICY = deny("Murage did not allow this call");
const CARD = "The owner has now answered the approval you were waiting for. If a code cell is still running, call wait on it to get the result. Then report what really happened, and correct anything you said earlier that turned out not to be true.";
const TIMEOUT = "Murage: nobody answered this permission request in time. Skip this action and finish what you can without it.";
const rows = [
  ["PreToolUse", "allow", ""],
  ["PreToolUse", "deny.policy", POLICY],
  ["PreToolUse", "deny.owner", deny("The owner did not allow this call. Do not try it again; carry on without it or ask the owner.")],
  ["PreToolUse", "deny.timeout", deny(TIMEOUT)],
  ["PreToolUse", "deny.ended", deny("Murage: the turn ended")],
  ["PreToolUse", "deny.unchecked", UNCHECKED],
  ["PreToolUse", "deny.nohook", deny("Murage held this call back because its check is not ready yet. Carry on without it for now, or try it again later.")],
  ["Stop", "stop.end", ""],
  ["Stop", "stop.block.card", JSON.stringify({ decision: "block", reason: CARD })],
  ["SubagentStop", "stop.end", ""],
  ["SubagentStop", "stop.block.card", JSON.stringify({ decision: "block", reason: CARD })],
  ["SessionStart", "session.ok", ""],
] as const;
let dir: string;
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => { ensureDirs(); mkdirSync(join(DATA_DIR, "native"), { recursive: true }); dir = realpathSync.native(mkdtempSync(join(DATA_DIR, "native", "h1a-bound-"))); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await removeTempDir(dir);
});
const pre = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: SECRET }, tool_use_id: "one", turn_id: "turn" };
interface Output { code: number | null; stdout: string; stderr: string }
function runScript(home: string, envFile: string, input: unknown = pre, preload?: string): Promise<Output> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(preload ? ["--require", preload] : []), join(home, HOOK_SCRIPT_FILE)], {
      env: { ...process.env, [HOOK_ENV_VAR]: envFile, MURAGE_CODEX_HOOK_ENV_SHA256: existsSync(envFile) ? createHash("sha256").update(readFileSync(envFile)).digest("hex") : "missing-fixture-env" }, stdio: ["pipe", "pipe", "pipe"],
    });
    cleanups.push(() => { if (child.exitCode === null) child.kill(); });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}
interface SocketOptions { mode?: string | null; wire?: string; close?: boolean; deadline?: boolean }
async function fakeSocket(reply: unknown, options: SocketOptions = {}) {
  const path = hookSocketPath();
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", () => {
      if (options.close) socket.end();
      else if (!options.deadline) socket.end(options.wire ?? JSON.stringify(reply) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const home = join(dir, `scope-${cleanups.length}`), envFile = hookEnvPathOf(home, "test");
  const files = writeHookFiles(home, path, "token", envFile);
  cleanups.push(() => releaseHookCanon(files.canon));
  writeFileSync(envFile, `SOCKET=${path}\nTOKEN=token\n${options.mode === null ? "" : `MODE=${options.mode ?? "bound"}\n`}`);
  if (options.deadline) writeFileSync(join(home, HOOK_SCRIPT_FILE), CODEX_HOOK_SCRIPT.replace(`const DEADLINE_MS = ${HOOK_SCRIPT_DEADLINE_MS};`, "const DEADLINE_MS = 50;"));
  return { home, envFile };
}

describe("LASTRESORT fixed hook frames", () => {
  it.each(rows)("T-HOOK-BYTES: %s %s", async (event, code, expected) => {
    const f = await fakeSocket({ code });
    expect(await runScript(f.home, f.envFile, { ...pre, hook_event_name: event })).toEqual({ code: 0, stdout: expected, stderr: "" });
  });
  it("T-HOOK-BYTES: short writes still write the complete frame without a newline", async () => {
    const f = await fakeSocket({ code: "deny.timeout" });
    const preload = join(dir, "short.cjs");
    writeFileSync(preload, `const fs = require('node:fs'); const original = fs.writeSync;
fs.writeSync = (fd, data, offset, length, ...rest) => fd === 1 && Buffer.isBuffer(data)
  ? original(fd, data, offset, Math.min(length, 3), ...rest) : original(fd, data, offset, length, ...rest);
require('node:module').syncBuiltinESMExports();`);
    expect(await runScript(f.home, f.envFile, pre, preload)).toEqual({ code: 0, stdout: deny(TIMEOUT), stderr: "" });
  });
  it.each([
    ["PreToolUse", { decision: "allow", updatedInput: { command: SECRET } }, UNCHECKED],
    ["PreToolUse", { decision: "deny", reason: SECRET }, UNCHECKED],
    ["Stop", { decision: "block", reason: SECRET }, ""],
    ["PreToolUse", { code: "allow", additionalContext: SECRET }, UNCHECKED],
    ["PreToolUse", { code: "deny.policy", reason: SECRET }, UNCHECKED],
  ] as Array<[string, unknown, string]>)("T-HOOK-NO-CONTENT: %s rejects content-bearing replies %#", async (event, reply, expected) => {
    const f = await fakeSocket(reply);
    const out = await runScript(f.home, f.envFile, { ...pre, hook_event_name: event });
    expect(out).toEqual({ code: 0, stdout: expected, stderr: "" });
    expect(out.stdout + out.stderr).not.toContain("owner-private-sentinel");
  });
  it.each([null, "Open", "", "bound"])("T-HOOK-MODE: %s defaults to bound", async mode => {
    const f = await fakeSocket({ decision: "deny", reason: SECRET }, { mode });
    expect(await runScript(f.home, f.envFile)).toEqual({ code: 0, stdout: UNCHECKED, stderr: "" });
  });
  it("T-HOOK-MODE: unreadable env and pre-parse exception are bound on both fds", async () => {
    const f = await fakeSocket({ decision: "allow" }, { mode: "open" });
    for (const [envFile, input] of [[join(dir, "absent.env"), pre], [f.envFile, "not json"]] as const) {
      expect(await runScript(f.home, envFile, input)).toEqual({ code: 0, stdout: UNCHECKED, stderr: "Murage blocked this call\n" });
    }
  });
  it("T-HOOK-MODE: an env read exception never exposes its message, even beside MODE=open", async () => {
    const f = await fakeSocket({ decision: "allow" }, { mode: "open" });
    const preload = join(dir, "read-fails.cjs");
    writeFileSync(preload, `const fs = require('node:fs'); const read = fs.readFileSync;
fs.readFileSync = function (path, ...args) {
  if (typeof path === 'number') throw new Error('private-env-read-error');
  return read.call(this, path, ...args);
};
require('node:module').syncBuiltinESMExports();`);
    expect(await runScript(f.home, f.envFile, pre, preload)).toEqual({ code: 0, stdout: UNCHECKED, stderr: "Murage blocked this call\n" });
    for (const event of ["Stop", "SubagentStop", "SessionStart"]) {
      expect(await runScript(f.home, f.envFile, { hook_event_name: event }, preload))
        .toEqual({ code: event === "SessionStart" ? 2 : 0, stdout: "", stderr: "Murage blocked this call\n" });
    }
  });
  it.each([
    ["PreToolUse", { decision: "allow" }, ""],
    ["PreToolUse", { decision: "deny", reason: SECRET }, deny(SECRET.slice(0, 2000))],
    ["PreToolUse", { decision: "allow", updatedInput: { command: SECRET }, additionalContext: SECRET }, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: SECRET }, additionalContext: SECRET } })],
    ["Stop", { decision: "block", reason: SECRET }, JSON.stringify({ decision: "block", reason: SECRET.slice(0, 2000) })],
    ["SessionStart", { ok: true }, ""],
  ] as Array<[string, unknown, string]>)("T-HOOK-MODE: MODE=open preserves tip bytes for %s %#", async (event, reply, expected) => {
    const f = await fakeSocket(reply, { mode: "open" });
    expect(await runScript(f.home, f.envFile, { ...pre, hook_event_name: event })).toEqual({ code: 0, stdout: expected, stderr: "" });
  });
  it.each([
    ["PreToolUse", "stop.end", 0, UNCHECKED], ["PreToolUse", "session.ok", 0, UNCHECKED],
    ["Stop", "allow", 0, ""], ["SubagentStop", "deny.owner", 0, ""], ["SessionStart", "allow", 2, ""],
  ] as Array<[string, string, number, string]>)("T-HOOK-CROSS-EVENT: %s rejects %s", async (event, code, exit, stdout) => {
    const f = await fakeSocket({ code });
    expect(await runScript(f.home, f.envFile, { ...pre, hook_event_name: event })).toEqual({ code: exit, stdout, stderr: "" });
  });
  it.each([
    [{ code: "unknown" }, {}], [{ code: "allow", extra: SECRET }, {}],
    [null, { wire: "malformed-secret\n" }], [null, { close: true }], [null, { deadline: true }],
  ] as Array<[unknown, SocketOptions]>)("T-HOOK-FORGED: refuses malformed, extra, missing and late replies %#", async (reply, options) => {
    const f = await fakeSocket(reply, options);
    const out = await runScript(f.home, f.envFile);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(UNCHECKED);
    expect(out.stderr).toBe(options.wire || options.close || options.deadline ? "Murage blocked this call\n" : "");
  });
  it("T-HOOK-MODE: writeHookFiles uses open only for explicit null and rewrites on reuse", () => {
    const home = join(dir, "modes"), envFile = hookEnvPathOf(home, "mode");
    const f = consumingFixture(); cleanups.push(() => f.close());
    for (const binding of [null, f.binding, undefined, null, f.binding]) {
      const files = writeHookFiles(home, "socket", "token", envFile, undefined, undefined, binding);
      cleanups.push(() => releaseHookCanon(files.canon));
      expect(readFileSync(envFile, "utf8")).toBe(`SOCKET=socket\nTOKEN=token\nMODE=${binding === null ? "open" : "bound"}\n`);
    }
  });
  it("T-HOOK-CODE-MAP: all driver answer shapes and explicit server errors", () => {
    expect(CARD_ANSWERED_NOTE).toBe(CARD); expect(DENY_TIMEOUT_NOTE).toBe(TIMEOUT);
    const cases: Array<[unknown, string]> = [
      [{ decision: "allow" }, "allow"], [{ decision: "allow", updatedInput: { command: SECRET } }, "deny.policy"],
      [{ decision: "allow", additionalContext: SECRET }, "deny.policy"],
      [{ decision: "deny", reason: SECRET }, "deny.policy"], [{ decision: "deny", reason: SECRET, source: "owner" }, "deny.owner"],
      [{ decision: "deny", reason: "Murage did not allow this call" }, "deny.policy"],
      [{ decision: "deny", reason: TIMEOUT }, "deny.timeout"],
      [{ decision: "deny", reason: "Murage: the turn ended" }, "deny.ended"],
      [{ decision: "deny", reason: "Murage could not check this call" }, "deny.unchecked"],
      [{ decision: "deny", reason: SECRET, source: "nohook" }, "deny.nohook"],
      ...["too large", "malformed", "token", "kind"].map(error => [{ error }, "deny.unchecked"] as [unknown, string]),
    ];
    for (const [answer, code] of cases) expect(hookCodeOf("PreToolUse", answer)).toBe(code);
    for (const event of ["Stop", "SubagentStop"]) {
      expect(hookCodeOf(event, { decision: "block", reason: CARD })).toBe("stop.block.card");
      for (const answer of [{ decision: "end" }, { decision: "block", reason: SECRET }, ...["too large", "malformed", "token", "kind"].map(error => ({ error }))]) expect(hookCodeOf(event, answer)).toBe("stop.end");
    }
    expect(hookCodeOf("SessionStart", { ok: true })).toBe("session.ok");
    expect(hookCodeOf("SessionStart", { error: "token" })).not.toBe("session.ok");
  });
});

async function realGate(answer: HookAnswer) {
  const fixture = consumingFixture(); cleanups.unshift(() => fixture.close());
  const gate = new CodexHookGate(); await gate.listen();
  cleanups.push(() => { gate.close(); gate.release(); });
  const home = join(dir, `real-${gate.id}`), envFile = hookEnvPathOf(home, gate.id);
  gate.envPath = envFile;
  const files = writeHookFiles(home, gate.path, "token", envFile, undefined, undefined, fixture.binding);
  cleanups.push(() => releaseHookCanon(files.canon));
  gate.arm({ releaseBinding: fixture.binding, token: "token", onSession() {}, onPreTool: async () => answer });
  return { fixture, gate, home, envFile };
}
function wire(path: string, message: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path); let data = "";
    socket.setEncoding("utf8"); socket.on("data", chunk => { data += chunk; });
    socket.once("connect", () => socket.write(JSON.stringify(message) + "\n"));
    socket.once("error", reject); socket.once("close", () => resolve(data));
  });
}
describe("LASTRESORT real socket release boundary", () => {
  it("T-HOOK-NO-CONTENT: the bound socket sends only a code, including narrowing and owner notes", async () => {
    const f = await realGate({ decision: "deny", reason: SECRET, source: "owner" });
    expect(await wire(f.gate.path, { kind: "pretool", token: "token", tool_use_id: "one" })).toBe('{"code":"deny.owner"}\n');
    expect(await runScript(f.home, f.envFile)).toEqual({ code: 0, stdout: deny("The owner did not allow this call. Do not try it again; carry on without it or ask the owner."), stderr: "" });
    f.gate.arm({ releaseBinding: f.fixture.binding, token: "token", onSession() {}, onPreTool: async () => ({ decision: "allow", updatedInput: { command: SECRET } }) });
    expect(await runScript(f.home, f.envFile)).toEqual({ code: 0, stdout: POLICY, stderr: "" });
  });
  it("T-HOOK-FORGED: another turn's token never proves a session or allows a call", async () => {
    const f = await realGate({ decision: "allow" });
    writeHookFiles(f.home, f.gate.path, "forged", f.envFile, undefined, undefined, f.fixture.binding);
    expect(await runScript(f.home, f.envFile)).toEqual({ code: 0, stdout: UNCHECKED, stderr: "" });
    expect(await runScript(f.home, f.envFile, { hook_event_name: "SessionStart" })).toEqual({ code: 2, stdout: "", stderr: "" });
    expect(await runScript(f.home, f.envFile, { hook_event_name: "Stop" })).toEqual({ code: 0, stdout: "", stderr: "" });
  });
  it("T-HOOK-LEDGER-STOPS: a revoked release destroys the socket and invokes ledger refusal", async () => {
    const f = await realGate({ decision: "allow" });
    f.fixture.flip();
    expect(await runScript(f.home, f.envFile)).toEqual({ code: 0, stdout: UNCHECKED, stderr: "Murage blocked this call\n" });
    expect(f.fixture.refusals).toBeGreaterThan(0);
    expect(await wire(f.gate.path, { kind: "pretool", token: "token" })).toBe("");
  });
  it.each(["disarm", "rearm"])("T-HOOK-LOST-ONE-CALL: ignores loss after %s", async change => {
    const f = await realGate({ decision: "allow" });
    const lost = vi.fn(); let entered!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    let release!: (answer: HookAnswer) => void;
    f.gate.arm({ releaseBinding: f.fixture.binding, token: "token", onSession() {}, onDeliveryLost: lost,
      onPreTool: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
    const socket = net.connect(f.gate.path);
    socket.on("error", () => {});
    await new Promise<void>(resolve => socket.once("connect", resolve));
    socket.write(JSON.stringify({ kind: "pretool", token: "token", tool_use_id: "late" }) + "\n");
    await arrived;
    if (change === "disarm") f.gate.disarm();
    else f.gate.arm({ releaseBinding: f.fixture.binding, token: "new", onSession() {}, onPreTool: async () => ({ decision: "allow" }) });
    socket.end();
    await new Promise<void>(resolve => socket.once("close", resolve));
    release({ decision: "allow" });
    expect(lost).not.toHaveBeenCalled(); expect(f.fixture.refusals).toBe(0);
  });
});

// These integration tests intentionally run through production admission. They
// need F4's §5.1 removals merged; no guard is stubbed to make them pass on H1 alone.
describe("LASTRESORT bound Codex (real gate, fake app-server; needs F4)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let dumpPath: string;
  let callsPath: string;
  const children: Array<ReturnType<typeof procs.spawnCli>> = [];
  const armed: Array<{ gate: CodexHookGate; turn: HookTurn }> = [];
  const sockets = new Map<unknown, net.Socket>();
  const loss = vi.fn();
  const sendBound = (turn: Parameters<ProviderInstance["adapter"]["sendTurn"]>[0]) => instance.adapter.sendTurn(fixtureBoundTurn(turn));
  async function create(tools: unknown[] = []) {
    resetIsolationCache();
    chmodSync(FAKE_CLI, 0o755);
    const home = join(dir, "owner-home"); mkdirSync(home);
    writeFileSync(join(home, "config.toml"), 'model = "fixture-model"\n');
    dumpPath = join(dir, "dump.json"); callsPath = join(dir, "calls.log");
    vi.stubEnv("FAKE_CODEX_VERSION", "codex-cli 0.163.0");
    vi.stubEnv("FAKE_CODEX_TOOLS", JSON.stringify(tools));
    vi.stubEnv("FAKE_CODEX_DUMP", dumpPath); vi.stubEnv("FAKE_CODEX_CALL_LOG", callsPath);
    const spawnCli = procs.spawnCli;
    vi.spyOn(procs, "spawnCli").mockImplementation((...args) => {
      const child = spawnCli(...args);
      if (args[1]?.includes("app-server")) children.push(child);
      return child;
    });
    const original = CodexHookGate.prototype.arm;
    vi.spyOn(CodexHookGate.prototype, "arm").mockImplementation(function (this: CodexHookGate, turn) {
      armed.push({ gate: this, turn });
      const server = (this as unknown as { server: net.Server }).server;
      server.on("connection", socket => {
        let data = "";
        socket.on("data", chunk => {
          data += chunk;
          if (!data.includes("\n")) return;
          const message = JSON.parse(data.slice(0, data.indexOf("\n")));
          if (message.kind === "pretool") sockets.set(message.tool_use_id, socket);
        });
      });
      return original.call(this, { ...turn, onDeliveryLost: delivery => { loss(delivery); turn.onDeliveryLost?.(delivery); } });
    });
    instance = await CodexDriver.create({ instanceId: "h1a-codex", displayName: "Private owner instance", enabled: true,
      environment: { CODEX_HOME: home }, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    cleanups.push(async () => { recorder.stop(); await instance.dispose(); });
  }
  beforeEach(() => { children.length = 0; armed.length = 0; sockets.clear(); loss.mockClear(); });
  const dump = (): any => JSON.parse(readFileSync(dumpPath, "utf8"));
  const done = async (id: string) => { const e = await recorder.until(e => e.type === "turn.completed" && e.turnId === id); if (e.type === "turn.completed" && !e.ok) console.error("BOUND-CODEX-FAILURE", JSON.stringify(e)); return e; };
  const opened = (id: string) => recorder.until(e => e.type === "request.opened" && e.turnId === id);
  function bound(threadId: string) {
    const f = consumingFixture(undefined, { threadId });
    cleanups.unshift(() => f.close());
    return f;
  }
  it("T-CODEX-CHAT-RUNS: cold and reused owner chat retain lineage and never report not launched (needs F4)", async () => {
    await create();
    const admissionNotLaunched = vi.fn();
    const warmIdentity = { botId: "h1a-owner", audience: "owner" as const, decidedOwner: true };
    const threadId = "h1a-chat";
    for (let n = 0; n < 2; n++) {
      const turn = fixtureMountTurn({ threadId, text: "hello", cwd: dir, warmIdentity, admissionNotLaunched });
      expect(turn.releaseBinding?.identity.lineageTurnIds.length).toBeGreaterThan(0);
      const sent = await sendBound(turn);
      expect(await done(sent.turnId)).toMatchObject({ ok: true });
      expect(readFileSync(armed.at(-1)!.gate.envPath!, "utf8")).toContain("MODE=bound\n");
    }
    expect(admissionNotLaunched).not.toHaveBeenCalled();
    expect(armed).toHaveLength(2); expect(armed[1]!.gate).toBe(armed[0]!.gate);
    // The newer canonical hook contract pins process env bytes. Generation
    // identity rotates independently while the process token remains pinned.
    expect(armed[1]!.turn.token).toBe(armed[0]!.turn.token);
    expect(armed[1]!.turn.releaseBinding).not.toBe(armed[0]!.turn.releaseBinding);
    expect(readFileSync(callsPath, "utf8").split("\n").filter(line => line.includes(" turn/start"))).toHaveLength(2);
  }, 40_000);
  it("T-CODEX-CHAT-RUNS: a bound current Codex retries and completes (needs F4)", async () => {
    vi.stubEnv("FAKE_CODEX_TRANSIENTS", "1"); vi.stubEnv("FAKE_CODEX_STATE", join(dir, "retry-count"));
    vi.stubEnv("FAKE_CODEX_RETRY_SCALE", "0.001");
    await create();
    const admissionNotLaunched = vi.fn(); const f = bound("h1a-retry");
    const sent = await sendBound({ threadId: "h1a-retry", text: "hello", cwd: dir, releaseBinding: f.binding, admissionNotLaunched });
    expect(await done(sent.turnId)).toMatchObject({ ok: true });
    expect(recorder.events.filter(e => e.type === "turn.retrying")).toHaveLength(1);
    expect(admissionNotLaunched).not.toHaveBeenCalled();
    expect(readFileSync(callsPath, "utf8").split("\n").filter(line => line.includes(" turn/start"))).toHaveLength(2);
  }, 40_000);
  it("T-HOOK-NO-CONTENT through the driver: owner note is fixed; narrowing denies only that call (M7)", async () => {
    await create([{ kind: "shell", id: "owner", command: "pwd" }, { kind: "shell", id: "narrow", command: "ls" }, { kind: "shell", id: "policy", command: "find /" }]);
    const f = bound("h1a-content");
    const sent = await sendBound({ threadId: "h1a-content", text: "go", cwd: dir, releaseBinding: f.binding });
    const first = await opened(sent.turnId);
    await instance.adapter.respondToRequest("h1a-content", first.requestId!, { behavior: "deny", message: SECRET });
    const second = await recorder.until(e => e.type === "request.opened" && e.turnId === sent.turnId && e.requestId !== first.requestId);
    await instance.adapter.respondToRequest("h1a-content", second.requestId!, { behavior: "allow", updatedInput: { command: "ls safe" } });
    const third = await recorder.until(e => e.type === "request.opened" && e.turnId === sent.turnId && e.requestId !== first.requestId && e.requestId !== second.requestId);
    await instance.adapter.respondToRequest("h1a-content", third.requestId!, { behavior: "deny", source: "narrow", message: SECRET });
    expect(await done(sent.turnId)).toMatchObject({ ok: true });
    expect(dump().hookLog.filter((r: any) => ["owner", "narrow", "policy"].includes(r.id))).toMatchObject([
      // EXPECTATION CHANGE (7C s9): the reasons are the fixed HOOK_CONTROL_FRAMES texts (hook-control.ts, the Tier F table of e4ed83d16
      // gave the owner frame its "Do not try it again" sentence); the test reads the table, so a changed frame is one edit, never a drift.
      { id: "owner", verdict: "deny", reason: HOOK_DENY_REASONS["deny.owner"] },
      { id: "narrow", verdict: "deny", reason: HOOK_DENY_REASONS["deny.policy"] },
      { id: "policy", verdict: "deny", reason: HOOK_DENY_REASONS["deny.policy"] },
    ]);
    expect(JSON.stringify(dump().hookLog)).not.toContain("owner-private-sentinel");
    expect(f.refusals).toBe(0);
  }, 40_000);
  it("T-HOOK-LOST-ONE-CALL: a closed socket denies one call; next call and turn complete without ledger refusal", async () => {
    await create([{ kind: "shell", id: "lost", command: "pwd" }, { kind: "shell", id: "next", command: "ls" }]);
    const records = vi.spyOn(HookDecisionTable.prototype, "record");
    const f = bound("h1a-lost");
    const ledgerRefused = vi.fn(f.binding.onLedgerRefused);
    const releaseBinding = { ...f.binding, onLedgerRefused: ledgerRefused };
    const sent = await sendBound({ threadId: "h1a-lost", text: "go", cwd: dir, releaseBinding });
    const first = await opened(sent.turnId);
    await waitFor(() => expect(sockets.has("lost")).toBe(true));
    sockets.get("lost")!.destroy();
    await waitFor(() => expect(loss).toHaveBeenCalledTimes(1));
    expect(ledgerRefused).not.toHaveBeenCalled();
    // A late owner answer cannot turn the lost delivery's table entry back into allow.
    await instance.adapter.respondToRequest("h1a-lost", first.requestId!, { behavior: "allow" });
    const next = await recorder.until(e => e.type === "request.opened" && e.turnId === sent.turnId && e.requestId !== first.requestId);
    await instance.adapter.respondToRequest("h1a-lost", next.requestId!, { behavior: "allow" });
    expect(await done(sent.turnId)).toMatchObject({ ok: true });
    expect(ledgerRefused).not.toHaveBeenCalled(); expect(f.refusals).toBe(0);
    expect(records.mock.calls.filter(([entry]) => entry.toolUseId === "lost").at(-1)?.[0]).toMatchObject({ decision: "deny", final: true });
    expect(dump().hookLog.filter((r: any) => ["lost", "next"].includes(r.id))).toMatchObject([
      { id: "lost", verdict: "deny", reason: "Murage could not check this call" }, { id: "next", verdict: "allow" },
    ]);
  }, 40_000);
  it.each(["allow", "stop.block.card"])("T-HOOK-REVOKE-WINDOW: %s stays fixed while §9.6 stops the lease and fences subsequent releases", async effect => {
    // Keep the fake app-server alive behind an ordinary card and its Stop barrier.
    const stopGate = join(dir, "fake-stop-gate");
    vi.stubEnv("FAKE_CODEX_STOP_GATE", stopGate);
    await create([{ kind: "shell", id: "held", command: "pwd" }]);
    const threadId = `h1a-window-${effect}`;
    let lease: ReturnType<typeof createLedgerLease> | undefined;
    const f = consumingFixture(undefined, { threadId, onRefused: verdict => lease?.onLedgerRefused(verdict) });
    cleanups.unshift(() => f.close());
    const seal = vi.fn(() => f.replace());
    const settle = vi.fn(); const present = vi.fn(); const quarantine = vi.fn();
    const interrupt = vi.fn(async (turnId: string) => {
      const child = children.at(-1)!;
      await instance.adapter.interruptTurn(threadId, turnId);
      // Codex's legacy stop returns void; use its actual owned-child close,
      // never an acknowledged interrupt or a synthetic confirmation.
      return procs.awaitCliRootClose(child);
    });
    lease = createLedgerLease(f.binding.identity, { seal, interrupt, settle, present, quarantine });
    const sent = await sendBound({ threadId, text: "go", cwd: dir, releaseBinding: f.binding,
      warmIdentity: { botId: "window-bot", audience: "owner", decidedOwner: true } });
    lease.attach(sent.turnId);
    const card = await opened(sent.turnId);
    const { gate, turn } = armed.at(-1)!;
    const home = dirname(dirname(gate.envPath!));
    const marker = join(dir, "socket-replied.json"), resume = join(dir, "resume-hook");
    // Delay the isolated child's received frame after the server has released
    // it. Keep canonical script bytes intact so repair remains fully enabled.
    const preload = join(dir, "receive-barrier.cjs");
    writeFileSync(preload, `const fs = require('node:fs'), net = require('node:net');
const original = net.Socket.prototype.on;
let held = false, resumed;
// One barrier preserves data-before-close ordering when the child resumes.
const afterResume = callback => {
  resumed ??= new Promise(resolve => { const poll = () => fs.existsSync(${JSON.stringify(resume)}) ? resolve() : setTimeout(poll,10); poll(); });
  resumed.then(callback);
};
net.Socket.prototype.on = function(event, listener) {
  if(event === 'close' || event === 'end' || event === 'error') return original.call(this,event,function(...args) { if(held) afterResume(() => listener.apply(this,args)); else listener.apply(this,args); });
  if(event !== 'data') return original.call(this,event,listener);
  return original.call(this,event,function(chunk) {
    let frame; try { frame=JSON.parse(String(chunk).trim()); } catch {}
    if(frame && frame.code === ${JSON.stringify(effect)}) {
      held = true;
      fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(frame));
      afterResume(() => listener.call(this,chunk));
    } else listener.call(this,chunk);
  });
};`);
    cleanups.push(() => { writeFileSync(resume, "resume"); writeFileSync(stopGate, "resume"); });
    const external = runScript(home, gate.envPath!, effect === "allow"
      ? { ...pre, turn_id: "turn-1", tool_name: "update_plan", tool_use_id: "window", tool_input: {} }
      : { hook_event_name: "Stop" }, preload);
    if (effect === "stop.block.card") {
      // Observe the external Stop handler waiting before resolving its card.
      const server = (gate as unknown as { server: net.Server }).server;
      // The socket exists while onStop is held; the gate's wrapped handler below
      // is installed before this child can connect (spawn only schedules I/O).
      const onStop = turn.onStop!;
      const waiting = vi.fn(onStop);
      (gate as unknown as { turn: HookTurn }).turn!.onStop = waiting;
      await waitFor(() => expect(waiting).toHaveBeenCalledTimes(1));
      expect(server.listening).toBe(true);
      await instance.adapter.respondToRequest(threadId, card.requestId!, { behavior: "allow" });
    }
    await waitFor(() => expect(existsSync(marker)).toBe(true));
    expect(readFileSync(marker, "utf8")).toBe(JSON.stringify({ code: effect }));
    // A real retained-line revoke is observed at the next release boundary.
    f.flip();
    const laterWrite = vi.fn();
    expect(() => releaseNativeAnswer(f.binding, "codex:hook-socket", "later-private-frame", laterWrite)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(seal).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith("memory-refused", expect.any(Object));
    expect(lease.state).toBe("settled");
    writeFileSync(resume, "resume");
    const received = await external;
    expect(received, JSON.stringify(received)).toEqual({ code: 0, stdout: effect === "allow" ? "" : JSON.stringify({ decision: "block", reason: CARD }), stderr: "" });
    await waitFor(() => expect(interrupt).toHaveBeenCalledWith(sent.turnId));
    await lease.teardownConfirmed;
    expect(quarantine).not.toHaveBeenCalled();
    // df1617dc60 P1 via 1ebbd84f1e: a claimed refusal ends the turn refused; the Stop-hook variant keeps its answered Stop card ending as the Stop
    expect(await done(sent.turnId)).toMatchObject(effect === "allow" ? { ok: false, stopReason: "memory-refused" } : { stopReason: "cancelled" });
    expect(laterWrite).not.toHaveBeenCalled();
    expect(() => releaseNativeAnswer(f.binding, "codex:hook-socket", "another-frame", laterWrite)).toThrow("MEMORY_CONTEXT_REVOKED");
    expect(laterWrite).not.toHaveBeenCalled();
    expect((gate as unknown as { server: net.Server | null }).server).toBeNull();
    expect(await runScript(home, gate.envPath!, pre)).toEqual({ code: 0, stdout: UNCHECKED, stderr: "Murage blocked this call\n" });
    // After the stopped lease, a fresh turn gets a fresh process/gate.
    writeFileSync(stopGate, "resume");
    const fresh = bound(threadId);
    const next = await sendBound({ threadId, text: "next", cwd: dir, releaseBinding: fresh.binding,
      warmIdentity: { botId: "window-bot", audience: "owner", decidedOwner: true } });
    const nextCard = await opened(next.turnId);
    await instance.adapter.respondToRequest(threadId, nextCard.requestId!, { behavior: "allow" });
    expect(await done(next.turnId)).toMatchObject({ ok: true });
    expect(armed.at(-1)!.gate).not.toBe(gate);
    expect(armed.at(-1)!.turn.releaseBinding).toBe(fresh.binding);
  }, 45_000);

  it("T-HOOK-LEDGER-STOPS: a refusal inside the socket release stops the actual app-server lease", async () => {
    await create([{ kind: "shell", id: "revoke", command: "pwd" }]);
    const threadId = "h1a-ledger";
    let lease: ReturnType<typeof createLedgerLease> | undefined;
    const f = consumingFixture(undefined, { threadId, onRefused: verdict => lease?.onLedgerRefused(verdict) });
    cleanups.unshift(() => f.close());
    const seal = vi.fn(() => f.replace()), settle = vi.fn(), quarantine = vi.fn();
    lease = createLedgerLease(f.binding.identity, { seal, settle, quarantine, present: vi.fn(),
      interrupt: async id => {
        const child = children.at(-1)!;
        await instance.adapter.interruptTurn(threadId, id);
        return procs.awaitCliRootClose(child);
      } });
    const sent = await sendBound({ threadId, text: "go", cwd: dir, releaseBinding: f.binding });
    lease.attach(sent.turnId);
    await opened(sent.turnId);
    const { gate } = armed.at(-1)!;
    const home = dirname(dirname(gate.envPath!));
    f.flip();
    // An independent hook survives app-server teardown, so both the real lease
    // shutdown and the generated script's fallback are observable.
    expect(await runScript(home, gate.envPath!, { ...pre, tool_name: "update_plan", tool_use_id: "revoked" }))
      .toEqual({ code: 0, stdout: UNCHECKED, stderr: "Murage blocked this call\n" });
    await lease.teardownConfirmed;
    expect(seal).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledTimes(1);
    expect(quarantine).not.toHaveBeenCalled(); expect(f.refusals).toBeGreaterThan(0);
    expect(await done(sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" }); // df1617dc60 P1 via 1ebbd84f1e: a claimed refusal ends the turn refused, no owner Stop was confirmed
  }, 40_000);

});
