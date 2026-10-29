import { cloudEngineHome, cloudTurnRender, cloudTurnScratch } from "./cloud-home/turn-process.ts";
import { cloudRouteUrl } from "./cloud-home/engine-render.ts";
import { cloudHomeCopy } from "./cloud-home/copy.ts";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DATA_DIR, deleteEnvNames } from "./config.ts";
import type { ProviderPreset, ProviderProtocol } from "../shared/provider-connections.ts";
import { providerEngineProtocol } from "../shared/provider-engine.ts";
import { writeFileAtomic } from "./atomic.ts";
import { keepFuigoTurnLogs } from "./fuigo-turn-logs.ts";
import { copyFuigoOrgPolicy, fuigoHomePermission, fuigoMemoryAllowPatterns } from "./drivers/acp/fuigo-permission.ts";
import { MURAGE_FUIGO_ROUTED_HOME, realFuigoHome, setFuigoAuthPath } from "./drivers/acp/fuigo-scope.ts";
import { MURAGE_GROK_OWNER_HOME, realGrokHome } from "./drivers/acp/grok-scope.ts";
import { readTomlTables } from "./drivers/acp/toml-scan.ts";
import { z } from "zod";
/** Server-only, resolved from encrypted custody at admission. */
export interface ProviderTurnRoute { connectionId: string; preset: ProviderPreset; protocol: ProviderProtocol; baseUrl: string; apiKey: string; model: string; revision: string }
export interface ProviderRouteBinding { model: string; args: string[]; modelProvider?: string; identity?: string; cleanup: () => void;
  /** Keep this turn's engine logs (never auth or session files) when the turn failed or retried. */
  keepLogs: (turnId: string) => void }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const grokThread = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
function directory(path: string, privateMode = true) {
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (privateMode && process.platform !== "win32" && (s.mode & (process.env.MURAGE_CLOUD_ROLE === "home" ? 0o007 : 0o077)) !== 0)) throw new Error("Grok provider directory ownership needs review");
}
function privateText(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Grok provider state is unreadable; original data preserved"); }
  try {
    const stat = fstatSync(fd), link = lstatSync(path);
    if (!stat.isFile() || link.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024 || (process.platform !== "win32" && (stat.mode & (process.env.MURAGE_CLOUD_ROLE === "home" ? 0o007 : 0o077)) !== 0)) throw new Error("Grok provider state ownership needs review");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function ownedDirectory(path: string, owner: object) {
  let created = false;
  try { mkdirSync(path, { mode: 0o700 }); created = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  directory(path);
  const marker = join(path, ".murage-owner.json"), expected = JSON.stringify(owner);
  if (created) writeFileAtomic(marker, expected, { mode: 0o600 });
  if (privateText(marker) !== expected) throw new Error("Grok provider ownership marker mismatch; original data preserved");
}
function grokThreadRoot(threadId: string): string {
  // Grok keeps its native session home beside server receipts; until those
  // are split, a home must not create either inside the engine home.
  if (process.env.MURAGE_CLOUD_ROLE === "home") throw new Error(cloudHomeCopy.grokRouteOnHome);
  grokThread.parse(threadId);
  const base = process.env.MURAGE_CLOUD_ROLE === "home" ? cloudEngineHome("grokAgent") : DATA_DIR;
  directory(base, false); directory(join(base, "native"), false);
  const root = join(base, "native", "grok-provider-context");
  ownedDirectory(root, { version: 1, kind: "murage-grok-provider-context" });
  const thread = join(root, hash(threadId));
  ownedDirectory(thread, { version: 1, kind: "murage-grok-thread", threadId });
  return thread;
}
export function grokProviderIdentity(route: ProviderTurnRoute, threadId: string): string {
  return hash(JSON.stringify([threadId, route.connectionId, route.revision, route.baseUrl.replace(/\/+$/, ""), route.protocol, route.model]));
}
const grokReceiptSchema = z.object({ version: z.literal(1), identity: z.string().regex(/^[a-f0-9]{64}$/).nullable(), sessionId: z.string().min(1).max(1000) }).strict();
/** Native IDs stay native in RuntimeEvent and memory bookkeeping. This private
 * receipt determines which home, if any, is allowed to load one. */
export function grokResumeBinding(threadId: string, identity: string | null, rawCursor: unknown) {
  const root = grokThreadRoot(threadId), file = join(root, "resume-binding.json"), text = privateText(file);
  let saved: z.infer<typeof grokReceiptSchema> | null = null;
  if (text !== null) { const parsed = grokReceiptSchema.safeParse(JSON.parse(text)); if (!parsed.success) throw new Error("Grok resume binding needs review"); saved = parsed.data; }
  const requested = typeof rawCursor === "string" && rawCursor.length > 0 ? rawCursor : null;
  // A pre-existing native cursor remains supported when no routed binding has
  // ever been recorded here. Routed homes require an exact retained receipt.
  const cursor = requested && ((!saved && identity === null) || (saved?.identity === identity && saved.sessionId === requested)) ? requested : null;
  return { cursor, replay: Boolean(requested && !cursor), record(sessionId: string) {
    const receipt = grokReceiptSchema.parse({ version: 1, identity, sessionId });
    privateText(file); writeFileAtomic(file, JSON.stringify(receipt), { mode: 0o600 });
  } };
}
/** Explicit maintenance only, after confirmed child closure. Never invoked on
 * normal turn completion: Grok sessions live in the retained home. */
export function removeGrokProviderHome(threadId: string, identity: string, closeConfirmed: boolean): void {
  if (!closeConfirmed || !/^[a-f0-9]{64}$/.test(identity)) throw new Error("Confirm Grok child closure before removing retained state");
  const home = join(grokThreadRoot(threadId), identity);
  const owner = { version: 1, kind: "murage-grok-provider-home", threadId, identity };
  directory(home); if (privateText(join(home, ".murage-owner.json")) !== JSON.stringify(owner)) throw new Error("Grok provider ownership marker mismatch");
  rmSync(home, { recursive: true, force: false });
}
/** Model-provider credentials Hermes can fall back to (hermes-agent's provider registry). */
const HERMES_OTHER_PROVIDER_KEYS = ["AI_GATEWAY_API_KEY", "ALIBABA_CODING_PLAN_API_KEY", "ARCEEAI_API_KEY", "AZURE_ANTHROPIC_KEY", "AZURE_FOUNDRY_API_KEY", "AZURE_OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "COMMANDCODE_API_KEY", "COPILOT_GITHUB_TOKEN", "CUSTOM_API_KEY", "DASHSCOPE_API_KEY", "DEEPINFRA_API_KEY", "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GLM_API_KEY", "GMI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY", "HERMES_CUSTOM_API_KEY", "HF_TOKEN", "KILOCODE_API_KEY", "KIMI_API_KEY", "KIMI_CN_API_KEY", "KIMI_CODING_API_KEY", "LM_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MISTRAL_API_KEY", "NOUS_API_KEY", "NOVITA_API_KEY", "NVIDIA_API_KEY", "OLLAMA_API_KEY", "OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "STEPFUN_API_KEY", "TOGETHER_API_KEY", "TOKENHUB_API_KEY", "UPSTAGE_API_KEY", "XIAOMI_API_KEY", "Z_AI_API_KEY", "ZAI_API_KEY"];
/** Fuigo's DNS egress guard (fuigo-extra-ca egress.rs) refuses these registrable
 * domains and every subdomain, and FUIGO_ALLOW_UPSTREAM_HOSTS=1 lifts it for the
 * whole process. */
export const FUIGO_ALLOW_UPSTREAM_ENV = "FUIGO_ALLOW_UPSTREAM_HOSTS";
const FUIGO_BLOCKED_DOMAINS = ["x.ai", "grok.com", "mixpanel.com"];
/** Whether Fuigo would refuse to resolve the endpoint's host. Label-boundary
 * match, the same rule as the guard, so `prefixx.ai` and `x.ai.evil.example` do not count. */
export function fuigoBlocksHost(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.replace(/\.$/, "").toLowerCase(); } catch { return false; }
  return FUIGO_BLOCKED_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
}
export function routedProviderId(route: ProviderTurnRoute): string { return `murage_${createHash("sha256").update(route.connectionId).digest("hex").slice(0, 16)}`; }
export function routeEndpoint(driver: string, route: ProviderTurnRoute): string {
  const base = route.baseUrl.replace(/\/+$/, "");
  if (driver === "fuigoAgent" && route.preset === "anthropic" && !base.endsWith("/v1")) return `${base}/v1`;
  return driver === "claudeAgent" ? route.preset === "flux" ? `${base.replace(/\/v1$/, "")}/anthropic` : base.replace(/\/v1$/, "") : base;
}
export function validateProviderTurnRoute(driver: string, route: ProviderTurnRoute): void {
  if (process.env.MURAGE_CLOUD_ROLE === "home" && driver === "claudeAgent") throw new Error(cloudHomeCopy.claudeFluxOnHome);
  if (!route.apiKey || !route.connectionId || !route.revision || !route.model || route.model.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9_./:@+-]*$/.test(route.model)) throw new Error("Selected provider connection is incomplete");
  if (!providerEngineProtocol(driver, route.preset, route.protocol)) throw new Error("This engine does not support the selected provider protocol");
  const url = new URL(route.baseUrl);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error("Selected provider endpoint is invalid");
}
export function applyProviderRoute(driver: string, env: NodeJS.ProcessEnv, route: ProviderTurnRoute, context?: { threadId: string; memoryTools?: boolean; nativeProfile?: string | null; /** Caller-owned private home (reflection temp root): used as the engine home instead of a retained or task-created one; the caller removes it. */ homeRoot?: string }): ProviderRouteBinding {
  validateProviderTurnRoute(driver, route);
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CODEX_API_KEY", "FUIGO_API_KEY", "FUIGO_CODE_API_KEY", "FLUX_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY"]) delete env[name];
  deleteEnvNames(env, [FUIGO_ALLOW_UPSTREAM_ENV]);
  let keepLogsFor = "";
  const result = { model: route.model, args: [] as string[], cleanup: () => {}, keepLogs: (_turnId: string) => {} };
  if (driver === "grokAgent") {
    if (!context) throw new Error("Grok provider routing requires an exact thread");
    const identity = grokProviderIdentity(route, grokThread.parse(context.threadId));
    const model = `murage_${identity.slice(0, 24)}`;
    const cloudGrok = process.env.MURAGE_CLOUD_ROLE === "home";
    let home: string;
    if (context.homeRoot && !cloudGrok) { home = resolve(context.homeRoot); directory(home); }
    else {
      home = join(grokThreadRoot(context.threadId), identity);
      ownedDirectory(home, { version: 1, kind: "murage-grok-provider-home", threadId: context.threadId, identity });
    }
    const file = join(home, "config.toml");
    const text = `[models]\ndefault = "${model}"\nweb_search = "${model}"\nsession_summary = "${model}"\nallowed_models = ["${model}"]\n[model.${model}]\nmodel = ${JSON.stringify(route.model)}\nbase_url = ${JSON.stringify(routeEndpoint(driver, route))}\nenv_key = "MURAGE_GROK_PROVIDER_API_KEY"\napi_backend = "chat_completions"\n`;
    // Unreachable on a home (grokThreadRoot refuses there); the launcher renders no Grok route.
    if (cloudGrok) throw new Error(cloudHomeCopy.grokRouteOnHome);
    privateText(file); writeFileAtomic(file, text, { mode: 0o600 });
    for (const key of ["GROK_CODE_XAI_API_KEY", "GROK_API_KEY", "GROK_API_BASE_URL", "GROK_MODELS_LIST_URL", "GROK_WEB_SEARCH_MODEL"]) delete env[key];
    // The selected endpoint also owns discovery. The documented discovery
    // credential is XAI_API_KEY, populated only with this authorised route key.
    // The owner's own grok home, named before GROK_HOME moves to the provider home: the bot's scope carries its denies.
    if (!context.homeRoot) env[MURAGE_GROK_OWNER_HOME] = realGrokHome(env);
    Object.assign(env, { GROK_HOME: home, GROK_MODELS_BASE_URL: routeEndpoint(driver, route), GROK_SESSION_SUMMARY_MODEL: model, XAI_API_KEY: route.apiKey, MURAGE_GROK_PROVIDER_API_KEY: route.apiKey });
    // A plan sign-in route's key is a local gateway key: keep Grok Build's
    // own xAI API probe on the gateway too, so the key never leaves this computer.
    if (route.baseUrl.includes("/api/model-gateway/")) env.GROK_XAI_API_BASE_URL = routeEndpoint(driver, route);
    return { ...result, model, identity };
  }
  if (driver === "claudeAgent") {
    Object.assign(env, { ANTHROPIC_BASE_URL: routeEndpoint(driver, route), ANTHROPIC_API_KEY: route.apiKey, ANTHROPIC_AUTH_TOKEN: route.apiKey, ANTHROPIC_MODEL: route.model }); return result;
  }
  if (driver === "codex") {
    const provider = routedProviderId(route); env.MURAGE_PROVIDER_API_KEY = route.apiKey;
    // Cloud home: the launcher renders this provider table into config.toml from the typed
    // route and refuses `-c model_providers.*` on argv (CLOUD-ENGINES-DESIGN.md 2.2, 4.1).
    if (process.env.MURAGE_CLOUD_ROLE === "home") {
      cloudTurnRender(env, "route", { provider, baseUrl: cloudRouteUrl(route.baseUrl), model: route.model, apiKey: route.apiKey, label: "Selected provider" });
      return { ...result, modelProvider: provider };
    }
    return { ...result, modelProvider: provider, args: ["-c", `model_providers.${provider}.name=${JSON.stringify("Selected provider")}`, "-c", `model_providers.${provider}.base_url=${JSON.stringify(route.baseUrl)}`, "-c", `model_providers.${provider}.wire_api="responses"`, "-c", `model_providers.${provider}.env_key="MURAGE_PROVIDER_API_KEY"`] };
  }
  if (driver === "hermesAgent" || driver === "fuigoAgent") {
    // A pinned Hermes profile keeps its persona, skills and sign-ins in its
    // own home, which this route replaces. HERMES_PROFILE was the old key
    // here, but Hermes never reads it to pick a home (hermes-profiles.ts).
    if (driver === "hermesAgent" && process.env.MURAGE_CLOUD_ROLE === "home") throw new Error(cloudHomeCopy.hermesOnHome);
    if (driver === "hermesAgent" && context?.nativeProfile) throw new Error(`This bot runs the Hermes profile "${context.nativeProfile}", which uses its own models. Choose one of that profile's models instead of a model connection.`);
    const cloud = process.env.MURAGE_CLOUD_ROLE === "home";
    let home: string;
    if (cloud) {
      // The server uid may not touch the engine home: the launcher mounts a
      // fresh tmpfs here inside the turn namespace, so nothing is created or
      // cleaned up on disk. (A caller-owned homeRoot is a server-side path the
      // turn namespace cannot see, so it is not used here.)
      const relative = `native/provider-turns/${driver}-${randomBytes(12).toString("hex")}`;
      home = join(cloudEngineHome(driver), relative);
      cloudTurnScratch(env, relative);
    } else if (context?.homeRoot && driver === "fuigoAgent") { home = resolve(context.homeRoot); mkdirSync(home, { recursive: true, mode: 0o700 }); }
    else {
      const parent = join(DATA_DIR, "native", "provider-turns"); mkdirSync(parent, { recursive: true, mode: 0o700 });
      home = mkdtempSync(join(parent, `${driver}-`));
      result.cleanup = () => {
        if (keepLogsFor) keepFuigoTurnLogs(home, keepLogsFor, join(DATA_DIR, "native", "fuigo-turn-logs"));
        rmSync(home, { recursive: true, force: true });
      };
      result.keepLogs = (turnId: string) => { if (driver === "fuigoAgent" && turnId) keepLogsFor = turnId; };
    }
    if (driver === "hermesAgent") {
      // Hermes side tasks (titles, compression, vision) fall back across any
      // provider they can find on a rate limit or payment error, even an
      // explicit one (agent/auxiliary_client.py). A routed turn must never
      // switch provider, so nothing else is left to find: no other provider
      // key in the environment and no Codex CLI login to import.
      for (const name of HERMES_OTHER_PROVIDER_KEYS) delete env[name];
      env.CODEX_HOME = join(home, "no-codex-login");
      env.HERMES_HOME = home;
      // explicit, so the driver passes `-p default` for this home only
      env.MURAGE_HERMES_ROUTED_HOME = resolve(home);
      const config = `model:\n  default: ${JSON.stringify(route.model)}\n  provider: custom\n  base_url: ${JSON.stringify(route.baseUrl)}\n  api_mode: chat_completions\n  api_key: ${JSON.stringify(route.apiKey)}\nproviders: {}\n`;
      writeFileSync(join(home, "config.yaml"), config, { mode: 0o600 });
    } else {
      const name = routedProviderId(route), protocol = { openai: "chat_completions", anthropic: "messages", responses: "responses" }[route.protocol];
      // The owner's own Fuigo home, read before this turn's home replaces it: its denies, deployment key, organisation
      // policy and login reach the routed home too (FUIGO-SCOPE-1010 V2, H2, H3). Never written.
      // A reflection temp home (caller-owned homeRoot) is outside this: it runs text-only with no tools and pins its
      // own [plugins]/[skills] lines (pip-transport.ts pinReflectionFuigoConfig), so the owner's home is never read.
      const reflection = Boolean(context?.homeRoot);
      const ownerHome = realFuigoHome(env);
      let ownerConfig = "";
      if (!cloud && !reflection) { try { ownerConfig = readFileSync(join(ownerHome, "config.toml"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Fuigo's settings file could not be read, so the turn did not start. Fix or remove the file, then try again.", { cause: error }); } }
      env.FUIGO_HOME = home; env.MURAGE_PROVIDER_API_KEY = route.apiKey;
      // This home is Murage's own and already carries the bot's rules: the scope step leaves it as it is.
      if (!reflection) env[MURAGE_FUIGO_ROUTED_HOME] = home;
      env.FUIGO_API_BASE_URL = routeEndpoint(driver, route);
      env.FUIGO_MODELS_BASE_URL = routeEndpoint(driver, route);
      // A key route pointed straight at xAI (api.x.ai) is refused by Fuigo's
      // egress guard unless it is lifted. Lift it only for that choice: Flux
      // Router, other providers and the loopback plan gateway never need it.
      // Still required on Fuigo 1.0.22 (captured 2026-10-07, published
      // linux-x64 binary, stub TLS endpoint): its P192 fix covers only
      // SUBSCRIPTION models (exact vendor endpoint, no key), which reach
      // api.x.ai / chatgpt.com without this. This route always carries an
      // env_key, and without the lift 1.0.22 answers "refuses to contact
      // upstream vendor host" before any request leaves. Murage never writes a
      // subscription model here, so no subscription turn ever gets the lift.
      if (fuigoBlocksHost(routeEndpoint(driver, route))) env[FUIGO_ALLOW_UPSTREAM_ENV] = "1";
      const fuigoConfig = `[cli]\nuse_leader = false\n[models]\ndefault = "murage_selected"\nsession_summary = "murage_selected"\nprompt_suggestion = "murage_selected"\nweb_search = "murage_selected"\nimage_description = "murage_selected"\nallowed_models = ["murage_selected"]\n[model_providers.${name}]\nbase_url = ${JSON.stringify(routeEndpoint(driver, route))}\nenv_key = "MURAGE_PROVIDER_API_KEY"\napi_backend = "${protocol}"\nauth_scheme = "${route.protocol === "anthropic" ? "x_api_key" : "bearer"}"\n[model.murage_selected]\nmodel = ${JSON.stringify(route.model)}\nmodel_provider = "${name}"\n`;
      result.model = "murage_selected";
      if (!cloud && reflection) writeFileSync(join(home, "config.toml"), fuigoConfig, { mode: 0o600 });
      else if (!cloud) {
        // An owner's deployment key keeps their organisation's policy served to this home (managed_config store.rs).
        let deploymentKey: string | undefined;
        try { const key = readTomlTables(ownerConfig).tables.get("endpoints")?.[0]?.deployment_key; if (typeof key === "string") deploymentKey = key; } catch { /* unreadable: none carried */ }
        // The ONE permission renderer (fuigo-permission.ts): the bot's ask rules, the owner's denies and, for a memory
        // turn, the memory tools by their registered ids (never display titles). This config belongs solely to the
        // task-created routed FUIGO_HOME.
        const permission = fuigoHomePermission(ownerConfig, context?.memoryTools ? fuigoMemoryAllowPatterns() : undefined);
        writeFileSync(join(home, "config.toml"), `${fuigoConfig}[plugins]\nauto_discover = false\n${deploymentKey ? `[endpoints]\ndeployment_key = ${JSON.stringify(deploymentKey)}\n` : ""}\n${permission}`, { mode: 0o600 });
        copyFuigoOrgPolicy(ownerHome, home);
        // The route's model key is named by env_key, which outranks a session token, so the owner's login only
        // serves the organisation principal check here (agent/config.rs resolve_credentials).
        setFuigoAuthPath(env, ownerHome, true);
      }
      // Cloud home: the launcher renders $FUIGO_HOME/config.toml (this text plus its pins)
      // from the typed route; the server never sends the file (CLOUD-ENGINES-DESIGN.md 2.2).
      if (cloud) {
        cloudTurnRender(env, "route", { provider: name, baseUrl: cloudRouteUrl(routeEndpoint(driver, route)), model: route.model, apiKey: route.apiKey, protocol: route.protocol });
        if (context?.memoryTools) cloudTurnRender(env, "memoryTools", true);
      }
    }
    return result;
  }
  Object.assign(env, { OPENAI_BASE_URL: route.baseUrl, OPENAI_API_KEY: route.apiKey, OPENAI_MODEL: route.model }); return result;
}
