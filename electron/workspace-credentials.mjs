// Workspace credentials the desktop shell keeps OS-encrypted (credentials.bin
// via safeStorage) instead of leaving in plaintext config.json — the same
// treatment the Composio project key already gets in main.mjs. Pure functions:
// main.mjs owns the fs and safeStorage plumbing, so the migration decisions
// stay testable without an Electron runtime.
//
// One row per secret: the config.json home it migrates OUT of, the
// credentials.bin field it lives in, and the env var the spawned server
// prefers over the file (server/config.ts loadConfig).
export const WORKSPACE_CREDENTIALS = [
  { section: "modelProviders", field: "bank", name: "modelProviderConnections", env: "MURAGE_MODEL_PROVIDER_CONNECTIONS" },
  { section: "telegram", field: "botToken", name: "telegramBotToken", env: "MURAGE_TELEGRAM_BOT_TOKEN" },
  { section: "xai", field: "key", name: "xaiApiKey", env: "XAI_API_KEY" },
  { section: "box", field: "token", name: "boxToken", env: "BOX_TOKEN" },
  { section: "tts", field: "key", name: "ttsKey", env: "MURAGE_TTS_KEY" },
  { section: "imageGen", field: "key", name: "openaiImageApiKey", env: "MURAGE_OPENAI_IMAGE_KEY" },
  { section: "opencodeGo", field: "apiKey", name: "opencodeGoApiKey", env: "OPENCODE_API_KEY" },
  { section: "webSearch", field: "tavilyApiKey", name: "tavilySearchApiKey", env: "MURAGE_TAVILY_SEARCH_KEY" },
  { section: "webSearch", field: "exaApiKey", name: "exaSearchApiKey", env: "MURAGE_EXA_SEARCH_KEY" },
  { section: "webSearch", field: "firecrawlApiKey", name: "firecrawlSearchApiKey", env: "MURAGE_FIRECRAWL_SEARCH_KEY" },
];

/** One boot-time sweep of config.json: move every plaintext workspace secret
 * into the encrypted store and DELETE the plaintext field.
 *
 * Deleting (never blanking) keeps the meaning of what remains unambiguous:
 *   - non-empty value  → newest user intent: overwrite the stored secret
 *   - "" or absent     → no plaintext information; the store stays authoritative
 *
 * "" must never drop a stored secret. The packaged app's external-secret
 * save path writes an empty tombstone into config.json on EVERY credential
 * commit (the real value goes to credentials.bin first), so reading "" as
 * "the user cleared this" deleted freshly saved keys at the next boot.
 * Clearing runs through the desktop shell's credential:set handler, which
 * removes the entry from the store directly before persisting the same
 * tombstone — so there is no "" case in which the store should lose data.
 * Running twice is a no-op, and nothing is lost if a boot dies between the
 * two writes — the caller persists credentials BEFORE rewriting config, so
 * the worst case re-runs the same overwrite.
 *
 * Inputs are treated as immutable; the changed flags tell the caller which
 * file(s) actually need rewriting. Non-string junk in a field is left for
 * the server's schema to reject rather than silently destroyed here. */
export function migrateWorkspaceCredentials(config, credentials) {
  const nextConfig = structuredClone(config ?? {});
  const nextCredentials = { ...credentials };
  let configChanged = false;
  let credentialsChanged = false;
  for (const { section, field, name } of WORKSPACE_CREDENTIALS) {
    const home = nextConfig?.[section];
    if (!home || typeof home !== "object" || Array.isArray(home)) continue;
    if (!Object.hasOwn(home, field)) continue;
    const value = home[field];
    if (typeof value !== "string") continue;
    const secret = value.trim();
    if (secret && nextCredentials[name] !== secret) {
      nextCredentials[name] = secret;
      credentialsChanged = true;
    }
    delete home[field];
    configChanged = true;
  }
  return { config: nextConfig, credentials: nextCredentials, configChanged, credentialsChanged };
}

/** Env for the spawned server: one var per stored secret, nothing else.
 * The server treats each var as authoritative over its config.json field. */
export function workspaceCredentialEnv(credentials) {
  const env = {};
  for (const { name, env: envName } of WORKSPACE_CREDENTIALS) {
    const value = credentials?.[name];
    if (typeof value === "string" && value) env[envName] = value;
  }
  // Flux migration requires explicit user choice, so it is deliberately not
  // part of the boot-time overwrite table above. Blank is a managed disconnect.
  if (credentials?.fluxConnectionManaged === "true") env.FLUX_API_KEY = credentials.fluxApiKey ?? "";
  else if (typeof credentials?.fluxApiKey === "string") env.FLUX_API_KEY = credentials.fluxApiKey;
  if (typeof credentials?.fluxConnectionAliases === "string") env.MURAGE_FLUX_CONNECTION_ALIASES = credentials.fluxConnectionAliases;
  return env;
}
