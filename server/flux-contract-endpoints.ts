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
] as const;

/** Called by the code but Flux has no handler (FluxMain, 2026-10-09). Being
 * removed or put behind a flag by the m102-fluxpaths lane; delete each entry
 * with its code. Never probed: a 404 here is the known answer. */
export const FLUX_KNOWN_UNSERVED: readonly string[] = [
  "/v1/images/models",
  "/v1/images/jobs",
  "/v1/audio/transcriptions/stream",
];

/** Non-test server files that name a Flux base or host, and what they use. A
 * file that starts doing so without being added here fails the static test. */
export const FLUX_CALLER_FILES: Readonly<Record<string, readonly string[]>> = {
  "server/avatar-image.ts": ["images.generations"],
  "server/browser-action-checker-connection.ts": ["chat.completions"],
  "server/composio.ts": ["composio.health", "composio.broker"],
  "server/decider/flux.ts": ["decide"],
  "server/drivers/acp/hermes.ts": ["chat.completions"],
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
