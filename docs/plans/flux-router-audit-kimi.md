kimi version 0.34.0
• Let me read the plan and the referenced files.AcpAgentManager.ts
AcpSkillManager.ts
AgentFactory.ts
agentTypes.ts
agentUtils.ts
BaseAgentManager.ts
claudeConfig.ts
codexConfig.ts
ConciergeProposeDetector.ts
ConversationTurnCompletionService.ts
CronCommandDetector.ts
fluxRouting.ts
GeminiAgentManager.ts
hermesConfig.ts
IAgentEventEmitter.ts
IAgentFactory.ts
IAgentManager.ts
IpcAgentEventEmitter.ts
IWorkerTaskManager.ts
mcpConnectorGuidance.ts
MessageMiddleware.ts
NanoBotAgentManager.ts
OpenClawAgentManager.ts
RemoteAgentManager.ts
resumeSeed.ts
ThinkTagDetector.ts
WCoreManager.ts
WorkerTaskManager.ts
workerTaskManagerSingleton.ts
---
     233 /Users/seandonahoe/dev/wayland/app/src/process/task/fluxRouting.ts
/Volumes/Mando/WaylandBots/murage-app/server/:
atomic.test.ts
atomic.ts
attachments.test.ts
attachments.ts
auto-approve.test.ts
auto-approve.ts
auto-review.test.ts
auto-review.ts
avatar-image.test.ts
avatar-image.ts
bot-avatar.test.ts
bot-cwd.test.ts
bot-cwd.ts
bot-directory.test.ts
bot-directory.ts
bot-package.test.ts
bot-package.ts
bot-profile.test.ts
bot-profile.ts
box-errors.test.ts
box-lifecycle.test.ts
box-provision.test.ts
box-trial.test.ts
box.ts
branching.test.ts
browser-connection.test.ts
browser-connection.ts
browser-lifecycle-cleanup.test.ts
browser-lifecycle-cleanup.ts
calendar-calls.test.ts
calendar-calls.ts
checkpoints.test.ts
checkpoints.ts
chief-of-staff.test.ts
chief-of-staff.ts
cloud-backend.test.ts
cloud-backend.ts
comms-visibility.test.ts
comms-visibility.ts
comms.test.ts
composer-attachments.test.ts
composio-availability.test.ts
composio.test.ts
composio.ts
computer-control.test.ts
computer-control.ts
computer-observation.test.ts
computer-observation.ts
computer-proxy.test.ts
computer-proxy.ts
config.test.ts
config.ts
connector-proxy.test.ts
connector-proxy.ts
container-computer.test.ts
container-computer.ts
container-mcp.test.ts
container-mcp.ts
contracts.ts
control-client.ts
control-murage.test.ts
credential-request.test.ts
decision-log-wiring.test.ts
decision-log.test.ts
decision-log.ts
delegations.test.ts
delegations.ts
drafts.test.ts
drivers
env-path.test.ts
env-path.ts
graceful-shutdown.test.ts
graceful-shutdown.ts
group-goal-run.e2e.test.ts
group-goal-run.test.ts
group-goal-run.ts
group-tasks.test.ts
harness
index.test.ts
---
/Volumes/Mando/WaylandBots/murage-app/server/drivers/local-inject.ts
/Volumes/Mando/WaylandBots/murage-app/server/drivers/openai-compat.ts
/Volumes/Mando/WaylandBots/murage-app/server/drivers/openai-compat.test.ts
Now read the key Murage files: server/drivers/local-inject.ts, server/drivers/openai-compat.ts, plus spawn path, config.ts (WORKSPACE_CREDENTIAL_ENV), avatar-image.ts, and the driver model. Also check PROVIDER_ENV_VARS equivalent (KeyDiscovery) in Murage, and how models pickers work, and codex config handling in Murage.Key facts emerging:

  1. **openai-compat.ts is a transcript-replay driver** — it's not a spawn-env injector for CLIs; it's a full in-process chat driver (createOpenAIChatRuntime) for "OpenRouter/Groq/Together" style endpoints, i.e. Murage's own Node-side HTTP runtime, NOT an OpenAI surface for spawned agent CLIs. fluxRouting.ts's "OpenAI surface" is about env injection into spawned CLI backends (qwen, goose) — different layer. So the plan's claim "the OpenAI surface should reuse openai-compat.ts" is a wrong assumption: openai-compat is a Murage-internal runtime driver for Murage speaking to providers itself, not for redirecting CLI backends. Reusing it would only make sense if Flux were added as another Murage-native provider driver (like openai-compat with url=https://api.fluxrouter.ai/v1, apiKeyEnv=FLUX_API_KEY). That's actually a much simpler route — add Flux as an openai-compat instance rather than env injection! That's a major architectural finding: the plan ported the Wayland spawn-env model but Murage's driver model means Flux could be a first-class driver via openai-compat with ~zero porting. But wait — Murage forks OpenMausBot; need to check whether Murage spawns CLI agents (claude, codex CLIs) at all, or whether its drivers are all in-process runtimes. Let me check server/drivers/ listing.

  2. **local-inject.ts** — it does do env injection (applyOpenAIInject, applyClaudeInject, codexLocalProviderArgs), and notably codexLocalProviderArgs already solves the codex problem differently: it passes `-c model_providers.X...` argv overrides to the codex app-server instead of a scoped CODEX_HOME! So the plan's claim that codex needs a scoped CODEX_HOME port is contradicted by existing Murage machinery — local-inject already configures codex custom providers via `-c` flags. Big finding for items 2 and 5.

  Also note applyClaudeInject already sets ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY/MODEL — exactly the Flux anthropic surface. So the "three surface builders" mostly already exist in local-inject, parameterized by host. The reuse claim is partially right (local-inject) but wrong for openai-compat.

  But important: local-inject is keyed to LOCAL_HOSTS (loopback hosts only, apiKey hardcoded "ollama" etc). Reuse would need extending LocalHost to include Flux or a parallel mechanism. Also decodeInjectId's MODEL_ID regex etc.

  Need to check more of the Murage driver model: ls server/drivers, check how spawning works, whether claude/codex are spawned CLIs with env (do they exist in Murage?). Murage forked from OpenMausBot. Let me look at the drivers directory and how claude driver injects env. Also check config.ts for WORKSPACE_CREDENTIAL_ENV, and avatar-image.ts, and whether "qwen"/"goose" backends even exist in Murage — the plan's whole surface table assumes Wayland backend membership (qwen, goose, claude, codex, hermes...). Murage may have a completely different set of drivers! That's the crux of audit item 2: the backend membership sets from Wayland probably don't map onto Murage's driver roster at all.acp
agents-proxy.test.ts
agents-proxy.ts
antigravity.test.ts
antigravity.ts
boxagent.test.ts
boxagent.ts
browser-proxy.test.ts
browser-proxy.ts
builtIn.ts
claude-auth.test.ts
claude-catalog.test.ts
claude.test.ts
claude.ts
codex-catalog.test.ts
codex-catalog.ts
codex.test.ts
codex.ts
dweb-proxy.test.ts
dweb-proxy.ts
grok.test.ts
grok.ts
grokagent.ts
local-inject-matrix.test.ts
local-inject.test.ts
local-inject.ts
minimax.test.ts
minimax.ts
native.test.ts
native.ts
openai-chat.ts
openai-compat.test.ts
openai-compat.ts
phone-proxy.test.ts
phone-proxy.ts
pi-mcp-extension.test.ts
pi-mcp-extension.ts
pi.test.ts
pi.ts
retry.test.ts
retry.ts
Key: Murage's drivers are: acp, antigravity, boxagent, browser-proxy, claude, codex, dweb-proxy, grok, minimax, native, openai-compat, phone-proxy, pi. There is NO qwen/goose/hermes CLI spawn list like Wayland. The Wayland backend membership (qwen, goose, hermes, opencode, droid, auggie, copilot, kiro, vibe) does not exist in Murage. So porting "backend membership sets" is mostly meaningless; Murage's driver roster is different. Need to check which Murage drivers spawn CLIs with env: claude.ts (spawns claude CLI? uses applyClaudeInject), codex.ts (app-server), acp/ (agent client protocol — check what's in acp), native.ts, pi.ts, grok, minimax, antigravity.

  Also, WORKSPACE_CREDENTIAL_ENV is in config.ts and server/drivers/acp/core.ts. Let me check those, claude.ts spawn env, codex.ts, acp dir, native.ts, avatar-image.ts. Also check what "openai-chat.ts" is (runtime used by openai-compat). And the model catalog / picker: contracts.ts ModelCatalog.

  Let me read several files in parallel.acp.test.ts
core.ts
cursor.test.ts
cursor.ts
custom.test.ts
custom.ts
droid.ts
gemini-auth.test.ts
gemini.ts
grok-catalog.test.ts
grok.ts
hermes.test.ts
hermes.ts
kimi.ts
opencode-go.test.ts
opencode-go.ts
qwen.ts
---
/Volumes/Mando/WaylandBots/murage-app/server/config.ts:532:export const WORKSPACE_CREDENTIAL_ENV = [
/Volumes/Mando/WaylandBots/murage-app/server/config.ts:553:  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
/Volumes/Mando/WaylandBots/murage-app/server/drivers/acp/core.ts:18:import { PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
/Volumes/Mando/WaylandBots/murage-app/server/drivers/acp/core.ts:204:        for (const key of [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]) {
Big finding: Murage DOES have an ACP driver layer with qwen.ts, hermes.ts, opencode-go.ts, droid.ts, cursor.ts, gemini.ts, grok.ts, kimi.ts — so the Wayland backend names do partially exist here via ACP. So the membership sets aren't meaningless. But the plan's claim about reusing local-inject/openai-compat needs deeper checking. Where is the spawn env constructed in acp/core.ts? Check how qwen.ts and hermes.ts set env, whether claude/codex are ACP or their own drivers.

  Also avatar-image.ts: the plan says 409 copy is "Add an OpenAI image API key first" — confirmed line 99. And base URL hardcoded line 104. But where does the avatar key come from — who calls generateAvatarImage? Check whether it uses config openai key.

  Now read acp/core.ts (spawn env), acp/qwen.ts, acp/hermes.ts, and how claude.ts spawns (env), codex.ts spawn. Also config.ts around WORKSPACE_CREDENTIAL_ENV and PROVIDER_CREDENTIAL_ENV. Also check model catalog structure (contracts.ts) and where picker lives (probably src/components). And check server/index.ts avatar route to see key source.Now I understand the Murage driver model well:

  - ACP drivers (qwen, hermes, opencode-go, droid, cursor, gemini, grok, kimi) spawn CLIs via `spawnCli` with `childEnv()` which strips PROVIDER_CREDENTIAL_ENV + WORKSPACE_CREDENTIAL_ENV unless in `credentialEnv` allowlist. Per-support `transformEnv` / `applyTurnEnv` hooks exist — these are exactly where Flux surface env would be applied. `resolveTurnModel` rewrites picker ids (`omlx::model`) to CLI-native ids.
  - claude.ts and codex.ts are separate non-ACP drivers with their own env handling.
  - local-inject.ts already implements the OpenAI surface (applyOpenAIInject: OPENAI_BASE_URL/OPENAI_API_KEY), the Anthropic surface (applyClaudeInject: ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY/MODEL), and the codex provider-table problem via `-c model_providers.*` argv (codexLocalProviderArgs) — NO scoped CODEX_HOME needed in Murage's model.

  So the plan's claims:
  1. "src/../local-inject.ts" — path is wrong (it's server/drivers/local-inject.ts; "src/../" would resolve to repo root, not server/drivers — sloppy but minor). Reuse: partially valid for local-inject, but note local-inject's mechanism is pick-driven (`host::model` encoded ids decoded from the picker selection) and its LOCAL_HOSTS are loopback-only with hardcoded keys and MODEL_ID regex — Flux's `flux-auto` passes MODEL_ID regex fine. But `decodeInjectId` requires host in HOST_BY_ID. So reuse means adding a flux entry — but then the model selection flow changes: Flux models become "custom inject rows" merged by mergeLocalInject only when probed live... probeLocalInjects probes LOCAL_HOSTS — adding a remote host means probing api.fluxrouter.ai on every catalog build with 1.2s timeout — behavior change. Also `skipSubscriptionAuthForLocalInject` treats inject ids as bypassing auth — Flux models would inherit that, which is right-ish. But this is a real design decision the plan doesn't surface: two integration styles (inject-id pick vs routing toggle). Plan item 5 adds a per-Ember routing toggle which CONFLICTS with the local-inject pick-based model. If Flux is surfaced via the picker as flux-* model ids (item 3), the routing decision is per-pick; the Wayland precedence logic (per-chat pick > global toggle > native) — plan item 5 adds per-bot routing toggle but plan doesn't reconcile with Murage's existing model-pick-driven injection. Actually Wayland fluxRouting already handles flux model ids in the picker (isFluxModelId). So item 3 (catalog) feeds resolveFluxRouting's selectedModelId. OK.

  2. openai-compat.ts — REFUTED. openai-compat is an in-process chat-completions runtime driver (createOpenAIChatRuntime) for Murage itself talking to OpenRouter/Groq; it has nothing to do with spawn-env redirection of CLI backends. The plan says "Murage already has local-inject.ts and openai-compat.ts; the OpenAI surface should reuse them rather than duplicating." openai-compat cannot be reused for the spawn-env OpenAI surface. However — and this is a big missed alternative — openai-compat proves Murage can add Flux as a first-class in-process driver with ~10 lines (url=https://api.fluxrouter.ai/v1, apiKeyEnv=FLUX_API_KEY), which would give Flux routing to ALL Embers without any spawn-env surgery for Murage-native (non-CLI) usage. The plan never considers this simpler path. Actually wait — is openai-compat a driver the user can select as an engine for an Ember? metadata.access: "custom", supportsMultipleInstances. Yes. So "point every Ember at Flux" could be achieved by an openai-compat instance today with zero code (set OPENAI_COMPAT_URL + OPENAI_COMPAT_API_KEY). The plan's "Why" (one key, any model) is partially already achievable; the plan misses this entirely. That's a major finding: the plan's work item 4 (large port) may be largely unnecessary for the in-process path; the real work is only for CLI backends (claude, codex, ACP harnesses).

  3. Sequencing: plan says 1-3 parallel, 4 depends on 1, 5 depends on 1 and 4. Check: item 3 (model catalog surfacing flux tiers in picker) depends on item 1? Surfacing "only when a Flux key exists" requires the config from item 1. Also where do catalogs live — per-driver models; adding flux tiers to pickers across drivers touches driver catalogs. Item 2 (avatar) needs the flux key config (item 1) to decide which base URL to use — "When a Flux key is present" — so item 2 DEPENDS on item 1's config schema. Plan claims 1–3 independent; item 2 clearly needs to read the flux key from config. Unless it reads env only. Minor-major sequencing error. Also item 4 depends on 3, not just 1: the "Done when" for 4 requires selecting flux-auto per Ember (model picker) and resolveFluxRouting's precedence uses selectedModelId which comes from the catalog work in 3. Also 5 depends on 4 AND 3. Plan says 5 depends on 1 and 4 — arguably needs 3 too. And 4 depends on 3 as argued. Actually the plan says items 1-3 parallelize and 4 depends on 1. My audit: 2 depends on 1 (config key); 3 depends on 1 (only surface when key exists → needs config); 4 depends on 1 and 3 (model ids in picker + resolution); 5 depends on 4. So the parallelization claim is wrong: only nothing is fully parallel; 1 is a prerequisite for 2 and 3 as specified. Unless 2/3 are built against a not-yet-landed config shape — in practice they'd be sequential. Severity: minor (planning inaccuracy, not fatal) — but the 4-depends-on-3 miss is more substantive because "Done when" of 4 references picker behavior.

  4. Safety gaps beyond native-key stripping:
     - Murage's childEnv already strips PROVIDER_CREDENTIAL_ENV + WORKSPACE_CREDENTIAL_ENV unless allowlisted (acp/core.ts:198-206). The plan's item 1 says "Add FLUX_API_KEY to WORKSPACE_CREDENTIAL_ENV so spawned agents cannot read it" — but then the Flux surface needs to RE-INJECT FLUX_API_KEY for codex/hermes per Wayland. If FLUX_API_KEY is in WORKSPACE_CREDENTIAL_ENV, adding it to a support's credentialEnv allowlist would expose it... Actually credentialEnv allowlist is per-driver: for codex, FLUX_API_KEY would need to be allowlisted when flux-routed but NOT otherwise. The plan doesn't address this conditional allowlist. Also there's a subtle conflict: putting FLUX_API_KEY in WORKSPACE_CREDENTIAL_ENV means every driver's childEnv deletes it — the routing layer must re-add after strip. Wayland does exactly that (stripKeys + env). Fine, but plan doesn't mention integrating with the allowlist mechanism. Severity: major (mechanism mismatch that will surface immediately at implementation).
     - PROVIDER_CREDENTIAL_ENV — check what's in it. Wayland strips NATIVE_PROVIDER_KEY_VARS from PROVIDER_ENV_VARS (KeyDiscovery). Murage equivalent is PROVIDER_CREDENTIAL_ENV in config.ts. Need to check it covers OPENAI_API_KEY, ANTHROPIC_*, OPENAI_BASE_URL etc. If Murage's list doesn't include OPENAI_BASE_URL/OPENAI_MODEL/ANTHROPIC_BASE_URL (non-secret but routing-affecting vars), a user's ambient shell env OPENAI_BASE_URL could fight the Flux surface. Wayland explicitly strips OPENAI_BASE_URL, OPENAI_MODEL, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL. Check config.ts lists.
     - applyClaudeInject in Murage sets ANTHROPIC_* — check claude.ts: does it strip pre-existing ANTHROPIC keys first? Check claude.ts spawn env.
     - Also avatar-image.ts: putting flux key where? The 401 passthrough (status 401 → 401) and error message says "OpenAI image generation failed" — minor.
     - redact.ts: does redactSecrets know about FLUX_API_KEY? Native logs redact secrets; if a new env var carries the flux key into mcpServers env or session setup, redaction list must include it. Check redact.ts.
     - The plan's item 1 "Done when: no spawned agent sees it in env" conflicts with codex needing FLUX_API_KEY in env at request time (Wayland). In Murage codex.ts, codexLocalProviderArgs sets env_key name and passes the secret via env — so codex flux would similarly need MURAGE_LOCAL_FLUX_API_KEY style or FLUX_API_KEY in child env. So "no spawned agent sees it" is wrong as stated for codex/hermes — the codex child MUST see it. The plan carries this contradiction from Wayland (Wayland emits FLUX_API_KEY to codex spawns). Plan's done-when for item 1 is internally inconsistent with item 4's codex path. Major/minor.

  5. Codex path deferral: Does deferring break anything? In Murage, codex.ts already has codexLocalProviderArgs solving exactly this problem via -c flags — no scoped CODEX_HOME needed, no filesystem work. The plan's risk #1 ("Codex is the hardest path, needs filesystem work, scoped CODEX_HOME") is a wrong assumption transplanted from Wayland: Murage's codex driver spawns `app-server` with argv config overrides (codex.ts:158). So codex is NOT the hardest path here; it's arguably the easiest after qwen. Deferring it based on that wrong premise mis-prioritizes. Also does deferring break anything? If item 3 surfaces flux tiers in the picker for codex Embers but routing core ships without codex support, resolveFluxRouting would return 'unknown' → badge honest, falls back native. But plan item 4's Done-when requires codex working; risk #1 contradicts the Done-when (ship without codex vs done-when requiring codex turn). Inconsistency: minor. Also claude: check claude.ts — does Murage's claude driver spawn the claude CLI with env (ANTHROPIC_BASE_URL honored)? It uses applyClaudeInject already, so yes env-based. Good.

  Other things to verify:
  - config.ts: PROVIDER_CREDENTIAL_ENV contents, config schema shape for adding flux, and whether settings panel pattern exists.
  - Who calls generateAvatarImage — where does the key come from (openai config?). Check server/index.ts.
  - Model catalog/picker: item 3 says "Add the four Flux tiers to the picker" — but Murage's pickers are per-driver catalogs; flux tiers would need adding to EVERY driver's catalog or as custom rows. And claude driver catalog (claude-catalog) has its own model ids; selecting flux-auto on claude requires ANTHROPIC_MODEL=flux-auto env (applyClaudeInject-style) — fine. But how does the picker selection reach spawn env for non-ACP claude/codex drivers? claude.ts:87 applyClaudeInject(env, model) — decodeInjectId returns null for "flux-auto" (no :: separator) → not injected. So to route claude to flux via a picker pick of "flux-auto", you'd extend decodeInjectId/local-inject to recognize flux ids, or add a separate resolution. The plan's "reuse local-inject" actually points the right way: add flux as a host in LOCAL_HOSTS with apiKeyEnv: FLUX_API_KEY... but LOCAL_HOSTS probing (probeLocalInjects) hits `${baseUrl}/models` with the key — flux supports GET /v1/models per the contract, so it would work, and mergeLocalInject would surface live flux models as custom rows automatically. Interesting — that means items 3 AND 4's openai/anthropic surfaces could be implemented by adding ONE LocalHost entry + making hostApiKey read the config key. That's a much smaller implementation than the plan's "port 233-line fluxRouting.ts". But there are mismatches: anthropicBaseUrl strips /v1 — flux anthropic surface is https://api.fluxrouter.ai/anthropic (not /v1), so anthropicBaseUrl(host) with baseUrl https://api.fluxrouter.ai/v1 → strips /v1 → https://api.fluxrouter.ai, but the needed base is /anthropic. Mismatch! So applyClaudeInject reuse needs a per-host anthropic base override. Concrete file:line: local-inject.ts:108-111 anthropicBaseUrl; flux.ts contract says anthropic surface is /anthropic. Good catch — proves "reuse" isn't drop-in.
  - Also MODEL_ID regex: /^[\w][\w./:+-]*$/ — "flux-auto" fine.
  - codex: CODEX_RESERVED_PROVIDERS = openai/ollama/lmstudio (local-inject.ts:123) — a "flux" host id is fine.
  - codexLocalProviderArgs passes env_key name; the env value is set on the child env (env[envKey] = hostApiKey). But child env for codex: codex.ts builds env how? Need to check codex.ts env handling & credentialEnv stripping for codex. Also whether codex app-server reads model_provider selection — codexLocalProviderArgs only sets model_providers.X args, but does anything set `-c model_provider=flux` and `-c model=flux-auto`? Check codex.ts around line 158 to see how the model is passed. If codex.ts passes `-c model=<model>` and model_provider is derived... let me read codex.ts.

  Also check config.ts lines ~520-560 for the credential lists and schema; and where settings panel Composio key entry is (src components) — minor.

  Also check: does the plan's item 3 picker gating ("only surface when a Flux key exists") fit Murage's catalog flow — catalogs come from drivers via contracts; key presence is server config; mergeLocalInject pattern exists for dynamic rows. OK.

  Also open question: plan says "Murage today makes users bring a subscription per engine" — fine.

  Another safety gap: the Flux key in config.json at ~/.murage/config.json — permissions/encryption? Existing composio key entry pattern presumably plaintext. Plan says "same shape as existing Composio key entry" — fine.

  Another: fluxRouting.ts depends on PROVIDER_ENV_VARS from Wayland's KeyDiscovery — Murage has no such module; equivalent is PROVIDER_CREDENTIAL_ENV in config.ts. Porting requires mapping. If PROVIDER_CREDENTIAL_ENV doesn't include e.g. OPENROUTER_API_KEY, GROQ_API_KEY (plan explicitly names those as stripped), check. Let me read config.ts around those lists.

  Also: plan item 4 "Wire into the spawn path so resolveFluxRouting() runs before each agent launch" — Murage has multiple spawn paths: acp/core.ts childEnv, claude.ts, codex.ts, plus openai-compat in-process (no spawn). A single resolveFluxRouting doesn't fit; the integration points are per-driver hooks (transformEnv/applyTurnEnv/credentialEnv, applyClaudeInject, codexLocalProviderArgs). Missing work: enumerate these integration points. Also boxagent/cloud drivers (box.ts, cloud-backend) — Embers can run in cloud boxes; does routing apply there? Out of scope maybe, but spawn env for box agents is remote — flux env injection there is missing work or needs explicit out-of-scope.

  Also item 5 per-Ember routing toggle: Murage bot-profile.ts / shared/bot-profile.ts — per-bot fields exist. But note the routing decision in Murage is naturally expressed via model pick (flux-* ids). A separate routing:"native"|"flux" toggle duplicates state that can conflict with the model pick (Wayland needed the toggle because team spawns had no explicit model; Murage always has a per-bot model pick? check shared/bot-profile.ts for model field). If every Murage Ember has an explicit model, the toggle's main role (route modelless spawns) is void and item 5 may be unnecessary complexity — or worse, contradictory UX (toggle=flux but model=gpt-5 → who wins?). Worth flagging as design gap.

  Also hermes exists in Murage (acp/hermes.ts) — Wayland's SCOPED_HOME_FLUX_BACKENDS includes hermes needing HERMES_HOME materialization. Does Murage's hermes support handle config home? Check acp/hermes.ts briefly — if Murage's hermes driver already writes a scoped home, porting is smaller; if not, plan's work item 4 underestimates (plan's surface table omits hermes entirely! Plan lists only claude/qwen/goose/codex; Murage also has hermes, gemini, grok, kimi, cursor, opencode-go, droid ACP drivers). The plan's backend membership sets ported from Wayland don't match Murage's roster: Murage has grok (grok.ts — xAI, vendor locked?), gemini (Google), kimi, cursor, opencode-go, droid, hermes, qwen. The plan's "Not routable by design" list names opencode/qoder/droid/auggie/copilot/kiro/vibe — but Murage's roster includes kimi, cursor, gemini, grok which the plan never classifies. Missing work: classify Murage's actual driver roster. Major.

  Let me now read: config.ts (credential lists + schema area), codex.ts (spawn + env + model passing), claude.ts env portion, acp/qwen.ts and acp/hermes.ts (how they do env/models), redact.ts, and check where generateAvatarImage is called + where settings panel composio key is. Parallel reads.532:export const WORKSPACE_CREDENTIAL_ENV = [
533-  "XAI_API_KEY",
534-  "OPENAI_COMPAT_API_KEY",
535-  "OPENAI_COMPAT_URL",
536-  "BOX_TOKEN",
537-  "OPENCODE_API_KEY",
538-  "MURAGE_TTS_KEY",
539-  "MURAGE_OPENAI_IMAGE_KEY",
540-  "COMPOSIO_API_KEY",
541-  "SENDLANE_API_KEY",
542-  "SENDLANE_HASH_KEY",
543-  "MURAGE_COMPOSIO_BROKER_TOKEN",
544-  // Harness-private filesystem hints are not credentials themselves, but
545-  // exposing them to a shell-capable agent points straight at app-owned
546-  // state. The built-in browser master is delivered privately in memory.
547-  "MURAGE_BROWSER_CONNECTION",
548-  "MURAGE_USER_DATA",
549-] as const;
550-
551-/** Drop every workspace credential from a child-process env (in place). */
552-export function stripWorkspaceCredentialEnv(env: Record<string, string | undefined>): void {
553:  for (const key of WORKSPACE_CREDENTIAL_ENV) delete env[key];
554-}
555-
556-/** Env names a provider CLI might read as its own billing identity. A spawned
557- * engine keeps only what its driver explicitly allows: a foreign key riding
558- * along in `...process.env` must not flip a subscription CLI onto
559- * pay-as-you-go billing the user never granted. */
560:export const PROVIDER_CREDENTIAL_ENV = [
561-  "ANTHROPIC_API_KEY",
562-  "FACTORY_API_KEY",
563-  "GEMINI_API_KEY",
564-  "GOOGLE_API_KEY",
565-  "KIMI_API_KEY",
566-  "MOONSHOT_API_KEY",
567-  "MINIMAX_API_KEY",
568-  "OPENAI_API_KEY",
569-  "OPENCODE_API_KEY",
570-  "XAI_API_KEY",
571-  "CURSOR_API_KEY",
572-  "CURSOR_AUTH_TOKEN",
573-] as const;
574-
575-/** Merge a partial config into ~/.murage/config.json (secrets never
576- * echoed back — callers report configured-or-not booleans only). */
577-export function saveConfig(patch: Partial<AppConfig>): void {
578-  const p = join(DATA_DIR, "config.json");
579-  let disk: JsonObject = {};
580-  try {
581-    const parsed = jsonObjectSchema.safeParse(parseJson(readFileSync(p, "utf8")));
582-    if (parsed.success) disk = parsed.data;
583-  } catch {
584-    /* first write */
585-  }
586-  const checkedPatch = appConfigSchema.partial().parse(patch);
587-  // A write is the durable migration point. Preserve every other raw key in
588-  // config.json, but never write #567's mixed-case or duplicate profile ids
589-  // back after we have successfully recognized the legacy list.
590-  const storedProfiles = storedBrowserProfilesSchema.safeParse(disk.browserProfiles);
Excellent. Massive findings confirmed:

  - Murage's hermes driver ALREADY writes the user's real ~/.hermes/config.yaml (ensureHermesInjectProvider writes providers.<host> into the user's actual HERMES_HOME — comment at hermes.ts:432-435 acknowledges this: "resolveTurnModel already wrote the named provider using the instance HOME"). Wait — it uses `hermesHome(env)` with the child env; env comes from childEnv() which is process.env + input.environment — so HERMES_HOME is the user's real home unless instance config sets it. The comment says "using the instance HOME" — so input.environment may carry a scoped HOME? Not sure. Either way, Murage's hermes inject path ALREADY EXISTS and writes provider blocks named by host id — adding a "flux" host to LOCAL_HOSTS would make hermes flux routing work via `custom:flux:flux-auto` set_model. Wayland needed scoped HERMES_HOME materialization; Murage already has a different, working mechanism (write named provider + set_model). So porting Wayland's SCOPED_HOME approach would be a regression/duplication.

  - Codex: codex.ts:158 already does `codexLocalProviderArgs(env, turn.model)` — argv `-c model_providers.<host>...` with env_key. No CODEX_HOME needed. And model selection: need to see how turn.model is passed later (probably `-c model=` or session config). But regardless, the plan's "codex needs scoped CODEX_HOME filesystem work" is refuted for Murage.

  - WORKSPACE_CREDENTIAL_ENV: no FLUX_API_KEY yet; note adding FLUX_API_KEY there means codex childEnv's stripWorkspaceCredentialEnv deletes it — then codexLocalProviderArgs re-adds under MURAGE_LOCAL_* name (env_key). Actually codexLocalProviderArgs sets env[envKey] where envKey = MURAGE_LOCAL_<HOST>_API_KEY — that name is not in WORKSPACE_CREDENTIAL_ENV, so it survives. Good pattern already.

  - PROVIDER_CREDENTIAL_ENV does NOT include OPENROUTER_API_KEY, GROQ_API_KEY (plan names those explicitly as stripped!), nor ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/OPENAI_BASE_URL/OPENAI_MODEL. So: (a) plan's example strip list (OPENROUTER_API_KEY, GROQ_API_KEY) isn't even in Murage's provider list — though hermes transformEnv deletes OPENROUTER_API_KEY itself (hermes.ts:427). (b) Routing-affecting non-secret vars (OPENAI_BASE_URL, ANTHROPIC_BASE_URL) ride through `...process.env` into every child today — a user's ambient OPENAI_BASE_URL would fight the Flux surface; Wayland explicitly strips these; plan doesn't mention. Safety gap, major.

  - qwen: check acp/qwen.ts quickly for how it applies env (OPENAI_BASE_URL etc.) and whether applyOpenAIInject is used. Let me check qwen.ts and claude.ts env sections, plus where generateAvatarImage is called from (index.ts) and redact.ts env redaction. Also check claude.ts:87 context.        resolve(
          typeof status === "object" && status !== null && "loggedIn" in status && status.loggedIn === true,
        );
      } catch {
        resolve(false);
      }
    });
  });
}

/** The CLI environment shared by auth probes and real turns.
 *
 * Subscription users can be billed pay-as-you-go if an inherited API key
 * leaks through, and a nested CLI must not inherit this session's identity.
 * Keeping the probe and turn environments identical prevents setup from
 * claiming an API-key login that the turn itself would deliberately remove.
 */
function claudeEnvironment(
  model?: string | null,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // The harness process may hold workspace credentials (xai/box/voice keys,
  // env-injected at boot); none of them are this CLI's to see.
  stripWorkspaceCredentialEnv(env);
  const applied = applyClaudeInject(env, model);
  if (!applied.injected) delete env.ANTHROPIC_API_KEY;
  return env;
}

const DRIVER_KIND = "claudeAgent";

export interface ClaudeConfig {
  cli: string;
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
  /** Available Claude built-ins. An empty list passes `--tools ""`. */
  tools?: string[];
  /** Claude tool patterns to deny after the available set is selected. */
  disallowedTools?: string[];
}

// model catalog ported from upstream packages/contracts/src/model.ts
export const STATIC_CLAUDE_MODELS: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

const CLAUDE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

/** Rewrite a leftover API slug (`orcarouter/Qwen…`) to `host::model` when a
 *  local host is serving it, so the turn injects instead of asking for /login.
 *  Official cloud ids and already-encoded inject ids skip the probe. */
async function resolveClaudeTurnModel(
  model: string | null | undefined,
===
/Volumes/Mando/WaylandBots/murage-app/server/avatar-image.ts:92:export async function generateAvatarImage(
/Volumes/Mando/WaylandBots/murage-app/server/config.ts:487:  if (process.env.MURAGE_OPENAI_IMAGE_KEY !== undefined) cfg.imageGen.key = process.env.MURAGE_OPENAI_IMAGE_KEY;
/Volumes/Mando/WaylandBots/murage-app/server/config.ts:506:    [patch.imageGen?.key, "MURAGE_OPENAI_IMAGE_KEY"],
/Volumes/Mando/WaylandBots/murage-app/server/config.ts:539:  "MURAGE_OPENAI_IMAGE_KEY",
/Volumes/Mando/WaylandBots/murage-app/server/index.ts:50:  generateAvatarImage,
/Volumes/Mando/WaylandBots/murage-app/server/index.ts:4846:    "MURAGE_OPENAI_IMAGE_KEY",
/Volumes/Mando/WaylandBots/murage-app/server/index.ts:6884:      const generated = await generateAvatarImage(cfg.imageGen?.key ?? "", existing, parsed.data.prompt);
===
10:// So the log keeps the SHAPE and loses the VALUES: a redacted entry still
15: * substring, so KEY catches ANTHROPIC_API_KEY and x-api-key. */
16:const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];
20: * every real one is spelled (API_KEY, consumer-key, xai_key). */
23:  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
27:const REDACTION_MARKER = /^«redacted \d+ chars»$/;
29:/** Keep repeated redaction byte-for-byte stable. Persisted payloads can pass
32:const mask = (value: string) => (REDACTION_MARKER.test(value) ? value : `«redacted ${value.length} chars»`);
59:export function redactSecretsInText(text: string): string {
72:export function redactSecrets(input: unknown, depth = 0): unknown {
73:  if (typeof input === "string") return redactSecretsInText(input);
78:      // ACP env entries: {name: "MURAGE_COMMS_TOKEN", value: "…"}
93:          : { ...entry, value: redactSecretsInText(entry.value) };
95:      return redactSecrets(item, depth + 1);
107:    out[key] = redactSecrets(value, depth + 1);
Excellent — huge finding: Murage's qwen driver does NOT use OPENAI_BASE_URL env at all. Wayland's comment says "qwen: the shared OPENAI_BASE_URL + OPENAI_MODEL=flux-auto is enough" — but Murage's qwen driver routes via writing ~/.qwen/settings.json modelProviders (ensureQwenInjectModel, qwen.ts:22-81) and passing `-m <model>`. And Wayland's own fluxRouting.ts caveat admits "a CLI whose own config already pins an openai baseUrl/provider may let the config win over these env vars (verified for an existing ~/.qwen/settings.json)". In Murage, the settings.json provider row is THE mechanism — so the Wayland env-only approach for qwen would be defeated by Murage's own injected settings.json rows (config wins over env). So the plan's surface table row for qwen ("OPENAI_BASE_URL + OPENAI_MODEL is enough") is wrong in this repo: env-only routing for qwen conflicts with Murage's settings.json injection. The correct Murage path is to add flux as a LOCAL_HOSTS-style host and reuse ensureQwenInjectModel. Blocker-level for the plan's claim.

  Similarly hermes: Murage writes config.yaml provider blocks; Wayland used scoped HERMES_HOME. Different mechanism, already present.

  Redact: SECRET_KEY_PARTS includes "api_key" so FLUX_API_KEY would be redacted (contains "api_key"→ lowercased "flux_api_key" includes "api_key"). Good, no gap there.

  Claude: claudeEnvironment deletes ANTHROPIC_API_KEY only when NOT injected (claude.ts:88-89: `if (!applied.injected) delete env.ANTHROPIC_API_KEY;`). applyClaudeInject sets ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY/MODEL. Note: claudeEnvironment does NOT delete pre-existing ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_MODEL when not injected — subscription users with ambient ANTHROPIC_BASE_URL (cc-switch!) would route... whatever, existing behavior. For flux routing via inject mechanism, adding a flux host works: applyClaudeInject(env, "flux::flux-auto") — but anthropicBaseUrl(host) strips /v1 giving https://api.fluxrouter.ai, while the required anthropic surface is https://api.fluxrouter.ai/anthropic (per the plan's own contract). So direct reuse is broken unless LocalHost gains an anthropicBase override. Concrete: local-inject.ts:108-111 vs plan line 26.

  Also note codex: turn.model flows to codexLocalProviderArgs; how is model selected afterwards? Probably `-c model=` later in codex.ts. Not crucial.

  Also claude catalog: STATIC_CLAUDE_MODELS has official ids; picker per-driver. Item 3 "Add the four Flux tiers to the picker" — picker is per-driver; flux tiers would need to appear for claude, codex, qwen, hermes, etc. And "Only surface when a Flux key exists" — catalogs are driver-side; gating needs config access in resolveModels — doable.

  Also the avatar key: config has imageGen.key (MURAGE_OPENAI_IMAGE_KEY), index.ts:6884 calls generateAvatarImage(cfg.imageGen?.key). So item 2's change: choose flux key vs imageGen key. Where would the flux key live — cfg.flux.apiKey. Fine. Also note WORKSPACE_CREDENTIAL_ENV includes MURAGE_OPENAI_IMAGE_KEY — env-injected at boot. The plan says add FLUX_API_KEY to WORKSPACE_CREDENTIAL_ENV — but plan item 1 also says settings panel field like Composio; Composio key is COMPOSIO_API_KEY in WORKSPACE_CREDENTIAL_ENV. OK consistent.

  Now item 1's "Done when: no spawned agent sees it in env" vs codex needing the key in env — but Murage's codex path passes key under MURAGE_LOCAL_FLUX_API_KEY (env_key mechanism), so the child never sees FLUX_API_KEY itself. Actually consistent-ish, but plan's item 4 port of fluxRouting emits FLUX_API_KEY directly (Wayland). In Murage that would be stripped by stripWorkspaceCredentialEnv if FLUX_API_KEY is in WORKSPACE_CREDENTIAL_ENV (codex.ts:112 deletes workspace creds AFTER... wait codex childEnv strips then codexLocalProviderArgs re-adds MURAGE_LOCAL_*. For ACP core, childEnv deletes PROVIDER+WORKSPACE unless credentialEnv allowlist; applyTurnEnv runs after, so fluxRouting env injection via applyTurnEnv would survive. OK.

  Another safety gap: qwen/hermes inject writes the flux key into USER config files (~/.qwen/settings.json env map, ~/.hermes/config.yaml api_key) in plaintext — the key persists on disk beyond the spawn. Wayland's R13-safe env-only approach was designed to avoid writing config. Murage's existing inject pattern writes keys to disk (qwen envMap, hermes api_key in yaml). Adding flux via that pattern leaks the billing key into user config files. Safety gap worth flagging: major. Also rollback: these writes are upserts, never removed — a user who disables flux keeps flux provider rows + key in ~/.qwen/settings.json.

  Also: claude subscription + applyClaudeInject: if a flux model id is picked for a claude Ember, the CLI's own login is bypassed — that's the intent. Fine.

  Missing work items:
  - Roster classification: Murage's actual engines are claude, codex, qwen, hermes, gemini, grok, kimi, cursor, opencode-go, droid, grokagent?, antigravity, pi, minimax, openai-compat, boxagent, proxies. Plan classifies only Wayland's roster (qwen, goose, claude, codex, opencode, qoder, droid, auggie, copilot, kiro, vibe). Goose doesn't exist in Murage; gemini/grok/kimi/cursor/antigravity/pi/minimax are never classified. Major missing work.
  - The picker/catalog flow: models come per-driver; "add four flux tiers to the picker" requires per-driver catalog changes or a merge step (mergeLocalInject-like) plus `custom: true` flag semantics (hermes.ts:240-244 comment shows custom flag is load-bearing for custom-pane agents). Minor-major.
  - resolveTurnModel/resolveInjectId: claude.ts has resolveClaudeTurnModel that rewrites leftover slugs to host::model — flux ids like "flux-auto" (no ::) would NOT decode; need either flux:: flux-auto encoding or special-casing. The interplay between flux-* bare ids (Wayland style) and Murage's host::model inject ids is unresolved in the plan. Major.
  - Precedence logic: Wayland's resolveFluxRouting handles "native model id pins native" — in Murage every Ember has an explicit model pick; porting the full precedence (routeThroughFlux global toggle + resolvedModelId) may be mostly unnecessary; but conversely plan item 5's per-Ember toggle duplicates the pick. Design conflict.
  - Box/cloud agents: boxagent.ts, cloud-backend — Embers may run in the cloud; flux routing env injection for remote boxes is unaddressed.
  - openai-compat alternative: adding flux as an openai-compat instance (or a tiny dedicated flux driver using createOpenAIChatRuntime) gives Murage-native (non-CLI) flux routing nearly for free; the plan never considers it, and its claim that openai-compat can be "reused for the OpenAI surface" shows the author misunderstood what openai-compat is (in-process runtime vs spawn-env).

  Sequencing:
  - Item 2 depends on item 1 (needs cfg.flux.apiKey to decide base URL; "when a Flux key is present" — presence is defined by item 1's config). Plan says 1-3 independent. Minor.
  - Item 3's "only surface when a Flux key exists" also depends on item 1. Minor.
  - Item 4's Done-when requires selecting flux-auto per Ember → depends on item 3 (catalog) — plan says 4 depends only on 1. Moderate.
  - Item 5 depends on 4 AND effectively 3. Plan says 1 and 4. Minor.
  - Also item 4 in Murage is NOT one "routing core" — it's per-driver hook work (transformEnv/applyTurnEnv/credentialEnv for ACP, claudeEnvironment, codexLocalProviderArgs). The "wire resolveFluxRouting into the spawn path" step is a category error: there are N spawn paths with existing injection hooks.

  Codex deferral (Q5): Deferring breaks nothing structurally — unknown → badge/native fallback is honest. BUT: (a) the premise (hardest path, needs CODEX_HOME filesystem work) is false in Murage — codexLocalProviderArgs (local-inject.ts:130-148) already solves provider-table-via-argv with secrets in env; adding flux is a LocalHost entry + reserved-provider check, likely the EASIEST surface after openai. (b) Plan's item 4 Done-when requires codex turn; risk #1 says ship without codex — internal contradiction in acceptance criteria. (c) If codex deferred and item 3 surfaces flux tiers in codex's picker (STATIC_CODEX_MODELS), a user picking flux-auto on codex with no routing → codex sends model=flux-auto to OpenAI → 400 "model does not exist" — exactly the failure Wayland's resolvedModelId guard existed to prevent. So deferral breaks the picker unless item 3 gates flux tiers per-engine on implemented surfaces. That's a real break: major.

  Also the plan's "goose" env (GOOSE_PROVIDER) — no goose driver in Murage: porting BACKEND_FLUX_ENV wholesale includes a backend that doesn't exist here; and omits Murage's actual ones. Confirms transcription-not-adaptation risk the plan itself noted but then its own work breakdown still says "port... the backend membership sets".

  Also plan's "Not routable" list includes opencode needing config-writing setup assistant — Murage HAS opencode-go driver and... check quickly? Not necessary; mention roster mismatch.

  Also qwen in Murage is "custom-only" — access: "custom", models EMPTY, catalog from mergeLocalInject only. So qwen in Murage ONLY runs injected local models; there is no native qwen subscription path. Flux via qwen = add flux host → shows in picker automatically via mergeLocalInject (probe https://api.fluxrouter.ai/v1/models with bearer). Actually that's elegant: probeLocalInjects with a flux host whose apiKeyEnv=FLUX_API_KEY... but hostApiKey falls back to "local" when no key — probe with wrong key → 401 → no rows. Gating "only when key exists" comes free-ish. But probing a remote host on every catalog build (1.2s timeout each, parallel) — latency/behavior change vs loopback assumption; timedJson 1200ms abort. Minor.

  One more wrong assumption: plan line 85 cites "src/../local-inject.ts" — path doesn't exist; actual server/drivers/local-inject.ts. Minor but signals the author didn't read the files. Also plan item 2's claim about avatar-image.ts hardcoding — verified TRUE (avatar-image.ts:104, 111; 409 copy line 99). Good, that's verified not refuted.

  Also item 2: generateAvatarImage signature takes apiKey only; caller index.ts:6884 passes cfg.imageGen?.key. Making base URL/model configurable requires plumbing through index.ts call site + config env parity (MURAGE_OPENAI_IMAGE_KEY at config.ts:487, 506) — plan doesn't mention the env-var parity for the flux key (should FLUX_API_KEY also be settable via env like other keys? config.ts:487 pattern). Minor missing work.

  Safety gaps beyond native-key stripping (Q4):
  1. PROVIDER_CREDENTIAL_ENV lacks OPENROUTER_API_KEY/GROQ_API_KEY (config.ts:560-573) and no BASE_URL/MODEL vars anywhere — ambient OPENAI_BASE_URL/ANTHROPIC_BASE_URL/OPENAI_MODEL ride through ...process.env into every spawn (acp/core.ts:193-197, codex.ts:101-106, claude.ts:80). Flux surface must strip/override these; plan only mentions secret keys. Wayland stripped them explicitly (fluxRouting.ts:104-107, 231). Major.
  2. Key persistence to disk: qwen/hermes inject paths write the key into ~/.qwen/settings.json and ~/.hermes/config.yaml (qwen.ts:49,74; hermes.ts:44-55,91-92) with no rollback — conflicts with plan's own "backup, write, report, rollback" doctrine for config-writing and with R13-safety. Major.
  3. ANTHROPIC_AUTH_TOKEN: claudeEnvironment only deletes ANTHROPIC_API_KEY when not injected (claude.ts:89); a stale ambient ANTHROPIC_AUTH_TOKEN/BASE_URL survives into native claude spawns — pre-existing, but flux work that touches this file must not codify it; more relevantly for flux: applyClaudeInject sets all four so flux path is fine.
  4. redact.ts: FLUX_API_KEY contains "api_key" → redacted in native logs. OK, no gap. But qwen settings env key MURAGE_QWEN_FLUX_API_KEY also contains API_KEY → fine.
  5. credentialEnv allowlist interaction: adding FLUX_API_KEY to WORKSPACE_CREDENTIAL_ENV (plan item 1) means ACP childEnv deletes it unless a support's credentialEnv names it — supports that need it (none if using MURAGE_LOCAL_* indirection). But if the ported fluxRouting emits FLUX_API_KEY into env (Wayland-style) BEFORE childEnv's strip... ordering matters: applyTurnEnv runs after strip (core.ts:207 transformEnv, 317 applyTurnEnv), so injection must happen in transformEnv/applyTurnEnv, not via input.environment. Plan's "wire resolveFluxRouting before each agent launch" doesn't specify the hook point; wrong hook = silently stripped key = 401s. Major implementation trap.
  6. Mutual exclusivity also means: when flux-routed, the CLI's own subscription login must not ALSO be used — for claude, applyClaudeInject path already replaces auth. For ACP supports with requireAuthenticationBeforeSpawn, skipSubscriptionAuthForLocalInject only bypasses for decodeInjectId models — bare "flux-auto" wouldn't bypass → flux pick on grok/gemini would demand subscription login. Roster-specific wiring missing.

  Severity assignments:
  - Blocker: qwen env-surface claim false in Murage (settings.json wins; Murage qwen driver never reads OPENAI_BASE_URL — indeed Wayland's own caveat + qwen.ts mechanism). Actually is it blocker? The plan's item 4 as written (port fluxRouting env-only surfaces) would produce a qwen integration that doesn't work against Murage's own injected settings. Yes, blocker for the plan-as-written.
  - Blocker/major: openai-compat reuse claim refuted (it's an in-process runtime, not spawn env). Major (mis-scopes work; the reuse target for OpenAI surface is local-inject only).
  - Major: roster mismatch (goose nonexistent; gemini/grok/kimi/cursor/opencode-go/antigravity/pi/minimax unclassified).
  - Major: codex premise false; deferral + picker gating interaction breaks codex flux picks (400s).
  - Major: anthropic surface base URL mismatch (anthropicBaseUrl strips /v1; flux needs /anthropic).
  - Major: hook-point/credential-strip ordering unspecified → key silently stripped.
  - Major: key written to disk via inject paths w/o rollback.
  - Minor: sequencing (2 and 3 depend on 1; 4 depends on 3; 5 on 3+4).
  - Minor: path typo src/../local-inject.ts.
  - Minor: item 1 done-when vs codex key-in-env contradiction (resolved via MURAGE_LOCAL_ indirection, but plan doesn't say that).
  - Minor: env parity (FLUX_API_KEY env → config like MURAGE_OPENAI_IMAGE_KEY), redact already fine.
  - Minor: plan item 3 "four tiers" but Wayland routing always forces FLUX_AUTO_MODEL (fluxRouting.ts:51,216,228) — surfaces hardcode flux-auto regardless of pick! So picking flux-reasoning in the picker would still spawn with ANTHROPIC_MODEL=flux-auto / OPENAI_MODEL=flux-auto. The plan's item 3 (four selectable tiers) contradicts the reference implementation it ports, which only ever injects flux-auto. That's a real functional miss: tier selection never reaches the spawn env. Major actually — item 3's done-when ("selecting one persists per Ember") plus item 4 port = user picks flux-fast, gets flux-auto silently. Severity major.

  Wait check: fluxRouting uses FLUX_AUTO_MODEL in all three surfaces — yes lines 51, 216, 228. isFluxModelId decides routing but the model injected is always flux-auto. In Wayland maybe the CLI also gets the picked model separately via normal model passing (ACP -m?). Hmm — in Wayland, the spawn presumably still passes the selected model to the CLI (e.g. qwen -m flux-reasoning?), and OPENAI_MODEL is a fallback. Unknown. But as ported into Murage, claude: applyClaudeInject sets ANTHROPIC_MODEL=inject.model — if flux were a host, model would be the picked tier. So the Murage-native approach handles tiers correctly; the Wayland port hardcodes auto. Worth flagging as a finding: plan ports code that pins flux-auto while item 3 sells four tiers; must verify how the picked tier reaches the wire per surface.

  Also claude picker: STATIC_CLAUDE_MODELS official ids; where would flux tiers appear for claude? claude-catalog? mergeLocalInject used by claude? Check quickly — grep mergeLocalInject usage. claude-catalog.test exists. Let me grep.

  Also "goose" — confirm no goose in Murage: drivers list has no goose. Confirmed.

  Also check antigravity/pi/minimax/grok drivers nature quickly? For roster claim I can just cite the drivers dir listing. Enough.

  One more: plan says items 1-3 parallelize "4 depends on 1" — also 4 depends on the roster classification work which isn't an item at all.

  Let me quickly grep mergeLocalInject usage to see which drivers merge local injects (claude? codex-catalog?).

• Two final checks — which drivers merge `local-inject` rows into their catalogs, and how codex passes the model:/Volumes/Mando/WaylandBots/murage-app/server/drivers/codex-catalog.ts:365:  if (!mainText) return mergeLocalInject(official, env, fetchImpl);
/Volumes/Mando/WaylandBots/murage-app/server/drivers/codex-catalog.ts:431:  return mergeLocalInject(
/Volumes/Mando/WaylandBots/murage-app/server/drivers/antigravity.ts:398:        const resolved = await mergeLocalInject(readAntigravityModelCatalog(catalogEnv), catalogEnv);
/Volumes/Mando/WaylandBots/murage-app/server/drivers/pi.ts:18:// other engines do: mergeLocalInject lists them in Custom, and a pick
/Volumes/Mando/WaylandBots/murage-app/server/drivers/pi.ts:50:  mergeLocalInject,
/Volumes/Mando/WaylandBots/murage-app/server/drivers/pi.ts:180:  return preferPiInjectRows(await mergeLocalInject(catalog, env, fetchImpl));
/Volumes/Mando/WaylandBots/murage-app/server/drivers/claude.ts:37:  mergeLocalInject,
/Volumes/Mando/WaylandBots/murage-app/server/drivers/claude.ts:39:  resolveInjectId,
/Volumes/Mando/WaylandBots/murage-app/server/drivers/claude.ts:126:  return resolveInjectId(model, await probeLocalInjects(env)) ?? model;
/Volumes/Mando/WaylandBots/murage-app/server/drivers/claude.ts:153: *  come from mergeLocalInject. */
/Volumes/Mando/WaylandBots/murage-app/server/drivers/claude.ts:536:        const resolved = await mergeLocalInject(readClaudeModelCatalog(catalogEnv), catalogEnv);
/Volumes/Mando/WaylandBots/murage-app/server/drivers/acp/kimi.ts:505:  resolveModels: (env) => mergeLocalInject(readKimiModelCatalog(env), env),
/Volumes/Mando/WaylandBots/murage-app/server/drivers/acp/qwen.ts:84:  const catalog = await mergeLocalInject(EMPTY, env);
/Volumes/Mando/WaylandBots/murage-app/server/drivers/acp/hermes.ts:367:  const catalog = await mergeLocalInject(EMPTY, env);
/Volumes/Mando/WaylandBots/murage-app/server/drivers/acp/grok.ts:188:  resolveModels: (env) => mergeLocalInject(readGrokModelCatalog(env), env),
/Volumes/Mando/WaylandBots/murage-app/server/drivers/acp/droid.ts:148:      // Live inject rows come from mergeLocalInject as host::model. Skip the
/Volumes/Mando/WaylandBots/murage-app/server/drivers/acp/droid.ts:171:  return mergeLocalInject(catalog, env);
/Volumes/Mando/WaylandBots/murage-app/server/drivers/acp/opencode-go.ts:381:  resolveModels: async (environment, config) => mergeLocalInject(
===
68:    "-c", `${prefix}.command=${JSON.stringify(server.command)}`,
69:    "-c", `${prefix}.args=${JSON.stringify(server.args)}`,
72:    "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(server.env))}`,
77:    appServerArgs.push("-c", `${prefix}.default_tools_approval_mode="auto"`);
196:            "-c", `${prefix}.command=${JSON.stringify(bridge.command)}`,
197:            "-c", `${prefix}.args=${JSON.stringify(bridge.args)}`,
198:            "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(bridge.env))}`,
199:            "-c", `${prefix}.default_tools_approval_mode="auto"`,
===
/Volumes/Mando/WaylandBots/murage-app/server/project-scout.ts


• I have enough. `mergeLocalInject` is already the universal catalog-merge path across claude, codex, kimi, grok, qwen, hermes, droid, opencode-go, antigravity, pi — so "add a flux LocalHost" would surface flux models in nearly every driver's picker automatically. And goose doesn't exist in Murage (only a comment hit in project-scout.ts probably). 

  Now write the audit. Be adversarial, specific, cite file:line, severity, concrete fix. Don't restate the plan.

• Audit complete. Findings only — everything below is something the plan gets wrong, with proof.

  ## 1. Wrong assumptions about reuse

  **BLOCKER — `openai-compat.ts` cannot be "reused for the OpenAI surface." It is the wrong layer.** The plan (line 85) assumes it participates in redirecting spawned CLIs. It does not spawn anything: it is an in-process transcript-replay runtime for Murage itself talking to OpenRouter/Groq (`server/drivers/openai-compat.ts:1-4`, `126` — `createOpenAIChatRuntime({...})`). There is no spawn env to inject. The actual OpenAI-surface mechanism for spawned CLIs is `applyOpenAIInject` in `server/drivers/local-inject.ts:393`. The plan conflating these two means item 4's "reuse" instruction will send the implementer to a file with nothing to reuse. Worse, the plan never notices the corollary: because `openai-compat` is config-driven (`url`, `apiKeyEnv` — `openai-compat.ts:32-49`), **Flux-as-Murage-native-driver is achievable today with zero code** (`OPENAI_COMPAT_URL=https://api.fluxrouter.ai/v1` + key), and a ~15-line dedicated Flux driver on `createOpenAIChatRuntime` would cover the entire non-CLI path. The 233-line port is only needed for CLI backends; the plan budgets it as the whole job.

  **BLOCKER — the qwen OpenAI-surface row is false in this repo.** Plan line 47 carries Wayland's claim that `OPENAI_BASE_URL` + `OPENAI_MODEL=flux-auto` is enough for qwen. Murage's qwen driver never reads those vars: it routes by writing a `modelProviders.openai[]` row into `~/.qwen/settings.json` and passing `-m <model>` (`server/drivers/acp/qwen.ts:22-81`, `106`). Wayland's own reference admits config beats env for qwen (`fluxRouting.ts:30-33` — "a CLI whose own config already pins an openai baseUrl/provider may let the config win"). Murage *guarantees* that pinned config exists — its own inject wrote it. An env-only Flux surface for qwen will be silently defeated by Murage's own settings.json rows. Fix: Flux for qwen goes through the existing `ensureQwenInjectModel` path with a `flux` host entry, not through `OPENAI_*` env.

  **MAJOR — `applyClaudeInject` reuse is broken for Flux's Anthropic surface as-is.** It derives the base via `anthropicBaseUrl()`, which strips a trailing `/v1` (`local-inject.ts:108-111`). Applied to `https://api.fluxrouter.ai/v1` that yields `https://api.fluxrouter.ai`, but the plan's own verified contract (line 26) says the Anthropic surface is `https://api.fluxrouter.ai/anthropic`. Direct reuse points claude at the wrong origin. Fix: `LocalHost` needs an optional `anthropicBaseUrl` override.

  **MINOR — the path cited doesn't exist.** Plan line 85 says `src/../local-inject.ts`; the file is `server/drivers/local-inject.ts`. Trivial, but it confirms the reuse claim was written without opening the file.

  ## 2. Missing work

  **MAJOR — the roster doesn't match. The plan ports Wayland's backend membership; Murage's engine set is different.** There is no goose driver here (the `GOOSE_PROVIDER` env in `BACKEND_FLUX_ENV` routes nothing), and Murage has drivers Wayland never classified: `gemini`, `grok`, `kimi`, `cursor`, `opencode-go`, `droid`, `antigravity`, `pi`, `minimax`, plus the proxied ones (`server/drivers/` listing). The plan's "not routable, by design" table (lines 52-53) names auggie/copilot/kiro/vibe/qoder — none of which exist here — while saying nothing about kimi, cursor, gemini, or grok, which do. Item 4's "backend membership sets" must be rebuilt from Murage's driver directory, not ported.

  **MAJOR — the plan misses that Murage already has a universal injection architecture that does 80% of the work.** `mergeLocalInject` is already called by claude, codex, kimi, grok, qwen, hermes, droid, opencode-go, antigravity, and pi (e.g. `claude.ts:536`, `codex-catalog.ts:365`, `acp/grok.ts:188`). One `flux` entry in `LOCAL_HOSTS` (`local-inject.ts:19-27`) with `apiKeyEnv: "FLUX_API_KEY"` surfaces Flux models in nearly every engine's picker for free, with key-gating (no key → probe 401s → no rows). The plan's items 3 and 4 are written as if this mechanism doesn't exist. The missing work is the deltas: remote-host probing against a 1.2s loopback-tuned timeout (`timedJson`, `local-inject.ts:218-219`), the anthropic-base override above, and the tier hardcoding below.

  **MAJOR — the reference implementation hardcodes `flux-auto` on every surface; item 3 sells four selectable tiers.** `fluxRouting.ts` injects `FLUX_AUTO_MODEL` unconditionally (`fluxRouting.ts:51`, `216`, `228`). A literal port means a user who picks `flux-fast` per item 3 gets `flux-auto` on the wire with no indication. The plan's item 4 "port" and item 3 "four tiers" are in conflict, and neither flags it. Murage's own inject path (`host::model`) handles tiers correctly, which is another reason the port should be reshaped around local-inject rather than transcribed.

  **MAJOR — no integration-point analysis.** "Wire into the spawn path" (plan line 84) is a category error: there are at least four spawn paths with different hooks — ACP `transformEnv`/`applyTurnEnv`/`credentialEnv` (`acp/core.ts:101-109`, `207`, `317`), `claudeEnvironment` (`claude.ts:76-91`), codex's `childEnv` + argv (`codex.ts:100-114`, `158`), and the in-process drivers that need none. The plan never maps resolveFluxRouting onto these. This is the actual adaptation work and it's unlisted.

  **MINOR — env-var parity for the key.** Every other Murage secret has an env boot path (`config.ts:487`, `506`: `MURAGE_OPENAI_IMAGE_KEY` → `cfg.imageGen.key`). Item 1 adds only the settings-panel route. Add `FLUX_API_KEY` → `cfg.flux.apiKey` the same way.

  ## 3. Sequencing errors

  The claim "1–3 independent, 4 depends on 1" is wrong in both directions:

  - **Item 2 depends on 1** (minor): "when a Flux key is present" requires item 1's `flux.apiKey` config to exist before `avatar-image.ts` can branch on it.
  - **Item 3 depends on 1** (minor): "only surface them when a Flux key exists" — same.
  - **Item 4 depends on 3, not just 1** (major): item 4's own Done-when is "an Ember set to Flux spawns with the correct surface" — an Ember is "set to Flux" via the picker/catalog work that is item 3. And the precedence logic being ported takes `selectedModelId` from that catalog. 4 cannot be verified, arguably cannot be designed, before 3.
  - **Item 5 depends on 3 and 4**, not "1 and 4" — the toggle's disabled-state copy for non-routable engines presupposes the roster classification that currently has no work item at all.

  Net: nothing is genuinely parallel; 1 is a prerequisite for 2 and 3 as specified, and the real critical path is 1 → 3 → 4 → 5.

  ## 4. Safety gaps beyond native-key stripping

  - **MAJOR — ambient routing vars are not stripped anywhere in Murage, and the plan doesn't add it.** `PROVIDER_CREDENTIAL_ENV` (`config.ts:560-573`) contains no `OPENAI_BASE_URL`, `OPENAI_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_MODEL`, and every spawn path spreads `...process.env` (`acp/core.ts:194`, `codex.ts:102`, `claude.ts:80`). A user with cc-switch or an ambient `OPENAI_BASE_URL` defeats or corrupts the Flux surface. Wayland strips exactly these (`fluxRouting.ts:104-107`, `231`); the plan's "native-key stripping" bullet (line 83) only names keys. Note also the plan's own example strip list (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, line 56) — **neither is in Murage's `PROVIDER_CREDENTIAL_ENV` at all**, so the ported strip list must be rebuilt from `config.ts`, not from Wayland's `KeyDiscovery`.
  - **MAJOR — the key lands on disk with no rollback.** The natural Murage integration (qwen/hermes inject) writes the Flux key into `~/.qwen/settings.json` (`qwen.ts:49,74`) and `~/.hermes/config.yaml` (`hermes.ts:44-55,91-92`) as plaintext upserts that are never removed. Wayland's whole design was R13-safe env-only injection precisely to avoid this; the plan carries that doctrine in prose (line 52's "backup, write, report, rollback") but its Murage-side mechanism violates it silently, including after the user disables Flux.
  - **MAJOR — hook-ordering trap the plan doesn't warn about.** Item 1 puts `FLUX_API_KEY` in `WORKSPACE_CREDENTIAL_ENV`, so `childEnv` deletes it (`acp/core.ts:204`, `codex.ts:112`). Injection must happen in `transformEnv`/`applyTurnEnv` (which run *after* the strip) or via the `MURAGE_LOCAL_*` env-key indirection `codexLocalProviderArgs` already uses (`local-inject.ts:138-139`). A naive "set env before spawn" port of fluxRouting will be silently stripped and 401. This also resolves the plan's internal contradiction: item 1's Done-when ("no spawned agent sees it") vs codex needing the key at request time — the indirection satisfies both, but the plan never says so.
  - **MINOR — redaction is fine, no action.** `redact.ts:16` matches any name containing `api_key`, so `FLUX_API_KEY` is covered in native logs.

  ## 5. The codex path

  Deferring breaks one concrete thing and is justified by a false premise.

  - **MAJOR — the premise is wrong here.** "Codex is the hardest path, needs filesystem work (scoped CODEX_HOME)" is Wayland-shaped. Murace's codex driver already solves the provider-table problem with argv: `codexLocalProviderArgs` emits `-c model_providers.<host>.base_url/env_key` with the secret riding the child env (`local-inject.ts:130-148`), called at `codex.ts:158`. No CODEX_HOME, no config.toml writes. In Murage, codex is arguably the *easiest* surface after the openai one. The risk register mis-prioritizes the whole schedule.
  - **MAJOR — deferral + item 3 ships a broken picker state.** Item 3 puts flux tiers in the picker; codex's catalog merge (`codex-catalog.ts:365,431`) would surface them. With codex routing deferred, a pick of `flux-auto` on codex falls through native and the CLI POSTs `model=flux-auto` to api.openai.com → 400 "model does not exist" — the exact failure Wayland's `resolvedModelId` guard exists to prevent (`fluxRouting.ts:114-126`). If codex slips, item 3 must gate flux rows per-engine on implemented surfaces, and the plan says nothing about that gating.
  - **MINOR — acceptance criteria contradict the risk.** Item 4's Done-when requires "a real turn completes against flux-auto on claude, qwen **and codex**" (line 86); risk 1 says ship without codex. Pick one.

  The one thing deferring does *not* break: correctness of the fallback — an unimplemented surface resolving `unknown`/native with an honest badge is the right default, and Murage's per-driver architecture makes that natural.

To resume this session: kimi -r session_4d04f56f-49ae-4374-85a3-ae4ac8133496
