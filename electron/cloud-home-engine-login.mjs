// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP5: the desktop's engine sign-in terminal relay for a Cloud home. Runs in Electron MAIN only.
//
// A paired owner desktop signs an engine (Codex / Claude) in or out on the home through the vendor's own CLI. The home
// runs the CLI on a pty and relays its terminal over GET /api/engine-login/<engine>?action=login|logout (a WebSocket;
// server/cloud-home/engine-login.ts). Main opens that socket (Bearer + native step-up through the Cloud client, so the
// token and the signing keys never reach a renderer) and relays the bytes to the window that asked, over the
// cloud-home:engine-login:* channels.
//
// Window: sign-in starts from the desktop, so the relay window is the MAIN local window. The channels are therefore
// NOT reachable from the Cloud-home window (ipc-channel-classes.mjs: MAIN_ONLY_CLOUD_CHANNELS = local-only class).
//
// Limits, matching the home's own (a client must not outlive them):
//   - 120 s with no traffic in either direction (idle), 15 min in total.
//   - codex waits silently while the person approves in the browser, so a codex relay sends one harmless space every
//     45 s to hold the session open. claudeAgent waits for a pasted code and gets NO keepalive (no byte is safe at
//     a code prompt): the code must be pasted within 120 s.
//   - One relay at a time.
//
// Links: the CLI prints a vendor auth URL. The renderer only makes allow-listed hosts clickable, and main re-checks
// the host here before shell.openExternal. Nothing the CLI prints is logged or stored.
import { randomUUID } from "node:crypto";

import { CloudHomeError } from "./cloud-home-client.mjs";
import { HOME_ID } from "./cloud-home-store.mjs";

export const ENGINE_LOGIN_CHANNELS = Object.freeze({
  start: "cloud-home:engine-login:start",
  input: "cloud-home:engine-login:input",
  stop: "cloud-home:engine-login:stop",
  openLink: "cloud-home:engine-login:open-link",
  data: "cloud-home:engine-login:data", // main -> renderer
  closed: "cloud-home:engine-login:closed", // main -> renderer
});

export const ENGINE_LOGIN_ENGINES = Object.freeze(["codex", "claudeAgent", "antigravityAgent", "grokAgent", "kimiAgent", "opencodeGo"]);
export const ENGINE_LOGIN_ACTIONS = Object.freeze(["login", "logout", "enroll-key"]);
/** Engines that save a typed API key (`enroll-key`); OpenCode also names the key's provider. */
export const ENGINE_KEY_ENGINES = Object.freeze(["codex", "opencodeGo"]);
/** The shapes server/cloud-home/engine-login.ts checks; checked here too so a bad value never reaches the network. */
export const ENGINE_LOGIN_SHAPES = Object.freeze({ bot: /^[\w-]{1,64}$/, provider: /^[a-z][a-z0-9_-]{0,31}$/, secret: /^[A-Za-z0-9._-]{20,512}$/ });

/**
 * The upgrade path for one sign-in, or null when the request is malformed. `bot` names the bot a per-bot sign-in is
 * for (the home requires it for Codex, Grok, Kimi and OpenCode); an `enroll-key` request carries a `secret` (never in
 * the URL: it is the socket's first message) and, for OpenCode, a `provider`. The home re-checks every rule.
 */
export function engineLoginPath({ engine, action = "login", bot, provider, secret }) {
  if (!ENGINE_LOGIN_ENGINES.includes(engine) || !ENGINE_LOGIN_ACTIONS.includes(action)) return null;
  if (bot !== undefined && (action === "enroll-key" || !ENGINE_LOGIN_SHAPES.bot.test(String(bot)))) return null;
  if (action === "enroll-key") {
    if (!ENGINE_KEY_ENGINES.includes(engine) || typeof secret !== "string" || !ENGINE_LOGIN_SHAPES.secret.test(secret)) return null;
    if (engine === "opencodeGo" ? typeof provider !== "string" || !ENGINE_LOGIN_SHAPES.provider.test(provider) : provider !== undefined) return null;
  } else if (secret !== undefined || provider !== undefined) return null;
  const query = new URLSearchParams({ action });
  if (bot !== undefined) query.set("bot", String(bot));
  if (provider !== undefined) query.set("provider", provider);
  return `/api/engine-login/${engine}?${query.toString()}`;
}
export const ENGINE_LOGIN_LIMITS = Object.freeze({ idleMs: 120_000, totalMs: 900_000, keepaliveMs: 45_000, maxInputBytes: 4096, maxInputTotal: 16 * 1024, maxLinkLength: 2048 });

/**
 * Hosts the vendor CLIs print sign-in links for. Exact match, https only. Sources: the URLs the CLIs printed in the
 * b2 live sign-in (https://auth.openai.com/codex/device for Codex, https://claude.com/cai/oauth/authorize for Claude),
 * the Cloud-home measurement of 2026-10-15 (https://accounts.x.ai/oauth2/device for Grok,
 * https://www.kimi.ai/code/authorize_device for Kimi)
 * and the vendors' own sign-in hosts (claude.ai, platform.claude.com). src/lib/engine-login-terminal.ts holds the same
 * list for the renderer; a test keeps the two equal.
 */
export const ENGINE_LOGIN_AUTH_HOSTS = Object.freeze(["accounts.x.ai", "auth.openai.com", "claude.ai", "claude.com", "platform.claude.com", "www.kimi.ai"]);

/** The normalized href when `value` is an https link to an allow-listed vendor auth host, else null. */
export function checkAuthUrl(value, hosts = ENGINE_LOGIN_AUTH_HOSTS) {
  if (typeof value !== "string" || value.length === 0 || value.length > ENGINE_LOGIN_LIMITS.maxLinkLength || /[\u0000- \u007f]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return null;
  if (!hosts.includes(url.hostname)) return null;
  return url.href;
}

export const COPY = Object.freeze({
  notAllowedLink: "That link isn't a sign-in page for this engine, so it was not opened.",
  ownerDesktopRequired: "Signing an engine in needs the desktop you paired as the owner. This device can't do it.",
  stepUpRequired: "Your Cloud home needs you to confirm this on your computer first.",
  alreadyOpen: "A sign-in for this engine is already open.",
  busy: "Another sign-in is already open. Finish or close it first.",
  unreachable: "Your Cloud home isn't reachable.",
  refused: "Your Cloud home refused the sign-in.",
  badRequest: "That sign-in request isn't valid.",
  notOpen: "That sign-in isn't open any more.",
});

export class EngineLoginError extends Error {
  constructor(code, message) { super(message); this.name = "EngineLoginError"; this.code = code; }
}

/** Map the HTTP status (and a few body bytes) of a refused upgrade to a clean error. */
export function refusalFor(status, bodyText = "") {
  if (status === 403) return /step-?up/i.test(bodyText) ? new EngineLoginError("step-up-required", COPY.stepUpRequired) : new EngineLoginError("owner-desktop-required", COPY.ownerDesktopRequired);
  if (status === 401) return new EngineLoginError("needs-repair", "Your Cloud home no longer knows this computer. Pair it again.");
  if (status === 409) return new EngineLoginError("already-open", COPY.alreadyOpen);
  if (status === 400) return new EngineLoginError("bad-request", COPY.badRequest);
  if (status === 502 || status === 504 || (status >= 520 && status <= 530)) return new EngineLoginError("unreachable", COPY.unreachable);
  return new EngineLoginError("refused", COPY.refused);
}

const asBytes = (data) => Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);

/**
 * @param {{ client: { authorizeUpgrade(homeId: string, path: string): Promise<{ url: string, headers: Record<string,string> }> },
 *   createSocket: (url: string, options: object) => any, openExternal: (url: string) => unknown,
 *   timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
 *   limits?: Partial<typeof ENGINE_LOGIN_LIMITS>, log?: (line: string) => void }} deps
 */
export function createEngineLoginRelay({ client, createSocket, openExternal, timers = globalThis, limits: overrides = {}, log = () => {} }) {
  if (!client || typeof createSocket !== "function" || typeof openExternal !== "function") throw new TypeError("client, createSocket and openExternal are required");
  const limits = { ...ENGINE_LOGIN_LIMITS, ...overrides };
  /** The single open relay, or null. */
  let active = null;
  let starting = false;

  const sendTo = (sender, channel, payload) => { try { if (!sender.isDestroyed?.()) sender.send(channel, payload); } catch { /* window gone */ } };

  function connect(auth) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = createSocket(auth.url, { headers: auth.headers, followRedirects: false, handshakeTimeout: 20_000, maxPayload: 1024 * 1024 }); }
      catch { reject(new EngineLoginError("unreachable", COPY.unreachable)); return; }
      let settled = false;
      const fail = (error) => { if (settled) return; settled = true; try { ws.terminate?.(); } catch { /* gone */ } reject(error); };
      ws.on("unexpected-response", (_request, response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => { if (size < 2048) { chunks.push(chunk); size += chunk.length; } });
        const done = () => fail(refusalFor(response.statusCode, Buffer.concat(chunks).toString("utf8", 0, 2048)));
        response.on("end", done); response.on("error", done); response.on("close", done);
      });
      ws.on("error", () => fail(new EngineLoginError("unreachable", COPY.unreachable)));
      ws.on("open", () => { if (settled) return; settled = true; resolve(ws); });
    });
  }

  /** @returns {Promise<{ ok: true, id: string } | { ok: false, code: string, message: string }>} */
  async function start({ sender, homeId, engine, action = "login", bot, provider, secret }) {
    if (!sender || typeof sender.send !== "function") return { ok: false, code: "bad-request", message: COPY.badRequest };
    const path = engineLoginPath({ engine, action, bot, provider, secret });
    if (!path || !HOME_ID.test(String(homeId))) return { ok: false, code: "bad-request", message: COPY.badRequest };
    if (active || starting) return { ok: false, code: "busy", message: COPY.busy };
    starting = true;
    try {
      const auth = await client.authorizeUpgrade(homeId, path);
      let ws;
      try { ws = await connect(auth); } finally { auth.headers = undefined; }
      // A key enrollment's key is the socket's first and only owner message; it is never logged or kept.
      if (action === "enroll-key") {
        try { ws.send(secret); } catch { try { ws.terminate?.(); } catch { /* gone */ } return { ok: false, code: "unreachable", message: COPY.unreachable }; }
      }
      const id = randomUUID();
      const session = { id, engine, action, sender, ws, bytesIn: 0, bytesOut: 0, seen: false, over: false, timers: {} };
      active = session;
      log(`engine-login start engine=${engine} action=${action}`);
      armIdle(session);
      session.timers.total = timers.setTimeout(() => end(session, "total-timeout"), limits.totalMs);
      ws.on("message", (data) => {
        const bytes = asBytes(data);
        session.bytesIn += bytes.length;
        armIdle(session);
        if (engine === "codex" && action === "login" && !session.seen) startKeepalive(session);
        session.seen = true;
        sendTo(sender, ENGINE_LOGIN_CHANNELS.data, { id, data: new Uint8Array(bytes) });
      });
      ws.on("close", () => end(session, session.reason ?? "done"));
      ws.on("error", () => end(session, "error"));
      sender.once?.("destroyed", () => end(session, "window-closed"));
      return { ok: true, id };
    } catch (error) {
      if (error instanceof EngineLoginError) return { ok: false, code: error.code, message: error.message };
      if (error instanceof CloudHomeError) return { ok: false, code: error.code, message: error.message };
      return { ok: false, code: "refused", message: COPY.refused };
    } finally {
      starting = false;
    }
  }

  function armIdle(session) {
    if (session.timers.idle) timers.clearTimeout(session.timers.idle);
    session.timers.idle = timers.setTimeout(() => end(session, "idle-timeout"), limits.idleMs);
    session.timers.idle?.unref?.();
  }

  /** codex only. One space, which the CLI ignores while it waits for the browser approval. */
  function startKeepalive(session) {
    session.timers.keepalive = timers.setInterval(() => {
      try { session.ws.send(" "); armIdle(session); } catch { /* the close handler ends the relay */ }
    }, limits.keepaliveMs);
    session.timers.keepalive?.unref?.();
  }

  function end(session, reason) {
    if (session.over) return;
    session.over = true;
    session.reason = reason;
    for (const timer of Object.values(session.timers)) { try { timers.clearTimeout(timer); timers.clearInterval(timer); } catch { /* cleared */ } }
    try { session.ws.close(1000, reason.slice(0, 100)); } catch { /* closed */ }
    try { session.ws.terminate?.(); } catch { /* closed */ }
    if (active === session) active = null;
    log(`engine-login end engine=${session.engine} action=${session.action} reason=${reason} in=${session.bytesIn} out=${session.bytesOut}`);
    sendTo(session.sender, ENGINE_LOGIN_CHANNELS.closed, { id: session.id, reason });
  }

  const owned = (sender, id) => active && !active.over && active.id === id && active.sender === sender ? active : null;

  /** The owner's typed or pasted text (the Claude code). Never logged. */
  function input({ sender, id, data }) {
    const session = owned(sender, id);
    if (!session) return { ok: false, code: "not-open", message: COPY.notOpen };
    // A key enrollment takes nothing after its key.
    if (session.action === "enroll-key") return { ok: false, code: "bad-request", message: COPY.badRequest };
    if (typeof data !== "string" || data.length === 0 || Buffer.byteLength(data) > limits.maxInputBytes || session.bytesOut + Buffer.byteLength(data) > limits.maxInputTotal) return { ok: false, code: "bad-request", message: COPY.badRequest };
    try { session.ws.send(data); } catch { return { ok: false, code: "not-open", message: COPY.notOpen }; }
    session.bytesOut += Buffer.byteLength(data);
    armIdle(session);
    return { ok: true };
  }

  function stop({ sender, id }) {
    const session = owned(sender, id);
    if (!session) return { ok: false, code: "not-open", message: COPY.notOpen };
    end(session, "stopped");
    return { ok: true };
  }

  /** Re-checks the host in main: only an https link to an allow-listed vendor auth host reaches the default browser. */
  async function openLink({ sender, id, url }) {
    if (!owned(sender, id)) return { ok: false, code: "not-open", message: COPY.notOpen };
    const href = checkAuthUrl(url);
    if (!href) return { ok: false, code: "link-not-allowed", message: COPY.notAllowedLink };
    try { await openExternal(href); } catch { return { ok: false, code: "refused", message: COPY.refused }; }
    return { ok: true };
  }

  return { start, input, stop, openLink, isOpen: () => Boolean(active) };
}

/** Registers the engine-login channels through the owned-main gate (main window only). Called only with the Cloud flag on. */
export function registerEngineLoginIpc({ ipcMain: rawIpcMain, relay, active = () => true }) {
  // Not live: a NEW sign-in is refused. A sign-in already running keeps its input, stop and link channels (the relay checks
  // the sender owns that session), so going not-live never cuts a person off in the middle of signing in.
  const ipcMain = { handle: (channel, fn, { continuing = false } = {}) => rawIpcMain.handle(channel, (event, ...args) => {
    if (!active() && !(continuing && relay.isOpen?.() === true)) throw new Error("Cloud isn't available yet.");
    return fn(event, ...args);
  }) };
  const str = (value, max = 200) => typeof value === "string" && value.length <= max ? value : "";
  const bad = { ok: false, code: "bad-request", message: COPY.badRequest };
  ipcMain.handle(ENGINE_LOGIN_CHANNELS.start, (event, request) => request && typeof request === "object"
    ? relay.start({ sender: event.sender, homeId: str(request.homeId), engine: str(request.engine), action: request.action === undefined ? "login" : str(request.action),
      ...(request.bot !== undefined ? { bot: str(request.bot, 64) } : {}), ...(request.provider !== undefined ? { provider: str(request.provider, 32) } : {}),
      ...(request.secret !== undefined ? { secret: str(request.secret, 512) } : {}) }) : bad);
  ipcMain.handle(ENGINE_LOGIN_CHANNELS.input, (event, request) => request && typeof request === "object" ? relay.input({ sender: event.sender, id: str(request.id), data: typeof request.data === "string" ? request.data : "" }) : bad, { continuing: true });
  ipcMain.handle(ENGINE_LOGIN_CHANNELS.stop, (event, request) => request && typeof request === "object" ? relay.stop({ sender: event.sender, id: str(request.id) }) : bad, { continuing: true });
  ipcMain.handle(ENGINE_LOGIN_CHANNELS.openLink, (event, request) => request && typeof request === "object" ? relay.openLink({ sender: event.sender, id: str(request.id), url: str(request.url, ENGINE_LOGIN_LIMITS.maxLinkLength) }) : bad, { continuing: true });
}
