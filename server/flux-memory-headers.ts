// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Flux Memory request headers: the one place that decides which memory headers
// a Flux-routed request carries (PROPOSAL-v2 sections 4.4, 5.4, 5.7).
//
// Rule: a PURPOSE decides the header values; the thread AUDIENCE decides the
// process. Every call that can reach api.fluxrouter.ai asks this module, so a
// call site cannot be added without a headers decision (flux-memory-headers.lint.test.ts).
//
//   - every Flux-routed request:  x-flux-memory-app: murage
//   - non-owner turns, unproven room turns, prewarm, every background call:
//       x-flux-memory-capture: off  +  x-flux-memory-inject: off
//   - owner turns: no off headers (interim, Sean's accounts), unless the owner
//     posture is "off" (after the Flux gates), the bot asks first, the kill
//     switch is on, or the latency breaker is open (inject only).
//   - unknown purpose: off/off.
//
// NEVER sent: x-flux-memory-scope (the old name) and `required`. A lint test
// and `assertNoForbiddenFluxHeaders` enforce it.
//
// x-flux-memory-space / x-flux-memory-read are computed here from Murage's
// spaces but only sent while the `spaces` flag is on. It defaults OFF: Flux
// returns no memory for them until its spaces PR ships, so turning it on later
// is one switch (`MURAGE_FLUX_MEMORY_SPACES=1` or `setFluxMemorySettings`).
import { createHmac } from "node:crypto";

import type { DriverKind, SendTurnInput } from "./contracts.ts";

export const FLUX_MEMORY_APP_HEADER = "x-flux-memory-app";
export const FLUX_MEMORY_CAPTURE_HEADER = "x-flux-memory-capture";
export const FLUX_MEMORY_INJECT_HEADER = "x-flux-memory-inject";
export const FLUX_MEMORY_SPACE_HEADER = "x-flux-memory-space";
export const FLUX_MEMORY_READ_HEADER = "x-flux-memory-read";
export const FLUX_MEMORY_APP = "murage";

/** Header names Murage must never put on a request. */
export const FLUX_MEMORY_FORBIDDEN_HEADERS = ["x-flux-memory-scope", "x-flux-memory-required", "x-flux-memory"] as const;

/** Every x-flux-memory-* name Murage may set. Anything else with that prefix is refused. */
const ALLOWED_MEMORY_HEADERS: ReadonlySet<string> = new Set([
  FLUX_MEMORY_APP_HEADER, FLUX_MEMORY_CAPTURE_HEADER, FLUX_MEMORY_INJECT_HEADER, FLUX_MEMORY_SPACE_HEADER, FLUX_MEMORY_READ_HEADER,
]);

export function assertNoForbiddenFluxHeaders(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if ((FLUX_MEMORY_FORBIDDEN_HEADERS as readonly string[]).includes(lower)) throw new Error(`Flux header ${lower} is never sent`);
    if (lower.startsWith("x-flux-memory-") && !ALLOWED_MEMORY_HEADERS.has(lower)) throw new Error(`Flux header ${lower} is not a Murage memory header`);
  }
}

// ---------------------------------------------------------------- settings --

export interface FluxMemorySettings {
  /** Kill switch: off/off on every Flux call, owner turns included. */
  killSwitch: boolean;
  /** `fluxMemory.inject: off` (5.7): owner turns send inject off. */
  inject: "on" | "off";
  /** After the gates: owner turns send off/off too (Murage's local bundle carries memory). */
  ownerMemory: "on" | "off";
  /** Send x-flux-memory-space / -read. Default OFF until Flux's spaces PR ships. */
  spaces: boolean;
}

let override: Partial<FluxMemorySettings> = {};

/** Integrator / tests: override the env-derived settings. `{}` clears. */
export function setFluxMemorySettings(next: Partial<FluxMemorySettings>): void {
  override = { ...next };
}

const offValue = (value: string | undefined): boolean => /^(off|0|false|no)$/i.test((value ?? "").trim());
const onValue = (value: string | undefined): boolean => /^(on|1|true|yes)$/i.test((value ?? "").trim());

export function fluxMemorySettings(env: NodeJS.ProcessEnv = process.env): FluxMemorySettings {
  return {
    killSwitch: override.killSwitch ?? offValue(env.MURAGE_FLUX_MEMORY),
    inject: override.inject ?? (offValue(env.MURAGE_FLUX_MEMORY_INJECT) ? "off" : "on"),
    ownerMemory: override.ownerMemory ?? (offValue(env.MURAGE_FLUX_MEMORY_OWNER) ? "off" : "on"),
    spaces: override.spaces ?? onValue(env.MURAGE_FLUX_MEMORY_SPACES),
  };
}

// ----------------------------------------------------------------- breaker --

export interface BreakerSample { firstTokenMs: number; injectOn: boolean }

const p95 = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};

/**
 * Circuit breaker (5.7): if first-token p95 over the last 20 inject-on turns
 * exceeds the inject-off baseline p95 by more than 1 s, owner turns send
 * `x-flux-memory-inject: off` for 15 minutes.
 */
export class FluxMemoryBreaker {
  private on: number[] = [];
  private off: number[] = [];
  private openUntil = 0;
  private readonly options: { window?: number; marginMs?: number; openMs?: number; minBaseline?: number; now?: () => number };
  // No parameter property: the server runs under Node's type stripping, which does not transform them.
  constructor(options: { window?: number; marginMs?: number; openMs?: number; minBaseline?: number; now?: () => number } = {}) {
    this.options = options;
  }
  private get window() { return this.options.window ?? 20; }
  private now() { return (this.options.now ?? Date.now)(); }

  record(sample: BreakerSample): void {
    if (!Number.isFinite(sample.firstTokenMs) || sample.firstTokenMs < 0) return;
    const list = sample.injectOn ? this.on : this.off;
    list.push(sample.firstTokenMs);
    if (list.length > this.window) list.shift();
    if (this.isOpen() || this.on.length < this.window || this.off.length < (this.options.minBaseline ?? 5)) return;
    if (p95(this.on) - p95(this.off) > (this.options.marginMs ?? 1000)) {
      this.openUntil = this.now() + (this.options.openMs ?? 15 * 60_000);
      this.on = [];
      console.warn("[flux] memory breaker open: inject is off for 15 minutes");
    }
  }
  isOpen(): boolean { return this.now() < this.openUntil; }
  reset(): void { this.on = []; this.off = []; this.openUntil = 0; }
}

export const fluxMemoryBreaker = new FluxMemoryBreaker();

// ------------------------------------------------------------------ spaces --

/** Murage's own space addresses, before hashing (PROPOSAL-v2 table 4.3). */
export type FluxSpaceRef =
  | { kind: "bot"; bot: string }
  | { kind: "bot-project"; bot: string; project: string }
  | { kind: "bot-team"; bot: string; team: string }
  | { kind: "project"; project: string }
  | { kind: "team"; team: string }
  | { kind: "room"; room: string; reachBack?: boolean; withOtherPeople?: boolean }
  | { kind: "shared" }
  /** Contact preferences, one conversation, a room with other people: stay on this computer. */
  | { kind: "local-only" };

const SPACE_CHARSET = /^[A-Za-z0-9._:#-]{1,128}$/;
export const FLUX_READ_LIMIT = 8;

const hashId = (salt: string, id: string): string => createHmac("sha256", salt).update(id).digest("hex").slice(0, 16);

/** The Flux space string for a Murage space, or null when it never goes to Flux. */
export function fluxSpaceString(ref: FluxSpaceRef, salt: string): string | null {
  const h = (id: string) => hashId(salt, id);
  let value: string | null;
  switch (ref.kind) {
    case "bot": value = `bot:${h(ref.bot)}`; break;
    case "bot-project": value = `bot:${h(ref.bot)}#project:${h(ref.project)}`; break;
    case "bot-team": value = `bot:${h(ref.bot)}#team:${h(ref.team)}`; break;
    case "project": value = `project:${h(ref.project)}`; break;
    case "team": value = `team:${h(ref.team)}`; break;
    case "room": value = ref.withOtherPeople ? null : `room:${h(ref.room)}`; break;
    case "shared": value = "you"; break;
    default: value = null;
  }
  return value && SPACE_CHARSET.test(value) ? value : null;
}

export interface FluxSpacePlan { write: string | null; read: string[] }

/**
 * Computes the write target and the read list from Murage's spaces. `read` is in
 * priority order (4.2). More than 8: room reach-backs go first, then the tail.
 * An empty or all-local write is null (no space header, no capture target).
 */
export function computeFluxSpacePlan(input: { write: FluxSpaceRef | null; read: readonly FluxSpaceRef[]; salt: string }): FluxSpacePlan {
  const write = input.write ? fluxSpaceString(input.write, input.salt) : null;
  const entries = input.read.flatMap((ref) => {
    const value = fluxSpaceString(ref, input.salt);
    return value ? [{ value, reachBack: ref.kind === "room" && ref.reachBack === true }] : [];
  });
  const unique = entries.filter((entry, index) => entries.findIndex((other) => other.value === entry.value) === index);
  let kept = unique;
  if (kept.length > FLUX_READ_LIMIT) {
    const dropReach = kept.filter((entry) => !entry.reachBack);
    kept = dropReach.length >= FLUX_READ_LIMIT ? dropReach : [...dropReach, ...kept.filter((entry) => entry.reachBack)];
  }
  return { write, read: kept.slice(0, FLUX_READ_LIMIT).map((entry) => entry.value) };
}

// ----------------------------------------------------------------- context --

export type FluxAudienceClass = "owner" | "non-owner" | "background" | "prewarm" | "unknown";

export interface FluxMemoryContext {
  audience: FluxAudienceClass;
  /** The bot is "Asks me first" (Phase 1): owner turn, but off/off. */
  asksFirst?: boolean;
  spaces?: FluxSpacePlan;
}

/** Unknown purpose is the safe default: off/off. */
export const FLUX_MEMORY_UNKNOWN: FluxMemoryContext = Object.freeze({ audience: "unknown" as const });

/**
 * The audience class of one engine turn, from what the harness stamped on it.
 * Owner only when the harness PROVED the owner (audience owner AND decidedOwner):
 * an owner-looking turn nobody proved (a room turn queued for unproven words) is
 * non-owner here. Background is never the owner's.
 */
export function fluxMemoryContextForTurn(
  turn: Pick<SendTurnInput, "background" | "prewarm" | "warmIdentity"> | undefined,
  extra: Pick<FluxMemoryContext, "asksFirst" | "spaces"> = {},
): FluxMemoryContext {
  if (!turn) return FLUX_MEMORY_UNKNOWN;
  if (turn.background) return { audience: "background" };
  const identity = turn.warmIdentity;
  // A prewarm sends no request, so its headers only fix the contract of the
  // process the real turn will adopt: classify it as that thread would be, or
  // every Flux owner turn would respawn the warm process it just adopted. A
  // prewarm with no identity has nothing to adopt it: off/off.
  if (!identity) return turn.prewarm ? { audience: "prewarm" } : FLUX_MEMORY_UNKNOWN;
  if (identity.audience === "owner" && identity.decidedOwner === true) return { audience: "owner", ...extra };
  return { audience: "non-owner" };
}

// ---------------------------------------------------------------- decision --

export type FluxMemoryReason =
  | "owner" | "non-owner" | "background" | "prewarm" | "unknown" | "asks-first" | "kill-switch" | "owner-gated" | "breaker" | "inject-off";

export interface FluxMemoryDecision {
  headers: Record<string, string>;
  capture: "on" | "off";
  inject: "on" | "off";
  reason: FluxMemoryReason;
  audience: FluxAudienceClass;
  /** Stable text for a warm-process key: a change forces a respawn. */
  signature: string;
}

const signatureOf = (headers: Record<string, string>): string =>
  Object.keys(headers).sort().map((name) => `${name}=${headers[name]}`).join(";");

export function fluxMemoryDecision(
  context: FluxMemoryContext = FLUX_MEMORY_UNKNOWN,
  options: { settings?: FluxMemorySettings; breaker?: FluxMemoryBreaker } = {},
): FluxMemoryDecision {
  const settings = options.settings ?? fluxMemorySettings();
  const breaker = options.breaker ?? fluxMemoryBreaker;
  let capture: "on" | "off" = "off";
  let inject: "on" | "off" = "off";
  let reason: FluxMemoryReason;
  if (settings.killSwitch) reason = "kill-switch";
  else if (context.audience !== "owner") reason = context.audience;
  else if (context.asksFirst) reason = "asks-first";
  else if (settings.ownerMemory === "off") reason = "owner-gated";
  else {
    capture = "on";
    inject = "on";
    reason = "owner";
    if (settings.inject === "off") { inject = "off"; reason = "inject-off"; }
    else if (breaker.isOpen()) { inject = "off"; reason = "breaker"; }
  }
  const headers: Record<string, string> = { [FLUX_MEMORY_APP_HEADER]: FLUX_MEMORY_APP };
  if (capture === "off") headers[FLUX_MEMORY_CAPTURE_HEADER] = "off";
  if (inject === "off") headers[FLUX_MEMORY_INJECT_HEADER] = "off";
  if (settings.spaces && context.spaces) {
    if (capture === "on" && context.spaces.write) headers[FLUX_MEMORY_SPACE_HEADER] = context.spaces.write;
    if (inject === "on" && context.spaces.read.length) headers[FLUX_MEMORY_READ_HEADER] = context.spaces.read.slice(0, FLUX_READ_LIMIT).join(",");
  }
  assertNoForbiddenFluxHeaders(headers);
  return { headers, capture, inject, reason, audience: context.audience, signature: signatureOf(headers) };
}

/** Header names that carry no secret: safe to log. */
export function describeFluxMemoryDecision(engine: string, decision: FluxMemoryDecision): string {
  return `[flux] memory-headers engine=${engine} thread=${decision.audience} capture=${decision.capture} inject=${decision.inject} reason=${decision.reason}`;
}

/** Once per process spawn. Never throws, never logs a header value. */
export function logFluxMemoryHeaders(engine: string, decision: FluxMemoryDecision): void {
  try { console.info(describeFluxMemoryDecision(engine, decision)); } catch { /* logging must not break a spawn */ }
}

// ------------------------------------------------------- engine mechanisms --

export type FluxHeaderMechanism =
  | "claude-env"        // ANTHROPIC_CUSTOM_HEADERS
  | "codex-provider"    // model_providers.flux / flux-off http_headers, chosen per thread
  | "fuigo-config-env"  // FUIGO_CONFIG overlay: models.extra_headers
  | "grok-config-env"   // GROK_CONFIG overlay: models.extra_headers (same shell source)
  | "hermes-config"     // config.yaml model.extra_headers
  | "qwen-settings"     // QWEN_CODE_SYSTEM_SETTINGS_PATH: model.generationConfig.customHeaders
  | "opencode-config"   // OPENCODE_CONFIG_CONTENT: provider.flux.options.headers
  | "murage-http"       // Murage's own fetch
  | "none";

export interface FluxEngineHeaderSupport {
  mechanism: FluxHeaderMechanism;
  /** "unsupported" blocks Flux routing on non-owner and background threads. */
  support: "supported" | "unsupported";
  /** How far the mechanism is verified: "code" = read in the engine source or docs and pinned by a Murage test;
   *  a live echo canary (F-ECHO) is still the rollout gate for every engine. */
  evidence: "code" | "docs";
}

/** Every engine that can route through Flux, and how its request gets the headers. */
export const FLUX_ENGINE_HEADERS: Readonly<Record<string, FluxEngineHeaderSupport>> = {
  claudeAgent: { mechanism: "claude-env", support: "supported", evidence: "docs" },
  codex: { mechanism: "codex-provider", support: "supported", evidence: "code" },
  fuigoAgent: { mechanism: "fuigo-config-env", support: "supported", evidence: "code" },
  grokAgent: { mechanism: "grok-config-env", support: "supported", evidence: "code" },
  hermesAgent: { mechanism: "hermes-config", support: "supported", evidence: "code" },
  qwenAgent: { mechanism: "qwen-settings", support: "supported", evidence: "docs" },
  opencodeGo: { mechanism: "opencode-config", support: "supported", evidence: "docs" },
  grok: { mechanism: "murage-http", support: "supported", evidence: "code" },
  "openai-compat": { mechanism: "murage-http", support: "supported", evidence: "code" },
};

/** `[flux] header-unsupported engine=<kind>` and a refusal, or null when the engine can carry the headers. */
export function fluxHeaderRefusal(engine: DriverKind, decision: FluxMemoryDecision): string | null {
  if (decision.capture === "on" && decision.inject === "on") return null;
  const entry = FLUX_ENGINE_HEADERS[engine];
  if (entry?.support === "supported") return null;
  try { console.warn(`[flux] header-unsupported engine=${engine}`); } catch { /* ignore */ }
  return "This engine cannot carry Flux Memory choices for this conversation, so it does not use Flux here.";
}

/** Whether a URL is a Flux Router host (so the memory headers belong on it). */
export function isFluxUrl(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(String(url)).hostname.toLowerCase();
    return host === "api.fluxrouter.ai" || host.endsWith(".fluxrouter.ai");
  } catch { return false; }
}

// ----------------------------------------------------------- call sites ----

/** Every direct Murage call that can reach Flux, and the purpose that decides its headers. */
export const FLUX_CALL_SITES = {
  decider: "background",
  "browser-checker": "background",
  "image-generation": "background",
  "avatar-image": "background",
  "voice-transcribe": "background",
  "voice-speech": "background",
  "voice-stream": "background",
  "memory-extraction": "background",
  "pip-reflection": "background",
  "composio-broker": "background",
  "voice-host": "background",
  "dictation-cleanup": "background",
  "web-search": "background",
} as const satisfies Record<string, "background">;
export type FluxCallSiteId = keyof typeof FLUX_CALL_SITES;

/** The headers for one direct Murage call to Flux. Every such call is background work: off/off. */
export function fluxCallHeaders(site: FluxCallSiteId, options: { settings?: FluxMemorySettings } = {}): Record<string, string> {
  void FLUX_CALL_SITES[site];
  return fluxMemoryDecision({ audience: "background" }, options).headers;
}

/** `fluxCallHeaders` for an endpoint that may or may not be Flux (`via` names it): none when it is not. */
export function fluxCallHeadersVia(site: FluxCallSiteId, via: string | undefined | null): Record<string, string> {
  return via === "flux" ? fluxCallHeaders(site) : {};
}

/**
 * fetch with the memory headers for `site` merged over the caller's headers.
 * The caller's own x-flux-memory-* values never survive.
 */
export function fluxFetch(
  site: FluxCallSiteId,
  input: string | URL,
  init: RequestInit = {},
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith("x-flux-memory")) headers.delete(name);
  for (const [name, value] of Object.entries(fluxCallHeaders(site))) headers.set(name, value);
  return fetchImpl(input, { ...init, headers });
}

/** Header record merged for a WebSocket handshake or a hand-built request. */
export function withFluxCallHeaders(site: FluxCallSiteId, headers: Record<string, string> = {}): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !name.toLowerCase().startsWith("x-flux-memory")));
  return { ...kept, ...fluxCallHeaders(site) };
}

// ------------------------------------------------- engine header renderers --

/** ANTHROPIC_CUSTOM_HEADERS value: newline-separated `Name: value`. */
export function claudeCustomHeadersValue(headers: Record<string, string>): string {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\n");
}

/** Codex provider ids. The app-server is shared by every thread, so the headers
 *  cannot ride its process: three provider tables are declared once, in argv,
 *  and each thread picks one at thread/start (and thread/resume). */
export const FLUX_CODEX_PROVIDER_BASE = "flux";
export const FLUX_CODEX_PROVIDER_OFF = "flux-off";
export const FLUX_CODEX_PROVIDER_NOINJECT = "flux-noinject";

/** The fixed headers of each codex table. Never depend on settings: a settings change picks another table. */
export const FLUX_CODEX_TABLE_HEADERS: Readonly<Record<string, Record<string, string>>> = {
  [FLUX_CODEX_PROVIDER_BASE]: { [FLUX_MEMORY_APP_HEADER]: FLUX_MEMORY_APP },
  [FLUX_CODEX_PROVIDER_OFF]: { [FLUX_MEMORY_APP_HEADER]: FLUX_MEMORY_APP, [FLUX_MEMORY_CAPTURE_HEADER]: "off", [FLUX_MEMORY_INJECT_HEADER]: "off" },
  [FLUX_CODEX_PROVIDER_NOINJECT]: { [FLUX_MEMORY_APP_HEADER]: FLUX_MEMORY_APP, [FLUX_MEMORY_INJECT_HEADER]: "off" },
};

/** `-c` argv declaring `http_headers` on one codex provider table. */
export function codexHttpHeaderArgs(provider: string, headers: Record<string, string>): string[] {
  const inline = `{ ${Object.entries(headers).map(([name, value]) => `${JSON.stringify(name)} = ${JSON.stringify(value)}`).join(", ")} }`;
  return ["-c", `model_providers.${provider}.http_headers=${inline}`];
}

/** The codex provider table whose headers equal the decision's. Space headers are not table-static: with the spaces flag on, codex keeps these three. */
export function codexFluxProviderFor(decision: FluxMemoryDecision): string {
  if (decision.capture === "off") return FLUX_CODEX_PROVIDER_OFF;
  if (decision.inject === "off") return FLUX_CODEX_PROVIDER_NOINJECT;
  return FLUX_CODEX_PROVIDER_BASE;
}

/** JSON for FUIGO_CONFIG: the global [models].extra_headers default, applied to every model. */
export function fuigoConfigOverlay(headers: Record<string, string>, existing?: string): string {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch { /* an unreadable inline overlay is replaced */ }
  }
  const models = base.models && typeof base.models === "object" && !Array.isArray(base.models) ? base.models as Record<string, unknown> : {};
  const extra = models.extra_headers && typeof models.extra_headers === "object" && !Array.isArray(models.extra_headers) ? models.extra_headers as Record<string, unknown> : {};
  const kept = Object.fromEntries(Object.entries(extra).filter(([name]) => !name.toLowerCase().startsWith("x-flux-memory")));
  return JSON.stringify({ ...base, models: { ...models, extra_headers: { ...kept, ...headers } } });
}

/** YAML lines for hermes `model.extra_headers` (two-space indent under `model:`). */
export function hermesExtraHeaderLines(headers: Record<string, string>): string[] {
  return ["  extra_headers:", ...Object.entries(headers).map(([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)}`)];
}

/** JSON settings file content for qwen: model.generationConfig.customHeaders. */
export function qwenSettingsJson(headers: Record<string, string>): string {
  return JSON.stringify({ model: { generationConfig: { customHeaders: headers } } });
}

/** OPENCODE_CONFIG_CONTENT overlay: provider.<id>.options.headers. */
export function opencodeConfigOverlay(provider: string, headers: Record<string, string>, existing?: string): string {
  let base: Record<string, unknown> = {};
  if (existing?.trim()) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch { /* replaced */ }
  }
  const providers = base.provider && typeof base.provider === "object" ? base.provider as Record<string, unknown> : {};
  const entry = providers[provider] && typeof providers[provider] === "object" ? providers[provider] as Record<string, unknown> : {};
  const options = entry.options && typeof entry.options === "object" ? entry.options as Record<string, unknown> : {};
  const oldHeaders = options.headers && typeof options.headers === "object" ? options.headers as Record<string, unknown> : {};
  const kept = Object.fromEntries(Object.entries(oldHeaders).filter(([name]) => !name.toLowerCase().startsWith("x-flux-memory")));
  return JSON.stringify({ ...base, provider: { ...providers, [provider]: { ...entry, options: { ...options, headers: { ...kept, ...headers } } } } });
}
