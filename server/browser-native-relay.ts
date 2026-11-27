import { withHideInherit } from "../shared/win-hide-child-process.mjs";
import { closeOwnedBrowser } from "./browser-owned-close.ts";
// Harness-owned transport for pinned agent-browser 0.36.0. Its raw localhost
// stream has NO authentication: this relay protects network clients, not other
// processes running with the same OS identity. Never disclose its port in APIs.
import { USER_CHROME_ALLOW_WAIT_MS, userChromeAttachLog } from "./user-chrome.ts";
import { writeFileSync } from "./counted-fs.ts";
import { existsSync, readFileSync } from "node:fs";
import { captureDaemonIdentity, judgeDaemonIdentity, type DaemonIdentity } from './browser-daemon-identity.ts';
import { join } from "node:path";
import { spawn } from "node:child_process";
import { nativeProcessList } from "./drivers/win-process-table.ts";
import type { NativeProcess } from "./engine-exclusion.ts";
import { spawnCloudBrowser } from "./cloud-home/browser-process.ts";
import { prepareCloudBrowserRestore, type CloudBrowserLaunch, type CloudRestoreSession } from "./cloud-home/browser-restore.ts";
import { cloudRelayConnection } from "./cloud-home/browser-relay.ts";
import { closeAgentBrowserSession, closeCapability } from "./browser-engine.ts";
import WebSocket from "ws";
import { ensureBrowserSandboxAccess } from "./browser-sandbox.ts";
import { BrowserDocumentGuard } from "./browser-document-guard.ts";
import type { AgentBrowserSpec } from "./browser-engine.ts";
import { startHeadlessEngine, type EngineClient } from "./drivers/headless-browser-proxy.ts";
import { closeSocketQuietly } from "./browser-socket-teardown.ts";
import { BrowserEngineError } from "./browser-engine-error.ts";
import { BROWSER_TAB_CLOSED, BROWSER_TAB_REPLACED } from "./browser-lock.ts";
import { isControlTokenMismatch, streamAuthHeaders } from "./browser-control-token.ts";
import { originOf, prepareBrowserRestore, restoreScript, type OriginStorage, type RestoreSession } from "./browser-restore-store.ts";

export type BrowserFrame = { seq: number; data: string; width: number; height: number };

export interface NativeBrowser {
  readonly daemonIdentity?: import('./browser-daemon-identity.ts').DaemonIdentity;
  seedDaemonIdentity?(identity: import('./browser-daemon-identity.ts').DaemonIdentity): void;
  /** `skip`: tabs left to the owner (protected); never looked at. */
  protected(armed?: boolean, skip?: ReadonlySet<string>): Promise<boolean>;
  /** The bot's pages (id, address) as the browser lists them, for the server only. Absent: tabs cannot be told apart. */
  pages?(): Promise<{ id: string; url: string }[]>;
  /** `internal`: a call Murage makes for itself (the reader's page reads inside one of the bot's steps, the new tab for a
   * protected page), not the bot's own step. `stepGen`: the tab the enclosing step began on (beginStep); once the bot's tab
   * has been replaced since, the call is not sent and throws. */
  request(method: string, params?: Record<string, unknown>, options?: { internal?: boolean; stepGen?: number }): Promise<unknown>;
  /** A bot step that makes its page calls itself (the mediated reader) begins here. `notice`: the plain-words reply the step
   * ends with instead of running (the bot's tab was replaced and it had not been told, or no tab can be opened). Else `gen`,
   * the tab the step runs on, to hand to its internal calls and to endStep. */
  beginStep?(name: string): Promise<{ notice: unknown } | { gen: number }>;
  /** The same step ended (it returned or threw). The plain-words reply that takes the place of its result when the bot's tab
   * was replaced or lost under it, else nothing. */
  endStep?(gen: number): Promise<unknown>;
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
export { BROWSER_TAB_CLOSED, BROWSER_TAB_REPLACED };
/** "Use my Chrome" pins the bot to its own tab (AGENT_BROWSER_PIN_TAB). Once that tab is closed, the engine refuses every
 * page command with code "tab_gone" until a new tab is bound, and remembers the closed tab across its restarts.
 * Returns the closed tab's id ("" when the engine did not name it), or undefined for any other answer. */
export function tabGoneTarget(response: unknown): string | undefined {
  const value = response as { code?: unknown; error?: unknown; data?: { targetId?: unknown } | null } | null;
  if (!value || typeof value !== "object") return undefined;
  if (value.code !== "tab_gone" && !(typeof value.error === "string" && value.error.startsWith("tab_gone:"))) return undefined;
  return typeof value.data?.targetId === "string" ? value.data.targetId : "";
}
/** The same answer as the engine's tool server hands it to the bot. */
function tabGoneReply(reply: unknown): string | undefined {
  const value = reply as { isError?: unknown; structuredContent?: { response?: unknown }; content?: Array<{ text?: unknown }> } | null;
  if (!value || typeof value !== "object" || value.isError !== true) return undefined;
  const text = Array.isArray(value.content) ? value.content.find(item => typeof item?.text === "string")?.text : undefined;
  // The words alone count only when the engine sent no structured answer.
  return value.structuredContent?.response == null ? tabGoneTarget({ error: text }) : tabGoneTarget(value.structuredContent.response);
}
/** Steps that give the bot a page of its own choosing: after one of them there is nothing left to tell about the new tab. */
const TAB_NOTICE_MOOT = new Set(["agent_browser_open", "agent_browser_tab_new", "agent_browser_close"]);
/** The engine answers these with or without a bound tab, so their success says nothing about the bot's tab. */
const TABLESS_TOOLS = new Set(["agent_browser_tab_new", "agent_browser_tab_list", "agent_browser_close"]);
const tablessCommand = (args: string[]) => args[0] === "tab" || args[0] === "stream" || args[0] === "close" || (args[0] === "get" && args[1] === "cdp-url");
/** New tabs Murage opens by itself for one closed tab before it stops and says so. */
const TAB_REPLACE_STRIKES = 2;
/** While the engine keeps refusing, the bot's steps make Murage try one more new tab at most this often. */
export const BROWSER_TAB_RETRY_MS = 30_000;
/** A command to an engine that is already running. */
export const BROWSER_COMMAND_BOUND_MS = 20_000;
/** A command that has to launch the engine first: its first use, or the first
 * command after the engine's 60 s idle exit (browser-engine.ts), which starts
 * Chrome again and restores the session. Measured on hetzner-dsm (2026-10-21,
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
  /** Recovery must receive an acknowledgement even when this relay never launched anything. */
  closeOnly?: boolean;
  commandBoundMs?: number; startBoundMs?: number;
  /** Arguments placed before the engine's own, for an engine run through an
   * interpreter (a test runs a script with process.execPath on every OS). */
  cliPrefix?: string[];
  /** Test seam for BROWSER_TAB_RETRY_MS. */
  tabRetryMs?: number;
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
  // A DevTools address can carry the token of Murage's connection to the owner's Chrome: never logged.
  const said = reason.replace(/\bwss?:\/\/\S+/giu, "ws://…");
  console.error(`[browser] engine command "${verbs}" failed (${how})${said ? `: ${said}` : ""}`);
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
  let closeAcknowledged = false;
  let retired = false;
  const commands = new Set<ReturnType<typeof spawn>>();
  const active = () => { if (retired) throw Object.assign(new Error('Browser session is closing'), { status: 409, code: 'browser_closing' }); };
  /** BRTOKEN19: a daemon a previous launch left running holds an older control token. One recovery per session, then the failure stands. */
  let staleRecovered = false;
  let streamId = "";
  let daemonPid: number | undefined;
  let daemonIdentity: DaemonIdentity | undefined;
  const pidFile = join(spec.env.AGENT_BROWSER_SOCKET_DIR!, `${spec.env.AGENT_BROWSER_SESSION}.pid`);
  const startFile = join(spec.env.AGENT_BROWSER_SOCKET_DIR!, `${spec.env.AGENT_BROWSER_SESSION}.murage-start`);
  let startRecordedFor: number | undefined;
  /** Windows: once a command answered, the daemon named by the pid file is this session's; record when it started. */
  const recordDaemonStart = async () => {
    const pid = daemonPid;
    daemonIdentity = pid === undefined ? undefined : await captureDaemonIdentity(pid, spec.command);
    if (process.platform !== "win32" || pid === undefined || !Number.isSafeInteger(pid) || pid <= 0 || startRecordedFor === pid) return;
    startRecordedFor = pid;
    // The native process list (no PowerShell): the daemon's own creation time.
    const entry = nativeProcessList()?.find((candidate) => candidate.pid === pid);
    const ms = entry ? nativeStartMs(entry) : null;
    if (!entry || (entry.exe ?? "").toLowerCase() !== spec.command.toLowerCase() || ms === null || !Number.isSafeInteger(ms) || ms <= 0) { startRecordedFor = undefined; return; }
    try { writeFileSync(startFile, `${pid} ${ms}`, { mode: 0o600 }); } catch { startRecordedFor = undefined; }
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
  /** An engine process that ended (crashed, killed, idle exit, failed initialize) refuses every later request.
   * Forget it so the next request starts a fresh one; a close in progress keeps it (close owns that teardown). */
  const forgetEndedEngine = () => {
    if (!client || closing || !client.ended?.()) return false;
    const dead = client; client = undefined; initialized = undefined;
    void dead.close().catch(() => {});
    return true;
  };
  const startEngine = async () => {
    await ensureBrowserSandboxAccess(spec); active();
    if (forgetEndedEngine()) console.warn("[browser] engine process had ended; starting a fresh one");
    if (!initialized) {
      closeAcknowledged = false;
      const started = client = startHeadlessEngine(spec, null);
      const attempt: Promise<void> = started.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "murage-browser", version: "1" } }).then(() => {});
      initialized = attempt;
      // A failed initialize is never cached for the life of the app: the next request starts again.
      attempt.catch(() => { if (initialized === attempt && client === started && !closing) { client = undefined; initialized = undefined; void started.close().catch(() => {}); } });
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
    active();
    await warm(); await syncCloudRestore(); await ensureBrowserSandboxAccess(spec);
    beforeEngineStart();
    // The owner typed an address: its saved storage goes back first, as it does for the bot.
    if (args[0] === "open" && typeof args[1] === "string") {
      const origin = originOf(args[1]);
      await restoreBeforeOpen(args[1]).catch(() => false);
      // One attempt per run: an origin whose "/" lands elsewhere is not tried again.
      if (origin && restore?.pending(origin)) restore.abandoned(origin);
    }
    return onLiveTab(args).catch(async (error) => {
      // BRTOKEN19: the engine refused our control token (a stale daemon). The identity-checked stop `close()` performs, then the same command once more.
      if ((error as { staleControlToken?: boolean }).staleControlToken && !staleRecovered) {
        staleRecovered = true;
        await browser.close(); retired = false; closing = false;
        return onLiveTab(args).catch((again) => { if (cloudRestore) cloudSuspect = true; throw again; });
      }
      if (cloudRestore) cloudSuspect = true;
      throw error;
    });
  };
  // TABGONE-1021: the bot's pinned tab was closed (the owner closed it in their Chrome). Before this, the live view's attach,
  // Reopen blank page and every step of the bot failed until the session files were removed. One lifecycle for that tab, which
  // every way into the engine goes through (the owner's commands, the bot's steps, the reader's page calls, the new tab for a
  // protected page):
  //   gen         replacement tabs bound so far. told: the gen the bot knows about. The notice is owed while told < gen.
  //   replacing   Murage's own `tab new` in flight. Nothing is sent to the engine meanwhile: the engine may already be on the
  //               new tab while its answer is still on the way, and a bot step sent then would act on a tab it was not told about.
  //   last        the closed tab the replacement at `gen` was for. A refusal for it is old news only when its command was sent
  //               before that replacement; sent after, it proves the replacement did not take.
  //   strikes     tabs Murage opened since the engine last ran a page command. At two it stops and says so.
  //   refusingAt  set: no working tab. The bot's steps get BROWSER_TAB_CLOSED and one more try per tabRetryMs (twice as long
  //               after each try that fails). Such a try is told as a replacement only once the new tab has answered.
  //   attemptId   counts up each time Murage opens a tab or finds none working. A command notes it when it is sent, and its
  //               success says the tab is live only if nothing changed since: an answer that was on its way while the tab
  //               closed (a slow `get url` of the view's attach) is not news about the tabs opened after it.
  let gen = 0, told = 0, strikes = 0, attemptId = 0;
  let replacing: Promise<boolean> | undefined;
  let last: { target: string; gen: number } | undefined;
  let refusingAt: number | undefined;
  let retryAt = 0, retryWait = 0;
  let goneTarget = "";
  // A close ends the lifecycle: a replacement still in flight then changes nothing.
  let tabEpoch = 0;
  const tabRetryMs = options.tabRetryMs ?? BROWSER_TAB_RETRY_MS;
  // gen only ever counts up, so a step that began before a close can never mistake a later tab for its own.
  const resetTab = () => { tabEpoch++; told = gen; strikes = 0; last = undefined; refusingAt = undefined; retryAt = 0; retryWait = 0; goneTarget = ""; };
  /** The engine ran a command that needs the bot's tab: the tab is live. */
  const tabAnswered = (sentAt: number): boolean => { if (sentAt !== attemptId) return false; strikes = 0; refusingAt = undefined; retryWait = 0; return true; };
  /** No working tab. `wait`: the bot's steps leave it alone for tabRetryMs; false when the owner's command met it, so the
   * bot's next step tries (a wait already running is left as it is). `longer`: a try after the wait failed, so the next wait doubles. */
  const refusing = (wait: boolean, longer = false) => {
    const already = refusingAt !== undefined;
    attemptId++; refusingAt = Date.now();
    if (wait) { retryWait = longer && retryWait ? Math.min(retryWait * 2, tabRetryMs * 16) : retryWait || tabRetryMs; retryAt = refusingAt + retryWait; }
    else if (!already) retryAt = 0;
  };
  /** Murage's own `tab new`, one at a time. True once the new tab is bound. `checked`: a try after the wait, which counts
   * only once the engine has answered a page call on the new tab (an engine that takes `tab new` and still refuses is not a new tab). */
  const replaceTab = (target: string, wait: boolean, checked = false): Promise<boolean> => {
    strikes++; attemptId++;
    const epoch = tabEpoch;
    const attempt: Promise<boolean> = replacing = run(["tab", "new"]).then(async () => {
      if (checked && tabGoneReply(await call("agent_browser_get_url", {})) !== undefined) throw new Error("the new tab did not take");
    }).then(() => {
      if (epoch !== tabEpoch) return false;
      gen++; last = { target, gen }; refusingAt = undefined;
      console.warn("[browser] the bot's tab was closed; opened a new one");
      return true;
    }, () => { if (epoch === tabEpoch) refusing(wait, checked); return false; }).finally(() => { if (replacing === attempt) replacing = undefined; });
    return attempt;
  };
  /** The engine refused a command sent at `startGen` because the bot's tab `target` is closed. True when a tab is bound for
   * it now (the caller runs again or tells the bot); false when none could be. `open` false: this refusal opens no tab. */
  const tabGone = async (target: string, startGen: number, path: "owner" | "bot" | "internal", open = true): Promise<boolean> => {
    // No await between this wait and the decision below: two commands refused together open one tab, not one each.
    while (replacing) await replacing;
    if (closing) return false;
    goneTarget = target;
    // Sent before a replacement it missed: that tab is already bound, nothing to open.
    if (target !== "" ? last?.target === target && startGen < last.gen : startGen < gen) return refusingAt === undefined;
    if (!open) { refusing(false); return false; }
    if (path !== "owner") {
      // The owner's own command (the view, Reopen blank page) always gets its try; Murage's own tries for the bot are bounded.
      if (refusingAt !== undefined && Date.now() < retryAt) return false;
      if (refusingAt === undefined && strikes >= TAB_REPLACE_STRIKES) { refusing(true); return false; }
    }
    return replaceTab(target, path !== "owner");
  };
  /** The bot's step, before anything is sent (the caller has waited out a replacement, with no await since). The plain-words
   * reply that ends the step unsent, or nothing: send it. May await only while ENGINE-REFUSING, for the one more try. */
  const stepEntry = (name: string): undefined | unknown | Promise<unknown> => {
    if (refusingAt !== undefined) {
      // The bot asks for a tab itself: that is the recovery, sent as it is. So is anything else the engine answers without a tab.
      if (TABLESS_TOOLS.has(name)) return undefined;
      if (Date.now() < retryAt) return toldBot(BROWSER_TAB_CLOSED);
      // One more try. The step itself is not sent to find out: the engine refuses until a new tab is bound.
      return replaceTab(goneTarget, true, true).then((bound) => {
        if (!bound) return toldBot(BROWSER_TAB_CLOSED);
        told = gen;
        return TAB_NOTICE_MOOT.has(name) ? undefined : toldBot(BROWSER_TAB_REPLACED);
      });
    }
    if (told < gen) {
      // Told once. This step was meant for the page that is gone, so it does not run on the blank tab. Opening a page needs no telling.
      told = gen;
      if (!TAB_NOTICE_MOOT.has(name)) return toldBot(BROWSER_TAB_REPLACED);
    }
    return undefined;
  };
  /** One engine command; refused for a closed tab, it runs once more on a new one. A second refusal stands. */
  const onLiveTab = async (args: string[]): Promise<unknown> => {
    const once = async (open: boolean): Promise<{ value: unknown } | { error: unknown }> => {
      while (replacing) await replacing;
      const startGen = gen, sentAt = attemptId;
      try { const value = await run(args); if (!tablessCommand(args)) tabAnswered(sentAt); return { value }; }
      catch (error) {
        const gone = (error as { tabGone?: string }).tabGone;
        // Refused again on the new tab: it did not take. That is said plainly to the bot, and the next command opens another.
        if (gone === undefined || closing || !(await tabGone(gone, startGen, "owner", open)) || !open) throw error;
        return { error };
      }
    };
    const first = await once(true);
    if ("value" in first) return first.value;
    const second = await once(false);
    if ("value" in second) return second.value;
    throw second.error;
  };
  const run = (args: string[]): Promise<unknown> => new Promise((resolve, reject) => {
    active(); closeAcknowledged = false;
    // No daemon for this session yet (first use, or after its idle exit): this
    // command starts Chrome and restores the session, so it gets the start bound.
    const starting = !attached && !cloud && sessionPid() === null;
    const bound = attached ? USER_CHROME_ALLOW_WAIT_MS : starting ? startBoundMs : commandBoundMs;
    const started = Date.now();
    const child = spawnCloudBrowser(["--json", ...args], spec.env) ?? spawn(spec.command, [...(options.cliPrefix ?? []), "--json", ...args], withHideInherit({ env: spec.env, cwd: spec.env.HOME, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
    commands.add(child); child.once("close", () => commands.delete(child));
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
    child.once("close", async (code) => {
      clearTimeout(timer);
      const staleControlToken = isControlTokenMismatch(output) || isControlTokenMismatch(stderr);
      if (timedOut || overflow || code !== 0) {
        const kind = timedOut ? "timeout" : overflow ? "overflow" : "failed";
        // A timed-out command is stopped mid-way; the log says which bound it hit and whether it was starting the engine.
        const how = kind === "failed" ? `exit ${code}` : kind === "timeout" ? `stopped after ${bound} ms, its bound ${starting ? "for starting the engine" : attached ? "for the owner's Allow" : "for a running engine"}` : kind;
        logBrowserEngineFailure(args, how, kind === "overflow" ? "" : engineReason(output, stderr));
        let tabGone: string | undefined;
        if (kind === "failed") { try { tabGone = tabGoneTarget(JSON.parse(output.trim().split("\n").pop() ?? "")); } catch { /* not the engine's JSON: any other failure */ } }
        return reject(Object.assign(new BrowserEngineError(kind), { staleControlToken, ...(tabGone !== undefined ? { tabGone } : {}) }));
      }
      if (starting && Date.now() - started > 5_000) console.error(`[browser] engine took ${Date.now() - started} ms to start`);
      else if (starting && restore) console.log(`[browser] engine started in ${Date.now() - started} ms (restore store: ${restore.origins} origins, each restored on first visit)`);
      let value: { success?: unknown; data?: unknown };
      try { value = JSON.parse(output); }
      catch { logBrowserEngineFailure(args, "invalid result", ""); return reject(new Error("Browser returned an invalid command result")); }
      // The engine exited 0 but refused the command: keep its reason too.
      if (value?.success === false) { const tabGone = tabGoneTarget(value); logBrowserEngineFailure(args, "refused", engineReason(output, stderr)); return reject(Object.assign(new BrowserEngineError("refused"), { staleControlToken, ...(tabGone !== undefined ? { tabGone } : {}) })); }
      if (!cloud) { try { daemonPid = Number(readFileSync(pidFile, "utf8")); } catch {} await recordDaemonStart(); }
      engineAnswered();
      resolve(value?.data ?? value);
    });
  });
  const toldBot = (text: string) => ({ isError: true, content: [{ type: "text", text }] });
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
  // The owner's own Chrome: the live view's `stream status` never starts the
  // engine's browser, so nothing reached Chrome and the panel showed an empty
  // "Live" page. One command that needs the browser attaches it, once per engine
  // session, and every later step reuses that one approved connection.
  let attachedReady = false;
  let attaching: Promise<void> | undefined;
  const attach = (): Promise<void> => {
    if (!attached || attachedReady) return Promise.resolve();
    return attaching ??= (async () => {
      const started = Date.now();
      console.log(userChromeAttachLog("start"));
      const waiting = setTimeout(() => console.log(userChromeAttachLog("waiting-allow", Date.now() - started)), 3000);
      try {
        await command(["get", "url"]);
        // Murage's page check keeps a connection of its own, and Chrome asks for
        // that one too. Opened now, both prompts come while the owner is already
        // looking, instead of a second one at the bot's first step.
        await guard.warm().catch(() => console.error(userChromeAttachLog("failed", Date.now() - started, "guard")));
        attachedReady = true; console.log(userChromeAttachLog("connected", Date.now() - started));
      }
      catch (error) { console.error(userChromeAttachLog("failed", Date.now() - started, error instanceof BrowserEngineError && error.kind === "timeout" ? "timeout" : "engine")); throw error; }
      finally { clearTimeout(waiting); attaching = undefined; }
    })();
  };
  const guard = new BrowserDocumentGuard(command, { ...(attached ? { connectTimeoutMs: USER_CHROME_ALLOW_WAIT_MS } : {}), ...(spec.guardCdpUrl ? { endpoint: spec.guardCdpUrl } : {}), ...(spec.guardScope ? { scope: spec.guardScope } : {}), connection: cloudRelayConnection("cdp", spec.env) });
  const browser: NativeBrowser = {
    command,
    protected: (armed = true, skip) => guard.protected(armed, skip),
    pages: () => guard.pages(),
    async request(method, params, options) {
      if (method === "tools/call" && params?.name === "agent_browser_read") throw Error("Network read must use the mediated reader.");
      await warm();
      await syncCloudRestore();
      beforeEngineStart();
      await startEngine(); active();
      let reply: unknown;
      const step = method === "tools/call";
      const name = String(params?.name), bot = step && !options?.internal;
      const send = async (): Promise<unknown> => {
        // A dialog the page opens during the bot's call is answered by the guard's connection (see answerDialogs).
        if (step) guard.answerDialogs(true);
        try { return step && restore?.waiting() ? await restoringCall(params ?? {}) : await client!.request(method, params); }
        catch (error) {
          if (cloudRestore) cloudSuspect = true;
          // Listing tools reads and changes nothing, so an engine that died under it is replaced once and asked again.
          if (method !== "tools/list" || !forgetEndedEngine()) throw error;
          console.warn("[browser] engine process ended during tools/list; asking a fresh one");
          await startEngine(); active();
          return client!.request(method, params);
        }
        finally { if (step) guard.answerDialogs(false); }
      };
      // TABGONE-1021 (see the lifecycle above). Nothing is sent while a replacement is in flight, and from here to the send
      // there is no await unless a reply ends the step first.
      for (;;) {
        while (replacing) await replacing;
        // A close or a restart of the engine during that wait: start again, and wait again.
        active(); if (!client) { await startEngine(); continue; }
        if (!bot) break;
        const early = stepEntry(name);
        if (!(early instanceof Promise)) { if (early !== undefined) return early; break; }
        const ended = await early;
        if (ended !== undefined) return ended;
      }
      // A call Murage makes for itself inside a step that began on a tab since replaced is not sent: the step is over (endStep tells the bot).
      if (step && !bot && options?.stepGen !== undefined && options.stepGen !== gen) throw new Error("Browser tab was replaced during this step.");
      let startGen = gen, sentAt = attemptId;
      reply = await send();
      // The engine refused the step because the bot's tab was closed. A new tab is bound now and the bot is told so, in place of
      // the engine's advice to run a command line it does not have. Not replayed: its page is gone. Opening an address is the
      // one step that is: it goes on in the new tab. A call of Murage's own keeps the engine's answer, and its step tells the bot.
      let gone = step ? tabGoneReply(reply) : undefined;
      if (gone !== undefined && closing) { if (bot) reply = toldBot(BROWSER_TAB_CLOSED); }
      else if (gone !== undefined) {
        let bound = await tabGone(gone, startGen, bot ? "bot" : "internal");
        if (bot && bound && name === "agent_browser_open") {
          while (replacing) await replacing;
          told = gen; startGen = gen; sentAt = attemptId;
          reply = await send();
          gone = tabGoneReply(reply);
          if (gone === undefined) tabAnswered(sentAt);
          else bound = await tabGone(gone, startGen, "bot");
        }
        if (bot && gone !== undefined) { if (bound) told = gen; reply = toldBot(bound ? BROWSER_TAB_REPLACED : BROWSER_TAB_CLOSED); }
      } else if (step && !TABLESS_TOOLS.has(name)) tabAnswered(sentAt);
      // A new tab opened on request is a working tab. The bot's own is the tab it chose, so nothing is left to tell. Answered
      // after Murage opened another: that later tab is not the one the bot chose, so the notice stays owed.
      else if (step && name === "agent_browser_tab_new" && (reply as { isError?: unknown } | null)?.isError !== true) { if (tabAnswered(sentAt) && bot) told = gen; }
      // MCP-only sessions also start daemons. Capture their identity while
      // the answering process is alive, before client.close can retire it.
      if(!cloud){const pid=sessionPid();if(pid!==null){daemonPid=pid;await recordDaemonStart();}}
      active();engineAnswered();
      return reply;
    },
    async beginStep(name) {
      for (;;) {
        while (replacing) await replacing;
        const early = stepEntry(name);
        if (!(early instanceof Promise)) return early !== undefined ? { notice: early } : { gen };
        const ended = await early;
        if (ended !== undefined) return { notice: ended };
      }
    },
    async endStep(stepGen) {
      while (replacing) await replacing;
      // No working tab was left under the step, or its tab was replaced: whatever it read is not the page the bot meant.
      if (refusingAt !== undefined) return toldBot(BROWSER_TAB_CLOSED);
      if (gen === stepGen) return undefined;
      told = gen;
      return toldBot(BROWSER_TAB_REPLACED);
    },
    ownerReached(address) { const origin = originOf(address); if (origin) restore?.passed(origin); },
    async connect(onFrame, onUrl, onDisconnect) {
      active(); closing = false;
      if (socket?.readyState === WebSocket.OPEN) return streamId;
      const dial = async (): Promise<string> => {
      await attach();
      const result = await command(["stream", "status"]) as { port?: number; streamPort?: number };
      active();
      const port = result.port ?? result.streamPort;
      if (!Number.isInteger(port) || port! < 1 || port! > 65535) throw new Error("Browser returned an invalid stream port");
      streamId = String(port);
      const streamConnection = cloudRelayConnection("stream", spec.env);
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=10`, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: 5000, ...(streamAuthHeaders(spec.env) ? { headers: streamAuthHeaders(spec.env) } : {}), ...(streamConnection ? { createConnection: streamConnection as never } : {}) });
        socket = ws;
        let opened = false;
        ws.once("open", () => { opened = true; resolve(); });
        ws.on("error", (error) => reject(Object.assign(new Error("Browser stream unavailable"), { unauthorized: /\b401\b/u.test(String((error as Error)?.message)) })));
        // A failed handshake rejects dial(); it never established a stream to
        // disconnect. Notifying here would retire the controller generation
        // whose callbacks the internal 401 recovery still needs for live frames.
        ws.on("close", () => { if (socket === ws) socket = undefined; if (opened && !closing) onDisconnect(); });
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
      };
      try { return await dial(); }
      catch (error) {
        // BRTOKEN19: the stream refused our token, so the engine is a stale daemon from an earlier launch. One recovery, then the failure stands.
        if (!(error as { unauthorized?: boolean }).unauthorized || staleRecovered) throw error;
        staleRecovered = true;
        await browser.close(); retired = false; closing = false;
        return dial();
      }
    },
    input(event) {
      if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) throw new Error("Browser stream disconnected or busy");
      const events = browserInputEvents(event);
      for (const item of events) socket.send(JSON.stringify(item));
    },
    // The teardown that ended the owner's server mid-conversation in 0.1.57.
    // See browser-socket-teardown.ts for the crash and why the order matters.
    resetStream() { const old = socket; socket = undefined; closeSocketQuietly(old); },
    get daemonIdentity() { return daemonIdentity; },
    seedDaemonIdentity(identity) { daemonIdentity = identity; daemonPid = identity.pid; closeAcknowledged = false; },
    async close() {
      retired = true;
      if (closeAcknowledged) return;
      // Even an unused relay asks the maintenance CLI for an ownership receipt.
      closing = true; attachedReady = false; resetTab();
      guard.close();
      socket?.close(); socket = undefined;
      await Promise.all([...commands].map(child => new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.once('close', () => resolve()); child.kill('SIGKILL');
      })));
      await client?.close();
      if (process.env.MURAGE_CLOUD_ROLE === "home") {
        await closeAgentBrowserSession(spec);
        closeAcknowledged = true; client = undefined; initialized = undefined; warmed = undefined; return;
      }
      // Recovery may not treat a missing ownership record as proof that an old process is ours.
      const ownerFile = join(spec.env.AGENT_BROWSER_SOCKET_DIR!, `${spec.env.AGENT_BROWSER_SESSION}.owner.json`);
      if (options.closeOnly && !existsSync(ownerFile)) {
        const legacyPanel = spec.env.AGENT_BROWSER_LAUNCH_ID === undefined && "cap" in closeCapability(spec);
        if (!legacyPanel || !daemonIdentity || await judgeDaemonIdentity(daemonIdentity, spec.command) !== 'alive') {
          throw new Error('Browser ownership is unconfirmed; try closing it again');
        }
      }
      if (daemonIdentity && existsSync(ownerFile)) {
        const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
        if (owner?.daemon?.pid !== daemonIdentity.pid || await judgeDaemonIdentity(daemonIdentity, spec.command) !== 'alive') {
          throw new Error('Browser daemon identity could not be checked');
        }
      }
      // Preserve launch-bound ownership and descendant exhaustion checks for shutdown.
      await closeOwnedBrowser(spec, sessionPid());
      closeAcknowledged = true; daemonPid = undefined; daemonIdentity = undefined; client = undefined; initialized = undefined;

    },
  };
  return browser;
}
