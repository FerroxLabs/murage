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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedBrowserController, BROWSER_NOT_RUNNING } from "./browser-control.ts";
import { browserOwnerRequest } from "./browser-owner-api.ts";
import { BrowserEngineError, createNativeBrowser, engineReason, windowsDaemonStopDecision, type NativeBrowser, type NativeBrowserOptions } from "./browser-native-relay.ts";
import { BROWSER_REFUSALS } from "./browser-lock.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

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

  it("Reopen blank page starts a fresh engine even when closing the stuck one fails", async () => {
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
    await expect(controller.reopen("petra", "desktop", status.generation)).resolves.toMatchObject({ protectedDocument: false });
    expect(made).toBe(2);
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

// A stuck daemon: it holds its session socket and pid file and never answers.
const STUCK_DAEMON = `const net = require("node:net"), fs = require("node:fs"), path = require("node:path");
const [dir, session] = process.argv.slice(2);
const server = net.createServer(() => {});
const ready = () => { fs.writeFileSync(path.join(dir, session + ".pid"), String(process.pid)); process.stdout.write("ready\\n"); };
if (process.platform === "win32") server.listen(0, "127.0.0.1", () => { fs.writeFileSync(path.join(dir, session + ".port"), String(server.address().port)); ready(); });
else server.listen(path.join(dir, session + ".sock"), ready);
`;
async function stuckDaemon(dir: string, session: string) {
  const script = join(dir, `daemon-${session}.cjs`);
  writeFileSync(script, STUCK_DAEMON);
  const child = spawn(process.execPath, [script, dir, session], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  await new Promise<void>((done, fail) => { child.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("ready")) done(); }); child.once("exit", () => fail(new Error("daemon fixture exited"))); });
  return child;
}
const exited = (child: ChildProcess, ms: number) => new Promise<boolean>(done => {
  if (child.exitCode !== null || child.signalCode !== null) return done(true);
  const timer = setTimeout(() => done(false), ms);
  child.once("exit", () => { clearTimeout(timer); done(true); });
});

describe("Reopen blank page on a fresh server meets a stuck daemon", () => {
  it("finds this session's daemon by its own pid file and socket, and stops only that one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = temp();
    const ours = await stuckDaemon(dir, "handback");
    const theirs = await stuckDaemon(dir, "another");
    const spec = { command: process.execPath, args: [], env: { PATH: process.env.PATH ?? "", HOME: dir, AGENT_BROWSER_SOCKET_DIR: dir, AGENT_BROWSER_SESSION: "handback", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}) } };
    // No command ever answered on this server, so no daemon pid was captured.
    await createNativeBrowser(spec).close();
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
    await createNativeBrowser(spec).close();
    expect(await exited(theirs, 500)).toBe(false);
  }, 30_000);
});
