// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Connect button for a Cloud MCP server that signs in with OAuth. OWNERS: the route and its answer shapes belong to MurageCloud M1
// (server/cloud-home/mcp-signin-connect.ts, route POST /api/cloud/mcp/servers/<name>/connect); this page side belongs to this lane.
//   request:  POST, no body. The home's device-signed step-up (the second click) happens in the transport, not on this page.
//   answer:   200 { url }  the provider's authorize URL (state and PKCE challenge only; never a token)
//             403 { error } one plain line (owner only, no such tool, cannot reach it, not supported, step-up refused)
//             404 { error } not a Cloud home
// The state machine is idle -> connecting -> waiting -> connected, with failed (retry) reachable from connecting and waiting.
// Every state has a way out: a retry, an "open again" link, or a cancel. Nothing here is ever required of the owner.
import { api } from "@/state/store";
import { callNative, nativeAvailable } from "./native-shell";
import { t } from "./i18n";

export const MCP_SERVER_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
export const connectPath = (name: string): string => `/api/cloud/mcp/servers/${name}/connect`;

export type ConnectState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "waiting"; url: string }
  | { phase: "connected" }
  | { phase: "failed"; message: string };

type Call = (path: string, init?: { method?: string; body?: string }) => Promise<unknown>;

/** Whether a row gets the button: a Cloud home, a link added with OAuth, not yet signed in. */
export function showsConnect(input: { cloud: boolean; server: { kind?: string; auth?: string; status?: string } }): boolean {
  return input.cloud && input.server.kind === "remote" && input.server.auth === "oauth" && input.server.status === "needs-sign-in";
}

/** One connect request. The authorize URL must be https; anything else is a failure with the plain fallback line. */
export async function requestConnect(name: string, call: Call = api): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const fallback = t("ux.cloud.mcpConnect.failedFallback");
  if (!MCP_SERVER_NAME.test(name)) return { ok: false, message: fallback };
  try {
    const body = await call(connectPath(name), { method: "POST" }) as { url?: unknown } | null;
    const url = typeof body?.url === "string" ? body.url : "";
    return /^https:\/\//.test(url) ? { ok: true, url } : { ok: false, message: fallback };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.trim() : "";
    return { ok: false, message: message || fallback };
  }
}

/** Opens the provider's page in the owner's browser. Returns false when nothing could open it (the "open again" link stays). */
export async function openProviderPage(url: string): Promise<boolean> {
  try {
    if (await nativeAvailable("openExternal")) { await callNative("openExternal", url); return true; }
    // No "noopener" feature: a browser answers null for a window it opened that way, which cannot be told from a blocked pop-up.
    // The opener link is cut by hand instead.
    if (typeof window === "undefined") return false;
    const opened = window.open(url, "_blank");
    if (!opened) return false;
    opened.opener = null;
    return true;
  } catch { return false; }
}

export interface ConnectDeps {
  name: string;
  host: string;
  call?: Call;
  open?: (url: string) => Promise<boolean>;
  /** Whether the saved entry now reads as signed in (null: could not tell, keep waiting). */
  signedIn: () => Promise<boolean | null>;
  set: (state: ConnectState) => void;
  /** True once the owner cancelled or the row went away: stop quietly. */
  stopped: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  timeoutMs?: number;
}

/** Runs one connect to its end: connecting, waiting for the provider, then connected or failed. */
export async function runConnect(deps: ConnectDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = deps.pollMs ?? 2000;
  const timeoutMs = deps.timeoutMs ?? 5 * 60_000;
  deps.set({ phase: "connecting" });
  const started = await requestConnect(deps.name, deps.call);
  if (deps.stopped()) return;
  if (!started.ok) { deps.set({ phase: "failed", message: started.message }); return; }
  deps.set({ phase: "waiting", url: started.url });
  await (deps.open ?? openProviderPage)(started.url);
  if (deps.stopped()) return;
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    await sleep(pollMs);
    if (deps.stopped()) return;
    if (await deps.signedIn().catch(() => null) === true) { deps.set({ phase: "connected" }); return; }
  }
  if (!deps.stopped()) deps.set({ phase: "failed", message: t("ux.cloud.mcpConnect.timedOut", { host: deps.host }) });
}

/** The add card's browser sign-ins that are running, by server name, so its Cancel (and the card going away) can stop one. */
const homeSignIns = new Map<string, () => void>();
export function cancelHomeSignIn(name: string): void { homeSignIns.get(name)?.(); }

/** The add card's sign-in in a browser: one connect run, answered in the shape signInTo gives (ok, or a plain line).
 * A blocked pop-up ends it at once with a plain line; Cancel (cancelHomeSignIn) ends it quietly. */
export async function signInViaHome(name: string, call: Call = api, host = "", deps: Partial<ConnectDeps> = {}): Promise<{ ok: true } | { ok: false; message: string; cancelled: boolean }> {
  const last: { state: ConnectState; cancelled: boolean; blocked: boolean } = { state: { phase: "idle" }, cancelled: false, blocked: false };
  const open = deps.open ?? openProviderPage;
  let cancel = () => {};
  const cancelled = new Promise<void>((resolve) => { cancel = () => { last.cancelled = true; resolve(); }; });
  homeSignIns.get(name)?.();
  homeSignIns.set(name, cancel);
  try {
    await Promise.race([cancelled, runConnect({
      name, host: host || name, call, set: (state) => { last.state = state; },
      stopped: () => last.cancelled || last.blocked,
      signedIn: async () => {
        const result = await call("/api/mcp/servers") as { servers?: Array<{ name?: string; status?: string }> } | null;
        const row = result?.servers?.find((s) => s.name === name);
        return row ? row.status === "ready" : null;
      },
      ...deps,
      open: async (url) => { const opened = await open(url); if (!opened) last.blocked = true; return opened; },
    })]);
  } finally {
    if (homeSignIns.get(name) === cancel) homeSignIns.delete(name);
  }
  const end = last.state;
  if (last.cancelled) return { ok: false, message: "", cancelled: true };
  if (last.blocked) return { ok: false, message: t("ux.cloud.mcpConnect.popupBlocked"), cancelled: false };
  return end.phase === "connected" ? { ok: true } : { ok: false, message: end.phase === "failed" ? end.message : "", cancelled: false };
}
