// One profile is one control boundary, even when several bots share it.
// Holds survive disconnects and server restarts. No ownership token is accepted
// from model arguments. Callers supply a server-authenticated owner identity.
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic.ts";
import type { AgentBrowserSpec } from "./browser-engine.ts";
import { createNativeBrowser, type NativeBrowser, type BrowserFrame } from "./browser-native-relay.ts";
import { listHeadlessBrowserTools, validateHeadlessBrowserCall } from "./browser-engine-policy.ts";
import { browserRefusal, protectionRefusal, type BrowserProtection } from "./browser-lock.ts";

export type BrowserStatus = { generation: number; held: boolean; owner: string | null; connected: boolean; protectedDocument: boolean; protectedReason: BrowserProtection | null; url: string };
type Entry = BrowserStatus & { native?: NativeBrowser; spec?: AgentBrowserSpec; pending?: Promise<unknown>; frame?: BrowserFrame & { generation: number }; lastSeq: number; streamId?: string; connecting?: Promise<void> };
const refusal = () => browserRefusal("browser_control_changed");
// Conservative document barrier: never deliver any DOM/text/pixels from a page
// containing a protected input. Human input taints the session until explicit
// owner reopen; returning control alone cannot disclose a transformed secret.
// A page the guard flagged on its own (no human input) is different: the bot
// never received it, and a navigation to a new address discloses nothing of
// it, so the bot may leave it; the guard re-checks every open page after the
// navigation and the lock clears only when none of them is protected.
function protect(e: Entry, reason: BrowserProtection) {
  if (e.protectedReason !== "owner-input") e.protectedReason = reason;
  e.protectedDocument = true;
}


export class UnifiedBrowserController {
  private entries = new Map<string, Entry>();
  private readonly stateFile: string;
  private readonly factory: (spec: AgentBrowserSpec) => NativeBrowser;
  constructor(options: { stateFile: string; createNative?: (spec: AgentBrowserSpec) => NativeBrowser }) {
    this.stateFile = options.stateFile; this.factory = options.createNative ?? createNativeBrowser;
    if (existsSync(this.stateFile)) {
      const saved = JSON.parse(readFileSync(this.stateFile, "utf8"));
      if (!Array.isArray(saved) || saved.length > 1000) throw new Error("Invalid browser control state");
      for (const [key, state] of saved) {
        if (typeof key !== "string" || !Number.isSafeInteger(state.generation) || typeof state.held !== "boolean") throw new Error("Invalid browser control state");
        // A lock saved before its cause was recorded is treated as the
        // owner's: only the owner's reopen clears it.
        const protectedReason: BrowserProtection | null = state.protectedDocument === true ? (state.protectedReason === "sensitive-page" ? "sensitive-page" : "owner-input") : null;
        this.entries.set(key, { ...state, protectedDocument: protectedReason !== null, protectedReason, generation: state.generation + 1, connected: false, url: "", lastSeq: -1 });
      }
    }
  }
  private save() {
    writeFileAtomic(this.stateFile, JSON.stringify([...this.entries].map(([key, e]) => [key, { generation: e.generation, held: e.held, owner: e.owner, protectedDocument: e.protectedDocument, protectedReason: e.protectedReason }])), { mode: 0o600 });
  }
  register(key: string, spec: AgentBrowserSpec) {
    const old = this.entries.get(key);
    if (old?.spec && JSON.stringify(old.spec) !== JSON.stringify(spec)) throw new Error("Browser profile binding changed; close it before rebinding");
    if (!old && this.entries.size >= 256) throw new Error("Browser profile capacity reached");
    const e = old ?? { generation: 1, held: false, owner: null, connected: false, protectedDocument: false, protectedReason: null, url: "", lastSeq: -1 };
    e.spec = spec; this.entries.set(key, e); this.save();
  }
  private entry(key: string): Entry { const e = this.entries.get(key); if (!e?.spec) throw new Error("Browser profile is unavailable"); return e; }
  status(key: string): BrowserStatus { const e = this.entry(key); return { generation: e.generation, held: e.held, owner: e.owner, connected: e.connected, protectedDocument: e.protectedDocument, protectedReason: e.protectedReason, url: e.url }; }
  private native(e: Entry) { return e.native ??= this.factory(e.spec!); }
  async connect(key: string) {
    const e = this.entry(key);
    if (e.connected || e.pending) return;
    if (e.connecting) return e.connecting;
    const generation = e.generation;
    e.connecting = this.native(e).connect((frame) => {
      if (e.generation !== generation || frame.seq <= e.lastSeq) return;
      e.lastSeq = frame.seq; e.frame = { ...frame, generation };
    }, (url) => { if (e.generation === generation) e.url = url; }, () => {
      if (e.generation !== generation) return;
      e.connected = false; e.frame = undefined; e.generation++; this.save();
    }).then((streamId) => { if (e.generation === generation) { if (e.streamId !== streamId) e.lastSeq = -1; e.streamId = streamId; e.connected = true; } }).finally(() => { e.connecting = undefined; });
    await e.connecting;
  }
  private fence(e: Entry) { e.generation++; e.frame = undefined; e.connected = false; e.native?.resetStream(); this.save(); }
  async take(key: string, owner: string) {
    const e = this.entry(key);
    if (!owner) throw refusal();
    if (e.held && e.owner !== owner) throw new Error("Another owner session holds this browser profile");
    if (!e.held) { e.held = true; e.owner = owner; this.fence(e); }
    // In-flight work drains before the human receives control. Its observation
    // is discarded by the generation check; queued work is never admitted.
    await e.pending?.catch(() => {});
    await this.connect(key);
    return this.status(key);
  }
  async reclaim(key: string, owner: string) {
    const e = this.entry(key); e.held = true; e.owner = owner; this.fence(e);
    await e.pending?.catch(() => {}); await this.connect(key); return this.status(key);
  }
  private human(e: Entry, owner: string, generation: number) {
    if (!e.held || e.owner !== owner || e.generation !== generation || e.pending) throw refusal();
  }
  async release(key: string, owner: string, generation: number) {
    const e = this.entry(key); this.human(e, owner, generation);
    e.held = false; e.owner = null; this.fence(e); await this.connect(key); return this.status(key);
  }
  frame(key: string, generation: number) {
    const e = this.entry(key);
    if (e.generation !== generation) throw Object.assign(new Error("Browser frame generation is stale"), { status: 409 });
    return e.frame ?? null;
  }
  async navigate(key: string, owner: string, generation: number, address: string) {
    const e = this.entry(key); this.human(e, owner, generation);
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || address.length > 8192) throw new Error("Enter an HTTP or HTTPS address without embedded credentials");
    this.fence(e); const nextGeneration = e.generation;
    await this.native(e).command(["open", url.toString()]);
    this.human(e, owner, nextGeneration); e.url = url.toString();
    await this.connect(key); return this.status(key);
  }
  input(key: string, owner: string, generation: number, event: Record<string, unknown>) {
    const e = this.entry(key); this.human(e, owner, generation);
    if (JSON.stringify(event).length > 8192 || !["input_mouse", "input_keyboard", "input_touch"].includes(String(event.type))) throw new Error("Invalid browser input");
    if (event.type === "input_mouse" && (!["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].includes(String(event.eventType)) || ![event.x, event.y].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10000))) throw new Error("Invalid pointer input");
    if (event.type === "input_keyboard" && (!["keyDown", "keyUp", "char"].includes(String(event.eventType)) || ["key", "code", "text"].some(k => event[k] !== undefined && (typeof event[k] !== "string" || (event[k] as string).length > 100)))) throw new Error("Invalid keyboard input");
    if (e.protectedReason !== "owner-input" && (event.type !== "input_mouse" || event.eventType === "mousePressed")) { e.protectedDocument = true; e.protectedReason = "owner-input"; this.save(); }
    this.native(e).input(event);
  }
  async reopen(key: string, owner: string, generation: number) {
    const e = this.entry(key); this.human(e, owner, generation);
    this.fence(e);
    await e.native?.close(); e.native = undefined; e.lastSeq = -1;
    await this.native(e).command(["open", "about:blank"]);
    e.protectedDocument = false; e.protectedReason = null; e.url = ""; this.save(); await this.connect(key); return this.status(key);
  }
  async dispatch(key: string, method: string, params: Record<string, unknown> = {}, authorize: () => boolean = () => false): Promise<unknown> {
    const e = this.entry(key); const generation = e.generation;
    // Listing tools reads nothing from any page, so neither a protected page
    // nor the owner's hold refuses it: the bot keeps its tools and learns the
    // reason from the refusal of the call itself.
    if (method === "tools/list") {
      if (!authorize()) throw browserRefusal("browser_not_authorized");
      const result = await this.native(e).request(method) as { tools?: unknown };
      if (!authorize()) throw browserRefusal("browser_not_authorized");
      return { tools: listHeadlessBrowserTools(result.tools) };
    }
    if (method !== "tools/call") throw new Error("Unsupported browser method");
    const call = validateHeadlessBrowserCall(params.name, params.arguments ?? {});
    // Leaving a page the guard flagged by itself. Never a page the owner typed in.
    const leaving = call.name === "agent_browser_open" && typeof call.arguments.url === "string";
    const allowed = () => {
      if (!authorize()) throw browserRefusal("browser_not_authorized");
      if (e.held) throw browserRefusal("browser_held");
      if (e.generation !== generation) throw refusal();
      if (e.protectedDocument && !(leaving && e.protectedReason === "sensitive-page")) throw protectionRefusal(e.protectedReason ?? "owner-input");
    };
    allowed(); if (e.pending) throw new Error("This browser profile already has an action in progress");
    const run = async () => {
      const native = this.native(e);
      // Native Windows navigation can wait on an attached screencast. Keep
      // the viewer detached for the operation; connect() refuses to race the
      // in-flight action and the next owner status read restores the stream.
      native.resetStream(); e.connected = false; e.frame = undefined;
      // All frame/tab/value reads use this same barrier. No direct MCP mount.
      const before = await native.protected();
      if (before && !leaving) { protect(e, "sensitive-page"); this.save(); throw protectionRefusal(e.protectedReason!); }
      allowed();
      const result = await native.request(method, call);
      const after = await native.protected();
      if (after) { protect(e, "sensitive-page"); this.save(); throw protectionRefusal(e.protectedReason!); }
      allowed();
      if (e.protectedDocument) { e.protectedDocument = false; e.protectedReason = null; this.save(); }
      await this.connect(key); allowed(); return result;
    };
    const pending = run().finally(async () => { try { await e.native?.protected(false); } catch { protect(e, "sensitive-page"); this.save(); } }); e.pending = pending;
    try { const result = await pending; allowed(); return result; } finally { if (e.pending === pending) e.pending = undefined; }
  }
  async forget(key: string) { const e = this.entry(key); this.fence(e); await e.pending?.catch(() => {}); await e.native?.close(); this.entries.delete(key); this.save(); }
  async close() { await Promise.all([...this.entries.values()].map(async e => { this.fence(e); await e.native?.close(); e.native = undefined; })); }
}
