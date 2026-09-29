// xAI API driver. Grok uses the OpenAI chat-completions wire contract and
// adds the shared transient-failure retry policy.
import type { ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { keyIssuer } from "../../electron/provider-connections.mjs";
import { endpointProvider } from "./endpoint-provider.ts";

const DRIVER_KIND = "grok";
const DEFAULT_URL = "https://api.x.ai/v1";
const MODELS = {
  default: "grok-4",
  options: [
    // Upstream #1632: without a window the memory budget falls back to
    // 20,480 tokens (index.ts) for a model that takes 500k.
    { id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 },
    { id: "grok-4", label: "Grok 4" },
    { id: "grok-4-fast", label: "Grok 4 Fast" },
    { id: "grok-3-mini", label: "Grok 3 Mini" },
  ],
};

export interface GrokConfig {
  url: string;
  apiKeyEnv: string;
}

function decodeConfig(raw: unknown): GrokConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  return {
    url: typeof config.url === "string" ? config.url : DEFAULT_URL,
    apiKeyEnv: typeof config.apiKeyEnv === "string" ? config.apiKeyEnv : "XAI_API_KEY",
  };
}

export const GrokDriver: ProviderDriver<GrokConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Grok (API)", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const saved = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    // A key whose own prefix names a provider other than the one this
    // endpoint belongs to (a restored workspace slot on api.x.ai, say) is
    // never sent; the person replaces it in Models. Any other server keeps
    // whatever key it was configured with.
    const issuer = keyIssuer(saved), endpoint = endpointProvider(config.url);
    const mismatch = Boolean(issuer && endpoint && issuer !== endpoint);
    const apiKey = mismatch ? "" : saved;
    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl: config.url,
      models: () => MODELS,
      // Usage totals in the stream are sent only on request; never ask on a
      // request that does not stream.
      requestBody: (model, messages, stream) => ({
        model,
        messages,
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      }),
      httpErrorLabel: "xAI",
      missingKeyError: mismatch ? "The saved xAI key belongs to a different provider. Replace it in App Settings → Models." : "This engine has no xAI key yet. Add one in App Settings → Models.",
      unavailableReason: mismatch ? "The saved xAI key belongs to a different provider. Replace it in App Settings → Models." : "No xAI key yet: add one in App Settings → Models.",
      // No provider idle cut of its own (0.1.61): the thread's silence watch,
      // on the owner's setting, decides when a quiet turn stops.
      retryScale: Number(process.env.FAKE_GROK_RETRY_SCALE ?? "1"),
      generateModel: () => "grok-3-mini",
      nativeLog: {
        source: "xai.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messages }),
        incoming: ({ text, usage }) => ({ text, usage }),
      },
    });
  },
};
