// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every Flux Router endpoint Murage calls, and the code that calls it. The
// daily live check (.github/workflows/flux-contract-daily.yml, probes in
// server/flux-contract.live.test.ts) probes each `id` below against the real
// Flux. flux-contract-endpoints.test.ts fails if code starts using Flux in a
// file that is not listed here, so a new endpoint must be added here and probed.
// The allowed list is FluxMain's answer of 2026-10-09 (#408 default-deny).

export interface FluxEndpoint {
  id: string;
  method: "GET" | "POST";
  /** Path on api.fluxrouter.ai. */
  path: string;
}

export const FLUX_ENDPOINTS: readonly FluxEndpoint[] = [
  { id: "models", method: "GET", path: "/v1/models" },
  { id: "chat.completions", method: "POST", path: "/v1/chat/completions" },
  { id: "messages", method: "POST", path: "/v1/messages" },
  { id: "messages.anthropic-base", method: "POST", path: "/anthropic/v1/messages" },
  { id: "messages.count_tokens", method: "POST", path: "/v1/messages/count_tokens" },
  { id: "responses", method: "POST", path: "/v1/responses" },
  { id: "audio.speech", method: "POST", path: "/v1/audio/speech" },
  { id: "audio.transcriptions", method: "POST", path: "/v1/audio/transcriptions" },
  { id: "audio.voices", method: "GET", path: "/v1/audio/voices" },
  { id: "voice.lookup", method: "POST", path: "/v1/voice/lookup" },
  { id: "images.generations", method: "POST", path: "/v1/images/generations" },
  { id: "images.edits", method: "POST", path: "/v1/images/edits" },
  { id: "search", method: "POST", path: "/v1/search" },
  { id: "decide", method: "POST", path: "/v1/decide" },
  { id: "composio.health", method: "GET", path: "/composio/health" },
  { id: "composio.broker", method: "GET", path: "/composio/v1/me" },
  { id: "key.info", method: "GET", path: "/key/info" },
] as const;

/** Called by the code but Flux has no handler (FluxMain, 2026-10-09). Being
 * removed or put behind a flag by the m102-fluxpaths lane; delete each entry
 * with its code. Never probed: a 404 here is the known answer. */
export const FLUX_KNOWN_UNSERVED: readonly string[] = [
  "/v1/images/models",
  "/v1/images/jobs",
  "/v1/audio/transcriptions/stream",
  // UX-L2C spend meter (1.0.18): Flux serves it only behind FLUX_KEY_LIMITS_ROUTE_ENABLED, still off in prod; the meter says "will show once
  // Flux reports it" until then. When Flux turns it on, move it to FLUX_ENDPOINTS as key.limits (probed) and list it on server/flux-limits.ts.
  "/v1/key/limits",
];

/** Non-test server files that name a Flux base or host, and what they use. A
 * file that starts doing so without being added here fails the static test. */
export const FLUX_CALLER_FILES: Readonly<Record<string, readonly string[]>> = {
  "server/avatar-image.ts": ["images.generations"],
  "server/browser-action-checker-connection.ts": ["chat.completions"],
  "server/composio.ts": ["composio.health", "composio.broker"],
  "server/decider/flux.ts": ["decide"],
  // Bot email (1.0.9) is dark until Flux serves /v1/email/capabilities with enabled: true; its /v1/email/* routes join the probed list
  // above (and the daily live check) when Flux ships them (BOT-EMAIL-FLUX-CONTRACT). Until then it reaches nothing a probe could answer.
  "server/email/runtime.ts": [],
  // 1.0.18 voice-402 call budget: these two name the default Flux base only as the key of the shared budget memo (markBudgetReached) when a
  // turn's own route carries no base. They make no request there: the turn itself reaches Flux through the files listed below and flux-routing.ts.
  // docs/verification/voice-402-call-1018.md:22 (ACP and OpenAI adapters mark the existing memo on a known Flux route only).
  "server/drivers/acp/core.ts": [],
  "server/drivers/claude.ts": [],
  "server/drivers/acp/hermes.ts": ["chat.completions"],
  // On a Cloud home these two hand the launcher a Flux route to render (cloudTurnRender): the engine then calls that base itself.
  "server/drivers/acp/opencode-go.ts": ["chat.completions"],
  "server/drivers/codex.ts": ["responses"],
  "server/flux-key-health.ts": ["key.info"],
  // GET /v1/key/limits for the spend meter: known-unserved above until Flux turns the route on in prod (then ["key.limits"]).
  "server/flux-limits.ts": [],
  // Recognises a Flux host so callers attach the memory headers; no request of its own.
  "server/flux-memory-headers.ts": [],
  // Builds the usage tags (bot, feature, thread) and reads the served-model headers; recognises a Flux host so callers attach
  // them only there. No request of its own.
  "server/flux-usage-tags.ts": [],
  "server/flux-routing.ts": ["chat.completions", "messages", "messages.anthropic-base", "messages.count_tokens", "responses", "models"],
  "server/image-generation.ts": ["images.generations", "images.edits", "models"],
  "server/index.ts": ["search"],
  "server/memory/extractor-connections.ts": ["chat.completions"],
  "server/opencode-config.ts": ["chat.completions", "models"],
  "server/tts/flux-speech.ts": ["audio.speech", "audio.voices"],
  "server/voice/flux-stream.ts": [],
  "server/voice/flux-voice.ts": ["audio.transcriptions", "voice.lookup"],
  "server/voice/stream-route.ts": [],
};
