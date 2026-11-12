// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every server file that can reach Flux declares which kind it is (UX-L2C-PAUSE r4 2.2). flux-admission.lint.test.ts
// fails a source that reaches Flux without an entry, so a new Flux call site cannot skip the pause.
//   entitled  an in-process call made inside an admitted turn; calls authorizeFluxDispatch(key) so the turn's permission is checked per call
//   child     an engine child process inside an admitted turn; its calls cannot be intercepted here, the turn admission covers them
//   admits    calls authorizeFluxDispatch(key) (flux-start-gate.ts) before it sends: without a matching turn permission it is a start
//   none      makes no billable Flux request of its own (the reason says why)
export type FluxAdmissionKind = "entitled" | "admits" | "child" | "none";
export interface FluxAdmissionEntry { kind: FluxAdmissionKind; why: string }

export const FLUX_ADMISSION: Readonly<Record<string, FluxAdmissionEntry>> = {
  "drivers/boxagent.ts": { kind: "none", why: "Box agent API calls use the box provider; shared transport markers do not add a Flux model call" },
  "drivers/headless-target-guard.ts": { kind: "none", why: "browser CDP validation only; shared markers register decoded browser messages" },
  "drivers/headless-text-only.ts": { kind: "child", why: "headless CLI side calls run after the caller's admission fence; the child sends the model request" },
  "drivers/local-inject.ts": { kind: "none", why: "local catalog probes validate local server URLs; no remote Flux model request" },
  "drivers/pi.ts": { kind: "child", why: "engine child sends model requests inside the admitted turn; in-process catalog probes validate local server URLs" },
  "drivers/stop-gate.rules.config.ts": { kind: "none", why: "source-expression inventory for stop-gate tests; makes no request" },
  "local-tool-probe.ts": { kind: "none", why: "local model capability probes validate local server URLs before each request" },
  "drivers/acp/core.ts": { kind: "child", why: "engine child process: its Flux spend happens inside the admitted turn and cannot be intercepted in-process" },
  "drivers/acp/fuigo.ts": { kind: "child", why: "engine child process: its Flux spend happens inside the admitted turn and cannot be intercepted in-process" },
  "drivers/acp/hermes.ts": { kind: "child", why: "engine child process: its Flux spend happens inside the admitted turn and cannot be intercepted in-process" },
  "drivers/acp/opencode-go.ts": { kind: "child", why: "engine child process: its Flux spend happens inside the admitted turn and cannot be intercepted in-process" },
  "drivers/acp/qwen.ts": { kind: "child", why: "engine child process: its Flux spend happens inside the admitted turn and cannot be intercepted in-process" },
  "flux-admission.ts": { kind: "none", why: "this list" },
  "announcements.ts": { kind: "none", why: "a comment; announcements come from Ferrox, not Flux" },
  "app-trigger-delivery.ts": { kind: "none", why: "connected-app events claim and ack: no model call, nothing billed to the figure" },
  "browser-extension-integration.ts": { kind: "none", why: "reads fluxKey() only to hash it into the checker fence; the check request is browser-action-checker-connection.ts" },
  "cloud-home/flux-home-gate.ts": { kind: "none", why: "Cloud home GET /v1/cloud-home/status: key status only, no model call or billed work" },
  "cloud-home/flux-device-code-client.ts": { kind: "none", why: "device-code capabilities, owner sign-in and key revocation only; no model call or billed work" },
  "drivers/openai-compat.ts": { kind: "none", why: "GET /models catalog discovery only; model turns use the shared openai-chat runtime and its admission gate" },
  "composio.ts": { kind: "none", why: "tool-broker health and mounts: no model call; token calls go through flux-composio-dev-token.ts" },
  "decider/index.ts": { kind: "none", why: "wiring; the request is made by decider/flux.ts" },
  "drivers/agents-proxy.ts": { kind: "none", why: "a tool description" },
  "drivers/codex-catalog.ts": { kind: "none", why: "spawns the codex app-server for its catalog; no Flux request" },
  "email/email-secrets.ts": { kind: "none", why: "bot email key storage; makes no request" },
  "email/runtime.ts": { kind: "none", why: "bot email wiring; requests are made by email/flux-email-client.ts" },
  "engine-health-routes.ts": { kind: "none", why: "the Health line; the key check is flux-key-health.ts (GET /key/info), nothing billed" },
  "flux-config.ts": { kind: "none", why: "reads the key" },
  "flux-contract-endpoints.ts": { kind: "none", why: "the endpoint list; makes no request" },
  "flux-key-health.ts": { kind: "none", why: "GET /key/info key validity: no model call, nothing billed" },
  "flux-limits.ts": { kind: "none", why: "GET /v1/key/limits for the meter: an account read, not billed work" },
  "flux-memory-headers.ts": { kind: "none", why: "decides headers only; makes no request of its own" },
  "flux-usage-tags.ts": { kind: "none", why: "usage tag values and the Flux host rule; makes no request" },
  "index.ts": { kind: "none", why: "wiring: installs the gate and hands the key to the modules above; its search call is web-search.ts (admits)" },
  "memory/extractor-connections.ts": { kind: "none", why: "hands the Flux base to memory/extract.ts, which admits" },
  "model-gateway.ts": { kind: "none", why: "a comment; the local gateway never falls back to Flux" },
  "provider-connections.ts": { kind: "none", why: "catalog GET /v1/models: no model call, nothing billed" },
  "spend-gate.ts": { kind: "none", why: "the gate itself: GET /v1/key/limits account reads, not billed work" },
  "tts/elevenlabs.ts": { kind: "none", why: "ElevenLabs; mentions Flux in a comment" },
  "voice/stream-route.ts": { kind: "none", why: "the page-facing route; the Flux socket is voice/flux-stream.ts (admits)" },
  "voice/transcribe-route.ts": { kind: "none", why: "the page-facing route; the request is voice/flux-voice.ts (admits)" },
  "drivers/claude.ts": { kind: "child", why: "engine child process: its Flux spend happens inside the admitted turn and cannot be intercepted in-process" },
  "drivers/codex.ts": { kind: "child", why: "engine child process: its Flux spend happens inside the admitted turn and cannot be intercepted in-process" },
  "drivers/http-text-only.ts": { kind: "entitled", why: "engine turn: runs inside an admitted turn" },
  "drivers/openai-chat.ts": { kind: "entitled", why: "engine turn: runs inside an admitted turn" },
  "flux-routing.ts": { kind: "none", why: "routes an admitted turn at Flux and reads the catalog (GET /v1/models): no billed call of its own" },
  "opencode-config.ts": { kind: "child", why: "engine child process: its Flux spend happens inside the admitted turn and cannot be intercepted in-process" },
  "avatar-image.ts": { kind: "admits", why: "avatar image generation" },
  "browser-action-checker-connection.ts": { kind: "admits", why: "browser action checker model call" },
  "decider/flux.ts": { kind: "admits", why: "decider calls" },
  "email/flux-email-client.ts": { kind: "admits", why: "bot email send and read: billed to the bot key, a start" },
  "flux-composio-dev-token.ts": { kind: "admits", why: "composio broker token calls" },
  "image-generation.ts": { kind: "admits", why: "image calls: entitled by the turn token inside an admitted turn, a start otherwise" },
  "memory/extract.ts": { kind: "admits", why: "memory extraction, never inside a turn" },
  "voice/dictation-cleanup.ts": { kind: "admits", why: "dictation cleanup" },
  "voice/flux-stream.ts": { kind: "admits", why: "voice stream socket" },
  "voice/flux-voice.ts": { kind: "admits", why: "voice transcription" },
  "voice/voice-host.ts": { kind: "admits", why: "voice host chat and lookup" },
  "web-search.ts": { kind: "admits", why: "Flux web search: entitled inside a Flux turn, a start from a non-Flux turn" },
};
