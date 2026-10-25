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
import { cloudIdentity } from "../cloud-request-identity.ts";
import { spawnCloudLauncher } from "./bot-state.ts";
import { cloudHomeCopy } from "./copy.ts";

import { ENGINE_LOGIN_PATH, type EngineLoginEngine } from "./engine-login-engines.ts";
export { ENGINE_LOGIN_ENGINES, ENGINE_LOGIN_PATH, type EngineLoginEngine } from "./engine-login-engines.ts";
export const ENGINE_LOGIN_ACTIONS = ["login", "logout", "enroll-key"] as const;
export type EngineLoginAction = (typeof ENGINE_LOGIN_ACTIONS)[number];
/** The actions each engine offers (mirrors LOGIN_COMMANDS and ENROLL_ENGINES in the launcher).
 * No logout runs a CLI: every sign-out, Kimi's included, is the launcher's own publish of an empty
 * sign-in generation (publish_login), through this same relay and log. */
export const ENGINE_LOGIN_ENGINE_ACTIONS: Readonly<Record<EngineLoginEngine, readonly EngineLoginAction[]>> = {
  codex: ["login", "logout", "enroll-key"], claudeAgent: ["login", "logout"], grokAgent: ["login", "logout"], kimiAgent: ["login", "logout"],
  opencodeGo: ["login", "logout", "enroll-key"],
};
/** Every engine whose `login` is a per-bot (B mode) sign-in. Claude's login (`setup-token`) is engine-wide and takes no bot. */
const BOT_LOGIN_ENGINES: readonly EngineLoginEngine[] = ["codex", "grokAgent", "kimiAgent", "opencodeGo"];
/** Same shapes the launcher validates; checked here too so a bad value never spawns anything. */
const LOGIN_BOT = /^[\w-]{1,64}$/;
const LOGIN_PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
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
  totalMs: number;
}
export const ENGINE_LOGIN_LIMITS: EngineLoginLimits = { maxOutBytes: 256 * 1024, maxInBytes: 16 * 1024, maxMessageBytes: 4096, idleMs: 120_000, totalMs: 900_000 };

export interface EngineLoginOptions {
  limits?: Partial<EngineLoginLimits>;
  log?: (line: string) => void;
  /** Test seam: the launcher process. */
  spawnLauncher?: (engine: EngineLoginEngine, action: EngineLoginAction, extra: EngineLoginExtra) => ChildProcess;
  killGraceMs?: number;
}

/** `sudo -n -C 4 -- murage-turn-launch` with the request on FD 3, like every turn. `enroll-key` and `logout`
 * run no CLI, so only `login` asks for a terminal. */
export function spawnEngineLoginLauncher(engine: EngineLoginEngine, action: EngineLoginAction, extra: EngineLoginExtra = {}): ChildProcess {
  // No files: the launcher renders the engine's base configuration itself (CLOUD-ENGINES-DESIGN.md 2.1).
  return spawnCloudLauncher({ mode: "login", engine, action, ...(action === "login" ? { pty: true } : {}),
    ...(extra.bot ? { bot: extra.bot } : {}), ...(extra.provider ? { provider: extra.provider } : {}), ...(extra.secret ? { secret: extra.secret } : {}) });
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxMessageBytes });
  return async (req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): Promise<boolean> => {
    const match = ENGINE_LOGIN_PATH.exec(url.pathname);
    if (!match || req.method !== "GET" || String(req.headers.upgrade).toLowerCase() !== "websocket") return false;
    const engine = match[1] as EngineLoginEngine;
    // Second layer: cloudRequestAuth already required owner-desktop + step-up.
    const identity = cloudIdentity(req.headers);
    if (identity?.scope !== "owner-desktop") { reject(socket, 403, cloudHomeCopy.engineLoginOwnerDesktopRequired); return true; }
    const action = url.searchParams.get("action") ?? "login";
    if (!(ENGINE_LOGIN_ENGINE_ACTIONS[engine] as readonly string[]).includes(action) || [...url.searchParams.keys()].some(key => !["action", "bot", "provider"].includes(key))) { reject(socket, 400, cloudHomeCopy.engineLoginUnknownAction); return true; }
    const bot = url.searchParams.get("bot") ?? undefined, provider = url.searchParams.get("provider") ?? undefined;
    if (bot !== undefined && !LOGIN_BOT.test(bot)) { reject(socket, 400, cloudHomeCopy.engineLoginUnknownAction); return true; }
    // A per-bot sign-in must name its bot; Claude's engine-wide login and a key enrollment take none.
    if (action === "login" && BOT_LOGIN_ENGINES.includes(engine) && bot === undefined) { reject(socket, 400, cloudHomeCopy.engineLoginBotRequired); return true; }
    if (action === "enroll-key" ? bot !== undefined : (engine === "claudeAgent" && action === "login" && bot !== undefined)) { reject(socket, 400, cloudHomeCopy.engineLoginUnknownAction); return true; }
    // `provider` names the OpenCode key being enrolled, and nothing else.
    if (action === "enroll-key" && engine === "opencodeGo" ? provider === undefined || !LOGIN_PROVIDER.test(provider) : provider !== undefined) { reject(socket, 400, cloudHomeCopy.engineLoginUnknownAction); return true; }
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
          relay(ws, child, engine, action, device, release, action !== "enroll-key");
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

  function relay(ws: WebSocket, child: ChildProcess, engine: EngineLoginEngine, action: string, device: string, release: () => void, takesInput = true): void {
    let ended = false, bytesIn = 0, bytesOut = 0, reason = "exited", idle: NodeJS.Timeout, total: NodeJS.Timeout, kill: NodeJS.Timeout | undefined;
    const signal = (sig: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    const finish = (code: number | null) => {
      if (ended) return;
      ended = true;
      clearTimeout(idle); clearTimeout(total); if (kill) clearTimeout(kill);
      release();
      log(`engine-login end engine=${engine} action=${action} device=${device} reason=${reason} exit=${code ?? "none"} in=${bytesIn} out=${bytesOut}`);
    };
    const stop = (why: string, closeCode = 1000) => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(closeCode, why);
      if (child.exitCode === null && child.signalCode === null) {
        if (reason === "exited") reason = why;
        signal("SIGTERM");
        kill = setTimeout(() => signal("SIGKILL"), grace); kill.unref?.();
      }
    };
    const touch = () => { clearTimeout(idle); idle = setTimeout(() => stop("idle-timeout", 1001), limits.idleMs); idle.unref?.(); };
    total = setTimeout(() => stop("total-timeout", 1001), limits.totalMs); total.unref?.();
    touch();
    const forward = (chunk: Buffer) => {
      touch(); bytesOut += chunk.length;
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
      if (chunk.length > limits.maxMessageBytes || bytesIn > limits.maxInBytes) { stop("input-cap", 1009); return; }
      child.stdin?.write(chunk);
    });
    ws.on("close", () => stop("client-closed"));
    ws.on("error", () => stop("socket-error", 1011));
    child.on("error", () => { reason = "launch-error"; stop("launch-error", 1011); finish(null); });
    child.on("close", code => { if (ws.readyState === ws.OPEN) ws.close(1000, "done"); finish(code); });
  }
}
