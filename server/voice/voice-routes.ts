// Where each part of a call goes: Flux by default, the owner's own keys
// otherwise.
//
// A call has four parts that need a service beyond the bot's own engine: the
// fast voice host, a web lookup, speech out, and (off the Mac) speech in.
// Flux Router carries all four on one key. An owner without Flux, or who
// prefers their own accounts, can use the model connections Murage already
// stores (Settings → Models, plus the older standalone keys the connection
// service merges in). This file picks, per part, the first source that can
// serve it, in a fixed order, and reports only WHICH provider serves each,
// never a key.
//
// Subscriptions (a Claude or ChatGPT plan signed into an engine CLI) are not
// a source here. They reach a model only through that engine's agent loop,
// which is the latency the voice host exists to avoid (Claude Code on Haiku
// took 9.3 s to first words), and using a plan's sign-in against the raw API
// is outside those plans' terms. A subscription still does the bot's work.
import type { ProviderPreset } from "../../shared/provider-connections.ts";

export type VoicePart = "host" | "lookup" | "speech" | "transcribe";

export interface VoiceEndpoint {
  /** Which provider serves this part, for display. */
  via: ProviderPreset;
  label: string;
  baseUrl: string;
  key: string;
  model: string;
}

interface ConnectionSource {
  list(): Array<{ id: string; preset: ProviderPreset; label: string; enabled: boolean }>;
  resolve(id: string): { baseUrl: string; key: string; preset: ProviderPreset; label: string } | null;
}

/**
 * The model each provider serves each part with. Order within a part is the
 * order sources are tried. A provider missing from a part cannot serve it.
 * Models marked "measured" were run live on 2026-09-23; the others are the
 * provider's current small model from the models.dev snapshot and are
 * checked by `server/voice/voice-host.eval.test.ts` when a key is supplied.
 */
const PLAN: Record<VoicePart, Array<[ProviderPreset, string]>> = {
  host: [
    ["flux", "claude-haiku-4-5"], // measured: 13/13 routing, first words 1.2-2.2 s
    // xAI's current fast model (2026-09-23). grok-4-1-fast-non-reasoning
    // still answers but is gone from xAI's model list; grok-4.7, the newest,
    // reasons first: 2.5-6 s to first words and 4 of 21 checks missed.
    ["xai", "grok-4.20-non-reasoning"], // measured: 20/21, first words 0.6-0.9 s
    ["anthropic", "claude-haiku-4-5"], // same model as Flux's default, direct
    ["openai", "gpt-6-luna"],
    ["groq", "openai/gpt-oss-120b"],
    ["openrouter", "anthropic/claude-haiku-4.5"],
  ],
  lookup: [
    ["flux", "flux-voice-lookup"], // xAI web search behind Flux
    ["xai", "grok-4.20-non-reasoning"], // measured: web lookups 1.9-6 s (grok-4.7: 21-31 s)
    ["openai", "gpt-6-luna"], // Responses API web_search tool
    ["anthropic", "claude-haiku-4-5"], // Messages API web_search server tool
  ],
  speech: [
    ["flux", "flux-voice-speak"],
    ["openai", "gpt-4o-mini-tts"], // the model flux-voice-speak is backed by
  ],
  transcribe: [
    ["flux", "flux-voice-fast"],
    ["groq", "whisper-large-v3-turbo"], // the arm flux-voice-fast is backed by
    ["openai", "gpt-4o-mini-transcribe"],
  ],
};

/** Every endpoint that can serve `part`, in the order they are tried. */
export function voiceEndpoints(part: VoicePart, source: ConnectionSource): VoiceEndpoint[] {
  const connections = source.list().filter((c) => c.enabled);
  const found: VoiceEndpoint[] = [];
  for (const [preset, model] of PLAN[part]) {
    for (const connection of connections.filter((c) => c.preset === preset)) {
      const resolved = source.resolve(connection.id);
      if (!resolved?.key?.trim()) continue;
      // Anthropic's preset is its bare host; both its OpenAI-compatible chat
      // endpoint and its Messages API live under /v1.
      const base = resolved.baseUrl.replace(/\/+$/, "");
      found.push({ via: preset, label: connection.label, baseUrl: preset === "anthropic" ? `${base}/v1` : base, key: resolved.key.trim(), model });
      break;
    }
  }
  return found;
}

/** The endpoint that serves `part`, or null when nothing can. */
export function voiceEndpoint(part: VoicePart, source: ConnectionSource): VoiceEndpoint | null {
  return voiceEndpoints(part, source)[0] ?? null;
}

/** A source answered that this part is not switched on for the account
 *  (Flux while one of its voice capabilities is dark). The next source can
 *  take over; the caller marks this one with `markUnavailable`. */
export class VoiceUnavailable extends Error {}

/** Sources that said a part is not switched on, and until when to skip them.
 *  Without this every sentence or lookup of a call would pay a refused
 *  request first. Rechecked after ten minutes, so a capability that switches
 *  on is picked up without a restart. */
const unavailable = new Map<string, number>();
const UNAVAILABLE_MS = 10 * 60_000;
const sourceId = (e: VoiceEndpoint) => `${e.via} ${e.baseUrl} ${e.model}`;
export function markUnavailable(endpoint: VoiceEndpoint, now = Date.now()): void {
  unavailable.set(sourceId(endpoint), now + UNAVAILABLE_MS);
}
export function isUnavailable(endpoint: VoiceEndpoint, now = Date.now()): boolean {
  return (unavailable.get(sourceId(endpoint)) ?? 0) > now;
}
/** Test seam: forget every refusal. */
export function resetUnavailable(): void {
  unavailable.clear();
}

/** What the app may know: which provider serves each part, nothing more. */
export function describeVoiceRoutes(source: ConnectionSource): Record<VoicePart, ProviderPreset | null> {
  return {
    host: voiceEndpoint("host", source)?.via ?? null,
    lookup: voiceEndpoint("lookup", source)?.via ?? null,
    speech: voiceEndpoint("speech", source)?.via ?? null,
    transcribe: voiceEndpoint("transcribe", source)?.via ?? null,
  };
}
