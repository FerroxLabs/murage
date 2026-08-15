// OpenCode Go subscription/API product through the maintained OpenCode CLI's
// ACP stdio interface. The generic protocol runtime lives in core.ts.
import { createAcpDriver, type AcpSupport } from "./core.ts";
import type { ModelCatalog } from "../../contracts.ts";

const CATALOG_URL = "https://opencode.ai/zen/go/v1/models";
const STATIC_MODELS: ModelCatalog = {
  default: "opencode-go/minimax-m3",
  options: [
    { id: "opencode-go/minimax-m3", label: "Minimax M3" },
    { id: "opencode-go/kimi-k3", label: "Kimi K3" },
    { id: "opencode-go/glm-5.2", label: "GLM 5.2" },
  ],
};

let lastSuccessfulCatalog: ModelCatalog | null = null;

function labelForModel(id: string): string {
  return id
    .split(/[-_.]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resetOpenCodeGoModelCache() {
  lastSuccessfulCatalog = null;
}

export async function fetchOpenCodeGoModels(fetcher: typeof fetch = fetch): Promise<ModelCatalog> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    timeout.unref?.();
    try {
      const response = await fetcher(CATALOG_URL, { signal: controller.signal });
      if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
      const payload = await response.json() as unknown;
      const records = Array.isArray(payload)
        ? payload
        : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
          ? (payload as { data: unknown[] }).data
          : [];
      const ids = records
        .map((record) => record && typeof record === "object" ? (record as { id?: unknown }).id : undefined)
        .filter((id): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(id));
      if (!ids.length) throw new Error("catalog contained no valid models");
      const catalog = {
        default: `opencode-go/${ids[0]}`,
        options: ids.map((id) => ({ id: `opencode-go/${id}`, label: labelForModel(id) })),
      } satisfies ModelCatalog;
      lastSuccessfulCatalog = catalog;
      return catalog;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return lastSuccessfulCatalog ?? STATIC_MODELS;
  }
}

const stripForeignProviderKeys = (env: Record<string, string | undefined>) => {
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "MOONSHOT_API_KEY",
  ]) delete env[key];
};

const support = (fetcher: typeof fetch): AcpSupport => ({
  driverKind: "opencodeGo",
  displayName: "OpenCode Go",
  models: STATIC_MODELS,
  defaultCli: "opencode",
  nativeSource: "opencode-go.acp",
  loginNote: "OpenCode Go is not configured — add an OPENCODE_API_KEY in OpenMausBot settings",
  install: {
    command: {
      darwin: "npm install -g opencode-ai",
      linux: "npm install -g opencode-ai",
      win32: "npm install -g opencode-ai",
    },
    docsUrl: "https://opencode.ai/docs/go/",
    signInCommand: "opencode auth login",
    needsNode: true,
  },
  spawnArgs: () => ["acp"],
  modelConfigOption: "model",
  transformEnv: stripForeignProviderKeys,
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: (env) => Boolean(env.OPENCODE_API_KEY),
  resolveModels: () => fetchOpenCodeGoModels(fetcher),
  buildPromptText: (turn) => turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
});

export function createOpenCodeGoDriver(fetcher: typeof fetch = fetch) {
  return createAcpDriver(support(fetcher));
}

export const OpenCodeGoDriver = createOpenCodeGoDriver();
