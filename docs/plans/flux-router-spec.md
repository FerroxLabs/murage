# Flux Router Integration — Implementation Spec

**Status:** implementation-ready, with two hard blockers called out in §1.
**Date:** 2026-09-01
**Scope:** `/Volumes/Mando/WaylandBots/murage-app`
**Supersedes the plan-level parts of:** `docs/plans/flux-router-integration.md`, `docs/plans/flux-router-audit-kimi.md`

Everything below is grounded in either a **live probe** against `https://api.fluxrouter.ai`
(observed HTTP, headers and bodies) or a **file:line read** of this repo. Where neither
exists the item is filed under §9 UNVERIFIED and must not be built against.

Flux is **not implemented anywhere in this codebase today** — `grep -ri flux` over source
returns hits only in the two docs above, `HANDOFF.md`, and two SVGs. There is no
`server/flux-routing.ts`, no `flux-*` catalog row, no `FLUX_API_KEY` in `server/config.ts`.
This is a greenfield build, not a repair.

---

## 1. Surface status — read this first

### 1.1 CONFIRMED WORKING

| Surface | Endpoint | Verdict |
|---|---|---|
| OpenAI chat-completions | `POST /v1/chat/completions` | **WORKS** — 200, standard `chat.completion` body |
| Anthropic Messages | `POST /anthropic/v1/messages` | **WORKS** — 200, genuine `msg_…` object, SSE streaming confirmed |
| OpenAI Responses | `POST /v1/responses` | **WORKS** — 200, standard `resp_…` object, SSE + function calling confirmed |
| Model discovery | `GET /v1/models` | **WORKS** — 200, lists `flux-auto`, `flux-fast`, `flux-standard`, `flux-reasoning`, `flux-voice`, `flux-image`, `flux-pinned-*` |

### 1.2 FAILED — DO NOT BUILD AGAINST

> ### 🔴 `POST /v1/images/generations` IS BROKEN. 8/8 attempts failed.
>
> Every request carrying a real prompt returned a **Cloudflare 502 with a
> 16-byte `text/plain` body — `error code: 502`** — in 0.54–1.68 s, across
> ~10 minutes, including with `-m 300`. Variants tried: with/without `size`,
> with/without `model`, `b64_json`, bad size, distinct prompts. All 502.
>
> The route *exists* and validates (`{}` → 400 `prompt required`; no auth →
> 401 `unauthorized`; `GET` → 405), and `/v1/chat/completions` on the **same
> key** returns 200. So this is an **origin/backend outage on the image
> route**, not our request shape and not a bad key.
>
> **Consequence: the SUCCESS response shape of the image route was never
> observed.** `b64_json` vs `url`, the returned MIME type, and whether
> `quality`/`output_format` are honoured are all unknown. See §7.

> ### 🔴 THE PROBE ACCOUNT IS 402'd. All inference is currently dead.
>
> Partway through probing — after ~13 billed calls totalling ≈ $0.003 —
> **every** `POST` to `/v1/responses` **and** `/v1/chat/completions` began
> returning `402`:
> `"A prior charge on this account could not be reconciled automatically and
> requires support intervention. Please contact support to restore access.
> Top up at https://fluxrouter.ai/home/billing"`
> Still 402 after a 45 s wait.
>
> **`GET /v1/models` still returns 200 while 402'd.** A models-list health
> check will show green while every turn fails. Do not use `/v1/models` as
> the liveness probe (§6.4).

### 1.3 Non-blocking behaviours that change the design

- **`flux-auto` is an alias, not a model.** Observed resolutions across calls:
  `qwen-plus`, `MiniMax-M3`, `deepseek-v4-pro`, `claude-haiku-4-5-20251001`.
  Selection is per-request (bandit selector; `x-flux-phase-latency.bandit_ms`).
- **`x-flux-model-window` varied 129024 ↔ 1000000** between calls on the same
  alias. Anything sized against the pinned window overflows when `flux-auto`
  downgrades.
- **The proxy mutates the prompt.** `x-flux-engines-applied:
  r10_11_rtk_compactor,r10_2_semantic_cache,r10_4a_directives` on every call.
  Identical one-word prompts reported 164 `input_tokens` (128 cache_read) on
  one call and 9 on another. **`usage.*_tokens` is unusable for our cost or
  context accounting.** Use the `x-flux-cost-usd` header.
- **A tool named `shell` is silently renamed to `local_shell`** in the
  returned `function_call`. Reproduced 3/3 on `flux-auto` and on two pinned
  models, so it is gateway-level. `get_weather_v2` passed through unchanged.
  This is a codex-CLI hazard (§4.2).
- **`previous_response_id` is rejected by design** — `"flux-router is
  stateless; resend full input without previous_response_id"`.
- **Error codes lie.** On `/v1/responses` an unknown model id (`gpt-4o`,
  `flux-nope`) returns **401 `authentication_error`**, indistinguishable from
  a bad key. On `/anthropic/v1/messages` an unknown model returns **403
  `permission_error`** with the same wording as a genuinely gated model. There
  is no 404 for a bad model id on either surface.
- **Response headers leak tenant internals** — `x-litellm-key-spend`,
  `x-litellm-key-max-budget`, the upstream provider base URL, and on the
  Anthropic route `llm_provider-anthropic-organization-id` /
  `-workspace-id`. **Never log a full header dump.** Whitelist headers (§6.3).

---

## 2. Config and secret storage

### 2.1 Add the credential to config

`server/config.ts` — follow the exact `imageGen`/`tts` pattern.

1. Add `flux?: { key?: string }` to `AppConfig` and to `parseStoredConfig`.
2. `loadConfig()` env-override, insert beside the others (after the
   `imageGen` block at **config.ts:487**):
   ```ts
   cfg.flux = { ...cfg.flux };
   if (process.env.FLUX_API_KEY !== undefined) cfg.flux.key = process.env.FLUX_API_KEY;
   ```
3. `syncCredentialEnv()` secrets array — **config.ts:507** (the array that
   currently ends `[patch.imageGen?.key, "MURAGE_OPENAI_IMAGE_KEY"]`):
   ```ts
   [patch.flux?.key, "FLUX_API_KEY"],
   ```
4. `WORKSPACE_CREDENTIAL_ENV` — **config.ts:535** (insert after
   `"OPENAI_COMPAT_URL"`): add `"FLUX_API_KEY"`.

`FLUX_API_KEY` being in `WORKSPACE_CREDENTIAL_ENV` is the whole point: **no
spawned CLI ever sees the raw workspace key**. It is deleted from every child
env by `stripWorkspaceCredentialEnv` (config.ts:552-554) and by the ACP loop
at core.ts:204-206. Injection is therefore always a **post-strip** mutation
under a different, harness-owned name (§4).

### 2.2 Two pre-existing config gaps to close in the same change

- **`WORKSPACE_CREDENTIAL_ENV` is missing `OPENAI_COMPAT_MODEL` and
  `OPENAI_COMPAT_PROVIDER`.** `syncCredentialEnv` writes all three of
  url/model/provider into `process.env` (config.ts:516-518) and `loadConfig`
  reads all three back (config.ts:475-477), but only `OPENAI_COMPAT_URL` is in
  the strip list (config.ts:535). Every spawned CLI currently inherits the
  user's saved openai-compat model and provider. **Add both at config.ts:535.**
- `ANTHROPIC_API_KEY` (config.ts:561) and `OPENAI_API_KEY` (config.ts:568) are
  already in `PROVIDER_CREDENTIAL_ENV` — no change needed there.

---

## 3. Routing env to STRIP (prerequisite — do this before any Flux injection)

Neither strip list contains any *routing* variable. All four spawn paths spread
`...process.env` (core.ts:194, codex.ts:102, claude.ts:81, pi.ts:381), so an
ambient `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` from a leftover shell
currently redirects every turn — and defeats the `delete env.ANTHROPIC_API_KEY`
protection at claude.ts:88, since Claude Code accepts `ANTHROPIC_AUTH_TOKEN` as
the same Bearer identity.

Turning the strip on is **required before Flux injection**, and it is also what
forces Flux injection to be post-strip on the same three hooks.

### 3.1 The list — exactly four names

Add to `server/config.ts`, immediately after `PROVIDER_CREDENTIAL_ENV` closes
at **config.ts:573**, mirroring `stripWorkspaceCredentialEnv` (config.ts:551-554):

```ts
/** Routing switches a third-party CLI reads to choose its endpoint/model.
 *  Never allowlistable: a leftover shell overlay would steal every turn. */
export const ROUTING_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "OPENAI_BASE_URL",
] as const;

export function stripRoutingEnv(env: Record<string, string | undefined>): void {
  for (const key of ROUTING_ENV) delete env[key];
}
```

**Why exactly these four:** they are precisely the four this app itself writes
as routing switches — `applyClaudeInject` sets `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`
(local-inject.ts:417-420) and `applyOpenAIInject` sets `OPENAI_BASE_URL`
(local-inject.ts:402).

**`OPENAI_MODEL` has zero references in this repo** (grep across `server/`,
`scripts/`, `drivers/`). Include it only as a deliberate defensive entry, and
label it as such — it is not evidence-backed here.

### 3.2 Names that must NOT be stripped

| Name | Why |
|---|---|
| `UNSLOTH_STUDIO_AUTH_TOKEN` | Required routing **input**, read by `hostApiKey` at **local-inject.ts:112** for the `unsloth`/`unsloth_api` hosts (local-inject.ts:25-26). Stripping it makes `hostApiKey` fall back to the literal `"local"` (local-inject.ts:117) and every Unsloth turn fails auth. |
| `CLAUDE_CONFIG_DIR` | Read at **claude.ts:171** to locate the same `settings.json` the child reads. Stripping desyncs catalog from child. |
| `MINIMAX_BASE_URL` | Read in-process at minimax.ts:67; never placed in a child env. |
| `MURAGE_LOCAL_*_API_KEY` | Written onto a local env copy at **local-inject.ts:135-138**, always overwritten before use. |
| `KIMI_MODEL_*` | Already handled by `stripKimiModelEnv` (**kimi.ts:452**, called from transformEnv at kimi.ts:538). Adding them to `ROUTING_ENV` would double-strip. |

Do **not** import Wayland's list wholesale (`ANTHROPIC_SMALL_FAST_MODEL`,
`ANTHROPIC_DEFAULT_*`, `CLAUDE_CODE_USE_BEDROCK`, `VERTEX_*`) — none has a
writer or reader in this codebase.

### 3.3 Where each strip goes — exact file:line

| Path | Insert at | Rule |
|---|---|---|
| **claude** | `server/drivers/claude.ts:86` | Immediately **after** `stripWorkspaceCredentialEnv(env)` and **before** `applyClaudeInject(env, model)` at :87. Covers all three spawn sites: turn (:768), snapshot/auth probe (:1211), review (:1236). |
| **claude catalog** | `server/drivers/claude.ts:532` | `catalogEnv` is built as raw `{ ...process.env, ...input.environment }` with no strip, and `readClaudeModelCatalog` reads `env.ANTHROPIC_MODEL` at **claude.ts:168** into a phantom Custom row. Either route `catalogEnv` through `stripRoutingEnv`, **or** drop the `env.ANTHROPIC_MODEL` fallback at :168. Fixing only :86 leaves the picker corrupted. |
| **codex** | `server/drivers/codex.ts:112` | Inside `childEnv()`, after `stripWorkspaceCredentialEnv(env)`. Covers `catalogEnv` (:115) and every relaunch env (:157) before `codexLocalProviderArgs` mutates it at :158. |
| **acp** | `server/drivers/acp/core.ts:206` | A **separate unconditional loop**, after the allowlist loop (:204-206) and **before** `support.transformEnv?.(env, config)` at :207. Must NOT be appended to the :204 array — that array is filtered by `support.credentialEnv`, a *credential* allowlist (droid.ts:241, opencode-go.ts:366); a routing switch must never be grantable that way. Before :207 so kimi's `transformEnv` (kimi.ts:533) and `applyTurnEnv` (kimi.ts:539) can re-set their own values. |
| **pi** | `server/drivers/pi.ts:388` | After the `PROVIDER_CREDENTIAL_ENV` loop, before `return env` at :389. pi is an OpenAI-compatible BYOK CLI (see its own comment at pi.ts:382-386) and is a fourth `...process.env` spreader reaching a live CLI — turn spawn pi.ts:502, snapshot pi.ts:784. |

---

## 4. Per-engine injection — hook point and exact variables

**Universal rule:** the injector must read the key from `process.env.FLUX_API_KEY`
or `loadConfig()`, **never from the `env` object it is mutating** — by the time
it runs, `stripWorkspaceCredentialEnv` has already deleted it from that object
(config.ts:552-554 mutates only the copy; `process.env` is untouched, and
`syncCredentialEnv` at config.ts:498 keeps `process.env` authoritative).

New module: **`server/flux-routing.ts`**. It owns the surface table (§5.1),
the base URLs, and one applier per surface.

```ts
export const FLUX_OPENAI_BASE     = "https://api.fluxrouter.ai/v1";
export const FLUX_ANTHROPIC_BASE  = "https://api.fluxrouter.ai";       // Claude Code appends /v1/messages
export const FLUX_RESPONSES_BASE  = "https://api.fluxrouter.ai/v1";
export const FLUX_MODEL_PREFIX    = "flux-";
export function fluxKey(): string | undefined { return process.env.FLUX_API_KEY || loadConfig().flux?.key; }
export function isFluxModel(id: string | null | undefined): boolean { return !!id?.startsWith(FLUX_MODEL_PREFIX); }
```

### 4.1 claude — Anthropic Messages surface (CONFIRMED WORKING)

**Hook point: `claudeEnvironment()`, between claude.ts:86 and claude.ts:89** —
the same slot `applyClaudeInject` occupies at :87. This is the single env
builder for the driver; turn (:768), snapshot (:1211) and review (:1236) all
go through it.

Order inside the function becomes:
`{...source}` [:81] → delete CLAUDECODE/ENTRYPOINT [:82-83] → `stripWorkspaceCredentialEnv` [:86] → **`stripRoutingEnv`** [new, :86] → **`applyFluxClaude(env, model)`** [new] → `applyClaudeInject(env, model)` [:87, skipped if Flux applied] → `if (!applied.injected) delete env.ANTHROPIC_API_KEY` [:88].

Variables to set:

```
ANTHROPIC_BASE_URL   = https://api.fluxrouter.ai
ANTHROPIC_AUTH_TOKEN = <FLUX_API_KEY>
ANTHROPIC_API_KEY    = <FLUX_API_KEY>
ANTHROPIC_MODEL      = flux-auto | flux-reasoning | flux-standard | flux-fast
```

Notes bound to probe evidence:
- Auth is permissive: **both** `x-api-key: sk-flux-…` and
  `Authorization: Bearer sk-flux-…` returned 200, alone or together. Setting
  both `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` is safe and is also what
  keeps the guard at claude.ts:88 from half-routing the env.
- The **`Bearer ` prefix is load-bearing** — `Authorization: sk-flux-…` with no
  prefix is a 401 identical to sending nothing. Claude Code adds it; do not
  hand-roll a header anywhere that drops it.
- **`anthropic-version` is not required and is not validated.** Omitted → 200,
  `2023-06-01` → 200, `banana-9999` → 200. Never suspect it when debugging.
- **`applyFluxClaude` and `applyClaudeInject` must be mutually exclusive** —
  both write the same four vars. Flux ids are not host-encoded, so
  `decodeInjectId` returns null for them and `applyClaudeInject` no-ops
  naturally, but make the exclusion explicit rather than relying on that.

**Two extra claude edits, both mandatory:**

1. **claude.ts:669** calls `applyClaudeInject({ ...turnEnvironment }, turnModel)`
   on a **throwaway copy**, used only for `injected.model` on argv (:670) and
   the process-reuse cache key (:774-781). The env that actually spawns is
   built separately at :768. **Patch both sites** or argv/`argsKey` desync from
   the credentials, and the reuse cache at :787 can hand a Flux turn to a live
   native-routed process.
2. **claude.ts:123** — `resolveClaudeTurnModel` treats any id that is neither
   in `STATIC_CLAUDE_MODELS` nor `decodeInjectId`-able as a stale local slug and
   fires `probeLocalInjects(env)` across five loopback hosts. All four `flux-*`
   ids fall into that bucket. Add `isFluxModel(model)` to the early-return
   guard at :123, or every Flux turn pays a multi-host probe **and** can be
   silently rewritten into a `host::model` inject id by `resolveInjectId`
   (local-inject.ts:103-105).

### 4.2 codex — Responses surface (CONFIRMED WORKING, with a tool-name hazard)

**Hook point: `server/drivers/codex.ts:158`** — the line immediately after
`const env = childEnv()` at :157, composed into the same `appServerArgs` array
literal as `codexLocalProviderArgs`. Order: `childEnv()` [:157, strips] →
`codexFluxProviderArgs(env, turn.model)` [:158, injects] → `mountMcpServer` calls
[:159-190] → spawn. Anything injected before :157 is deleted; the `-c` argv must
exist before the spawn, so :158 is the only clean slot.

Model the new function on `codexLocalProviderArgs` (local-inject.ts:126-145) —
the secret rides the child env under a **harness-owned name absent from both
strip lists**, and only the *name* reaches argv:

```ts
env.MURAGE_FLUX_API_KEY = fluxKey()!;
return [
  "-c", `model_providers.flux.name="Flux Router"`,
  "-c", `model_providers.flux.base_url="https://api.fluxrouter.ai/v1"`,
  "-c", `model_providers.flux.wire_api="responses"`,
  "-c", `model_providers.flux.env_key="MURAGE_FLUX_API_KEY"`,
  "-c", `model_provider="flux"`,
];
```

No `CODEX_HOME` and no `config.toml` write is needed.

Probe-bound constraints:
- Codex declares its exec tool as **`shell`**, and the gateway **renames it to
  `local_shell`** in the returned `function_call` (reproduced 3/3, on
  `flux-auto` and two pinned models). Expect unknown-tool errors or dropped
  tool calls. **This must be exercised in a real codex turn before shipping the
  codex surface** — it may be a hard blocker for codex specifically.
- `previous_response_id` is rejected; full history must be resent each turn.
- `store: true` is accepted but echoed back `false`, and
  `GET /v1/responses/{id}` returns 400 even for an id just created with it.
  `DELETE` and `/cancel` return 500 with raw LiteLLM tracebacks. Do not build
  on any lifecycle endpoint.
- Reasoning items come back with `encrypted_content: null` even when
  `include: ["reasoning.encrypted_content"]` is requested — nothing to carry
  forward across turns.
- **Streaming disagrees with non-streaming:** SSE `response.completed` reports
  `model: "flux-auto"` while the non-streaming body reports the resolved
  backend. Never assert on `response.model`.
- **Codex catalog ids must be provider-qualified.** `decodeCodexSelection`
  (**codex-catalog.ts:51**) maps any bare id matching `MODEL_ID` to
  `OFFICIAL_CODEX_PROVIDER = "openai"`. `flux-auto` matches that regex, so a
  bare row decodes to `{model:"flux-auto", modelProvider:"openai"}` and gets
  posted to `api.openai.com` → 400. Every Flux row offered to codex **must** go
  through `encodeCodexSelection("flux", "flux-auto")` → `flux::flux-auto`.
  This makes the fall-through structurally impossible even if every other gate
  fails.
- `catalogEnv` (**codex.ts:115**) is built once at `create()` and frozen. A key
  saved later via `syncCredentialEnv` never reaches it. Any Flux `/v1/models`
  read must take the key from config/`process.env`, not from `catalogEnv`.

### 4.3 qwen — OpenAI chat-completions surface (CONFIRMED WORKING)

**Hook point: a new `applyTurnEnv` on qwen's `AcpSupport` object
(`server/drivers/acp/qwen.ts:88-94`), which the core invokes at
`server/drivers/acp/core.ts:317`.**

Why that hook and not another:
- core.ts:317 runs **after** the strip loop (:204-206), **after**
  `transformEnv` (:207), and **after** the turn model is known (:316) — so it
  can decide native-vs-Flux per turn and re-write vars the strip removed.
- `transformEnv` (core.ts:207) is the **wrong** hook: it is shared by catalog
  refresh (core.ts:214) and snapshot (core.ts:738), which per the core's own
  doc comment (core.ts:104-105) must not see a per-turn overlay. Putting Flux
  there would point `--version` probes and catalog reads at Flux for instances
  running native.
- Kimi (kimi.ts:540) and Droid (droid.ts:254) are the existing precedent for
  exactly this shape.

Variables to set:

```
OPENAI_BASE_URL = https://api.fluxrouter.ai/v1
OPENAI_API_KEY  = <FLUX_API_KEY>
OPENAI_MODEL    = flux-auto            # defensive; see §3.1 — unread in this repo
```

Hard rules:
- **Do NOT add `"FLUX_API_KEY"` to qwen's `credentialEnv` allowlist.** That
  would let the raw workspace key ride in the child env on every qwen spawn,
  including catalog and snapshot, contradicting "no spawned agent sees it".
- **Do NOT route Flux through `ensureQwenInjectModel`.** That function writes
  the provider key **in plaintext to `~/.qwen/settings.json`**
  (`envMap[keyName] = key`, **qwen.ts:49**; `writeFileSync`, **qwen.ts:74**)
  with no rollback. For a Flux id `decodeInjectId` returns null
  (local-inject.ts:73-81) so it early-returns at qwen.ts:28 and writes nothing —
  keep it that way. The Flux surface stays **env-only**.
- **argv/env agreement:** qwen's `spawnArgs` pushes `-m <turn.model>`
  (**qwen.ts:106**), evaluated at core.ts:324 from `resolvedModel` computed at
  :316 — one step *before* `applyTurnEnv` at :317. `applyTurnEnv` cannot change
  argv. If qwen resolves `-m` against `~/.qwen` modelProviders rather than
  `OPENAI_BASE_URL`, the model id must be settled in `resolveTurnModel`
  (core.ts:316) instead. **Verify with a real qwen turn** (§9).

### 4.4 Engines with no Flux surface

`opencode`, `qoder` (config-file only), `droid`, `auggie`, `copilot`, `kiro`,
`vibe` (vendor-locked). No injection, no picker rows (§5).

---

## 5. Per-engine picker gate

### 5.1 One table, two consumers

Export from `server/flux-routing.ts` — the same module that injects — so the
picker and the router can never disagree about which engines are routable:

```ts
export const FLUX_SURFACE: Partial<Record<DriverKind, "anthropic" | "openai" | "responses">> = {
  claudeAgent: "anthropic",
  qwenAgent:   "openai",
  gooseAgent:  "openai",
  codex:       "responses",
};
```

Absent key ⇒ not routable ⇒ no rows, and the spawn gate throws (§5.4).

### 5.2 The gate must NOT live in `mergeLocalInject`

`mergeLocalInject` (**local-inject.ts:356**) has signature
`(catalog, env, fetchImpl)` — **no engine identity at all** — and is called by
10 drivers (codex-catalog.ts:365 and :431, claude.ts:536, antigravity.ts:398,
pi.ts:180, kimi.ts:505, qwen.ts:84, hermes.ts:367, grok.ts:188, droid.ts:171,
opencode-go.ts:381). Appending Flux rows to its loop (local-inject.ts:373-388)
is the shortest path and is precisely the bug: it fans `flux-*` onto every
engine, routable or not. It is engine-blind by design because local hosts are
engine-agnostic; **Flux is not**.

### 5.3 Where the gate goes

New sibling helper with engine identity as a **required** parameter:

```ts
export function mergeFluxCatalog(
  catalog: ModelCatalog,
  driverKind: DriverKind,
  env: Record<string, string | undefined>,
): ModelCatalog   // returns catalog untouched when FLUX_SURFACE[driverKind] is absent
```

Called from each driver's own `resolveModels`/`refreshModels`, where
`driverKind` is a compile-time constant. A required parameter makes the gate
unskippable at the type level. For codex the call site is **between
codex-catalog.ts:420 and :431** — after the extras loop closes, before the
`mergeLocalInject` return — and it must emit `flux::flux-auto` style ids
(§4.2), never bare slugs.

### 5.4 Backstop and spawn-side enforcement

- **Registry backstop — `server/harness/registry.ts:168`.** `describe()` passes
  `models: inst.models` straight through with no filtering; it is the one choke
  point every catalog crosses to the UI (and it calls `refreshModels()` at :158
  immediately before). Re-filter `flux-`-prefixed rows here against the same
  `FLUX_SURFACE` table, so a driver that forgets the gate still cannot leak.
- **Spawn-side 409 — `server/index.ts`, immediately after the effort re-check
  at :2496.** A client filter cannot be the gate: `checkedModelSelection`
  (**index.ts:729**) only validates ids against the catalog when
  `requireAvailableModel` is true, deliberately (comment at :725-728), so a
  persisted, cloned (store.tsx:1623), imported, or MCP-set `flux-auto`
  selection passes untouched. Throw the same-shaped 409 as the effort check:
  > `this bot's engine cannot route Flux Router — choose another model in settings`
- **Capability flag — `server/contracts.ts:215` block.** Add
  `fluxRouting?: boolean` beside `computerMcp`/`effortLevels`/`queueing`, which
  all carry the doctrine "never offer a control the driver cannot honour". It
  projects through **registry.ts:169-180** into `InstanceInfo.capabilities`
  (store.tsx:383-396) and is what disables the UI toggle with a reason.

### 5.5 Client side

The client does **not** filter. `ModelPicker.tsx:192-193` partitions solely on
`option.custom`; the rail splits solely on `access` (engine-rail.ts:6-8);
`ModelCatalog`'s option shape (**contracts.ts:316**) has no field that could
express engine affinity — `provider` is display-only (ModelPicker.tsx:54-61).
The client's only legitimate Flux job is rendering the disabled-toggle reason
from `capabilities.fluxRouting`, never inspecting model ids.

### 5.6 Ordering makes the gate urgent, not optional

The plan requires "Flux tiers first (Auto leads)". Flux rows are non-custom, so
they land in `ModelPicker`'s `official` list (:192), and `suggestedModels` fills
the compact 5-row list from catalog order (**custom-models.ts:48**). Ungated,
`flux-auto` becomes the **top suggested row on every engine**, including the
ones that would 400. The gate must land in the same change as the rows.

---

## 6. Client behaviour required by the probes

### 6.1 Never trust the body's `model`
- `/v1/chat/completions`: `model` **echoes the requested alias verbatim** —
  `flux-auto` stayed `flux-auto`. Attribution by body `model` records the alias.
- `/anthropic/v1/messages`: `model` carries the **resolved backend**
  (`MiniMax-M3`, `qwen-plus`, `claude-sonnet-4-5-20250929`) and varies per call.
- `/v1/responses` non-streaming: resolved backend. **Streaming: the alias.**

Anything asserting `response.model === requested` will break. Read
`x-flux-original-model` (the alias) and `x-flux-routed-model` (the backend).

### 6.2 Pinned routes do not disclose the upstream version
For `flux-pinned-claude-opus-5`, `x-flux-routed: false` and
`x-flux-routed-model` just repeats the alias. There is **no `claude-opus-*`
version string anywhere** in the response. The Anthropic backend is only
inferable from `llm_provider-anthropic-*` headers and Anthropic-shaped usage
fields. You cannot verify which model version you were billed for.

### 6.3 Header handling — whitelist, never dump
Capture only: `x-flux-original-model`, `x-flux-routed-model`, `x-flux-model`,
`x-flux-routed`, `x-flux-cost-usd`, `x-flux-model-window`, `x-flux-request-id`,
`x-flux-engines-applied`, `x-flux-tier-escalated`, `x-flux-route`.

Never log: `x-litellm-key-spend`, `x-litellm-key-max-budget`,
`x-litellm-model-api-base`, `llm_provider-anthropic-organization-id`,
`llm_provider-anthropic-workspace-id`, `llm_provider-request-id`.

### 6.4 Health check
**`GET /v1/models` is not a liveness probe** — it returned 200 throughout the
402 outage. Health must be a cheap `POST` (e.g. `/v1/chat/completions`,
`flux-fast`, `max_tokens: 1`) and must classify:

| Status | Meaning | User-facing action |
|---|---|---|
| 401 | Key or **header shape** wrong (missing `Bearer ` prefix), **or** an unknown model id on `/v1/responses` | Check key *and* model id — these are indistinguishable |
| 402 | Account billing blocked | "Flux Router billing needs attention — top up at fluxrouter.ai/home/billing". Do **not** retry-loop |
| 403 (anthropic surface) | Authenticated fine; model rejected **or** model id typo'd — same wording either way | **Never regenerate the key** — the body says the key is valid |
| 502 `text/plain` | Upstream/route down | Surface as provider outage; body is **not JSON**, guard `JSON.parse` |

### 6.5 Cost
Three different numbers per call: header `x-flux-cost-usd`, body
`usage.cost_usd`, and `x-litellm-response-cost` (0.000062 / 6.2e-05 / 1.08e-05
on the same call). **Use `x-flux-cost-usd` — the Flux-billed figure.** The
other two are not interchangeable with it.

### 6.6 Context window
`x-flux-model-window` is the only advertisement, and it varied 129024 ↔ 1000000
between calls. Never size a rebuild against a pinned window when the user is on
`flux-auto`; read the header from the previous turn or assume the floor.

---

## 7. `server/avatar-image.ts` — can it be repointed by config alone?

### **NO. Not by config, and not at all today.**

Two independent reasons:

**1. The endpoint is dead.** `POST /v1/images/generations` returned Cloudflare
502 `text/plain` on 8/8 attempts (§1.2). The repoint cannot be validated until
the provider's image backend is fixed. **Gate any repoint behind one observed
successful generation.**

**2. Even once it works, the file needs code changes, not a URL swap:**

| Site | Current | Problem |
|---|---|---|
| `avatar-image.ts:13-15` | `generatedImageResponseSchema` hard-requires `data[].b64_json` | The success shape was **never observed**. If Flux returns `data[].url` (as Flux/BFL-backed routers commonly do, returning signed URLs) this needs a real second `fetch` to download the bytes — a structural change, not config. |
| `avatar-image.ts:105` | URL hardcoded `https://api.openai.com/v1/images/generations` | Not configurable at all today. |
| `avatar-image.ts:112-115` | sends `model: "gpt-image-2"`, `quality: "low"`, `output_format: "webp"` | Model id must change to `flux-image`. Whether `quality`/`output_format` are accepted, ignored, or rejected is **unverified** — no request with a prompt ever reached a responding backend. |
| `avatar-image.ts:168` | `return { bytes, mime: "image/webp" }` — hardcoded, and `GeneratedAvatarImage.mime` is typed `"image/webp"` | Flux backends typically emit PNG or JPEG. If `output_format` is not honoured, stored avatars get the wrong MIME. This is a real adaptation point **regardless** of the b64/url question. |
| `avatar-image.ts:139-147` | error path | `JSON.parse("error code: 502")` throws, the `catch` swallows it, and the user sees **"OpenAI image generation failed (HTTP 502)"** — naming OpenAI for a Flux failure. |
| `avatar-image.ts:99, 122, 154, 158, 162, 166` | user-facing strings all say "OpenAI" | Must be reworded with any repoint. |
| `avatar-image.ts:147` | maps 401 straight through as an auth error | An unrecognised model on this route returns **401 `unauthorized`**, not 404/400 — so a **model-name typo surfaces to the user as a credential problem**. |

Compatible as-is: the error envelope. Flux returns `{"error":{"message":…}}`
for `prompt required` / `unauthorized`, which the parser at
**avatar-image.ts:142** handles. Framework errors use `{"detail":…}` (404/405)
which that schema will not parse — those degrade to the status-only message,
which is acceptable.

**Recommendation:** leave `avatar-image.ts` on OpenAI. Revisit only after a
single successful `flux-image` generation is captured and its body shape
recorded here.

---

## 8. Build order

1. **Strip first** (§3) — `ROUTING_ENV` + the five call sites + the
   `OPENAI_COMPAT_MODEL`/`PROVIDER` fix. Independently valuable; no Flux
   dependency. Ships alone.
2. **Config** (§2) — `FLUX_API_KEY` through `loadConfig`/`syncCredentialEnv`/
   `WORKSPACE_CREDENTIAL_ENV`.
3. **`server/flux-routing.ts`** — `FLUX_SURFACE`, `fluxKey()`, `isFluxModel()`,
   the three appliers, `mergeFluxCatalog`.
4. **Gate + backstop + 409 + capability flag** (§5) — *before* any row ships.
5. **claude surface** (§4.1) — the best-verified of the three; also patch
   claude.ts:669 and claude.ts:123.
6. **qwen surface** (§4.3) — after the `-m` vs `OPENAI_BASE_URL` question is
   settled by a live turn.
7. **codex surface** (§4.2) — **last**, and only after the `shell` →
   `local_shell` rename is exercised end-to-end in a real codex turn. That
   rename may block codex entirely.
8. **avatar-image.ts** — do not attempt (§7).

---

## 9. UNVERIFIED — do not build against these

**Blocked by the 402 wall (probe account is currently billing-blocked):**
- `text.format` / `json_schema` structured outputs on `/v1/responses`. The one
  attempt before the 402 returned a bare `error code: 502` Cloudflare
  plain-text body — so error bodies are **not always JSON**.
- `max_output_tokens` truncation and `incomplete_details` behaviour.

**Never probed on the chat-completions surface:**
- Streaming (`stream: true`) — confirmed on the Anthropic and Responses
  surfaces, **not** on `/v1/chat/completions`.
- Tool calling on `/v1/chat/completions`.
- 4xx error body shapes on `/v1/chat/completions`.
- Whether `flux-auto` routing changes with prompt complexity.
  `x-flux-tier-escalated: false` and `x-flux-summarization-applied: false` on
  both calls imply escalation/summarization paths exist but were not exercised.

**Never probed at all:**
- The entire **image success path** (§7) — `b64_json` vs `url`, MIME, whether
  `quality`/`output_format`/`size` are honoured.
- `flux-voice` (present in `/v1/models`, untouched).
- Whether qwen resolves `-m <model>` against `OPENAI_BASE_URL` or against
  `~/.qwen` modelProviders (§4.3) — decides whether the Flux model id must be
  settled at core.ts:316 or core.ts:317.
- Whether Claude Code accepts `flux-auto` as `ANTHROPIC_MODEL` without
  client-side model validation.
- Whether the `shell` → `local_shell` rename actually breaks a codex turn, or
  whether codex tolerates it (§4.2).
- Semantic-cache hit rate and whether a cached answer is ever distinguishable.
  Nothing in the body flags a cache hit; only `cached_tokens` /
  `cache_read_input_tokens` hint at it.
- Rate limits and concurrency behaviour on any surface.
- Whether the 402 is specific to the probe key or account-wide.

**Not evidence-backed in this repo:**
- `OPENAI_MODEL` — zero references anywhere in `server/`, `scripts/`,
  `drivers/`. Any inclusion in `ROUTING_ENV` or in the qwen injection is
  defensive only.

---

# Probe round 2 — 2026-09-01, after the key was reported fixed

Live re-probe against `api.fluxrouter.ai` with the same key. The account
recovered, served ~15 calls, then **re-entered the 402 state**. Everything
below was captured inside that window. Corrections to round 1 are marked.

## R2.1 The 402 is RECURRING, not resolved

Observed twice now, same shape both times:

| Round | Calls served before re-block |
|---|---|
| Workflow probe | ~13 calls, ≈ $0.003 |
| Round 2 | ~15 calls |

After re-blocking: `chat=402 models=200` on three consecutive tries 10s apart.
The message is identical each time — *"A prior charge on this account could not
be reconciled automatically and requires support intervention."*

**This is a Flux Router billing-reconciliation defect, not a Murage concern.**
But it dictates one Murage design rule: **any Flux turn can 402 mid-session
without warning.** The 402 path must surface a real message and fall back to
native routing, never retry-loop.

`GET /v1/models` returned **200 throughout both block windows.** §6.4 stands:
never use the models list as a liveness probe.

## R2.2 Newly CONFIRMED WORKING (clears four §9 items)

| Capability | Verdict |
|---|---|
| `/v1/chat/completions` streaming (`stream:true`) | **WORKS** — SSE, standard `chat.completion.chunk` |
| `/v1/chat/completions` tool calling | **WORKS** — standard `tool_calls[]`, `finish_reason:"tool_calls"` |
| `max_output_tokens` truncation | **WORKS** — `status:"incomplete"`, `incomplete_details:{reason:"max_output_tokens"}` |
| `/v1/responses` function calling | **WORKS** |

**Streaming gotcha:** the first deltas carry `reasoning_content`, not
`content` — `{"delta":{"reasoning_content":"We","role":"assistant"}}`. A client
that reads only `delta.content` sees empty frames and may render nothing or
close the stream early. Handle or discard `reasoning_content` explicitly.

## R2.3 `shell` → `local_shell` — CONFIRMED, and it is a CONTRACT SUBSTITUTION

Reproduced 5/5 across two sessions. Trigger is the **exact** tool name `shell`.

```
sent=shell          returned=local_shell    args={"command": ["ls", "-la"]}
sent=local_shell    returned=local_shell
sent=run_shell      returned=run_shell        <- passes through
sent=shell_exec     returned=shell_exec       <- passes through
sent=bash           returned=bash             <- passes through
sent=myshell        returned=myshell          <- passes through
sent=get_weather_v2 returned=get_weather_v2   <- passes through
```

Not merely a rename. The declared schema was `command: {type: "string"}`; the
returned call carries `command: ["ls","-la"]` — an **array**. The gateway
substitutes OpenAI's native `local_shell` tool contract over the caller's
declared function. A client that declares `shell` gets back a call it did not
declare, carrying arguments of a type it did not ask for.

**Codex CLI declares `shell`.** Build step 7 stays last and stays gated on a
real end-to-end codex turn.

**CORRECTION to round 1:** the `run_shell` / `shell_exec` 502s recorded earlier
were **transient, not name-triggered** — both return 200 and pass through on
re-probe. The responses surface throws sporadic 502s independent of payload.

## R2.4 Structured outputs — silently ignored (INCONCLUSIVE, re-probe needed)

`text.format.json_schema` with `strict:true` on `flux-auto` returned **prose,
not JSON**, with `status:"completed"` and **no error**. The request routed to
`us.amazon.nova-pro-v1:0`.

Unresolved: whether Flux drops the param, or routes to a model that cannot
honour it and LiteLLM strips it silently. Re-probes on
`flux-pinned-claude-opus-5` and `flux-reasoning` both hit the 402 before
answering.

**Either way this is the dangerous failure mode** — a silent contract break
that only shows up at `JSON.parse`. **Do not rely on structured output from
Flux until this is settled.**

## R2.5 Error shapes — one round-1 finding REVERSED, two real bugs

**REVERSED — unknown model is now cleanly distinguishable.** Round 1 recorded
unknown model → 401, indistinguishable from a bad key. On `/v1/chat/completions`
it now returns **403** with a genuinely well-written message:

```json
{"error":{"message":"This key is not permitted to use flux-nope-9000.
 The key itself is valid — regenerating it will not change this.
 Contact support@fluxrouter.ai if it should have access.",
 "type":"auth_error","param":"model","code":"403"}}
```

Two real defects remain, both **5xx where a 4xx belongs**:

| Request | Returns | Should be |
|---|---|---|
| No `Authorization` header | **500** `"Flux Router error: No api key passed in."` | 401 |
| Missing `messages` | **500** `"Router.acompletion() missing 1 required positional argument: 'messages'"` | 400 |

The second leaks a Python framework traceback to the caller. The first is
worse operationally: **clients retry 5xx and do not retry 401**, so a
missing or malformed key produces a retry storm instead of a clean failure.
Murage must not treat a Flux 500 as retryable without inspecting the body.

## R2.6 CORRECTION to §6.1 — `model` echo differs BY SURFACE

Round 1 concluded "never trust the body's `model`". True only on one surface:

| Surface | `model` in body |
|---|---|
| `/v1/chat/completions` | echoes the **alias** (`flux-auto` → `"flux-auto"`) |
| `/v1/responses` | returns the **resolved upstream** (`flux-fast` → `"mistral-small-latest"`) |
| `/anthropic/v1/messages` | returns the **resolved upstream** (`flux-fast` → `"mistral-small-latest"`) |

This matters for claude (§4.1): Claude Code sees a `model` in the response that
is not the one it sent. Confirm it does not validate the echo before shipping
that surface.

Also re-confirmed: `flux-auto` resolutions now include `qwen-plus`,
`us.amazon.nova-pro-v1:0` and `mistral-small-latest` on top of round 1's list.

## R2.7 Images route — STILL DEAD, and now provably not a billing symptom

`POST /v1/images/generations` returned **502** while the account was serving
200s on all three inference surfaces. Every other route hit the billing gate
first and returned 402; this one returned 502 in both states.

Two conclusions: the image backend is genuinely down, **and the image route
appears to bypass the billing layer entirely** — worth checking on the Flux
side, since image generations may not be billed once it serves.

**§7 stands unchanged: leave `avatar-image.ts` on OpenAI.**
