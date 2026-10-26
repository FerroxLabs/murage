// SPDX-License-Identifier: AGPL-3.0-or-later
// "Use my Chrome" over remote debugging: ONE DevTools connection to the owner's
// Chrome per binding, shared by Murage's browser engine and Murage's page check.
//
// Chrome asks the owner "Allow remote debugging?" for every new DevTools
// connection. The engine (agent-browser) and the page check
// (BrowserDocumentGuard) each used to dial Chrome, and the engine dialled again
// after every restart, so the owner saw the prompt again and again. Here Murage
// holds the one approved connection and both clients talk through it.
//
// - Loopback only. Each client role has its own unguessable path token; any
//   other path is refused, so no other local program gets the owner's Chrome
//   through this connection without the owner's Allow.
// - A client's WebSocket handshake is held until Chrome has answered a
//   Browser.getVersion over the shared connection, which only happens after
//   the owner clicked Allow. A client therefore never sees a half-approved
//   connection, and its own command timeouts never start a second attempt.
// - Request ids are rewritten per client. Events go to the client that owns
//   their session; browser-level events go to the engine. A session the page
//   check opened is announced to the page check only.
// - When the engine disconnects (its idle exit, a restart), its sessions are
//   detached and its auto-attach and target discovery are switched off, so no
//   tab of the owner's waits on a debugger that is gone. The connection to
//   Chrome stays, so the next engine start asks nothing.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { closeSocketQuietly } from "./browser-socket-teardown.ts";
import { userChromeAttachLog } from "./user-chrome.ts";

type Role = "engine" | "guard";
type Pending = { role: Role | "proxy"; id: number; method: string; targetId?: string; resolve?: (value: unknown) => void; reject?: (error: Error) => void };
type Message = { id?: unknown; method?: unknown; params?: Record<string, unknown>; sessionId?: unknown; result?: Record<string, unknown>; error?: unknown };
export type UserChromeProxyState = "idle" | "waiting" | "allowed" | "failed" | "closed";

const CLIENT_MAX_PAYLOAD = 16 * 1024 * 1024;

export class UserChromeProxy {
  readonly engineUrl: string;
  readonly guardUrl: string;
  private readonly tokens: Record<Role, string>;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: CLIENT_MAX_PAYLOAD, perMessageDeflate: false });
  private upstream?: WebSocket;
  private allowed?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sessions = new Map<string, Role>();
  private readonly clients = new Map<Role, WebSocket>();
  /** Browser-level Target.attachedToTarget events held until the page check's attach answers. */
  private held: Message[] = [];
  private stateValue: UserChromeProxyState = "idle";

  // Plain fields, not constructor parameter properties: the server runs under node --experimental-strip-types, which rejects non-erasable syntax.
  private readonly server: Server;
  private readonly chromeUrl: string;
  private readonly allowWaitMs: number;

  private constructor(server: Server, port: number, chromeUrl: string, allowWaitMs: number) {
    this.server = server;
    this.chromeUrl = chromeUrl;
    this.allowWaitMs = allowWaitMs;
    this.tokens = { engine: randomBytes(24).toString("hex"), guard: randomBytes(24).toString("hex") };
    this.engineUrl = `ws://127.0.0.1:${port}/devtools/browser/${this.tokens.engine}`;
    this.guardUrl = `ws://127.0.0.1:${port}/devtools/browser/${this.tokens.guard}`;
    server.on("upgrade", (request, socket, head) => { void this.upgrade(request, socket, head); });
  }

  /** `chromeUrl`: the owner's Chrome browser endpoint (user-chrome.ts, always loopback). */
  static async start(chromeUrl: string, allowWaitMs: number): Promise<UserChromeProxy> {
    const server = createServer((_request, response) => { response.writeHead(404).end(); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    return new UserChromeProxy(server, (server.address() as { port: number }).port, chromeUrl, allowWaitMs);
  }

  get state(): UserChromeProxyState { return this.stateValue; }
  /** The Chrome endpoint this proxy was made for: a new one means Chrome restarted. */
  get chromeEndpoint(): string { return this.chromeUrl; }

  private roleFor(path: string | undefined): Role | null {
    const token = /^\/devtools\/browser\/([0-9a-f]{48})$/u.exec(path ?? "")?.[1];
    if (!token) return null;
    return token === this.tokens.engine ? "engine" : token === this.tokens.guard ? "guard" : null;
  }

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const role = this.roleFor(request.url);
    if (!role || this.stateValue === "closed" || this.clients.has(role)) { socket.destroy(); return; }
    let gone = false; socket.once("close", () => { gone = true; });
    try { await this.ensureAllowed(); }
    catch { socket.destroy(); return; }
    if (gone || this.clients.has(role) || this.stateValue !== "allowed") { socket.destroy(); return; }
    this.wss.handleUpgrade(request, socket, head, (client) => this.attachClient(role, client));
  }

  /** Opens the one connection to Chrome and waits for the owner's Allow. */
  ensureAllowed(): Promise<void> {
    if (this.stateValue === "closed") return Promise.reject(new Error("Chrome connection closed"));
    if (this.allowed && (this.stateValue === "waiting" || this.stateValue === "allowed")) return this.allowed;
    const started = Date.now();
    this.stateValue = "waiting";
    console.log(userChromeAttachLog("chrome-waiting"));
    const attempt = new Promise<void>((resolve, reject) => {
      const upstream = new WebSocket(this.chromeUrl, { handshakeTimeout: this.allowWaitMs, perMessageDeflate: false });
      this.upstream = upstream;
      const timer = setTimeout(() => fail("timeout"), this.allowWaitMs);
      let settled = false;
      const fail = (reason: "timeout" | "allow") => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (this.upstream === upstream) this.upstream = undefined;
        closeSocketQuietly(upstream);
        if (this.stateValue !== "closed") this.stateValue = "failed";
        console.error(userChromeAttachLog("failed", Date.now() - started, reason));
        reject(new Error("Chrome did not allow the connection"));
      };
      upstream.on("message", (raw) => this.fromChrome(raw));
      upstream.on("close", () => { if (!settled) fail("allow"); else if (this.upstream === upstream) this.chromeClosed(); });
      upstream.on("error", () => { if (!settled) fail("allow"); });
      upstream.once("open", () => {
        this.internal("Browser.getVersion").then(() => {
          if (settled) return; settled = true; clearTimeout(timer);
          this.stateValue = "allowed";
          console.log(userChromeAttachLog("chrome-allowed", Date.now() - started));
          resolve();
        }, () => fail("allow"));
      });
    });
    this.allowed = attempt;
    attempt.catch(() => { if (this.allowed === attempt) this.allowed = undefined; });
    return attempt;
  }

  private chromeClosed() {
    this.upstream = undefined; this.allowed = undefined;
    if (this.stateValue !== "closed") this.stateValue = "idle";
    console.log(userChromeAttachLog("chrome-closed"));
    for (const pending of this.pending.values()) pending.reject?.(new Error("Chrome connection closed"));
    this.pending.clear(); this.sessions.clear(); this.held = [];
    for (const client of this.clients.values()) closeSocketQuietly(client);
    this.clients.clear();
  }

  private toChrome(message: Record<string, unknown>) {
    if (this.upstream?.readyState !== WebSocket.OPEN) return false;
    this.upstream.send(JSON.stringify(message)); return true;
  }

  private internal(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { role: "proxy", id, method, resolve, reject });
      if (!this.toChrome({ id, method, params, ...(sessionId ? { sessionId } : {}) })) { this.pending.delete(id); reject(new Error("Chrome connection closed")); }
    });
  }

  private attachClient(role: Role, client: WebSocket) {
    this.clients.set(role, client);
    client.on("message", (raw) => this.fromClient(role, client, raw));
    client.on("close", () => { if (this.clients.get(role) === client) this.clientGone(role); });
    client.on("error", () => closeSocketQuietly(client));
  }

  private fromClient(role: Role, client: WebSocket, raw: WebSocket.RawData) {
    let message: Message;
    try { message = JSON.parse(raw.toString()); } catch { closeSocketQuietly(client); return; }
    if (!message || typeof message !== "object" || !Number.isSafeInteger(message.id) || typeof message.method !== "string") { closeSocketQuietly(client); return; }
    const id = message.id as number, method = message.method;
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    // A client acts only in the sessions it opened (and the engine in Chrome-level ones).
    if (sessionId && (this.sessions.get(sessionId) ?? "engine") !== role) {
      client.send(JSON.stringify({ id, error: { code: -32001, message: "Session not found" } })); return;
    }
    const upId = this.nextId++;
    const targetId = method === "Target.attachToTarget" && typeof message.params?.targetId === "string" ? message.params.targetId : undefined;
    this.pending.set(upId, { role, id, method, ...(targetId ? { targetId } : {}) });
    if (!this.toChrome({ ...message, id: upId })) { this.pending.delete(upId); client.send(JSON.stringify({ id, error: { code: -32000, message: "Chrome connection closed" } })); }
  }

  private deliver(role: Role, message: Message) {
    const client = this.clients.get(role);
    if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  }

  private fromChrome(raw: WebSocket.RawData) {
    let message: Message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id as number);
      if (!pending) return;
      this.pending.delete(message.id as number);
      if (pending.role === "proxy") { if (message.error) pending.reject?.(new Error("Chrome refused")); else pending.resolve?.(message.result); return; }
      const sessionId = pending.method === "Target.attachToTarget" && typeof message.result?.sessionId === "string" ? message.result.sessionId : undefined;
      if (sessionId) this.sessions.set(sessionId, pending.role);
      // The announcement of a session comes before the answer that names it.
      this.flushHeld(sessionId, pending.role);
      this.deliver(pending.role, { ...message, id: pending.id });
      return;
    }
    const method = message.method, params = message.params ?? {};
    const parent = typeof message.sessionId === "string" ? message.sessionId : undefined;
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
      if (parent) { const owner = this.sessions.get(parent) ?? "engine"; this.sessions.set(params.sessionId, owner); this.deliver(owner, message); return; }
      const targetId = (params.targetInfo as { targetId?: unknown } | undefined)?.targetId;
      if (typeof targetId === "string" && this.guardAttaching(targetId)) { this.held.push(message); return; }
      if (!this.sessions.has(params.sessionId)) this.sessions.set(params.sessionId, "engine");
      this.deliver(this.sessions.get(params.sessionId)!, message); return;
    }
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      const owner = this.sessions.get(params.sessionId) ?? (parent ? this.sessions.get(parent) : undefined) ?? "engine";
      this.sessions.delete(params.sessionId); this.deliver(owner, message); return;
    }
    this.deliver(parent ? this.sessions.get(parent) ?? "engine" : "engine", message);
  }

  private guardAttaching(targetId: string): boolean {
    for (const pending of this.pending.values()) if (pending.role === "guard" && pending.targetId === targetId) return true;
    return false;
  }

  /** Hand held announcements to their owner once an attach has answered. */
  private flushHeld(sessionId: string | undefined, role: Role | "proxy") {
    if (!this.held.length) return;
    const keep: Message[] = [];
    for (const message of this.held) {
      const id = message.params!.sessionId as string;
      const targetId = (message.params!.targetInfo as { targetId?: string }).targetId!;
      if (sessionId && id === sessionId && role !== "proxy") this.deliver(role, message);
      else if (this.guardAttaching(targetId)) keep.push(message);
      else { if (!this.sessions.has(id)) this.sessions.set(id, "engine"); this.deliver(this.sessions.get(id)!, message); }
    }
    this.held = keep;
  }

  private clientGone(role: Role) {
    this.clients.delete(role);
    for (const [id, pending] of this.pending) if (pending.role === role) this.pending.delete(id);
    this.flushHeld(undefined, "proxy");
    for (const [sessionId, owner] of this.sessions) {
      if (owner !== role) continue;
      this.sessions.delete(sessionId);
      void this.internal("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
    if (role === "engine") {
      // Nothing of the owner's waits on a debugger that left.
      void this.internal("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
      void this.internal("Target.setDiscoverTargets", { discover: false }).catch(() => {});
    }
  }

  async close() {
    this.stateValue = "closed";
    for (const client of this.clients.values()) closeSocketQuietly(client);
    this.clients.clear();
    if (this.upstream) closeSocketQuietly(this.upstream);
    this.upstream = undefined;
    for (const pending of this.pending.values()) pending.reject?.(new Error("Chrome connection closed"));
    this.pending.clear(); this.sessions.clear(); this.held = [];
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
