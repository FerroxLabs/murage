// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Flux usage tags (1.0.10, issue #13 CREDIT-DRAIN-13): three request headers that let Flux Router split one key's
// spend by bot, by feature and by conversation. Agreed with FluxMain:
//
//   x-flux-bot-id     the stable bot id, 1..64 of [A-Za-z0-9._:-]. Anything else is dropped, never sent.
//   x-flux-feature    exactly one of chat | routine | memory | voice | image | email | app_event | other.
//   x-flux-thread-id  an opaque id for the conversation: an HMAC of Murage's thread id (32 hex). It can never carry
//                     message text, a name or an email address, whatever the thread id holds.
//
// Flux does not forward these to model providers and ignores them until its tag reader ships, so sending them is
// harmless. Every value is validated here; a caller cannot put a malformed value on the wire through this module.
import { createHmac } from "node:crypto";

export const FLUX_BOT_ID_HEADER = "x-flux-bot-id";
export const FLUX_FEATURE_HEADER = "x-flux-feature";
export const FLUX_THREAD_ID_HEADER = "x-flux-thread-id";
export const FLUX_USAGE_HEADERS = [FLUX_BOT_ID_HEADER, FLUX_FEATURE_HEADER, FLUX_THREAD_ID_HEADER] as const;

export const FLUX_FEATURES = ["chat", "routine", "memory", "voice", "image", "email", "app_event", "other"] as const;
export type FluxFeature = (typeof FLUX_FEATURES)[number];

/** What one Flux request is for. `botId` and `threadId` are Murage's own ids, validated and hashed here. */
export interface FluxUsage {
  feature: FluxFeature;
  botId?: string | null;
  threadId?: string | null;
}

const BOT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const THREAD_ID_MAX_INPUT = 512;
/** Fixed key: the tag must be stable across restarts so Flux can group a conversation's requests. Murage thread ids are random. */
const THREAD_TAG_KEY = "murage-flux-thread-v1";

export function isFluxFeature(value: unknown): value is FluxFeature {
  return typeof value === "string" && (FLUX_FEATURES as readonly string[]).includes(value);
}

/** The bot id as sent, or null when it is not exactly the agreed shape (dropped, never repaired). */
export function fluxBotIdValue(botId: unknown): string | null {
  return typeof botId === "string" && BOT_ID.test(botId) ? botId : null;
}

/** The opaque conversation tag for a Murage thread id, or null when there is none. */
export function fluxThreadIdValue(threadId: unknown): string | null {
  if (typeof threadId !== "string") return null;
  const id = threadId.trim();
  if (!id || id.length > THREAD_ID_MAX_INPUT) return null;
  return createHmac("sha256", THREAD_TAG_KEY).update(id).digest("hex").slice(0, 32);
}

/** The usage headers for one request. The feature is always present (`other` when unknown); bot and thread only when valid. */
export function fluxUsageHeaders(usage: FluxUsage | undefined | null): Record<string, string> {
  const headers: Record<string, string> = { [FLUX_FEATURE_HEADER]: isFluxFeature(usage?.feature) ? usage!.feature : "other" };
  const bot = fluxBotIdValue(usage?.botId);
  if (bot) headers[FLUX_BOT_ID_HEADER] = bot;
  const thread = fluxThreadIdValue(usage?.threadId);
  if (thread) headers[FLUX_THREAD_ID_HEADER] = thread;
  return headers;
}

export function isFluxUsageHeader(name: string): boolean {
  return (FLUX_USAGE_HEADERS as readonly string[]).includes(name.toLowerCase());
}

/** A header record without any usage header: a caller's or an inherited overlay's own values never survive. */
export function withoutFluxUsageHeaders<T>(headers: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !isFluxUsageHeader(name)));
}

/** Whether a URL is a Flux Router host (the usage tags belong on it and nowhere else). Same rule as flux-memory-headers.ts isFluxUrl. */
export function isFluxHost(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === "api.fluxrouter.ai" || host.endsWith(".fluxrouter.ai");
  } catch { return false; }
}

/** Puts the usage tags on a Headers object, replacing any the caller set. */
export function setFluxUsageHeaders(headers: Headers, usage: FluxUsage): Headers {
  for (const name of FLUX_USAGE_HEADERS) headers.delete(name);
  for (const [name, value] of Object.entries(fluxUsageHeaders(usage))) headers.set(name, value);
  return headers;
}

/** Refuses a usage header whose value is not the agreed shape (the last check before a header record leaves). */
export function assertFluxUsageHeaders(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === FLUX_FEATURE_HEADER && !isFluxFeature(value)) throw new Error("Flux feature tag is not one of the agreed values");
    if (lower === FLUX_BOT_ID_HEADER && fluxBotIdValue(value) === null) throw new Error("Flux bot tag is malformed");
    if (lower === FLUX_THREAD_ID_HEADER && !/^[0-9a-f]{32}$/.test(value)) throw new Error("Flux thread tag is malformed");
  }
}

// --------------------------------------------------------------- engine turns --

/** The automation kinds a turn can carry (store.ts Message["automation"]), mapped onto the agreed features. */
export function fluxFeatureForAutomation(kind: string | undefined): FluxFeature {
  switch (kind) {
    case undefined: return "chat";
    // a routine run: on its schedule, by hand, or started by a channel message (ROUTINE_RUN_TRIGGERS)
    case "schedule": case "manual": case "channel": return "routine";
    // a routine run started by an app calling its webhook
    case "webhook": return "app_event";
    // an unattended message, a bot asking a bot, a room turn: conversation
    case "message": case "delegation": case "ask": case "room": return "chat";
    default: return "other";
  }
}

/** The usage of one engine turn, from what the harness stamped on it. */
export function fluxUsageForTurn(turn: { threadId?: string; background?: boolean; usageFeature?: FluxFeature; warmIdentity?: { botId: string } } | undefined): FluxUsage {
  return {
    feature: isFluxFeature(turn?.usageFeature) ? turn!.usageFeature : turn?.background ? "other" : "chat",
    botId: turn?.warmIdentity?.botId ?? null,
    threadId: turn?.threadId ?? null,
  };
}

/** A Cloud home's launcher validates every engine header overlay against the exact memory-header shape and refuses a turn that
 *  carries anything else (deploy/cloud-home/murage-turn-launch.py FLUX_MEMORY_HEADERS). Until it accepts the usage headers, engine
 *  overlays on a home carry none; Murage's own HTTP calls on a home still do. */
export function engineUsageTagsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MURAGE_CLOUD_ROLE !== "home";
}

// -------------------------------------------------------------- served model --

export const FLUX_ROUTED_MODEL_HEADER = "x-flux-routed-model";
export const FLUX_ORIGINAL_MODEL_HEADER = "x-flux-original-model";

/** The model that answered and the one that was asked for, as stored on a reply. */
export interface ServedModel { routed: string; requested: string }

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/** Both model headers of a Flux response, or null when either is missing or not a model id. */
export function readServedModel(headers: { get(name: string): string | null } | undefined | null): ServedModel | null {
  if (!headers) return null;
  const routed = headers.get(FLUX_ROUTED_MODEL_HEADER)?.trim() ?? "";
  const requested = headers.get(FLUX_ORIGINAL_MODEL_HEADER)?.trim() ?? "";
  return MODEL_ID.test(routed) && MODEL_ID.test(requested) ? { routed, requested } : null;
}
