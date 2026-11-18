// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The engine sign-in bridge for an owner's BROWSER on a Cloud home (browser-owner DESIGN section 5). The desktop's bridge lives in
// Electron's main process; a browser has none, so this one speaks the home's own door:
//   1. POST /api/cloud/engine-login/ticket {engine, action, bot?, provider?}. The page's api() answers a fresh-code request with the
//      emailed-code dialog and retries, so this never sees a code. The answer is one 30 second ticket bound to this browser and target.
//   2. Open wss://<home>/api/engine-login/<engine>?action=...&loginTicket=... The cookie rides the upgrade. The relay hands a browser
//      one keyboard line only: the pasted vendor code. Whatever else is sent, the home drops.
//   3. `enroll-key` sends the typed key as the first message, never in a URL.
// It implements the same EngineLoginBridge the terminal already takes, so the terminal and its link and paste rules are unchanged.
import { openSignInTab } from "./signin-tab";
import { checkAuthUrl, type EngineLoginBridge, type EngineLoginStart } from "./engine-login-terminal";

export const ENGINE_LOGIN_TICKET_PATH = "/api/cloud/engine-login/ticket";

export interface BrowserBridgeDeps {
  /** Asks the home for a ticket. Defaults to the page's own api(), which handles the emailed-code dialog. */
  ticket(body: Record<string, string>): Promise<{ ticket: string }>;
  openSocket(url: string): WebSocket;
  /** The page's origin, e.g. https://home.example. */
  origin(): string;
  /** Opens a vendor page in a new tab. */
  openTab(url: string): boolean;
}

const failure = (code: string, message: string) => ({ ok: false as const, code, message });
const failed = (cause: unknown): string => (cause instanceof Error && cause.message ? cause.message : "The sign-in could not start. Try again in a moment.");

/** The relay's URL for a start request. The secret of an `enroll-key` is deliberately not part of it. */
export function engineLoginSocketUrl(origin: string, request: Pick<EngineLoginStart, "engine" | "action" | "bot" | "provider">, ticket: string): string {
  const url = new URL(`/api/engine-login/${request.engine}`, origin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("action", request.action ?? "login");
  if (request.bot) url.searchParams.set("bot", request.bot);
  if (request.provider) url.searchParams.set("provider", request.provider);
  url.searchParams.set("loginTicket", ticket);
  return url.href;
}

export function createBrowserEngineLoginBridge(deps: BrowserBridgeDeps): EngineLoginBridge {
  const sockets = new Map<string, WebSocket>();
  const stopped = new Set<string>();
  const dataListeners = new Set<(payload: { id: string; data: Uint8Array }) => void>();
  const closedListeners = new Set<(payload: { id: string; reason: string }) => void>();
  let counter = 0;
  const closed = (id: string, reason: string) => { sockets.delete(id); for (const listener of closedListeners) listener({ id, reason }); };
  return {
    async start(request) {
      let ticket: string;
      try {
        const body: Record<string, string> = { engine: request.engine, action: request.action ?? "login" };
        if (request.bot) body.bot = request.bot;
        if (request.provider) body.provider = request.provider;
        const answer = await deps.ticket(body);
        if (typeof answer?.ticket !== "string" || answer.ticket === "") return failure("refused", "The sign-in could not start. Try again in a moment.");
        ticket = answer.ticket;
      } catch (cause) { return failure("refused", failed(cause)); }
      const id = `browser-${++counter}`;
      let socket: WebSocket;
      try { socket = deps.openSocket(engineLoginSocketUrl(deps.origin(), request, ticket)); } catch (cause) { return failure("refused", failed(cause)); }
      socket.binaryType = "arraybuffer";
      return new Promise((resolve) => {
        let opened = false;
        socket.onopen = () => {
          opened = true; sockets.set(id, socket);
          if (request.action === "enroll-key" && request.secret) socket.send(request.secret);
          resolve({ ok: true, id });
        };
        socket.onmessage = (event) => {
          const raw = event.data;
          const data = raw instanceof ArrayBuffer ? new Uint8Array(raw) : typeof raw === "string" ? new TextEncoder().encode(raw) : null;
          if (data) for (const listener of dataListeners) listener({ id, data });
        };
        socket.onerror = () => { if (!opened) resolve(failure("refused", "Your Cloud home did not open the sign-in. Try again in a moment.")); };
        socket.onclose = (event) => {
          if (!opened) { resolve(failure("refused", "Your Cloud home did not open the sign-in. Try again in a moment.")); return; }
          closed(id, stopped.delete(id) ? "stopped" : event.reason && /^[a-z-]{2,24}$/.test(event.reason) ? event.reason : event.code === 1000 ? "done" : "error");
        };
      });
    },
    async input({ id, data }) {
      const socket = sockets.get(id);
      if (!socket || socket.readyState !== 1) return failure("closed", "The sign-in has closed.");
      socket.send(data);
      return { ok: true };
    },
    async stop({ id }) {
      const socket = sockets.get(id);
      if (socket) { stopped.add(id); try { socket.close(1000, "stopped"); } catch { /* gone */ } }
      return { ok: true };
    },
    async openLink({ url }) {
      const clean = checkAuthUrl(url);
      if (!clean) return failure("refused", "That link isn't a sign-in page for this engine, so it was not opened.");
      return deps.openTab(clean) ? { ok: true } : failure("blocked", "Your browser blocked the new tab. Allow pop-ups for this page, then click the link again.");
    },
    onData(listener) { dataListeners.add(listener); return () => { dataListeners.delete(listener); }; },
    onClosed(listener) { closedListeners.add(listener); return () => { closedListeners.delete(listener); }; },
  };
}

let shared: EngineLoginBridge | undefined;
/** The one bridge the page uses in a browser. Built on first use; needs no desktop. */
export function browserEngineLoginBridge(): EngineLoginBridge {
  return shared ??= createBrowserEngineLoginBridge({
    ticket: async (body) => { const { api } = await import("@/state/store"); return api(ENGINE_LOGIN_TICKET_PATH, { method: "POST", body: JSON.stringify(body) }); },
    openSocket: (url) => new WebSocket(url),
    origin: () => window.location.origin,
    // The click that started the sign-in opened an empty tab (lib/signin-tab.ts); the vendor's link is pointed at it here.
    openTab: (url) => openSignInTab(url),
  });
}
