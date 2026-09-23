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
    ["xai", "grok-4-1-fast-non-reasoning"], // measured: 12/12 routing, first words 0.6-1.1 s
    ["anthropic", "claude-haiku-4-5"], // same model as Flux's default, direct
    ["openai", "gpt-6-luna"],
    ["groq", "openai/gpt-oss-120b"],
    ["openrouter", "anthropic/claude-haiku-4.5"],
  ],
  lookup: [
    ["flux", "flux-voice-lookup"], // xAI web search behind Flux
    ["xai", "grok-4-1-fast-non-reasoning"], // measured: answers with citations in 3-7 s
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

/** The endpoint that serves `part`, or null when nothing can. */
export function voiceEndpoint(part: VoicePart, source: ConnectionSource): VoiceEndpoint | null {
  const connections = source.list().filter((c) => c.enabled);
  for (const [preset, model] of PLAN[part]) {
    for (const connection of connections.filter((c) => c.preset === preset)) {
      const resolved = source.resolve(connection.id);
      if (!resolved?.key?.trim()) continue;
      // Anthropic's preset is its bare host; both its OpenAI-compatible chat
      // endpoint and its Messages API live under /v1.
      const base = resolved.baseUrl.replace(/\/+$/, "");
      return { via: preset, label: connection.label, baseUrl: preset === "anthropic" ? `${base}/v1` : base, key: resolved.key.trim(), model };
    }
  }
  return null;
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
