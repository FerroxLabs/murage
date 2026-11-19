// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Engine sign-in relay (plan B2). A paired owner desktop signs an engine in or
// out through the vendor's own CLI. The CLI runs in the turn sandbox through
// the root launcher's `login` mode (fixed argv, deploy/cloud-home/murage-turn-launch.py)
// and its terminal streams are relayed over a WebSocket. The server never holds
// a vendor token: the CLI writes it into the engine home.
//
// The CLI gets a real terminal: the launcher's `pty` login mode allocates the
// pseudo-terminal itself (after dropping to the turn user) and shuttles it onto
// the pipes this relay holds, so an interactive CLI sees a tty and the server
// needs no native pty module. The pty merges stderr into stdout.
//
// Opened only from the cloud upgrade gate AFTER cloudRequestAuth (route class
// `engine-login`: owner-desktop session + step-up). Bytes are never logged:
// one start line and one end line carry identifiers and counts only.
import type { ChildProcess } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { cloudIdentity, isOwnerBrowser } from "../cloud-request-identity.ts";
import { spawnCloudLauncher } from "./bot-state.ts";
import { cloudHomeCopy } from "./copy.ts";

import { ENGINE_LOGIN_PATH, type EngineLoginEngine } from "./engine-login-engines.ts";
export { ENGINE_LOGIN_ENGINES, ENGINE_LOGIN_PATH, type EngineLoginEngine } from "./engine-login-engines.ts";
import { BOT_LOGIN_ENGINES, ENGINE_TICKET_QUERY, browserStdin, checkEngineLoginTarget, engineTicketRedeemedFor, type EngineLoginAction } from "./engine-login-target.ts";
export { ENGINE_LOGIN_ACTIONS, ENGINE_LOGIN_ENGINE_ACTIONS, type EngineLoginAction } from "./engine-login-target.ts";
const LOGIN_SECRET = /^[A-Za-z0-9._-]{20,512}$/;
/** What the request may carry beyond engine and action. */
export interface EngineLoginExtra { bot?: string; secret?: string; provider?: string }

export interface EngineLoginLimits {
  /** Bytes the engine may send to the owner, and the owner to the engine, per session. */
  maxOutBytes: number;
  maxInBytes: number;
  /** One owner message. */
  maxMessageBytes: number;
  idleMs: number;
  /** Antigravity waits on the owner picking a Google account and approving, which can outlast the usual idle limit (no keystrokes are sent meanwhile). */
  agyIdleMs: number;
  totalMs: number;
}
export const ENGINE_LOGIN_LIMITS: EngineLoginLimits = { maxOutBytes: 256 * 1024, maxInBytes: 16 * 1024, maxMessageBytes: 4096, idleMs: 120_000, agyIdleMs: 600_000, totalMs: 900_000 };

/** Who a relay speaks for, as the commit gate re-checks it (identifiers only; never a token). */
export interface EngineLoginWho { deviceId: string; accessHash?: string; desktop: boolean; engine: EngineLoginEngine; action: EngineLoginAction; bot?: string }
export interface EngineLoginOptions {
  /** The commit gate (design 13 r2): true only while this device session, its owner factor, its access token and the bot are all still live.
   * Absent means no sign-in is ever committed (fail closed). */
  revalidate?: (who: EngineLoginWho) => boolean;
  /** Whether a bot exists on this home; an Antigravity sign-in for one that does not is refused at the upgrade. Absent: not checked. */
  botExists?: (bot: string) => boolean;
  /** After an Antigravity code was applied and the launcher ended: a fresh read of whether the bot is signed in. May throw (unknown). */
  confirmSignedIn?: (who: EngineLoginWho) => Promise<boolean>;
  /** The bot's Antigravity login epoch (0: none; a token refresh does not change it, only a completed login does). Read before the login
   * starts and again after the commit: Done needs a HIGHER epoch, since "signed in" alone is also true of the previous account when the replacement failed to publish.
   * Absent or throwing: the outcome cannot be proven, so it is never reported as Done. */
  signInEpoch?: (who: EngineLoginWho) => Promise<number>;
  limits?: Partial<EngineLoginLimits>;
  log?: (line: string) => void;
  /** Test seam: the launcher process. */
  spawnLauncher?: (engine: EngineLoginEngine, action: EngineLoginAction, extra: EngineLoginExtra) => ChildProcess;
  killGraceMs?: number;
  /** Called after a session ended, with the engine, action and bot it was for (identifiers only). */
  onEnded?: (engine: EngineLoginEngine, action: EngineLoginAction, extra: EngineLoginExtra) => void;
}

/** `sudo -n -C 4 -- murage-turn-launch` with the request on FD 3, like every turn. `enroll-key` and `logout`
 * run no CLI, so only `login` asks for a terminal. */
/** The launcher names Antigravity by its short engine name (turn-process.ts CLOUD_ENGINES); the registry and the desktop use the driver kind. */
export const launcherEngineName = (engine: EngineLoginEngine): string => (engine === "antigravityAgent" ? "antigravity" : engine);
export function spawnEngineLoginLauncher(engine: EngineLoginEngine, action: EngineLoginAction, extra: EngineLoginExtra = {}): ChildProcess {
  // No files: the launcher renders the engine's base configuration itself (CLOUD-ENGINES-DESIGN.md 2.1).
  // Every B-mode login (per bot) publishes only on the relay's yes: FD 4 and `commit: true` (design 13 r2, item 7).
  const commit = action === "login" && Boolean(extra.bot) && BOT_LOGIN_ENGINES.includes(engine);
  return spawnCloudLauncher({ mode: "login", engine: launcherEngineName(engine), action, ...(action === "login" ? { pty: true } : {}),
    ...(extra.bot ? { bot: extra.bot } : {}), ...(extra.provider ? { provider: extra.provider } : {}), ...(extra.secret ? { secret: extra.secret } : {}), ...(commit ? { commit: true } : {}) },
  commit ? { commitChannel: true } : {});
}

function reject(socket: Duplex, status: number, message: string): void {
  const body = JSON.stringify({ error: message });
  socket.end(`HTTP/1.1 ${status} ${status === 409 ? "Conflict" : status === 400 ? "Bad Request" : "Forbidden"}\r\ncontent-type: application/json\r\ncache-control: no-store\r\nconnection: close\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/** Returns the upgrade handler the cloud upgrade gate calls once cloudRequestAuth
 * has let the request through. It answers true when it took the request. */
export function createEngineLoginRelay(options: EngineLoginOptions = {}) {
  const limits = { ...ENGINE_LOGIN_LIMITS, ...options.limits };
  const log = options.log ?? ((line: string) => console.log(line));
  const launch = options.spawnLauncher ?? spawnEngineLoginLauncher;
  const grace = options.killGraceMs ?? 5_000;
  // engine -> owner token. A release only counts for the session that took the slot.
  const active = new Map<EngineLoginEngine, symbol>();
  // Every open relay, so a device that lost its session can have them discarded and closed (sessions.onInvalidation).
  const openRelays = new Set<{ device: string; invalidate: () => void }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxMessageBytes });
  const handler = async (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<boolean> => {
    const match = ENGINE_LOGIN_PATH.exec(url.pathname);
    if (!match || req.method !== "GET" || String(req.headers.upgrade).toLowerCase() !== "websocket") return false;
    const engine = match[1] as EngineLoginEngine;
    // Second layer: cloudRequestAuth already admitted this request: an owner-desktop session behind a step-up, or an owner's
    // browser carrying a ticket it redeemed for exactly this target. Nothing else reaches a sign-in, whatever it claims.
    const identity = cloudIdentity(req.headers);
    const desktop = identity?.scope === "owner-desktop";
    const browser = !desktop && isOwnerBrowser(identity);
    if (!identity || (!desktop && !browser)) { reject(socket, 403, cloudHomeCopy.engineLoginOwnerDesktopRequired); return true; }
    const allowedKeys = browser ? ["action", "bot", "provider", ENGINE_TICKET_QUERY] : ["action", "bot", "provider"];
    const bot = url.searchParams.get("bot") ?? undefined, provider = url.searchParams.get("provider") ?? undefined;
    const checked = checkEngineLoginTarget({ engine, action: url.searchParams.get("action") ?? "login", bot, provider });
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length) { reject(socket, 400, cloudHomeCopy.engineLoginUnknownAction); return true; }
    if ([...url.searchParams.keys()].some(key => !allowedKeys.includes(key))) { reject(socket, 400, cloudHomeCopy.engineLoginUnknownAction); return true; }
    if (!checked.ok) { reject(socket, 400, checked.fault === "bot-required" ? cloudHomeCopy.engineLoginBotRequired : cloudHomeCopy.engineLoginUnknownAction); return true; }
    const action = checked.target.action;
    if (browser) {
      const redeemed = engineTicketRedeemedFor(req.headers);
      if (!redeemed || redeemed.engine !== engine || redeemed.action !== action || redeemed.bot !== bot || redeemed.provider !== provider) { reject(socket, 403, cloudHomeCopy.engineLoginOwnerDesktopRequired); return true; }
    }
    if (engine === "antigravityAgent" && bot && options.botExists && !options.botExists(bot)) { reject(socket, 403, cloudHomeCopy.engineLoginOwnerDesktopRequired); return true; }
    if (active.has(engine)) { reject(socket, 409, cloudHomeCopy.engineLoginAlreadyOpen); return true; }
    const slot = Symbol(engine);
    active.set(engine, slot);
    const release = () => { if (active.get(engine) === slot) active.delete(engine); };
    // The CLI is spawned only once the upgrade has completed. ws 8 never calls the callback when the
    // handshake is rejected or the socket is already gone, so the socket's own close frees the slot.
    let upgraded = false;
    const early = () => { if (!upgraded) release(); };
    socket.once("close", early); socket.once("error", early);
    const device = identity.id;
    try {
      wss.handleUpgrade(req, socket, head, ws => {
        upgraded = true; socket.off("close", early); socket.off("error", early);
        if (ws.readyState !== ws.OPEN) { release(); try { ws.terminate(); } catch { /* gone */ } return; }
        const begin = (secret?: string) => {
          let child: ChildProcess;
          try { child = launch(engine, action as EngineLoginAction, { ...(bot ? { bot } : {}), ...(provider ? { provider } : {}), ...(secret ? { secret } : {}) }); }
          catch { release(); ws.close(1011, "launch-error"); return; }
          log(`engine-login start engine=${engine} action=${action} device=${device}`);
          const who: EngineLoginWho = { deviceId: device, ...(identity.accessHash ? { accessHash: identity.accessHash } : {}), desktop, engine, action: action as EngineLoginAction, ...(bot ? { bot } : {}) };
          relay(ws, child, engine, action, device, browser, () => { release(); try { options.onEnded?.(engine, action as EngineLoginAction, bot ? { bot } : {}); } catch { /* a notice never ends the relay */ } }, action !== "enroll-key",
            { who, holdsSlot: () => active.get(engine) === slot });
        };
        if (action !== "enroll-key") { begin(); return; }
        // The key arrives as the first message, once the upgrade is done, so it never rides a URL or a log.
        // A message that is not a key closes the socket before any launcher exists.
        const wait = setTimeout(() => closeUnlaunched("idle-timeout", 1001), limits.idleMs); wait.unref?.();
        const closeUnlaunched = (why: string, code: number) => {
          clearTimeout(wait); release();
          if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, why);
          log(`engine-login end engine=${engine} action=${action} device=${device} reason=${why} exit=none in=0 out=0`);
        };
        const earlyClose = () => { clearTimeout(wait); release(); };
        ws.once("close", earlyClose);
        ws.once("message", (data: RawData) => {
          clearTimeout(wait);
          const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
          const text = chunk.length <= limits.maxMessageBytes ? chunk.toString("utf8").trim() : "";
          if (!LOGIN_SECRET.test(text)) { closeUnlaunched("invalid-secret", 1008); return; }
          ws.off("close", earlyClose);
          begin(text);
        });
      });
    } catch { upgraded = false; release(); try { socket.destroy(); } catch { /* gone */ } }
    return true;
  };

  handler.invalidate = (deviceId?: string): void => {
    for (const entry of [...openRelays]) if (deviceId === undefined || entry.device === deviceId) entry.invalidate();
  };
  return handler;

  function relay(ws: WebSocket, child: ChildProcess, engine: EngineLoginEngine, action: string, device: string, browser: boolean, release: () => void, takesInput = true,
    gate?: { who: EngineLoginWho; holdsSlot: () => boolean }): void {
    let ended = false, codeSent = false, bytesIn = 0, bytesOut = 0, reason = "exited", idle: NodeJS.Timeout, total: NodeJS.Timeout, kill: NodeJS.Timeout | undefined;
    // The commit gate (design 13 r2): FD 4 carries only the fixed words `ready` (launcher to relay) and `commit` (relay to launcher).
    // `decision` is set once; the write of `commit` is the single decision point and runs in the same synchronous step as the re-check.
    let decision: "pending" | "committed" | "discarded" = "pending", childGone = false;
    const channel = (child.stdio as unknown as (Duplex | null | undefined)[] | undefined)?.[4] ?? undefined;
    const discard = (): void => {
      if (decision !== "pending" || childGone) return;
      decision = "discarded";
      try { channel?.end(); } catch { /* gone */ }
    };
    const entry = { device, invalidate: () => { discard(); if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1008, "revoked"); } };
    if (channel) {
      openRelays.add(entry);
      let heard = Buffer.alloc(0);
      channel.on("error", () => {});
      channel.on("data", (chunk: Buffer) => {
        heard = Buffer.concat([heard, chunk]);
        if (heard.length > 64) heard = heard.subarray(heard.length - 64);
        let at: number;
        while ((at = heard.indexOf(10)) >= 0) {
          const line = heard.subarray(0, at + 1).toString("utf8"); heard = heard.subarray(at + 1);
          if (line === "ready\n") answerReady();
        }
      });
    }
    const answerReady = (): void => {
      if (decision !== "pending" || ended || ws.readyState !== ws.OPEN) return;
      let live = false;
      try { live = Boolean(gate && options.revalidate?.(gate.who) === true && gate.holdsSlot()); } catch { live = false; }
      if (!live) { discard(); return; }
      decision = "committed";
      try { channel?.write("commit\n"); } catch { /* the launcher is gone: nothing publishes */ }
    };
    const signal = (sig: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    const finish = (code: number | null) => {
      if (ended) return;
      ended = true;
      clearTimeout(idle); clearTimeout(total); if (kill) clearTimeout(kill);
      release(); openRelays.delete(entry);
      log(`engine-login end engine=${engine} action=${action} device=${device} reason=${reason} exit=${code ?? "none"} in=${bytesIn} out=${bytesOut} commit=${decision === "pending" ? "none" : decision}`);
    };
    const stop = (why: string, closeCode = 1000) => {
      discard();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(closeCode, why);
      if (child.exitCode === null && child.signalCode === null) {
        if (reason === "exited") reason = why;
        signal("SIGTERM");
        kill = setTimeout(() => signal("SIGKILL"), grace); kill.unref?.();
      }
    };
    const agyLogin = engine === "antigravityAgent" && action === "login";
    const epochBefore: Promise<number | undefined> = agyLogin && gate && options.signInEpoch ? options.signInEpoch(gate.who).catch(() => undefined) : Promise.resolve(undefined);
    // Output after the code is dropped until the relay's own closing line, so a pty echo of the code never reaches the owner's history.
    let quiet = false;
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => stop("idle-timeout", 1001), agyLogin ? limits.agyIdleMs : limits.idleMs); idle.unref?.(); };
    total = setTimeout(() => stop("total-timeout", 1001), limits.totalMs); total.unref?.();
    touch();
    const forward = (chunk: Buffer) => {
      touch();
      if (quiet) return;
      bytesOut += chunk.length;
      if (bytesOut > limits.maxOutBytes) { stop("output-cap", 1009); return; }
      if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
    };
    child.stdout?.on("data", forward); child.stderr?.on("data", forward);
    child.stdin?.on("error", () => {});
    ws.on("message", (data: RawData, isBinary: boolean) => {
      touch();
      const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      void isBinary; bytesIn += chunk.length;
      if (!takesInput) return; // a key enrollment runs no CLI: nothing reads further input
      if (browser || agyLogin) {
        // An owner's browser, and the desktop's code field for Antigravity, type nothing but one pasted vendor code, shaped for this engine; every other message is dropped.
        const line = browserStdin(engine, action as EngineLoginAction, chunk, codeSent);
        chunk.fill(0);
        if (line === null) return;
        // The identity is checked once more right before the code is written: a revoked device, factor or token writes nothing.
        if (agyLogin && options.revalidate && !(gate && options.revalidate(gate.who))) { discard(); if (ws.readyState === ws.OPEN) ws.close(1008, "revoked"); return; }
        codeSent = true;
        const bytes = Buffer.from(line, "utf8");
        if (agyLogin) quiet = true;
        child.stdin?.write(bytes, () => bytes.fill(0)); return;
      }
      if (chunk.length > limits.maxMessageBytes || bytesIn > limits.maxInBytes) { stop("input-cap", 1009); return; }
      child.stdin?.write(chunk);
    });
    ws.on("close", () => stop("client-closed"));
    ws.on("error", () => stop("socket-error", 1011));
    child.on("error", () => { reason = "launch-error"; stop("launch-error", 1011); finish(null); });
    child.on("close", code => {
      childGone = true;
      if (!(agyLogin && codeSent && gate)) { if (ws.readyState === ws.OPEN) ws.close(1000, "done"); finish(code); return; }
      // The outcome is said only after a fresh status read: committed and now signed in is Done; committed and unreadable is unknown;
      // anything else changed nothing.
      void (async () => {
        let line: string = cloudHomeCopy.antigravityDidNotFinish;
        if (decision === "committed") {
          try {
            // Signed in AND on an epoch newer than the one the login started from: the NEW account, not the previous one still current.
            const signed = (await options.confirmSignedIn?.(gate.who)) === true;
            const before = await epochBefore, after = signed && before !== undefined ? await options.signInEpoch?.(gate.who) : undefined;
            line = signed && before !== undefined && after !== undefined && after > before ? cloudHomeCopy.antigravitySignedInFor.replace("{bot}", gate.who.bot ?? "") : cloudHomeCopy.signInNotConfirmed;
          }
          catch { line = cloudHomeCopy.signInNotConfirmed; }
        } else if (decision === "pending") line = cloudHomeCopy.signInNotConfirmed;
        quiet = false;
        if (ws.readyState === ws.OPEN) { try { ws.send(Buffer.from(`\r\n${line}\r\n`)); } catch { /* gone */ } ws.close(1000, "done"); }
        finish(code);
      })();
    });
  }
}
