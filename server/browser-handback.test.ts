// 1.0.3 report (Petra, packaged Mac): the bot's browser engine stopped answering,
// the panel showed the page lock, the owner took control, and then neither
// "Return to bot" nor "Reopen blank page" gave the bot its browser back. The panel
// sat on "Browser unavailable · Human control" with "Browser command failed or
// exceeded its bound". Every owner step, and the status read the panel polls,
// waited on the live view reconnecting to an engine that could not answer, so
// each one failed and the panel never learned the new state.
//
// Fable's verify found the cause on the Mac: the engine stops after 60 s idle,
// the next command had to start Chrome again inside the 20 s command bound and
// was stopped mid-start, and an engine that was down locked the page as a
// "sensitive page" (password, code or card), which it never was.
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedCloseCli } from "./browser-owned-close.ts";
import { UnifiedBrowserController, BROWSER_NOT_RUNNING } from "./browser-control.ts";
import { browserOwnerRequest } from "./browser-owner-api.ts";
import { nativeProcessList } from "./drivers/win-process-table.ts";
import { captureDaemonIdentity } from "./browser-daemon-identity.ts";
import { BrowserEngineError, createNativeBrowser, engineReason, windowsDaemonStopDecision, type NativeBrowser, type NativeBrowserOptions } from "./browser-native-relay.ts";
import { BROWSER_REFUSALS } from "./browser-lock.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

// The engine here is a fixture, never Murage's verified bundled Chromium, so the Windows launch gate
// (ensureBrowserSandboxAccess: the bundle and its Authenticode identity) is out of scope for these cases, as in
// cloud-home/browser-restore.test.ts. Linux and macOS already pass it for a fixture.
vi.mock("./browser-sandbox.ts", async (importOriginal) => ({ ...await importOriginal<typeof import("./browser-sandbox.ts")>(), ensureBrowserSandboxAccess: async () => {} }));

const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const path of directories.splice(0)) removeTempDirSync(path);
});
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "murage-handback-")); directories.push(dir); return dir; };
// What the relay threw in 1.0.3 for any engine failure.
const ENGINE_DOWN = "Browser command failed or exceeded its bound";
// The words that belong to a real sensitive page only.
const SENSITIVE_WORDS = /password|one-time|code|card|payment/i;

function failingEngine() {
  const state = { down: true, natives: 0, opened: [] as string[], sensitive: false, guardTimeout: false };
  const fail = () => Promise.reject(new BrowserEngineError("timeout"));
  const factory = (): NativeBrowser => {
    state.natives++;
    return {
      protected: async () => { if (state.down) return fail(); if (state.guardTimeout) throw new Error("Browser guard timed out"); return state.sensitive; },
      request: async (_method, call) => { if (state.down) return fail(); return { content: [{ type: "text", text: `did ${String(call?.name)}` }] }; },
      command: async (args) => { if (state.down) return fail(); if (args[0] === "open") state.opened.push(String(args[1])); return {}; },
      connect: async () => { if (state.down) return fail(); return "stream"; },
      input: () => {}, resetStream: () => {}, close: async () => {},
    };
  };
  const controller = new UnifiedBrowserController({ stateFile: join(temp(), "control.json"), createNative: factory });
  controller.register("petra", { command: "fixture", args: [], env: {} });
  const authority = { owner: "desktop", profileKey: "petra", active: () => true, canReclaim: true };
  const owner = (method: "GET" | "POST", body: Record<string, unknown> = {}) => browserOwnerRequest(controller, authority, method, body) as Promise<Record<string, unknown> & { generation: number; held: boolean; notRunning: boolean; problem?: string }>;
  return { controller, owner, state };
}

describe("owner hand-back while the bot's browser engine is not answering", () => {
  it("the panel can still read status, return control to the bot, and reopen once the engine answers", async () => {
    const { controller, owner, state } = failingEngine();
    // The bot's call fails inside the engine. The engine is down, which says nothing about the page.
    await expect(controller.dispatch("petra", "tools/call", { name: "agent_browser_snapshot" }, () => true)).rejects.toMatchObject({ code: "browser_not_running" });
    expect(controller.status("petra")).toMatchObject({ protectedDocument: false, protectedReason: null, notRunning: true });

    // The panel's poll. In 1.0.3 this threw ENGINE_DOWN, so the panel never saw any later state.
    const first = await owner("GET");
    expect(first).toMatchObject({ held: false, connected: false, notRunning: true, problem: BROWSER_NOT_RUNNING });

    const taken = await owner("POST", { action: "take" });
    expect(taken).toMatchObject({ held: true, owned: true, connected: false });
    expect((await owner("GET")).generation).toBe(taken.generation);

    // "Return to bot".
    const returned = await owner("POST", { action: "release", generation: taken.generation });
    expect(returned).toMatchObject({ held: false, owner: null });
    expect(await owner("GET")).toMatchObject({ held: false, generation: returned.generation });

    // "Reopen blank page" while the engine is still down: refused with plain copy,
    // and the panel can read the new generation to try again.
    const again = await owner("POST", { action: "take" });
    const refused = await owner("POST", { action: "reopen", generation: again.generation }).catch((error: Error) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).not.toBe(ENGINE_DOWN);
    expect(controller.status("petra").protectedDocument).toBe(false);
    const current = await owner("GET");
    expect(current).toMatchObject({ held: true });

    // The engine answers again: Reopen blank page restarts it and gives the bot its browser back.
    state.down = false;
    const reopened = await owner("POST", { action: "reopen", generation: current.generation });
    expect(reopened).toMatchObject({ held: true, protectedDocument: false, connected: true, notRunning: false });
    expect(reopened.problem).toBeUndefined();
    expect(state.opened).toEqual(["about:blank"]);
    const back = await owner("POST", { action: "release", generation: reopened.generation });
    expect(back).toMatchObject({ held: false });
    await expect(controller.dispatch("petra", "tools/call", { name: "agent_browser_snapshot" }, () => true)).resolves.toMatchObject({ content: [{ text: "did agent_browser_snapshot" }] });
  });

  it("Reopen keeps the same engine refused when closing it is not acknowledged", async () => {
    let made = 0;
    const factory = (): NativeBrowser => {
      const index = ++made;
      return {
        protected: async () => false, request: async () => ({}), connect: async () => "stream", input: () => {}, resetStream: () => {},
        command: async () => { if (index === 1) throw new Error(ENGINE_DOWN); return {}; },
        close: async () => { if (index === 1) throw new Error("Browser session close timed out"); },
      };
    };
    const controller = new UnifiedBrowserController({ stateFile: join(temp(), "control.json"), createNative: factory });
    controller.register("petra", { command: "fixture", args: [], env: {} });
    const held = await controller.take("petra", "desktop");
    await expect(controller.navigate("petra", "desktop", held.generation, "https://example.com/")).rejects.toThrow();
    const status = controller.status("petra");
    await expect(controller.reopen("petra", "desktop", status.generation)).rejects.toMatchObject({ code: "browser_close_failed", status: 503 });
    expect(controller.status("petra").closeFailed).toBe(true);
    expect(made).toBe(1);
  });
});

describe("an engine that is down is its own state, never a sensitive page", () => {
  it("tells the bot and the owner the browser is not running, and Restart browser brings it back", async () => {
    const { controller, owner, state } = failingEngine();
    const failure = await controller.dispatch("petra", "tools/call", { name: "agent_browser_snapshot" }, () => true).catch((error: Error & { code?: string }) => error);
    expect(failure).toMatchObject({ code: "browser_not_running", message: BROWSER_REFUSALS.browser_not_running });
    expect((failure as Error).message).not.toMatch(SENSITIVE_WORDS);
    expect((failure as Error).message).not.toMatch(/\u2014|\bsafe|unsafe|safety/i);
    expect(controller.status("petra")).toMatchObject({ protectedDocument: false, protectedReason: null, notRunning: true });
    const status = await owner("GET");
    expect(status.problem).toBe(BROWSER_NOT_RUNNING);
    expect(status.problem).not.toMatch(SENSITIVE_WORDS);

    // Restart browser needs no hold, and keeps no "not running" once the engine answers.
    state.down = false;
    const restarted = await owner("POST", { action: "restart" });
    expect(restarted).toMatchObject({ held: false, notRunning: false, connected: true, protectedDocument: false });
    expect(restarted.problem).toBeUndefined();
    await expect(controller.dispatch("petra", "tools/call", { name: "agent_browser_snapshot" }, () => true)).resolves.toMatchObject({ content: [{ text: "did agent_browser_snapshot" }] });
  });

  it("still locks a real sensitive page, and a guard that times out on a page, as before", async () => {
    const { controller, state } = failingEngine();
    state.down = false; state.sensitive = true;
    await expect(controller.dispatch("petra", "tools/call", { name: "agent_browser_snapshot" }, () => true)).rejects.toMatchObject({ code: "browser_protected_sensitive_page" });
    expect(controller.status("petra")).toMatchObject({ protectedDocument: true, protectedReason: "sensitive-page", notRunning: false });

    const other = failingEngine();
    other.state.down = false; other.state.guardTimeout = true;
    await expect(other.controller.dispatch("petra", "tools/call", { name: "agent_browser_snapshot" }, () => true)).rejects.toThrow();
    expect(other.controller.status("petra")).toMatchObject({ protectedDocument: true, protectedReason: "sensitive-page" });
  });

  it("keeps an earlier page lock when the engine goes down afterwards", async () => {
    const { controller, state } = failingEngine();
    state.down = false; state.sensitive = true;
    await expect(controller.dispatch("petra", "tools/call", { name: "agent_browser_snapshot" }, () => true)).rejects.toMatchObject({ code: "browser_protected_sensitive_page" });
    state.down = true;
    await expect(controller.dispatch("petra", "tools/call", { name: "agent_browser_snapshot" }, () => true)).rejects.toMatchObject({ code: "browser_protected_sensitive_page" });
    expect(controller.status("petra")).toMatchObject({ protectedDocument: true, protectedReason: "sensitive-page" });
  });
});

describe("the owner's status read and take answer at once while the engine is down", () => {
  it("does not wait on a live view that cannot connect", async () => {
    const never = new Promise<string>(() => {});
    const factory = (): NativeBrowser => ({
      protected: async () => false, request: async () => ({}), command: async () => ({}), connect: () => never,
      input: () => {}, resetStream: () => {}, close: async () => {},
    });
    const controller = new UnifiedBrowserController({ stateFile: join(temp(), "control.json"), createNative: factory });
    controller.register("petra", { command: "fixture", args: [], env: {} });
    const authority = { owner: "desktop", profileKey: "petra", active: () => true, canReclaim: true };
    const within = <T,>(promise: Promise<T>) => Promise.race([promise, new Promise<"blocked">(done => setTimeout(() => done("blocked"), 500))]);
    const read = await within(browserOwnerRequest(controller, authority, "GET"));
    expect(read).toMatchObject({ held: false, connected: false });
    const taken = await within(browserOwnerRequest(controller, authority, "POST", { action: "take" }));
    expect(taken).toMatchObject({ held: true, owned: true });
    const generation = (taken as { generation: number }).generation;
    expect(await within(browserOwnerRequest(controller, authority, "POST", { action: "release", generation }))).toMatchObject({ held: false });
  });
});

// The engine's command line, run as a script through node so the same test runs on every OS.
function scriptEngine(source: string, options: NativeBrowserOptions = {}) {
  const dir = temp();
  const script = join(dir, "fake-engine.cjs");
  writeFileSync(script, source);
  const spec = { command: process.execPath, args: [], env: { PATH: process.env.PATH ?? "", HOME: dir, AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "handback", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}) } };
  return { dir, spec, native: createNativeBrowser(spec, { ...options, cliPrefix: [script] }) };
}
function captureLog() {
  const logged: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => { logged.push(parts.map(String).join(" ")); });
  return logged;
}
const slowSuccess = (ms: number) => `setTimeout(() => { process.stdout.write(JSON.stringify({ success: true, data: { port: 1 } }) + "\\n"); process.exit(0); }, ${ms});\n`;

describe("browser engine failures keep their reason", () => {
  it("logs the engine's own reason, without page addresses' queries, and says what to do in plain words", async () => {
    const logged = captureLog();
    const { native } = scriptEngine(`process.stdout.write(JSON.stringify({ success: false, error: "Chrome exited early without writing DevToolsActivePort at https://bank.example/login?session=abc123#frag" }) + "\\n");\nprocess.stderr.write("engine stderr detail\\n");\nprocess.exit(1);\n`);
    const failure = await native.command(["stream", "status"]).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).not.toBe(ENGINE_DOWN);
    expect(message).toMatch(/Reopen blank page/);
    expect(message).not.toMatch(/\u2014|\bsafe|unsafe|safety/i);
    const line = logged.find(entry => entry.includes("[browser]"));
    expect(line).toContain("stream status");
    expect(line).toContain("Chrome exited early without writing DevToolsActivePort");
    expect(line).not.toContain("abc123");
    expect(line).not.toContain("frag");
  });

  it("logs the reason when the engine exits 0 but refuses the command", async () => {
    const logged = captureLog();
    const { native } = scriptEngine(`process.stdout.write(JSON.stringify({ success: false, error: "Navigation failed at https://app.example/reset/abc/def?x=1" }) + "\\n");\nprocess.exit(0);\n`);
    await expect(native.command(["open", "https://app.example/"])).rejects.toBeInstanceOf(BrowserEngineError);
    const line = logged.find(entry => entry.includes("[browser]"));
    expect(line).toContain("refused");
    expect(line).toContain("Navigation failed at https://app.example/reset/…/…");
    expect(line).not.toMatch(/abc|def|x=1/);
  });

  it("removes path segments that look like tokens, and everything after a reset, verify, token, auth, magic or invite word", () => {
    const reason = engineReason(JSON.stringify({ error: [
      "https://user:pw@bank.example/verify/Zx9Qp2Lm7Vb4/next",
      "https://cdn.example/assets/9f8e7d6c5b4a39281706f5e4d3c2b1a0/app.js",
      "https://mail.example/magic-link/mlk/redeem https://site.example/invite/team-42 https://id.example/auth/callback/state",
      "https://files.example/s/aB3dE5gH7jK9/report.pdf https://ok.example/docs/getting-started/2026-10-21",
    ].join(" ") }), "");
    for (const secret of ["user", "pw@", "Zx9Qp2Lm7Vb4", "next", "9f8e7d6c5b4a39281706f5e4d3c2b1a0", "mlk", "redeem", "team-42", "callback", "state", "aB3dE5gH7jK9"]) expect(reason).not.toContain(secret);
    expect(reason).toContain("https://bank.example/verify/…/…");
    expect(reason).toContain("https://cdn.example/assets/…/app.js");
    expect(reason).toContain("https://files.example/s/…/report.pdf");
    expect(reason).toContain("https://ok.example/docs/getting-started/2026-10-21");
    expect(engineReason(JSON.stringify({ error: `x ${"https://a.example/p ".repeat(200)}` }), "").length).toBeLessThanOrEqual(500);
  });

  it("removes short numeric codes after a path segment, and everything after an otp, code, pin or 2fa word", () => {
    const reason = engineReason(JSON.stringify({ error: [
      "https://bank.example/otp/482913",
      "https://app.example/code/123456",
      "https://id.example/verify-phone/48291377",
      "https://id.example/2fa/setup/step",
      "https://id.example/pin/reset-it",
      "https://shop.example/orders/1234/receipt",
    ].join(" ") }), "");
    for (const secret of ["482913", "123456", "48291377", "setup", "step", "reset-it", "1234"]) expect(reason).not.toContain(secret);
    expect(reason).toContain("https://bank.example/otp/…");
    expect(reason).toContain("https://app.example/code/…");
    expect(reason).toContain("https://id.example/2fa/…/…");
    expect(reason).toContain("https://shop.example/orders/…/receipt");
    // A leading number, a longer one and a date stay readable.
    const kept = engineReason(JSON.stringify({ error: "https://news.example/2026/story https://ok.example/docs/getting-started/2026-10-21 https://ok.example/p/123 https://ok.example/codecs/list" }), "");
    expect(kept).toContain("https://news.example/2026/story");
    expect(kept).toContain("https://ok.example/docs/getting-started/2026-10-21");
    expect(kept).toContain("https://ok.example/p/123");
    expect(kept).toContain("https://ok.example/codecs/list");
  });
});

describe("Windows stops a daemon only when its image and start time match", () => {
  const EXE = "C:\\Murage\\agent-browser.exe";
  // the addon reports creation time as FILETIME seconds
  const at = (ms: number) => ({ exe: EXE, start: (ms + 11_644_473_600_000) / 1000 });
  it("checks the recorded start time when one was recorded for this pid", () => {
    expect(windowsDaemonStopDecision(at(1_760_000_000_123), EXE, { recordedMs: 1_760_000_000_123 })).toBe("stop");
    expect(() => windowsDaemonStopDecision({ ...at(1_760_000_000_123), exe: "C:\\Other\\x.exe" }, EXE, { recordedMs: 1_760_000_000_123 })).toThrow(/identity changed/);
    expect(() => windowsDaemonStopDecision(at(1_760_000_002_000), EXE, { recordedMs: 1_760_000_000_123 })).toThrow(/start time changed/);
    expect(windowsDaemonStopDecision(undefined, EXE, { recordedMs: 1 })).toBe("gone");
  });
  it("otherwise needs a process that was already running when the pid file was written", () => {
    // A pid Windows handed to a newer process started after the file was written is never stopped.
    expect(() => windowsDaemonStopDecision(at(1_760_000_002_001), EXE, { pidFileWrittenMs: 1_760_000_000_000 })).toThrow(/does not match its pid file/);
    expect(() => windowsDaemonStopDecision(at(1_759_999_939_999), EXE, { pidFileWrittenMs: 1_760_000_000_000 })).toThrow(/does not match its pid file/);
    expect(windowsDaemonStopDecision(at(1_760_000_001_000), EXE, { pidFileWrittenMs: 1_760_000_000_000 })).toBe("stop");
  });
});

describe("a command that has to start the engine gets the start bound", () => {
  it("lets a relaunch after the engine's idle exit take longer than a running engine's command", async () => {
    const { native } = scriptEngine(slowSuccess(1200), { commandBoundMs: 300, startBoundMs: 10_000 });
    // No daemon pid file: this command starts the engine.
    await expect(native.command(["get", "cdp-url"])).resolves.toMatchObject({ port: 1 });
  }, 20_000);

  it("keeps the shorter bound for a running engine, and logs why it stopped a command", async () => {
    const logged = captureLog();
    const { dir, native } = scriptEngine(slowSuccess(3000), { commandBoundMs: 300, startBoundMs: 10_000 });
    // A live process stands in for this session's running daemon. Nothing here ever stops it.
    writeFileSync(join(dir, "handback.pid"), String(process.pid));
    await expect(native.command(["stream", "status"])).rejects.toMatchObject({ kind: "timeout" });
    expect(logged.find(entry => entry.includes("[browser]"))).toMatch(/"stream status" failed \(stopped after 300 ms, its bound for a running engine\)/);
  }, 20_000);

  it("logs that it stopped a command mid-start when even the start bound runs out", async () => {
    const logged = captureLog();
    const { native } = scriptEngine(`process.stderr.write("launching Chrome\\n");\n${slowSuccess(3000)}`, { commandBoundMs: 100, startBoundMs: 300 });
    await expect(native.command(["get", "cdp-url"])).rejects.toMatchObject({ kind: "timeout" });
    const line = logged.find(entry => entry.includes("[browser]"));
    expect(line).toMatch(/stopped after 300 ms, its bound for starting the engine/);
    expect(line).toContain("launching Chrome");
  }, 20_000);
});

// A stuck daemon: ordinary commands never answer; only a launch-bound close receipt can stop it.
const STUCK_DAEMON = `const net = require("node:net"), fs = require("node:fs"), path = require("node:path");
const [dir, session, idleMs] = process.argv.slice(2);
if (Number(idleMs) > 0) setTimeout(() => process.exit(0), Number(idleMs));
const server = net.createServer(socket => {
  let pending = '';
  socket.on('data', chunk => {
    pending += chunk;
    if (!pending.includes('\\n')) return;
    try {
      const request = JSON.parse(pending.split('\\n')[0]);
      const owner = JSON.parse(fs.readFileSync(path.join(dir, session + '.owner.json'), 'utf8'));
      if (request.action === 'close' && request.closeOnly === true && request.launchId === owner.launchId) {
        socket.end(JSON.stringify({ success: true, data: { closed: true, launchId: owner.launchId } }) + '\\n', () => process.exit(0));
      }
    } catch { /* ordinary commands and unowned requests stay stuck */ }
  });
});
const ready = () => { fs.writeFileSync(path.join(dir, session + ".pid"), String(process.pid)); process.stdout.write("ready\\n"); };
if (process.platform === "win32") server.listen(0, "127.0.0.1", () => { fs.writeFileSync(path.join(dir, session + ".port"), String(server.address().port)); ready(); });
else server.listen(path.join(dir, session + ".sock"), ready);
`;
async function stuckDaemon(dir: string, session: string, idleMs = 0) {
  const script = join(dir, `daemon-${session}.cjs`);
  writeFileSync(script, STUCK_DAEMON);
  const child = spawn(process.execPath, [script, dir, session, String(idleMs)], { windowsHide: true, stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  await new Promise<void>((done, fail) => { child.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("ready")) done(); }); child.once("exit", () => fail(new Error("daemon fixture exited"))); });
  return child;
}
const exited = (child: ChildProcess, ms: number) => new Promise<boolean>(done => {
  if (child.exitCode !== null || child.signalCode !== null) return done(true);
  const timer = setTimeout(() => done(false), ms);
  child.once("exit", () => { clearTimeout(timer); done(true); });
});

// A fresh recovery close now refuses immediately without an ownership record.
// Settle the complete close under fake time and assert neither recorded pid is signalled.
const closeWithoutOwnershipRecord = async (dir: string): Promise<unknown> => {
  const spec = { command: process.execPath, args: [], env: { PATH: process.env.PATH ?? "", HOME: dir, AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "handback", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "" } : {}) } };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const closing = createNativeBrowser(spec, { closeOnly: true }).close().then(() => null, (error: unknown) => error ?? new Error("close rejected"));
    await vi.advanceTimersByTimeAsync(75_000);
    return await closing;
  } finally { vi.useRealTimers(); }
};
const alive = (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  try { process.kill(child.pid!, 0); return true; } catch { return false; }
};

describe("Reopen blank page on a fresh server meets a stuck daemon", () => {
  it("with no ownership record, signals neither this session's daemon nor another's", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = temp();
    const ours = await stuckDaemon(dir, "handback");
    const theirs = await stuckDaemon(dir, "another");
    const refusal = await closeWithoutOwnershipRecord(dir);
    expect(String((refusal as Error | null)?.message ?? refusal)).toMatch(/ownership is unconfirmed/);
    expect(alive(ours)).toBe(true);
    expect(alive(theirs)).toBe(true);
    expect(await exited(ours, 300)).toBe(false);
  }, 30_000);

  it("a restored matching daemon identity can stop this session's stuck daemon only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = temp();
    const ours = await stuckDaemon(dir, "handback");
    const theirs = await stuckDaemon(dir, "another");
    const spec = { command: process.execPath, args: [], env: { PATH: process.env.PATH ?? "", HOME: dir, AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "handback", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}) } };
    const identity = await captureDaemonIdentity(ours.pid!, spec.command);
    expect(identity).toBeDefined();
    const entry = process.platform === "darwin" ? nativeProcessList()?.find(row => row.pid === ours.pid) : undefined;
    if (process.platform === "darwin") expect(entry?.start).toBeTypeOf("number");
    const start = process.platform === "linux" ? `${identity!.bootId}:${identity!.start}`
      : process.platform === "darwin" ? `${Math.floor(entry!.start!)}.${String(Math.round((entry!.start! % 1) * 1e6)).padStart(6, "0")}` : identity!.start;
    writeFileSync(join(dir, "handback.owner.json"), JSON.stringify({ v: 1, session: "handback", launchId: "0123456789abcdef",
      daemon: { pid: ours.pid, start, exe: realpathSync(process.execPath) }, group: { kind: process.platform === "win32" ? "job" : "sid" } }));
    const native = createNativeBrowser(spec, { closeOnly: true }); native.seedDaemonIdentity!(identity!);
    const run = vi.spyOn(ownedCloseCli, "run").mockImplementation(async () => {
      ours.kill();
      return { code: 0, stdout: JSON.stringify({ launchId: "0123456789abcdef", closed: true,
        groupExhausted: true, treeExhausted: true, outsideSeen: 0, unconfirmed: null }) };
    });
    await native.close();
    expect(run).toHaveBeenCalledWith(spec, "0123456789abcdef");
    expect(await exited(ours, 5000)).toBe(true);
    expect(await exited(theirs, 200)).toBe(false);
  }, 30_000);

  it("never stops another session's daemon named by a stale pid file", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = temp();
    const theirs = await stuckDaemon(dir, "another");
    // This session's daemon is gone; its stale pid file now names a pid another session's daemon holds.
    writeFileSync(join(dir, "handback.pid"), String(theirs.pid));
    const spec = { command: process.execPath, args: [], env: { PATH: process.env.PATH ?? "", HOME: dir, AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "handback", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}) } };
    await expect(createNativeBrowser(spec, { closeOnly: true }).close()).rejects.toThrow("ownership is unconfirmed");
    const refusal = await closeWithoutOwnershipRecord(dir);
    expect(String((refusal as Error | null)?.message ?? refusal)).toMatch(/ownership is unconfirmed/);
    expect(alive(theirs)).toBe(true);
    expect(await exited(theirs, 500)).toBe(false);
  }, 30_000);
});

it("refuses an unreachable legacy daemon and leaves both sessions running", async () => {
  const dir = temp();
  const ours = await stuckDaemon(dir, "handback");
  const theirs = await stuckDaemon(dir, "another");
  const spec = { command: process.execPath, args: [], env: { PATH: process.env.PATH ?? "", HOME: dir,
    AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "handback" } };
  vi.spyOn(ownedCloseCli, "run").mockResolvedValue({ code: 3, stdout: JSON.stringify({ launchId: null,
    closed: false, error: "daemon_unresponsive", saveStatus: "lost" }) });
  await expect(createNativeBrowser(spec).close()).rejects.toMatchObject({ code: "daemon_unresponsive" });
  expect(await exited(ours, 200)).toBe(false); expect(await exited(theirs, 200)).toBe(false);
}, 30_000);

describe("legacy close receipt observes daemon exit without signal authority", () => {
  it("observes a legacy daemon's idle exit without signalling it or another session", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = temp();
    const ours = await stuckDaemon(dir, "handback", 1000);
    const theirs = await stuckDaemon(dir, "another");
    const spec = { command: process.execPath, args: [], env: { PATH: process.env.PATH ?? "", HOME: dir, AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "handback", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}) } };
    // No command ever answered on this server, so no daemon pid was captured.
    vi.spyOn(ownedCloseCli, "run").mockResolvedValue({ code: 0, stdout: JSON.stringify({ launchId: null, closed: true, groupExhausted: true, outsideSeen: 0, unconfirmed: null }) });
    await createNativeBrowser(spec).close();
    expect(await exited(ours, 5000)).toBe(true);
    expect(ours.exitCode).toBe(0);
    expect(ours.signalCode).toBeNull();
    expect(await exited(theirs, 200)).toBe(false);
  }, 30_000);

  it("never stops another session's daemon named by a stale pid file", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = temp();
    const theirs = await stuckDaemon(dir, "another");
    // This session's daemon is gone; its stale pid file now names a pid another session's daemon holds.
    writeFileSync(join(dir, "handback.pid"), String(theirs.pid));
    const spec = { command: process.execPath, args: [], env: { PATH: process.env.PATH ?? "", HOME: dir, AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "handback", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}) } };
    vi.spyOn(ownedCloseCli, "run").mockResolvedValue({ code: 0, stdout: JSON.stringify({ launchId: null, closed: true, groupExhausted: true, outsideSeen: 0, unconfirmed: null }) });
    let closed = false;
    const closing = createNativeBrowser(spec).close().then(() => { closed = true; });
    expect(await exited(theirs, 500)).toBe(false);
    expect(closed).toBe(false);
    // A legacy pid file confers no authority. Only the fixture owner ends this child;
    // close merely observes that its pinned identity has gone.
    theirs.kill();
    await closing;
  }, 30_000);
});
