// OpenCode Go subscription/API product through the maintained OpenCode CLI's
// ACP stdio interface. The generic protocol runtime lives in core.ts.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAcpDriver } from "./core.js";
const CATALOG_URL = "https://opencode.ai/zen/go/v1/models";
const STATIC_MODELS = {
    default: "opencode-go/minimax-m3",
    options: [
        { id: "opencode-go/minimax-m3", label: "Minimax M3" },
        { id: "opencode-go/kimi-k3", label: "Kimi K3" },
        { id: "opencode-go/glm-5.2", label: "GLM 5.2" },
    ],
};
let lastSuccessfulCatalog = null;
function labelForModel(id) {
    return id
        .split(/[-_.]+/g)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}
export function resetOpenCodeGoModelCache() {
    lastSuccessfulCatalog = null;
}
export async function fetchOpenCodeGoModels(fetcher = fetch) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8_000);
        timeout.unref?.();
        try {
            const response = await fetcher(CATALOG_URL, { signal: controller.signal });
            if (!response.ok)
                throw new Error(`catalog HTTP ${response.status}`);
            const payload = await response.json();
            const records = Array.isArray(payload)
                ? payload
                : payload && typeof payload === "object" && Array.isArray(payload.data)
                    ? payload.data
                    : [];
            const ids = records
                .map((record) => record && typeof record === "object" ? record.id : undefined)
                .filter((id) => typeof id === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(id));
            if (!ids.length)
                throw new Error("catalog contained no valid models");
            const catalog = {
                default: `opencode-go/${ids[0]}`,
                options: ids.map((id) => ({ id: `opencode-go/${id}`, label: labelForModel(id) })),
            };
            lastSuccessfulCatalog = catalog;
            return catalog;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    catch {
        return lastSuccessfulCatalog ?? STATIC_MODELS;
    }
}
const stripForeignProviderKeys = (env) => {
    for (const key of [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "XAI_API_KEY",
        "KIMI_API_KEY",
        "MOONSHOT_API_KEY",
    ])
        delete env[key];
};
function storedAuthPath(env) {
    const home = env.HOME || env.USERPROFILE || homedir();
    const dataRoot = env.XDG_DATA_HOME
        || (process.platform === "darwin"
            ? join(home, "Library", "Application Support")
            : process.platform === "win32"
                ? env.LOCALAPPDATA || join(home, "AppData", "Local")
                : join(home, ".local", "share"));
    return join(dataRoot, "opencode", "auth.json");
}
function hasStoredOpenCodeGoAuth(env) {
    const candidates = [];
    if (env.OPENCODE_AUTH_CONTENT)
        candidates.push(env.OPENCODE_AUTH_CONTENT);
    try {
        candidates.push(readFileSync(storedAuthPath(env), "utf8"));
    }
    catch {
        // A missing or unreadable file simply means there is no ambient login.
    }
    return candidates.some((raw) => {
        try {
            const parsed = JSON.parse(raw);
            const auth = parsed["opencode-go"];
            return Boolean(auth && typeof auth === "object" && auth.key);
        }
        catch {
            return false;
        }
    });
}
const support = (fetcher) => ({
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
        docsUrl: "https://opencode.ai/docs/",
        signInCommand: "opencode auth login",
        needsNode: true,
    },
    spawnArgs: () => ["acp"],
    credentialEnv: ["OPENCODE_API_KEY"],
    selectModel: { configId: "model" },
    transformEnv: stripForeignProviderKeys,
    pickAuthMethod: () => null,
    authFailure: "continue",
    isAuthenticated: (env) => Boolean(env.OPENCODE_API_KEY) || hasStoredOpenCodeGoAuth(env),
    classifyError: classifyOpenCodeGoError,
    resolveModels: () => fetchOpenCodeGoModels(fetcher),
    buildPromptText: (turn) => turn.system ? `${turn.system}\n\n${turn.text}` : turn.text,
});
export function classifyOpenCodeGoError(error) {
    const value = error && typeof error === "object" ? error : {};
    const code = value.code;
    if (code === -32000)
        return "invalid_credentials";
    if (code === "AUTH_REQUIRED" || code === "INVALID_API_KEY" || code === "UNAUTHORIZED")
        return "invalid_credentials";
    if (code === "SUBSCRIPTION_INACTIVE")
        return "inactive_subscription";
    if (code === "QUOTA_EXCEEDED" || code === "REGION_RESTRICTED")
        return "quota_or_region_restriction";
    if (code === "UPSTREAM_UNAVAILABLE" || code === "SERVICE_UNAVAILABLE")
        return "upstream_outage";
    if (code === "MODEL_CATALOG_UNAVAILABLE")
        return "model_catalog_outage";
    return undefined;
}
export function createOpenCodeGoDriver(fetcher = fetch) {
    return createAcpDriver(support(fetcher));
}
export const OpenCodeGoDriver = createOpenCodeGoDriver();
