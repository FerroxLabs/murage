import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import type { ProviderPreset, ProviderProtocol } from "../shared/provider-connections.ts";
import { providerEngineProtocol } from "../shared/provider-engine.ts";
import { writeFileAtomic } from "./atomic.ts";
import { z } from "zod";
/** Server-only, resolved from encrypted custody at admission. */
export interface ProviderTurnRoute { connectionId: string; preset: ProviderPreset; protocol: ProviderProtocol; baseUrl: string; apiKey: string; model: string; revision: string }
export interface ProviderRouteBinding { model: string; args: string[]; modelProvider?: string; identity?: string; cleanup: () => void }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const grokThread = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
function directory(path: string, privateMode = true) {
  try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (privateMode && process.platform !== "win32" && (s.mode & 0o077) !== 0)) throw new Error("Grok provider directory ownership needs review");
}
function privateText(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Grok provider state is unreadable; original data preserved"); }
  try {
    const stat = fstatSync(fd), link = lstatSync(path);
    if (!stat.isFile() || link.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128 * 1024 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Grok provider state ownership needs review");
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
  grokThread.parse(threadId);
  directory(DATA_DIR, false); directory(join(DATA_DIR, "native"), false);
  const root = join(DATA_DIR, "native", "grok-provider-context");
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
export function routedProviderId(route: ProviderTurnRoute): string { return `murage_${createHash("sha256").update(route.connectionId).digest("hex").slice(0, 16)}`; }
export function routeEndpoint(driver: string, route: ProviderTurnRoute): string {
  const base = route.baseUrl.replace(/\/+$/, "");
  if (driver === "fuigoAgent" && route.preset === "anthropic" && !base.endsWith("/v1")) return `${base}/v1`;
  return driver === "claudeAgent" ? route.preset === "flux" ? `${base.replace(/\/v1$/, "")}/anthropic` : base.replace(/\/v1$/, "") : base;
}
export function validateProviderTurnRoute(driver: string, route: ProviderTurnRoute): void {
  if (!route.apiKey || !route.connectionId || !route.revision || !route.model || route.model.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9_./:@+-]*$/.test(route.model)) throw new Error("Selected provider connection is incomplete");
  if (!providerEngineProtocol(driver, route.preset, route.protocol)) throw new Error("This engine does not support the selected provider protocol");
  const url = new URL(route.baseUrl);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error("Selected provider endpoint is invalid");
}
export function applyProviderRoute(driver: string, env: NodeJS.ProcessEnv, route: ProviderTurnRoute, context?: { threadId: string }): ProviderRouteBinding {
  validateProviderTurnRoute(driver, route);
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CODEX_API_KEY", "FUIGO_API_KEY", "FUIGO_CODE_API_KEY", "FLUX_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY"]) delete env[name];
  const result = { model: route.model, args: [] as string[], cleanup: () => {} };
  if (driver === "grokAgent") {
    if (!context) throw new Error("Grok provider routing requires an exact thread");
    const identity = grokProviderIdentity(route, grokThread.parse(context.threadId));
    const home = join(grokThreadRoot(context.threadId), identity), model = `murage_${identity.slice(0, 24)}`;
    ownedDirectory(home, { version: 1, kind: "murage-grok-provider-home", threadId: context.threadId, identity });
    const file = join(home, "config.toml"); privateText(file);
    writeFileAtomic(file, `[models]\ndefault = "${model}"\nweb_search = "${model}"\nsession_summary = "${model}"\nallowed_models = ["${model}"]\n[model.${model}]\nmodel = ${JSON.stringify(route.model)}\nbase_url = ${JSON.stringify(routeEndpoint(driver, route))}\nenv_key = "MURAGE_GROK_PROVIDER_API_KEY"\napi_backend = "chat_completions"\n`, { mode: 0o600 });
    for (const key of ["GROK_CODE_XAI_API_KEY", "GROK_API_KEY", "GROK_API_BASE_URL", "GROK_MODELS_LIST_URL", "GROK_WEB_SEARCH_MODEL"]) delete env[key];
    // The selected endpoint also owns discovery. The documented discovery
    // credential is XAI_API_KEY, populated only with this authorised route key.
    Object.assign(env, { GROK_HOME: home, GROK_MODELS_BASE_URL: routeEndpoint(driver, route), GROK_SESSION_SUMMARY_MODEL: model, XAI_API_KEY: route.apiKey, MURAGE_GROK_PROVIDER_API_KEY: route.apiKey });
    return { ...result, model, identity };
  }
  if (driver === "claudeAgent") {
    Object.assign(env, { ANTHROPIC_BASE_URL: routeEndpoint(driver, route), ANTHROPIC_API_KEY: route.apiKey, ANTHROPIC_AUTH_TOKEN: route.apiKey, ANTHROPIC_MODEL: route.model }); return result;
  }
  if (driver === "codex") {
    const provider = routedProviderId(route); env.MURAGE_PROVIDER_API_KEY = route.apiKey;
    return { ...result, modelProvider: provider, args: ["-c", `model_providers.${provider}.name=${JSON.stringify("Selected provider")}`, "-c", `model_providers.${provider}.base_url=${JSON.stringify(route.baseUrl)}`, "-c", `model_providers.${provider}.wire_api="responses"`, "-c", `model_providers.${provider}.env_key="MURAGE_PROVIDER_API_KEY"`] };
  }
  if (driver === "hermesAgent" || driver === "fuigoAgent") {
    if (driver === "hermesAgent" && env.HERMES_PROFILE) throw new Error("Choose a native Hermes profile or a provider connection; both cannot own the same turn");
    const parent = join(DATA_DIR, "native", "provider-turns"); mkdirSync(parent, { recursive: true, mode: 0o700 });
    const home = mkdtempSync(join(parent, `${driver}-`));
    result.cleanup = () => rmSync(home, { recursive: true, force: true });
    if (driver === "hermesAgent") {
      env.HERMES_HOME = home;
      writeFileSync(join(home, "config.yaml"), `model:\n  default: ${JSON.stringify(route.model)}\n  provider: custom\n  base_url: ${JSON.stringify(route.baseUrl)}\n  api_mode: chat_completions\n  api_key: ${JSON.stringify(route.apiKey)}\nproviders: {}\n`, { mode: 0o600 });
    } else {
      const name = routedProviderId(route), protocol = { openai: "chat_completions", anthropic: "messages", responses: "responses" }[route.protocol];
      env.FUIGO_HOME = home; env.MURAGE_PROVIDER_API_KEY = route.apiKey;
      env.FUIGO_API_BASE_URL = routeEndpoint(driver, route);
      env.FUIGO_MODELS_BASE_URL = routeEndpoint(driver, route);
      writeFileSync(join(home, "config.toml"), `[cli]\nuse_leader = false\n[models]\ndefault = "murage_selected"\nsession_summary = "murage_selected"\nprompt_suggestion = "murage_selected"\nweb_search = "murage_selected"\nimage_description = "murage_selected"\nallowed_models = ["murage_selected"]\n[model_providers.${name}]\nbase_url = ${JSON.stringify(routeEndpoint(driver, route))}\nenv_key = "MURAGE_PROVIDER_API_KEY"\napi_backend = "${protocol}"\nauth_scheme = "${route.protocol === "anthropic" ? "x_api_key" : "bearer"}"\n[model.murage_selected]\nmodel = ${JSON.stringify(route.model)}\nmodel_provider = "${name}"\n`, { mode: 0o600 });
      result.model = "murage_selected";
    }
    return result;
  }
  Object.assign(env, { OPENAI_BASE_URL: route.baseUrl, OPENAI_API_KEY: route.apiKey, OPENAI_MODEL: route.model }); return result;
}
