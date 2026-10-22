// Harness-owned transport for pinned agent-browser 0.36.0. Its raw localhost
// stream has NO authentication: this relay protects network clients, not other
// processes running with the same OS identity. Never disclose its port in APIs.
import { USER_CHROME_ALLOW_WAIT_MS } from "./user-chrome.ts";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { connect as connectSocket } from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { nativeProcessList } from "./drivers/win-process-table.ts";
import type { NativeProcess } from "./engine-exclusion.ts";
import { spawnCloudBrowser } from "./cloud-home/browser-process.ts";
import { prepareCloudBrowserRestore, type CloudBrowserLaunch, type CloudRestoreSession } from "./cloud-home/browser-restore.ts";
import { cloudRelayConnection } from "./cloud-home/browser-relay.ts";
import { closeAgentBrowserSession } from "./browser-engine.ts";
import WebSocket from "ws";
import { ensureBrowserSandboxAccess } from "./browser-sandbox.ts";
import { BrowserDocumentGuard } from "./browser-document-guard.ts";
import type { AgentBrowserSpec } from "./browser-engine.ts";
import { startHeadlessEngine, type EngineClient } from "./drivers/headless-browser-proxy.ts";
import { closeSocketQuietly } from "./browser-socket-teardown.ts";
import { BrowserEngineError } from "./browser-engine-error.ts";
import { originOf, prepareBrowserRestore, restoreScript, type OriginStorage, type RestoreSession } from "./browser-restore-store.ts";

export type BrowserFrame = { seq: number; data: string; width: number; height: number };

export interface NativeBrowser {
  protected(armed?: boolean): Promise<boolean>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  command(args: string[]): Promise<unknown>;
  connect(onFrame: (frame: BrowserFrame) => void, onUrl: (url: string) => void, onDisconnect: () => void): Promise<string>;
  input(event: Record<string, unknown>): void;
  resetStream(): void;
  /** The owner's view reached this address while they held control: what they do there wins over saved storage. */
  ownerReached?(address: string): void;
  close(): Promise<void>;
}
export function browserInputEvents(event: Record<string, unknown>): Record<string, unknown>[] {
  return event.type === "input_keyboard" && event.eventType === "char" && typeof event.text === "string"
    ? Array.from(event.text).map(text => ({ type: "input_keyboard", eventType: "keyDown", key: text, text, modifiers: event.modifiers ?? 0 }))
    : [event];
}
export { BROWSER_ENGINE_COPY, BrowserEngineError, browserEngineDown } from "./browser-engine-error.ts";
/** A command to an engine that is already running. */
export const BROWSER_COMMAND_BOUND_MS = 20_000;
/** A command that has to launch the engine first: its first use, or the first
 * command after the engine's 60 s idle exit (browser-engine.ts), which starts
 * Chrome again and restores the session. Measured on build-host (2026-10-21,
 * agent-browser 0.36.0, Chromium 1243, restore on): 0.38 to 0.61 s, and 0.83
 * to 0.99 s pinned to one core. A packaged Mac app can take far longer on the
 * first launch after an idle exit, when the OS checks the bundled Chrome
 * again, and 20 s was not enough there. 60 s leaves that room. */
export const BROWSER_START_BOUND_MS = 60_000;
/** Cloud home: while the browser is in use, the relay checks at most this often whether its browser host
 * restarted (a new restore generation) without the relay knowing, e.g. after an idle exit. */
export const CLOUD_RESTORE_REFRESH_MS = 60_000;
/** After an engine request failed, the soonest the relay asks the launcher whether the host restarted. */
export const CLOUD_RESTORE_SUSPECT_MS = 5_000;
export type NativeBrowserOptions = {
  commandBoundMs?: number; startBoundMs?: number;
  /** Arguments placed before the engine's own, for an engine run through an
   * interpreter (a test runs a script with process.execPath on every OS). */
  cliPrefix?: string[];
  /** Test seam: how the Cloud restore requests reach the launcher (default spawnCloudBrowser). */
  cloudLaunch?: CloudBrowserLaunch;
};
// Path words after which the rest of an address is a code or a token.
const TOKEN_PATH_WORD = /^(?:reset|verify|token|auth|magic|invite|(?:otp|code|pin|2fa)(?:$|[-_.]))/iu;
/** A path segment that looks like a token: long, or letters and digits mixed. */
function tokenLike(segment: string): boolean {
  return segment.length >= 24 || (segment.length >= 12 && /\d/u.test(segment) && /[a-z]/iu.test(segment));
}
/** A short numeric code after another path segment (/otp/482913, /code/123456). */
const SHORT_CODE = /^\d{4,8}$/u;
/** An address as the log keeps it: no user, query or fragment, and no path
 * segment that looks like a token, is a 4 to 8 digit code after another
 * segment, or follows a reset, verify, token, auth, magic, invite, otp, code,
 * pin or 2fa word. */
export function redactAddress(address: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)/iu.exec(address);
  if (!match) return address;
  const [, scheme, authority, path] = match;
  let after = false;
  let seen = false;
  const segments = path!.split("/").map(segment => {
    if (!segment) return segment;
    const first = !seen;
    seen = true;
    if (after || tokenLike(segment) || (!first && SHORT_CODE.test(segment))) return "…";
    if (TOKEN_PATH_WORD.test(segment)) after = true;
    return segment;
  });
  return `${scheme}${authority!.replace(/^[^@]*@/u, "")}${segments.join("/")}`;
}
// Only the command's verbs are logged, never an address or typed value.
const LOGGED_VERBS = new Set(["stream", "status", "get", "cdp-url", "open", "close", "eval", "box", "value"]);
/** The engine's reason: its JSON `error` when it printed one, else the end of stderr.
 * One bounded line, with the query and fragment of any address removed. */
export function engineReason(stdout: string, stderr: string): string {
  let reason = "";
  try { const value = JSON.parse(stdout.trim().split("\n").pop() ?? ""); if (typeof value?.error === "string") reason = value.error; } catch {}
  if (!reason) reason = stderr.trim().split("\n").slice(-3).join(" ");
  return reason.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']*/giu, redactAddress).replace(/\s+/gu, " ").slice(0, 500);
}
function logBrowserEngineFailure(args: string[], how: string, reason: string) {
  const verbs = args.slice(0, 2).map(arg => LOGGED_VERBS.has(arg) ? arg : "…").join(" ");
  console.error(`[browser] engine command "${verbs}" failed (${how})${reason ? `: ${reason}` : ""}`);
}
/** Windows: the daemon's start time as the stop checks it. Recorded once a command proved
 * the pid is this session's; until then, the pid file's own write time stands in, because
 * the engine writes it as its first step (daemon.rs). */
export type DaemonStartCheck = { recordedMs: number } | { pidFileWrittenMs: number };
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;
/** A native process-list entry's creation time in epoch ms (the addon reports FILETIME seconds), or null. */
export function nativeStartMs(entry: Pick<NativeProcess, "start">): number | null {
  return typeof entry.start === "number" && entry.start > 0 ? Math.floor(Math.round(entry.start * 1e7) / 10_000) - FILETIME_EPOCH_OFFSET_MS : null;
}
/** Windows: stop this session's daemon only when its image is the engine and its start time
 * matches what this session knows of it. A stale .port another listener reused, plus a pid
 * Windows reused for some other process, is never stopped. "gone": no such process; "stop":
 * ours; anything else throws before anything is stopped. */
export function windowsDaemonStopDecision(entry: Pick<NativeProcess, "exe" | "start"> | undefined, command: string, start: DaemonStartCheck): "gone" | "stop" {
  if (!entry) return "gone";
  if ((entry.exe ?? "").toLowerCase() !== command.toLowerCase()) throw new Error("Browser daemon identity changed");
  const s = nativeStartMs(entry);
  if (s === null) throw new Error("Browser daemon identity could not be checked");
  if ("recordedMs" in start) { if (Math.abs(s - Math.round(start.recordedMs)) > 1000) throw new Error("Browser daemon start time changed"); }
  else if (s > Math.round(start.pidFileWrittenMs) + 2000 || s < Math.round(start.pidFileWrittenMs) - 60000) throw new Error("Browser daemon start time does not match its pid file");
  return "stop";
}
export function createNativeBrowser(spec: AgentBrowserSpec, options: NativeBrowserOptions = {}): NativeBrowser {
  const commandBoundMs = options.commandBoundMs ?? BROWSER_COMMAND_BOUND_MS;
  const startBoundMs = options.startBoundMs ?? BROWSER_START_BOUND_MS;
  let client: EngineClient | undefined;
  let socket: WebSocket | undefined;
  let initialized: Promise<void> | undefined;
  let closing = false;
  let streamId = "";
  let daemonPid: number | undefined;
  const pidFile = join(spec.env.AGENT_BROWSER_SOCKET_DIR!, `${spec.env.AGENT_BROWSER_SESSION}.pid`);
  const startFile = join(spec.env.AGENT_BROWSER_SOCKET_DIR!, `${spec.env.AGENT_BROWSER_SESSION}.murage-start`);
  let startRecordedFor: number | undefined;
  /** Windows: once a command answered, the daemon named by the pid file is this session's; record when it started. */
  const recordDaemonStart = () => {
    const pid = daemonPid;
    if (process.platform !== "win32" || pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || startRecordedFor === pid) return;
    startRecordedFor = pid;
    // The native process list (no PowerShell): the daemon's own creation time.
    const entry = nativeProcessList()?.find((candidate) => candidate.pid === pid);
    const ms = entry ? nativeStartMs(entry) : null;
    if (!entry || (entry.exe ?? "").toLowerCase() !== spec.command.toLowerCase() || ms === null || !Number.isSafeInteger(ms) || ms <= 0) { startRecordedFor = undefined; return; }
    try { writeFileSync(startFile, `${pid} ${ms}`, { mode: 0o600 }); } catch { startRecordedFor = undefined; }
  };
  /** What the stop checks the daemon's start time against. */
  const daemonStartCheck = (pid: number): DaemonStartCheck | undefined => {
    try {
      const [recordedPid, recordedMs] = readFileSync(startFile, "utf8").trim().split(" ").map(Number);
      if (recordedPid === pid && Number.isSafeInteger(recordedMs) && recordedMs! > 0) return { recordedMs: recordedMs! };
    } catch { /* not recorded yet */ }
    try { return { pidFileWrittenMs: statSync(pidFile).mtimeMs }; } catch { return undefined; }
  };
  // The owner's own Chrome: its first connections wait on the owner's Allow.
  const attached = Boolean(spec.env.AGENT_BROWSER_CDP);
  // Cloud home: every launcher request runs in its own scope, and a scope takes its
  // children with it when it ends. A one-shot command (`get cdp-url`, `stream status`)
  // that had to start the browser itself would therefore start one that dies with the
  // command, and the next request would meet a different browser. So the long-lived
  // engine starts the browser first, once, and every command after that finds it.
  const cloud = process.env.MURAGE_CLOUD_ROLE === "home";
  let warmed: Promise<void> | undefined;
  /** This session's daemon, from its own pid file: null when none is running. */
  const sessionPid = (): number | null => {
    let pid: number;
    try { pid = Number(readFileSync(pidFile, "utf8")); } catch { return null; }
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return pid; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : null; }
  };
  // The saved session (browser-restore-store.ts): split before the engine starts, so its
  // launch restores only cookies; each origin's storage goes back on the bot's first visit.
  let restore: RestoreSession | undefined;
  let prepared = false;
  const restoreManaged = !attached && !cloud && spec.env.AGENT_BROWSER_RESTORE_SAVE === "auto";
  // Cloud home: the saved session sits in the browser user's home, out of the server's reach, so the
  // launcher splits it (modes browser-restore and browser-restore-mark) whenever a browser host starts,
  // the server's first start and a restart after an idle exit alike. The relay keeps the snapshot of the
  // current host generation: it asks again before the engine first starts, at most every
  // CLOUD_RESTORE_REFRESH_MS while in use, and at once after a mark comes back stale (the host restarted).
  // Marks still queued are drained first; a new generation replaces the snapshot (every origin is eligible
  // again, the ones given up on included), the same one keeps this run's progress.
  const cloudRestore = !attached && cloud && spec.env.AGENT_BROWSER_RESTORE_SAVE === "auto";
  let cloudSession: CloudRestoreSession | undefined;
  let cloudRefreshedAt = -Infinity;
  let cloudStale = false;
  // A failed engine request may mean the browser host died and restarted behind the relay's back: the next
  // request asks the launcher for the current generation (at most every CLOUD_RESTORE_SUSPECT_MS).
  let cloudSuspect = false;
  let cloudRefreshing: Promise<void> | undefined;
  const refreshCloudRestore = async () => {
    await cloudSession?.drain();
    cloudRefreshedAt = Date.now();
    cloudStale = false;
    cloudSuspect = false;
    try {
      const next = await prepareCloudBrowserRestore(spec.env, undefined, options.cloudLaunch, session => { if (session === cloudSession) cloudStale = true; });
      // The snapshot is replaced only by a successful answer; a different generation retires the old one.
      if (!next || next.generation !== cloudSession?.generation) { cloudSession?.retire(); cloudSession = next; restore = next; }
      else next.retire();
    } catch (error) { console.error(`${(error as Error).message}`); /* the last valid snapshot stays: the engine state it stands for is already stripped */ }
  };
  const syncCloudRestore = async (force = false) => {
    if (!cloudRestore) return;
    const age = Date.now() - cloudRefreshedAt;
    if (!force && !cloudStale && !(cloudSuspect && age >= CLOUD_RESTORE_SUSPECT_MS) && age < CLOUD_RESTORE_REFRESH_MS) return;
    cloudRefreshing ??= refreshCloudRestore().finally(() => { cloudRefreshing = undefined; });
    await cloudRefreshing;
  };
  /** No daemon for this session: the next command starts one, which restores the saved session. */
  const beforeEngineStart = () => {
    if (!restoreManaged || prepared || sessionPid() !== null) return;
    prepared = true;
    try { restore = prepareBrowserRestore(spec); }
    catch (error) { restore = undefined; console.error(`[browser] restore store could not be prepared (${(error as Error).message}); the engine restores the saved session as before`); }
  };
  /** A command answered, so a daemon is running: the next one with no daemon prepares again. */
  const engineAnswered = () => { prepared = false; };
  const startEngine = async () => {
    await ensureBrowserSandboxAccess(spec);
    if (!initialized) {
      client = startHeadlessEngine(spec);
      initialized = client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "murage-browser", version: "1" } }).then(() => {});
    }
    await initialized;
  };
  const warm = (): Promise<void> => {
    if (!cloud) return Promise.resolve();
    warmed ??= (async () => {
      await syncCloudRestore(true);
      await startEngine();
      await client!.request("tools/call", { name: "agent_browser_open", arguments: { url: "about:blank" } });
    })().catch((error) => { warmed = undefined; throw error; });
    return warmed;
  };
  const command = async (args: string[]): Promise<unknown> => {
    await warm(); await syncCloudRestore(); await ensureBrowserSandboxAccess(spec);
    beforeEngineStart();
    // The owner typed an address: its saved storage goes back first, as it does for the bot.
    if (args[0] === "open" && typeof args[1] === "string") {
      const origin = originOf(args[1]);
      await restoreBeforeOpen(args[1]).catch(() => false);
      // One attempt per run: an origin whose "/" lands elsewhere is not tried again.
      if (origin && restore?.pending(origin)) restore.abandoned(origin);
    }
    return run(args).catch((error) => { if (cloudRestore) cloudSuspect = true; throw error; });
  };
  const run = (args: string[]): Promise<unknown> => new Promise((resolve, reject) => {
    // No daemon for this session yet (first use, or after its idle exit): this
    // command starts Chrome and restores the session, so it gets the start bound.
    const starting = !attached && !cloud && sessionPid() === null;
    const bound = attached ? USER_CHROME_ALLOW_WAIT_MS : starting ? startBoundMs : commandBoundMs;
    const started = Date.now();
    const child = spawnCloudBrowser(["--json", ...args], spec.env) ?? spawn(spec.command, [...(options.cliPrefix ?? []), "--json", ...args], { env: spec.env, cwd: spec.env.HOME, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, bound);
    // Kept (bounded) so a failure says why in the server log instead of vanishing.
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 2_000_000) { overflow = true; child.kill("SIGKILL"); }
      else output += chunk.toString();
    });
    child.once("error", () => { clearTimeout(timer); logBrowserEngineFailure(args, "could not start", ""); reject(new BrowserEngineError("start")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut || overflow || code !== 0) {
        const kind = timedOut ? "timeout" : overflow ? "overflow" : "failed";
        // A timed-out command is stopped mid-way; the log says which bound it hit and whether it was starting the engine.
        const how = kind === "failed" ? `exit ${code}` : kind === "timeout" ? `stopped after ${bound} ms, its bound ${starting ? "for starting the engine" : attached ? "for the owner's Allow" : "for a running engine"}` : kind;
        logBrowserEngineFailure(args, how, kind === "overflow" ? "" : engineReason(output, stderr));
        return reject(new BrowserEngineError(kind));
      }
      if (starting && Date.now() - started > 5_000) console.error(`[browser] engine took ${Date.now() - started} ms to start`);
      else if (starting && restore) console.log(`[browser] engine started in ${Date.now() - started} ms (restore store: ${restore.origins} origins, each restored on first visit)`);
      let value: { success?: unknown; data?: unknown };
      try { value = JSON.parse(output); }
      catch { logBrowserEngineFailure(args, "invalid result", ""); return reject(new Error("Browser returned an invalid command result")); }
      // The engine exited 0 but refused the command: keep its reason too.
      if (value?.success === false) { logBrowserEngineFailure(args, "refused", engineReason(output, stderr)); return reject(new BrowserEngineError("refused")); }
      if (!cloud) { try { daemonPid = Number(readFileSync(pidFile, "utf8")); } catch {} recordDaemonStart(); }
      engineAnswered();
      resolve(value?.data ?? value);
    });
  });
  const call = async (name: string, args: Record<string, unknown>) => { await startEngine(); return client!.request("tools/call", { name, arguments: args }); };
  const replyText = (reply: unknown) => JSON.stringify(reply) ?? "";
  /** Puts one origin's storage back on the page now showing it. True once it went back. */
  const putBack = async (origin: string, storage: OriginStorage) => {
    const done = /murage-restore-(?:done|partial)/u.test(replyText(await call("agent_browser_eval", { script: restoreScript(origin, storage) })));
    if (done) restore?.restored(origin);
    return done;
  };
  /** First visit this run to an origin with saved storage: land on it, put its storage
   * back, and only then load the page asked for, which reads it from its first script. */
  const restoreBeforeOpen = async (address: string): Promise<boolean> => {
    const origin = originOf(address);
    const storage = origin ? restore?.pending(origin) : undefined;
    if (!origin || !storage) return false;
    await call("agent_browser_open", { url: `${origin}/` });
    return putBack(origin, storage);
  };
  /** The bot reached an origin another way (a link, a redirect, a form): its storage goes back and the page loads again. */
  const restoreWhereLanded = async () => {
    if (!restore?.waiting()) return;
    const address = /https?:\/\/[^\s"'\\]+/u.exec(replyText(await call("agent_browser_get_url", {})))?.[0];
    const origin = address ? originOf(address) : undefined;
    const storage = origin ? restore.pending(origin) : undefined;
    if (!address || !origin || !storage) return;
    // The reload is a plain GET of the address. A page reached by a form POST that did not
    // redirect (no POST/redirect/GET) reloads as a GET of its address: the form is never sent again.
    if (await putBack(origin, storage)) await call("agent_browser_open", { url: address });
    // One attempt per run: an origin the storage could not go back into is not tried again.
    else restore.abandoned(origin);
  };
  const restoringCall = async (params: Record<string, unknown>): Promise<unknown> => {
    const name = String(params.name);
    const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
    const address = (name === "agent_browser_open" || name === "agent_browser_tab_new") && typeof args.url === "string" ? args.url : undefined;
    const origin = address ? originOf(address) : undefined;
    let reply: unknown;
    if (address && origin && restore?.pending(origin)) {
      // A new tab is opened blank first, so the landing happens in it, never in the bot's current page.
      if (name === "agent_browser_tab_new") { const { url: _url, ...blank } = args; reply = await call(name, blank); }
      await restoreBeforeOpen(address).catch(() => false);
      const opened = await call("agent_browser_open", { url: address });
      reply ??= opened;
    } else reply = await client!.request("tools/call", params);
    // Closing the browser leaves no page to look at, and asking would start it again.
    if (name !== "agent_browser_close") await restoreWhereLanded().catch(() => {});
    // One attempt per run: an origin whose pages land elsewhere (its "/" and the address
    // both redirect away) is not landed on again, and stops keeping waiting() true.
    if (origin && restore?.pending(origin)) restore.abandoned(origin);
    return reply;
  };
  const guard = new BrowserDocumentGuard(command, { ...(attached ? { connectTimeoutMs: USER_CHROME_ALLOW_WAIT_MS } : {}), connection: cloudRelayConnection("cdp", spec.env) });
  return {
    command,
    protected: (armed = true) => guard.protected(armed),
    async request(method, params) {
      await warm();
      await syncCloudRestore();
      beforeEngineStart();
      await startEngine();
      let reply: unknown;
      try { reply = method === "tools/call" && restore?.waiting() ? await restoringCall(params ?? {}) : await client!.request(method, params); }
      catch (error) { if (cloudRestore) cloudSuspect = true; throw error; }
      engineAnswered();
      return reply;
    },
    ownerReached(address) { const origin = originOf(address); if (origin) restore?.passed(origin); },
    async connect(onFrame, onUrl, onDisconnect) {
      closing = false;
      if (socket?.readyState === WebSocket.OPEN) return streamId;
      const result = await command(["stream", "status"]) as { port?: number; streamPort?: number };
      const port = result.port ?? result.streamPort;
      if (!Number.isInteger(port) || port! < 1 || port! > 65535) throw new Error("Browser returned an invalid stream port");
      streamId = String(port);
      const streamConnection = cloudRelayConnection("stream", spec.env);
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=10`, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: 5000, ...(streamConnection ? { createConnection: streamConnection as never } : {}) });
        socket = ws;
        ws.once("open", resolve);
        ws.on("error", () => reject(new Error("Browser stream unavailable")));
        ws.on("close", () => { if (socket === ws) socket = undefined; if (!closing) onDisconnect(); });
        ws.on("message", (raw) => {
          try {
            const value = JSON.parse(raw.toString());
            if (value.type === "frame" && typeof value.data === "string" && value.data.length <= 3_000_000 && Number.isSafeInteger(value.seq)) {
              onFrame({ seq: value.seq, data: value.data, width: value.metadata?.deviceWidth ?? 1280, height: value.metadata?.deviceHeight ?? 800 });
              ws.send(JSON.stringify({ type: "ack", seq: value.seq }));
            } else if (value.type === "url" && typeof value.url === "string") onUrl(value.url.slice(0, 8192));
          } catch { ws.close(1008); }
        });
      });
      return streamId;
    },
    input(event) {
      if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) throw new Error("Browser stream disconnected or busy");
      const events = browserInputEvents(event);
      for (const item of events) socket.send(JSON.stringify(item));
    },
    // The teardown that ended the owner's server mid-conversation in 0.1.57.
    // See browser-socket-teardown.ts for the crash and why the order matters.
    resetStream() { const old = socket; socket = undefined; closeSocketQuietly(old); },
    async close() {
      closing = true;
      guard.close();
      socket?.close(); socket = undefined;
      await client?.close();
      if (process.env.MURAGE_CLOUD_ROLE === "home") {
        await closeAgentBrowserSession(spec);
        client = undefined; initialized = undefined; warmed = undefined; return;
      }
      const endpoint = () => process.platform === "win32"
        ? { host: "127.0.0.1", port: Number(readFileSync(join(spec.env.AGENT_BROWSER_SOCKET_DIR!, `${spec.env.AGENT_BROWSER_SESSION}.port`), "utf8")) }
        : { path: join(spec.env.AGENT_BROWSER_SOCKET_DIR!, `${spec.env.AGENT_BROWSER_SESSION}.sock`) };
      const currentPid = sessionPid();
      let pid = daemonPid !== undefined && currentPid === daemonPid ? daemonPid : undefined;
      // No command has answered since this server started (a fresh server
      // meeting a stuck daemon), so no pid was captured. This session's own pid
      // file names its daemon only while this session's own socket still
      // accepts a connection: a stale pid file, or a pid reused by another
      // session's daemon, is never stopped.
      if (pid === undefined && currentPid !== null) {
        const ours = await new Promise<boolean>((done) => {
          let target: ReturnType<typeof endpoint>;
          try { target = endpoint(); } catch { done(false); return; }
          const probe = connectSocket(target, () => { clearTimeout(timer); probe.destroy(); done(true); });
          const timer = setTimeout(() => { probe.destroy(); done(false); }, 2000);
          probe.once("error", () => { clearTimeout(timer); done(false); });
        });
        if (ours) pid = currentPid;
      }
      if (pid !== undefined) {
        // Send directly to the existing daemon: CLI `close` performs startup
        // discovery and would create a new daemon after an idle timeout.
        // A stuck daemon may never answer `close`. It is still stopped below, so
        // Reopen blank page can start a fresh one instead of reaching it again.
        await new Promise<void>((done, fail) => {
          const transport = connectSocket(endpoint(), () => transport.write(JSON.stringify({ id: "murage-close", action: "close" }) + "\n"));
          let data = "";
          const timer = setTimeout(() => { transport.destroy(); fail(new Error("Browser session close timed out")); }, 5000);
          transport.on("data", chunk => {
            data += chunk.toString();
            if (data.length > 65536) { transport.destroy(); clearTimeout(timer); fail(new Error("Browser close response exceeded its bound")); return; }
            if (!data.includes("\n")) return;
            clearTimeout(timer); transport.destroy();
            try { const result = JSON.parse(data.split("\n")[0]!); result.success === true && result.data?.closed === true ? done() : fail(new Error("Browser session close was refused")); }
            catch { fail(new Error("Browser close response was invalid")); }
          });
          transport.once("error", () => { clearTimeout(timer); fail(new Error("Browser session close connection failed")); });
        }).catch((error: Error) => { console.error(`[browser] engine did not close cleanly (${error.message}); stopping it`); });
        if (process.platform === "win32") {
          // Image and start time both have to match, read from the native process list (no PowerShell, murage-releases #1): a pid
          // that is gone is done, one that now runs another program or started at another time is refused, ours is ended and must be
          // gone within 5 s. A pid file with neither a record nor a readable write time stops nothing.
          const start = daemonStartCheck(pid);
          if (!start) throw new Error("Browser daemon identity could not be checked");
          const same = (list: readonly NativeProcess[]) => list.find((entry) => entry.pid === pid);
          const first = nativeProcessList();
          if (!first) throw new Error("Browser daemon cleanup failed");
          if (windowsDaemonStopDecision(same(first), spec.command, start) === "stop") {
            try { process.kill(pid); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("Browser daemon cleanup failed"); }
            const until = Date.now() + 5000;
            for (;;) {
              const now = nativeProcessList();
              if (!now) throw new Error("Browser daemon cleanup failed");
              if (!same(now)) break;
              if (Date.now() >= until) throw new Error("Browser daemon is still running");
              await new Promise((resume) => setTimeout(resume, 100));
            }
          }
        } else {
          // The daemon PID is read back from this session's private runtime
          // directory, never supplied by a caller. One that ignores SIGTERM is
          // stopped with SIGKILL, so the fresh engine never meets it again.
          const stopped = (): boolean => { try { process.kill(pid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } };
          try { process.kill(pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          const deadline = Date.now() + 3000;
          while (!stopped() && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
          if (!stopped()) { console.error("[browser] engine did not stop on SIGTERM; stopping it with SIGKILL"); try { process.kill(pid, "SIGKILL"); } catch {} }
        }
      }
      daemonPid = undefined; client = undefined; initialized = undefined;

    },
  };
}
