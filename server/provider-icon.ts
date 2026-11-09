// An OpenAI-compatible server shows the mark of whoever runs it (upstream #4067, adapted: Murage has no
// stored per-instance icon, so the server's host is the only source). The mark goes out with the engine
// list, so the desktop, the Cloud page and the phone show it without ever being sent the address.
import type { InstanceConfig } from "./contracts.ts";
import type { ProviderIcon, ProviderIconPreset } from "../shared/provider-icon.ts";

/** Who runs a server, by its host. `*` is one DNS label, or the rest of one. Only providers we have a mark for:
 * Groq, Together, Fireworks, Ollama and LM Studio servers keep the driver's own mark. */
const SERVER_HOSTS: Record<string, ProviderIconPreset> = {
  "api.openai.com": "openai", "*.api.openai.com": "openai",
  "*.openai.azure.com": "azure", "*.services.ai.azure.com": "azure", "*.cognitiveservices.azure.com": "azure",
  "bedrock-runtime.*.amazonaws.com": "aws",
  "generativelanguage.googleapis.com": "google", "aiplatform.googleapis.com": "google", "*-aiplatform.googleapis.com": "google",
  "api.x.ai": "xai",
  "api.deepseek.com": "deepseek",
  "dashscope.aliyuncs.com": "qwen", "dashscope-*.aliyuncs.com": "qwen",
  "api.moonshot.ai": "moonshot", "api.moonshot.cn": "moonshot",
  "api.mistral.ai": "mistral", "codestral.mistral.ai": "mistral",
  "api.cohere.com": "cohere", "api.cohere.ai": "cohere",
  "openrouter.ai": "openrouter", "*.openrouter.ai": "openrouter",
  "api.anthropic.com": "anthropic",
  "api.llama.com": "meta", "api.meta.ai": "meta",
};
const SERVER_MARKS = Object.entries(SERVER_HOSTS).map(([host, preset]) =>
  [new RegExp(`^${host.replaceAll(".", "\\.").replaceAll("*", "[a-z0-9-]+")}$`), preset] as const);

/** The provider whose mark a server address shows. Only the host counts, so a look-alike host
 * (api.openai.com.evil.test) or a provider named in the path or user name never matches. */
export function serverIconPreset(url: string): ProviderIconPreset | undefined {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    host = parsed.hostname.replace(/\.$/, "");
  } catch {
    return undefined;
  }
  return SERVER_MARKS.find(([pattern]) => pattern.test(host))?.[1];
}

/** The mark an instance shows everywhere the instance list goes: an OpenAI-compatible server shows the mark
 * of whoever runs it; anything else keeps its driver's mark (no `icon` field). */
export function instanceIcon(entry: Pick<InstanceConfig, "driver" | "config"> | undefined): { icon?: ProviderIcon } {
  const url = entry?.driver === "openai-compat" ? (entry.config as { url?: unknown } | null | undefined)?.url : undefined;
  const preset = typeof url === "string" ? serverIconPreset(url) : undefined;
  return preset ? { icon: { kind: "preset", preset } } : {};
}
