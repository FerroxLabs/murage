# Flux Router integration — plan

**Status:** proposed, pending cross-audit
**Author:** Claude Opus 5, 2026-09-01
**Reference implementation:** `~/dev/wayland/app/src/process/task/fluxRouting.ts` (233 lines, Ferrox Labs, Apache-2.0)

## Why

Murage today makes users bring a subscription per engine. Flux Router is our own
OpenAI-compatible inference router: one key, any supported model, automatic tier
selection. Integrating it means a user can either keep their own CLI logins or
point every Ember at Flux and stop paying per vendor.

It is also first-party, so a Flux key removes three other credentials: the OpenAI
image key for avatar generation, the transcription key, and any web-fetch key.

## The contract (verified, not assumed)

From `~/dev/wayland/app/src/common/config/flux.ts`:

```
provider id   flux-router
models        flux-auto · flux-reasoning · flux-standard · flux-fast   (picker order)
surfaces      openai      https://api.fluxrouter.ai/v1
              responses   https://api.fluxrouter.ai/v1     (wire_api=responses)
              anthropic   https://api.fluxrouter.ai/anthropic
```

Additional endpoints on the same host, from the Flux Router README:

| Endpoint | Use in Murage |
|---|---|
| `POST /v1/chat/completions` | Ember inference |
| `POST /v1/images/generations` (`flux-image`) | avatar generation, replaces `gpt-image-2` |
| `POST /v1/audio/transcriptions` (`flux-voice-*`) | composer speech input |
| `POST /v1/fetch` | web fetch |
| `GET /v1/models` | catalog |

## The hard part: three surfaces, not one

Agent CLIs do not agree on how to be redirected. Wayland proved this empirically
(capture server, 2026-06-05) and the split is not negotiable:

| Surface | Backends | Mechanism |
|---|---|---|
| **Anthropic** | `claude` | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, POSTs `/v1/messages` |
| **OpenAI** | `qwen`, `goose` | `OPENAI_BASE_URL` + `OPENAI_MODEL=flux-auto`; goose also needs `GOOSE_PROVIDER=openai` |
| **Responses** | `codex` | needs a `[model_providers.flux]` table plus `model_provider="flux"`, selected per-spawn via a scoped `CODEX_HOME`; reads its bearer from `FLUX_API_KEY` |

**Not routable, by design.** Carry this honesty across rather than rediscovering it:

- `opencode`, `qoder` — openai-capable but cannot be pointed at Flux by env alone. Need a config-writing setup assistant (backup, write, report, rollback).
- `droid`, `auggie`, `copilot`, `kiro`, `vibe` — vendor-locked to their own service. They stay native and the UI must say so.

**Mutual exclusivity is a safety property, not a nicety.** Native provider keys
(`OPENROUTER_API_KEY`, `GROQ_API_KEY`, …) are stripped from the spawn env before
the Flux surface is applied. A half-routed spawn that still holds a native key
can bill the user twice and leak which provider they actually use.

## Work breakdown

Ordered by dependency. Items 1–3 are independent and parallelisable; 4 depends on 1; 5 depends on 1 and 4.

### 1. Config + credential  (small)
- `flux: { apiKey, enabled }` in `server/config.ts` schema and the typed shape.
- Add `FLUX_API_KEY` to `WORKSPACE_CREDENTIAL_ENV` so spawned agents cannot read it.
- Settings panel field, same shape as the existing Composio key entry.
- **Done when:** a key can be set and read, and no spawned agent sees it in its env.

### 2. Avatar generation via Flux  (small)
- `server/avatar-image.ts` currently hardcodes `https://api.openai.com/v1/images/generations` and `model: "gpt-image-2"`.
- Make base URL and model configurable. When a Flux key is present, use `https://api.fluxrouter.ai/v1` + `flux-image`; otherwise fall back to the existing OpenAI path unchanged.
- Update the 409 copy: "Add an OpenAI image API key first" is wrong once Flux can serve it.
- **Done when:** avatar generation succeeds with only a Flux key configured, and still succeeds with only an OpenAI key.

### 3. Model catalog  (small)
- Add the four Flux tiers to the picker with `FLUX_MODEL_DISPLAY` labels, `flux-auto` first.
- Only surface them when a Flux key exists.
- **Done when:** the picker shows Flux Auto / Reasoning / Standard / Fast and selecting one persists per Ember.

### 4. Routing core  (large — the real work)
- Port `fluxRouting.ts` into `server/flux-routing.ts`, adapted from Wayland's process model to Murage's driver model.
- Three surface builders, the backend membership sets, and the native-key stripping.
- Wire into the spawn path so `resolveFluxRouting()` runs before each agent launch.
- Murage already has `local-inject.ts` and `openai-compat.ts`; the OpenAI surface should reuse them rather than duplicating.
- **Done when:** an Ember set to Flux spawns with the correct surface env for its engine, native keys absent, and a real turn completes against `flux-auto` on claude, qwen and codex.

### 5. Per-Ember routing toggle  (medium)
- Per-bot field: `routing: "native" | "flux"`.
- UI in the agent profile panel next to the model picker.
- Badge on the roster row showing which routing an Ember uses.
- For non-routable engines, disable the toggle and state why.
- **Done when:** two Embers on the same engine can run with different routing simultaneously.

## Risks

1. **Codex is the hardest path** and needs filesystem work (scoped `CODEX_HOME`, config table). If it slips, ship 1–3 + claude/qwen and mark codex as follow-up rather than blocking the release.
2. **The Wayland reference is Electron-process-shaped.** Murage's driver model differs; a literal port will not compile. Budget for adaptation, not transcription.
3. **Base URL is described as provisional** in Core's `flux_router.rs` ("placeholder until the production endpoint is finalized"). Confirm `api.fluxrouter.ai` is final before it ships in an installer.
4. **Unverified claim:** that `flux-image` accepts the same request shape as OpenAI's `images/generations`. Test before rewriting `avatar-image.ts` around it.

## Explicitly out of scope

- Flux Voice and `/v1/fetch`. Real wins, but they are separate surfaces with their own call sites and should not ride along with routing.
- Billing, quota display, spend caps.
- Migrating existing Embers automatically. Opt-in only.

## Open questions for Sean

1. Is `https://api.fluxrouter.ai` the final production host?
2. Should Flux be the default for new Embers when a key exists, or stay opt-in?
3. Does a Flux key also cover the TTS path (`MURAGE_TTS_KEY`), or only transcription?
