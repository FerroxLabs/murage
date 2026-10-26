// The Cloud-home engine sign-in terminal (B3 WP5): the logic around the xterm view, kept apart from React so a node
// test drives all of it.
//
// What the vendor CLI prints is untrusted. Four rules, all enforced here and again in main (electron/
// cloud-home-engine-login.mjs):
//   1. OSC 52 (clipboard write) and OSC 8 (hyperlink) are swallowed by parser handlers. Nothing the CLI prints reaches
//      the clipboard, and no printed text can hide a link behind other words.
//   2. A link is clickable only when it is an https URL on an allow-listed vendor auth host. The text of the link is
//      what is opened; there is no separate label.
//   3. The terminal takes no keystrokes. The only thing ever typed is the Claude sign-in code, through a masked input.
//   4. Main re-checks the host before shell.openExternal, so this file is a convenience, not the boundary.
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

/**
 * Hosts the vendor CLIs print sign-in links for: exact match, https only. Evidence: the URLs the CLIs printed in the
 * b2 live sign-in (https://auth.openai.com/codex/device, https://claude.com/cai/oauth/authorize), the Cloud-home measurement of 2026-10-15
 * (https://accounts.x.ai/oauth2/device for Grok, https://www.kimi.ai/code/authorize_device for Kimi) plus the vendors'
 * sign-in hosts claude.ai and platform.claude.com. electron/cloud-home-engine-login.mjs holds the same list; a test
 * keeps them equal.
 */
export const ENGINE_LOGIN_AUTH_HOSTS: readonly string[] = Object.freeze(["accounts.x.ai", "auth.openai.com", "claude.ai", "claude.com", "platform.claude.com", "www.kimi.ai"]);

const MAX_LINK = 2048;

/** The normalized href when `value` is an https link to an allow-listed host, else null. */
export function checkAuthUrl(value: unknown, hosts: readonly string[] = ENGINE_LOGIN_AUTH_HOSTS): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LINK || /[\u0000- \u007f]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return null;
  return hosts.includes(url.hostname) ? url.href : null;
}

export const LINK_REFUSED = "That link isn't a sign-in page for this engine, so it was not opened.";

// ── terminal guards ──────────────────────────────────────────────────────────────────────────────────────────────

interface ParserHost { parser: { registerOscHandler(ident: number, callback: (data: string) => boolean | Promise<boolean>): { dispose(): void } } }

/**
 * Swallow OSC 52 and OSC 8. A handler that returns true ends the chain, so xterm's own OSC 8 link handling (which
 * runs after ours) never sees the sequence, and an OSC 52 clipboard addon, if one were ever added, could not either.
 * `onSwallowed` is told the code only (never the payload).
 */
export function installTerminalGuards(terminal: ParserHost, onSwallowed: (code: 52 | 8) => void = () => {}): { dispose(): void } {
  const handlers = ([52, 8] as const).map((code) => terminal.parser.registerOscHandler(code, () => { onSwallowed(code); return true; }));
  return { dispose: () => handlers.forEach((handler) => handler.dispose()) };
}

// ── links ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One buffer row: its text at full width, and whether it continues the row above (soft wrap). */
export interface BufferRowText { text: string; isWrapped: boolean }
export interface Cell { x: number; y: number }
/** 1-based cells, `end` inclusive (xterm's IBufferRange). */
export interface AuthLink { url: string; start: Cell; end: Cell }

const URL_AT = /https:\/\/[^\s"'<>\u0000-\u001f\u007f]+/g;
const TRAILING = /[.,;:!?)\]}]+$/;

/**
 * Allow-listed sign-in links in `rows` (row 0 is buffer row `firstRow`, 1-based). A URL the terminal soft-wrapped is
 * one link. A URL the CLI itself broke across lines (no spaces on the continuation, not another link or a prompt)
 * is joined as well, the same rule tools/b2/signin.py uses. Off-list hosts produce no link at all.
 */
export function findAuthLinks(rows: readonly BufferRowText[], firstRow: number, hosts: readonly string[] = ENGINE_LOGIN_AUTH_HOSTS): AuthLink[] {
  // Logical lines: soft-wrapped rows joined, each char remembering its cell.
  const lines: { chars: string[]; cells: Cell[] }[] = [];
  rows.forEach((row, index) => {
    const y = firstRow + index;
    if (!row.isWrapped || lines.length === 0) lines.push({ chars: [], cells: [] });
    const line = lines[lines.length - 1];
    [...row.text].forEach((char, i) => { line.chars.push(char); line.cells.push({ x: i + 1, y }); });
  });
  for (const line of lines) {
    while (line.chars.length && /\s/.test(line.chars[line.chars.length - 1])) { line.chars.pop(); line.cells.pop(); }
  }
  // Chains: a line that ends inside a URL continues onto the next line when that one looks like the rest of it.
  const chains: { text: string; cells: Cell[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i].chars.join("");
    const cells = [...lines[i].cells];
    while (i + 1 < lines.length) {
      const tail = text.slice(text.lastIndexOf("https://"));
      const next = lines[i + 1].chars.join("");
      const trimmed = next.trimStart();
      if (!text.includes("https://") || /\s/.test(tail) || trimmed === "" || /\s/.test(trimmed) || trimmed.startsWith("http") || trimmed.startsWith(">")) break;
      const lead = next.length - trimmed.length;
      text += trimmed;
      cells.push(...lines[i + 1].cells.slice(lead));
      i++;
    }
    chains.push({ text, cells });
  }
  const links: AuthLink[] = [];
  for (const chain of chains) {
    for (const match of chain.text.matchAll(URL_AT)) {
      const raw = match[0].replace(TRAILING, "");
      const url = checkAuthUrl(raw, hosts);
      if (!url || raw.length === 0) continue;
      const first = match.index ?? 0;
      links.push({ url: raw, start: chain.cells[first], end: chain.cells[first + raw.length - 1] });
    }
  }
  return links;
}

/** xterm link provider over the visible and scrollback rows near `y`. Activating hands the URL text to `onActivate`. */
export function authLinkProvider(terminal: Pick<Terminal, "buffer">, onActivate: (url: string) => void, hosts: readonly string[] = ENGINE_LOGIN_AUTH_HOSTS): ILinkProvider {
  return {
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
      const buffer = terminal.buffer.active;
      const from = Math.max(0, y - 1 - 12), to = Math.min(buffer.length - 1, y - 1 + 12);
      const rows: BufferRowText[] = [];
      for (let row = from; row <= to; row++) {
        const line = buffer.getLine(row);
        rows.push({ text: line?.translateToString(false) ?? "", isWrapped: Boolean(line?.isWrapped) });
      }
      const found = findAuthLinks(rows, from + 1, hosts).filter((link) => link.start.y <= y && y <= link.end.y);
      callback(found.length ? found.map((link) => ({ range: { start: link.start, end: link.end }, text: link.url, activate: (_event: MouseEvent, text: string) => onActivate(text) })) : undefined);
    },
  };
}

// ── the session (no React, no DOM) ───────────────────────────────────────────────────────────────────────────────

type Failure = { ok: false; code: string; message: string };
export type EngineLoginAction = "login" | "logout" | "enroll-key";
/** What a sign-in asks the home for: a per-bot engine names its bot; an OpenCode key names its provider. */
export interface EngineLoginStart { homeId: string; engine: EngineLoginEngine; action?: EngineLoginAction; bot?: string; provider?: string;
  /** `enroll-key` only: the typed API key. Main sends it as the socket's first message and keeps nothing. */
  secret?: string }
export interface EngineLoginBridge {
  start(request: EngineLoginStart): Promise<{ ok: true; id: string } | Failure>;
  input(request: { id: string; data: string }): Promise<{ ok: true } | Failure>;
  stop(request: { id: string }): Promise<{ ok: true } | Failure>;
  openLink(request: { id: string; url: string }): Promise<{ ok: true } | Failure>;
  onData(listener: (payload: { id: string; data: Uint8Array }) => void): () => void;
  onClosed(listener: (payload: { id: string; reason: string }) => void): () => void;
}
export type EngineLoginEngine = "codex" | "claudeAgent" | "grokAgent" | "kimiAgent" | "opencodeGo";
/** Engines whose sign-in belongs to one bot (server/cloud-home/engine-login.ts BOT_LOGIN_ENGINES). Claude's is home-wide; it names a bot only for that bot's own sign-in. */
export const BOT_LOGIN_ENGINES: readonly EngineLoginEngine[] = Object.freeze(["codex", "grokAgent", "kimiAgent", "opencodeGo"]);
/** Same words as server/cloud-home/copy.ts (engineLoginBotRequired). */
export const BOT_REQUIRED_COPY = "Choose which bot to sign this engine in for.";
/** Whether this start would be refused for a missing bot: every per-bot sign-in names its bot. */
export const engineLoginNeedsBot = (engine: EngineLoginEngine, action: EngineLoginAction, bot?: { id: string } | null) =>
  action === "login" && BOT_LOGIN_ENGINES.includes(engine) && !bot;
/** Engines that take an API key typed in the sign-in screen (`enroll-key`); OpenCode also names the key's provider. */
export const KEY_ENGINES: readonly EngineLoginEngine[] = Object.freeze(["codex", "opencodeGo"]);
/** Same shapes the server checks before anything runs. */
export const ENGINE_KEY_SHAPE = /^[A-Za-z0-9._-]{20,512}$/;
export const ENGINE_KEY_PROVIDER_SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;
export type SessionPhase = "connecting" | "open" | "closed" | "error";
export interface SessionState { phase: SessionPhase; message?: string; notice?: string; reason?: string }

/** Plain-words endings for the reasons main reports. */
export const CLOSE_COPY: Record<string, string> = {
  done: "The sign-in finished.",
  stopped: "Closed.",
  "idle-timeout": "The sign-in sat idle for 2 minutes and was closed. Start it again.",
  "total-timeout": "The sign-in ran for 15 minutes and was closed. Start it again.",
  "window-closed": "Closed.",
  error: "The connection to your Cloud home dropped.",
};

/**
 * One relay session: starts it, feeds the terminal, opens vetted links, sends the pasted code, and stops it.
 * `write` receives raw terminal bytes. Data that races ahead of the start reply is held until the id is known.
 */
export function startEngineLoginSession({ bridge, request, write, onState }: {
  bridge: EngineLoginBridge;
  request: EngineLoginStart;
  write: (data: Uint8Array) => void;
  onState: (state: SessionState) => void;
}) {
  let id: string | null = null;
  let stopped = false;
  let finished = false;
  const early: { id: string; data: Uint8Array }[] = [];
  const finish = (state: SessionState) => { if (finished) return; finished = true; unsubscribe(); onState(state); };
  const unsubscribeData = bridge.onData((payload) => {
    if (finished) return;
    if (id === null) { early.push(payload); return; }
    if (payload.id === id) write(payload.data);
  });
  const unsubscribeClosed = bridge.onClosed((payload) => {
    if (id !== null && payload.id === id) finish({ phase: "closed", reason: payload.reason, message: CLOSE_COPY[payload.reason] ?? "The sign-in ended." });
  });
  function unsubscribe() { unsubscribeData(); unsubscribeClosed(); }
  onState({ phase: "connecting" });
  void bridge.start(request).then((result) => {
    if (!result.ok) { finish({ phase: "error", message: result.message, reason: result.code }); return; }
    id = result.id;
    if (stopped) { void bridge.stop({ id }); return; }
    for (const payload of early.splice(0)) if (payload.id === id) write(payload.data);
    onState({ phase: "open" });
  }, () => finish({ phase: "error", message: "The sign-in could not start.", reason: "refused" }));

  return {
    /** An allow-listed link opens in the default browser through main; anything else is refused here and again in main. */
    async openLink(url: string): Promise<boolean> {
      if (id === null || finished || !checkAuthUrl(url)) { onState({ phase: finished ? "closed" : id === null ? "connecting" : "open", notice: LINK_REFUSED }); return false; }
      const result = await bridge.openLink({ id, url });
      if (!result.ok) onState({ phase: "open", notice: result.message });
      return result.ok;
    },
    /** The code the vendor page shows (Claude). Sent once with a carriage return; never kept. */
    async sendCode(code: string): Promise<boolean> {
      const clean = code.trim();
      if (id === null || finished || clean === "") return false;
      const result = await bridge.input({ id, data: `${clean}\r` });
      if (!result.ok) onState({ phase: "open", notice: result.message });
      return result.ok;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (id !== null && !finished) void bridge.stop({ id });
      finish({ phase: "closed", reason: "stopped", message: CLOSE_COPY.stopped });
    },
  };
}
