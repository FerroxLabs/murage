import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import type { ProviderPreset, ProviderProtocol } from "../shared/provider-connections.ts";
import { providerEngineProtocol } from "../shared/provider-engine.ts";
/** Server-only, resolved from encrypted custody at admission. */
export interface ProviderTurnRoute { connectionId: string; preset: ProviderPreset; protocol: ProviderProtocol; baseUrl: string; apiKey: string; model: string; revision: string }
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
export function applyProviderRoute(driver: string, env: NodeJS.ProcessEnv, route: ProviderTurnRoute): { model: string; args: string[]; modelProvider?: string; cleanup: () => void } {
  validateProviderTurnRoute(driver, route);
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CODEX_API_KEY", "FUIGO_API_KEY", "FUIGO_CODE_API_KEY", "FLUX_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY"]) delete env[name];
  const result = { model: route.model, args: [] as string[], cleanup: () => {} };
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
