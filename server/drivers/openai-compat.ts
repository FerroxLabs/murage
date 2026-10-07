// Transcript-replay driver for OpenRouter, Groq, Together, llama.cpp, and
// other endpoints that speak the OpenAI chat-completions contract.
import { assertProviderKey, keyIssuer } from "../../electron/provider-connections.mjs";
import { endpointProvider } from "./endpoint-provider.ts";
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { requestMemoryExtraction, requestMemoryInference, requestMemoryGrounding } from "../memory/extract.ts";
import { classifyLocalHostname } from "../../shared/local-models.ts";
import { decodeInjectId, hostApiKey, localHost, mergeLocalInject } from "./local-inject.ts";

const DRIVER_KIND = "openai-compat";
const DEFAULT_MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)", custom: true },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)", custom: true },
  ],
};

export interface OpenAICompatConfig {
  url: string;
  apiKeyEnv: string;
  key?: string;
  model?: string;
  provider?: string;
}

const LOOPBACK_PLACEHOLDER_KEY = "local";

/** http(s) on 127.0.0.0/8, ::1 or localhost — never a LAN or public host. */
function isLoopbackEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && classifyLocalHostname(parsed.hostname) === "loopback";
  } catch {
    return false;
  }
}

function isOpenRouterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

function decodeConfig(raw: unknown): OpenAICompatConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  const envUrl = process.env.OPENAI_COMPAT_URL;
  return {
    url: (typeof config.url === "string" && config.url ? config.url : envUrl || "https://openrouter.ai/api/v1")
      .replace(/\/+$/, ""),
    apiKeyEnv: typeof config.apiKeyEnv === "string" && config.apiKeyEnv
      ? config.apiKeyEnv
      : "OPENAI_COMPAT_API_KEY",
    key: typeof config.key === "string" && config.key ? config.key : undefined,
    model: typeof config.model === "string" && config.model
      ? config.model
      : process.env.OPENAI_COMPAT_MODEL || undefined,
    provider: typeof config.provider === "string" && config.provider
      ? config.provider
      : process.env.OPENAI_COMPAT_PROVIDER || undefined,
  };
}

export const OpenAICompatDriver: ProviderDriver<OpenAICompatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenAI-compatible (OpenRouter / Groq)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: DEFAULT_MODELS,
  // No installer and no terminal sign-in: this engine only needs a key, which
  // is pasted in App Settings → Models. The setup card falls back to the guide
  // link rather than asking anyone to edit a file by hand.
  install: {
    docsUrl: "https://openrouter.ai/keys",
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    // The workspace key (OPENAI_COMPAT_API_KEY) reaches an instance only
    // through instanceConfigs(), which withholds it from an instance that
    // brings its own URL, key or key variable (instanceOwnsRouting). So it is
    // never read from process.env here, where loadConfig() and
    // syncCredentialEnv() keep it too: that fallback sent the shared router
    // key to any instance's own host (upstream #2053/#2107). An instance that
    // names its own key variable reads only that variable.
    const ownKeyVariable = config.apiKeyEnv !== "OPENAI_COMPAT_API_KEY";
    let apiKey =
      config.key ??
      input.environment[config.apiKeyEnv] ??
      (ownKeyVariable ? process.env[config.apiKeyEnv] : undefined) ??
      "";
    let credentialMismatch = false;
    // Never send a key whose own prefix names another provider (Google's
    // included) to a named provider's endpoint. Repair requires an explicit
    // provider connection; never rewrite native config. Opaque keys and any
    // other server are left as configured.
    const endpoint = endpointProvider(config.url);
    if (endpoint && (keyIssuer(apiKey) || apiKey.trim().startsWith("sk-admin-"))) {
      try { assertProviderKey(endpoint, apiKey.trim()); }
      catch { credentialMismatch = true; apiKey = ""; }
    }
    // Spec E4: a server on this machine needs no key. The shared runtime
    // refuses an empty key, so a keyless loopback endpoint gets a harmless
    // placeholder instead of asking the user to invent one. LAN and remote
    // endpoints still need a real key.
    if (!apiKey && !credentialMismatch && isLoopbackEndpoint(config.url)) apiKey = LOOPBACK_PLACEHOLDER_KEY;
    let catalog: ModelCatalog = config.model
      ? {
          default: config.model,
          options: DEFAULT_MODELS.options.some((model) => model.id === config.model)
            ? DEFAULT_MODELS.options
            : [{ id: config.model, label: config.model, custom: true }, ...DEFAULT_MODELS.options],
        }
      : DEFAULT_MODELS;

    // Local models rows (spec E4): a server added in Settings → Models is
    // offered here as a chat-only model, whatever its tools test said —
    // this driver never sends tools, so a role-play model that failed the
    // test still chats. Kept apart from the endpoint's own catalog.
    let localOptions: ModelCatalog["options"] = [];
    const withLocal = (base: ModelCatalog): ModelCatalog => {
      const ids = new Set(base.options.map((option) => option.id));
      const extra = localOptions.filter((option) => !ids.has(option.id));
      if (!extra.length) return base;
      // With no key for the endpoint, a local model is the only one that can answer.
      return { default: apiKey ? base.default : extra[0].id, options: [...base.options, ...extra] };
    };
    const localEnv = { ...process.env, ...input.environment };
    // The catalog refresh is daily; a server added in Settings → Models should
    // show up the next time the picker asks, so reads re-probe at most every 30s.
    let localProbedAt = 0;
    const refreshLocal = async () => {
      localProbedAt = Date.now();
      try {
        localOptions = (await mergeLocalInject({ default: "", options: [] }, localEnv, fetch, { driver: DRIVER_KIND })).options;
      } catch {
        // Local discovery is opportunistic, like the catalog refresh below.
      }
    };
    const localEndpoint = (model: string) => {
      const inject = decodeInjectId(model);
      const host = inject ? localHost(inject.host) : undefined;
      if (!inject || !host) return null;
      // Ollama, LM Studio and llama.cpp accept any bearer; a server added with a key gets its own.
      return { baseUrl: host.baseUrl.replace(/\/+$/, ""), apiKey: hostApiKey(host, localEnv) || LOOPBACK_PLACEHOLDER_KEY, model: inject.model, label: host.label };
    };
    void refreshLocal();
    const currentModels = () => {
      if (Date.now() - localProbedAt > 30_000) void refreshLocal();
      return withLocal(catalog);
    };

    const fetchModels = async () => {
      await refreshLocal();
      if (!apiKey) return;
      try {
        const response = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return;
        const json = await response.json() as { data?: Array<{ id?: unknown; name?: unknown }> } | Array<{ id?: unknown; name?: unknown }>;
        const rows = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];
        const seen = new Set<string>();
        const options: ModelCatalog["options"] = [];
        for (const row of rows) {
          const id = typeof row.id === "string" ? row.id : "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          options.push({
            id,
            label: typeof row.name === "string" && row.name.trim() ? row.name : id,
            custom: true,
          });
        }
        if (!options.length) return;
        if (config.model && !options.some((model) => model.id === config.model)) {
          options.unshift({ id: config.model, label: config.model, custom: true });
        }
        catalog = { default: config.model ?? options[0].id, options };
      } catch {
        // Catalog refresh is opportunistic; keep the seeded options.
      }
    };
    if (apiKey) void fetchModels();

    const runtime=createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl: config.url,
      models: currentModels,
      refreshModels: fetchModels,
      localEndpoint,
      requestBody: (model, messages, stream) => ({
        model,
        messages,
        stream,
        // Several servers report token usage in a stream only on request;
        // OpenAI rejects stream_options on a request that does not stream.
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        ...(config.provider && isOpenRouterUrl(config.url)
          ? { provider: { order: [config.provider], allow_fallbacks: false } }
          : {}),
      }),
      httpErrorLabel: "upstream",
      jsonSchemaResponse: true,
      missingKeyError: credentialMismatch ? "The saved key does not match this endpoint's provider. Connect its provider in Models." : "This engine has no API key yet. Add one in App Settings → Models.",
      unavailableReason: credentialMismatch ? "The saved key does not match this endpoint's provider. Connect its provider in Models." : "No API key yet. Add one in App Settings → Models.",
      // No provider idle cut of its own (0.1.61): the thread's silence watch,
      // on the owner's setting, decides when a quiet turn stops.
      reasoning: true,
      billing: "metered",
      includeUsageInCompleted: true,
      nativeLog: {
        source: "openai-compat.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({
          textLength: text.length,
          reasoningLength: reasoning.length,
          usage,
        }),
      },
    });
    let usable=false;
    try{const url=new URL(config.url);usable=Boolean(apiKey&&input.enabled&&["http:","https:"].includes(url.protocol)&&!url.username&&!url.password);}catch{/* invalid configured endpoint */}
    if(usable)runtime.extractMemory=(text,maximumOutputTokens,signal,dispatch)=>{
      const extractionConfig={url:config.url,apiKey,model:catalog.default,...(config.provider&&isOpenRouterUrl(config.url)?{provider:{order:[config.provider],allow_fallbacks:false as const}}:{})};
      return dispatch?.purpose?requestMemoryInference(extractionConfig,text,maximumOutputTokens,signal,dispatch)
        :requestMemoryExtraction(extractionConfig,text,maximumOutputTokens,signal,dispatch?.messages);
    };
    if(usable)runtime.groundMemory=(claim,maximumOutputTokens,signal)=>requestMemoryGrounding({url:config.url,apiKey,model:catalog.default,
      ...(config.provider&&isOpenRouterUrl(config.url)?{provider:{order:[config.provider],allow_fallbacks:false as const}}:{})},claim,Math.min(64,maximumOutputTokens),signal);
    return runtime;
  },
};
