// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What an engine sign-in names, and what an owner's browser may say to it (browser-owner DESIGN section 5).
//
// A browser has no desktop bridge, so it asks the home for a ticket (POST /api/cloud/engine-login/ticket, answered in
// cloud-request-auth.ts), then opens the relay WebSocket with it. The ticket is bound to the device, its access token and the
// exact target, lives 30 seconds and is spent by one redeem. The relay then gives a browser a narrow keyboard: one pasted
// vendor code, shaped for that engine, and nothing else. Dependency-light on purpose: the auth layer imports it.
import { createHash } from "node:crypto";
import { createTicketStore, type TicketStore } from "../single-use-ticket.ts";
import type { EngineLoginEngine } from "./engine-login-engines.ts";
import { ENGINE_LOGIN_ENGINES } from "./engine-login-engines.ts";
import { isCloudHiddenEngine } from "./runnable-engines.ts";

export const ENGINE_LOGIN_ACTIONS = ["login", "logout", "enroll-key"] as const;
export type EngineLoginAction = (typeof ENGINE_LOGIN_ACTIONS)[number];
/** The actions each engine offers (mirrors LOGIN_COMMANDS and ENROLL_ENGINES in the launcher).
 * No logout runs a CLI: every sign-out, Kimi's included, is the launcher's own publish of an empty
 * sign-in generation (publish_login), through this same relay and log. */
export const ENGINE_LOGIN_ENGINE_ACTIONS: Readonly<Record<EngineLoginEngine, readonly EngineLoginAction[]>> = {
  codex: ["login", "logout", "enroll-key"], claudeAgent: ["login", "logout"], antigravityAgent: ["login", "logout"], grokAgent: ["login", "logout"], kimiAgent: ["login", "logout"],
  opencodeGo: ["login", "logout", "enroll-key"],
};
/** Every engine whose `login` is a per-bot (B mode) sign-in. Claude's login (`setup-token`) is engine-wide and takes no bot. */
export const BOT_LOGIN_ENGINES: readonly EngineLoginEngine[] = ["codex", "antigravityAgent", "grokAgent", "kimiAgent", "opencodeGo"];
/** Same shapes the launcher validates; checked here too so a bad value never spawns anything. */
export const LOGIN_BOT = /^[\w-]{1,64}$/;
export const LOGIN_PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;

export interface EngineLoginTarget { engine: EngineLoginEngine; action: EngineLoginAction; bot?: string; provider?: string }
export type EngineLoginTargetFault = "unknown" | "bot-required";

/** The one check of a sign-in's shape, used by the ticket route and by the relay, so a ticket can only ever name what the relay would run. */
export function checkEngineLoginTarget(input: { engine: unknown; action: unknown; bot?: unknown; provider?: unknown }): { ok: true; target: EngineLoginTarget } | { ok: false; fault: EngineLoginTargetFault } {
  const { engine, action, bot, provider } = input;
  if (typeof engine !== "string" || !(ENGINE_LOGIN_ENGINES as readonly string[]).includes(engine)) return { ok: false, fault: "unknown" };
  // This relay runs only on a Cloud home, and a home withholds Antigravity (no code box yet): no ticket and no launch for it.
  if (isCloudHiddenEngine(engine)) return { ok: false, fault: "unknown" };
  if (typeof action !== "string" || !(ENGINE_LOGIN_ENGINE_ACTIONS[engine as EngineLoginEngine] as readonly string[]).includes(action)) return { ok: false, fault: "unknown" };
  if (bot !== undefined && (typeof bot !== "string" || !LOGIN_BOT.test(bot))) return { ok: false, fault: "unknown" };
  if (provider !== undefined && typeof provider !== "string") return { ok: false, fault: "unknown" };
  const e = engine as EngineLoginEngine, a = action as EngineLoginAction;
  if (a === "login" && BOT_LOGIN_ENGINES.includes(e) && bot === undefined) return { ok: false, fault: "bot-required" };
  if (a === "enroll-key" && bot !== undefined) return { ok: false, fault: "unknown" };
  if (a === "enroll-key" && e === "opencodeGo" ? provider === undefined || !LOGIN_PROVIDER.test(provider as string) : provider !== undefined) return { ok: false, fault: "unknown" };
  return { ok: true, target: { engine: e, action: a, ...(bot !== undefined ? { bot: bot as string } : {}), ...(provider !== undefined ? { provider: provider as string } : {}) } };
}

// ── the ticket ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const ENGINE_TICKET_TTL_MS = 30_000;
export const ENGINE_TICKET_QUERY = "loginTicket";
export interface EngineTicketWho { deviceId: string; accessToken: string }
/** The string a ticket is bound to: the device, a hash of its access token and the exact target. Any difference redeems nothing. */
export function engineTicketPrincipal(who: EngineTicketWho, target: EngineLoginTarget): string {
  const access = createHash("sha256").update(who.accessToken).digest("hex");
  return JSON.stringify(["murage-engine-login-v1", who.deviceId, access, target.engine, target.action, target.bot ?? null, target.provider ?? null]);
}
export function createEngineLoginTickets(opts: { ttlMs?: number; now?: () => number; maxOutstanding?: number } = {}): TicketStore {
  return createTicketStore({ ttlMs: opts.ttlMs ?? ENGINE_TICKET_TTL_MS, maxOutstanding: opts.maxOutstanding ?? 32, ...(opts.now ? { now: opts.now } : {}) });
}

const redeemed = new WeakMap<object, EngineLoginTarget>();
/** The auth layer records that this upgrade carried a ticket it redeemed, for exactly this target. The relay admits an owner browser only on this. */
export const markEngineTicketRedeemed = (headers: object, target: EngineLoginTarget): void => { redeemed.set(headers, target); };
export const engineTicketRedeemedFor = (headers: object): EngineLoginTarget | undefined => redeemed.get(headers);

// ── what a browser may type ─────────────────────────────────────────────────────────────────────────────────────────

/** The one pasted code a browser may send, per engine. null: the engine's sign-in takes no typing (the vendor page shows a code
 * to enter THERE, or the CLI waits on the vendor), so every message is dropped. OpenCode's menu cannot be driven through a filter,
 * so it takes a saved key (`enroll-key`) and no typed login. */
export const ENGINE_LOGIN_BROWSER_CODE: Readonly<Record<EngineLoginEngine, RegExp | null>> = {
  claudeAgent: /^[A-Za-z0-9._~#-]{16,400}$/,
  antigravityAgent: /^[A-Za-z0-9._~#\/%-]{8,512}$/,
  codex: null, grokAgent: null, kimiAgent: null, opencodeGo: null,
};

/** What a browser's message turns into on the CLI's stdin: the code and one carriage return, or null (dropped). Only a `login`, only once. */
export function browserStdin(engine: EngineLoginEngine, action: EngineLoginAction, message: Buffer | string, alreadySent: boolean): string | null {
  if (action !== "login" || alreadySent) return null;
  const pattern = ENGINE_LOGIN_BROWSER_CODE[engine];
  if (!pattern || (typeof message !== "string" && message.length > 1024)) return null;
  const text = (typeof message === "string" ? message : message.toString("utf8")).replace(/[\r\n]+$/, "");
  return pattern.test(text) ? `${text}\r` : null;
}
