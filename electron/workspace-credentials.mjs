import { MASK, splitSecretUrl } from "../shared/mcp-secret-url.mjs";

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
  { section: "slack", field: "appToken", name: "slackAppToken", env: "MURAGE_SLACK_APP_TOKEN" },
  { section: "slack", field: "botToken", name: "slackBotToken", env: "MURAGE_SLACK_BOT_TOKEN" },
  { section: "discord", field: "botToken", name: "discordBotToken", env: "MURAGE_DISCORD_BOT_TOKEN" },
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
  const mcp = projectMcpServerSecrets(credentials?.mcpServerSecrets);
  if (Object.keys(mcp).length > 0) env.MURAGE_MCP_SERVER_SECRETS = JSON.stringify(mcp);
  return env;
}

// ── servers added by link (spec MCP-LINK 3.4) ────────────────────────────

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * What the server child may hold for each server: header values, the full
 * link, the current access token, and a command server's env values (T16). The refresh token, the client secret and
 * every other OAuth field stay in this process (sign-in and refresh live in
 * main; the server gets access tokens pushed to it).
 * @param {unknown} store  credentials.mcpServerSecrets, an object or its JSON text
 */
export function projectMcpServerSecrets(store) {
  let source = store;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { return {}; }
  }
  const out = {};
  if (!isRecord(source)) return out;
  for (const [name, doc] of Object.entries(source)) {
    if (name === "__proto__" || !isRecord(doc)) continue;
    const projected = {};
    if (typeof doc.origin === "string" && doc.origin) projected.origin = doc.origin;
    if (isRecord(doc.headers)) {
      const headers = Object.fromEntries(Object.entries(doc.headers).filter(([key, value]) => key !== "__proto__" && typeof value === "string" && value));
      if (Object.keys(headers).length > 0) projected.headers = headers;
    }
    if (typeof doc.url === "string" && doc.url) projected.url = doc.url;
    if (isRecord(doc.env)) {
      const env = Object.fromEntries(Object.entries(doc.env).filter(([key, value]) => key !== "__proto__" && typeof value === "string"));
      if (Object.keys(env).length > 0) projected.env = env;
    }
    if (isRecord(doc.oauth) && typeof doc.oauth.accessToken === "string" && doc.oauth.accessToken) {
      // issuedAt and scope are not secrets: the harness settles a "sign in
      // again" card only on a token issued after the card, never on the same
      // one handed over again at start-up.
      projected.oauth = {
        accessToken: doc.oauth.accessToken,
        ...(Number.isFinite(doc.oauth.expiresAt) ? { expiresAt: doc.oauth.expiresAt } : {}),
        ...(Number.isFinite(doc.oauth.issuedAt) ? { issuedAt: doc.oauth.issuedAt } : {}),
        ...(Number.isFinite(doc.oauth.signedInAt) ? { signedInAt: doc.oauth.signedInAt } : {}),
        ...(typeof doc.oauth.scope === "string" && doc.oauth.scope && doc.oauth.scope.length <= 2_000 && /^[\x20-\x7e]+$/.test(doc.oauth.scope) ? { scope: doc.oauth.scope } : {}),
      };
    }
    if (projected.headers || projected.url || projected.oauth || projected.env) Object.defineProperty(out, name, { value: projected, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * Boot sweep for servers added by link: move every plaintext header value and
 * every secret-bearing link out of config.json into credentials.mcpServerSecrets
 * and leave `true` placeholders and a masked, marked link behind. Same rules as
 * migrateWorkspaceCredentials: inputs are not mutated, running twice is a no-op,
 * a non-empty plaintext value is the newest intent, and nothing moves unless the
 * encrypted store can take it (`storeAvailable`), so the plaintext is never the
 * only copy lost.
 * @param {any} config
 * @param {any} credentials
 * @param {{ storeAvailable?: boolean }} [options]
 */
export function migrateMcpServerSecrets(config, credentials, options = {}) {
  const nextConfig = structuredClone(config ?? {});
  const nextCredentials = { ...credentials };
  const unchanged = { config: nextConfig, credentials: nextCredentials, configChanged: false, credentialsChanged: false };
  if (options.storeAvailable === false) return { ...unchanged, config: config ?? {}, credentials: credentials ?? {} };
  const servers = isRecord(nextConfig.mcpServers) ? nextConfig.mcpServers : {};
  if (!isRecord(nextCredentials.mcpServerSecrets) || Object.keys(nextCredentials.mcpServerSecrets).length === 0) {
    if (Object.keys(servers).length === 0) return unchanged;
  }
  const store = isRecord(nextCredentials.mcpServerSecrets) ? structuredClone(nextCredentials.mcpServerSecrets) : {};
  let configChanged = false;
  let credentialsChanged = false;
  const docFor = (name) => {
    if (!isRecord(store[name])) store[name] = {};
    return store[name];
  };
  const originOf = (url) => {
    try { return new URL(url).origin; } catch { return undefined; }
  };
  for (const [name, entry] of Object.entries(servers)) {
    if (name === "__proto__" || !isRecord(entry)) continue;
    if (typeof entry.url !== "string" && typeof entry.command === "string") {
      // A command server (T16): every string env value moves to the store and
      // `true` stays behind. A link doc left under this name is dropped first.
      if (Object.hasOwn(store, name) && (!isRecord(store[name]) || store[name].origin !== undefined || store[name].headers !== undefined || store[name].url !== undefined || store[name].oauth !== undefined)) {
        delete store[name];
        credentialsChanged = true;
      }
      if (isRecord(entry.env)) {
        for (const [key, value] of Object.entries(entry.env)) {
          if (key === "__proto__" || typeof value !== "string") continue;
          const doc = docFor(name);
          doc.env = { ...(isRecord(doc.env) ? doc.env : {}), [key]: value };
          entry.env[key] = true;
          configChanged = true;
          credentialsChanged = true;
        }
      }
      continue;
    }
    if (typeof entry.url !== "string") continue;
    // A saved doc issued for another origin, or for none, is dropped BEFORE
    // anything is merged into it: merging would re-stamp it with this entry's
    // origin and send the old key to the new server (MCP-LINK N2). Only a
    // fresh doc or one already bound here is stamped below.
    const entryOrigin = originOf(entry.url);
    if (Object.hasOwn(store, name) && (entryOrigin === undefined || !isRecord(store[name]) || store[name].origin !== entryOrigin)) {
      delete store[name];
      credentialsChanged = true;
    }
    if (isRecord(entry.headers)) {
      for (const [header, value] of Object.entries(entry.headers)) {
        if (typeof value !== "string" || !value.trim()) continue;
        const doc = docFor(name);
        doc.headers = { ...(isRecord(doc.headers) ? doc.headers : {}), [header]: value };
        doc.origin = entryOrigin;
        entry.headers[header] = true;
        configChanged = true;
        credentialsChanged = true;
      }
    }
    const masked = entry.urlSecret === true && entry.url.includes(MASK);
    if (masked) {
      // A hand edit can add a query or userinfo to a link that is already
      // masked. Move those into the stored full link and keep the masked path.
      const extras = /[?#]/.test(entry.url) || /\/\/[^/?#]*@/.test(entry.url);
      if (extras) {
        let extrasUrl;
        try { extrasUrl = new URL(entry.url); } catch { extrasUrl = undefined; }
        const held = isRecord(store[name]) && typeof store[name].url === "string" ? store[name].url : entry.url;
        try {
          const full = new URL(held);
          if (extrasUrl) {
            full.search = extrasUrl.search;
            full.username = extrasUrl.username;
            full.password = extrasUrl.password;
          }
          const doc = docFor(name);
          doc.url = full.href;
          doc.origin = entryOrigin;
          entry.url = entry.url.replace(/\/\/[^/?#]*@/, "//").split(/[?#]/)[0];
          configChanged = true;
          credentialsChanged = true;
        } catch {
          // an unreadable link is left for the server's schema to refuse
        }
      }
    } else {
      const split = splitSecretUrl(entry.url);
      if (split?.urlSecret) {
        const doc = docFor(name);
        doc.url = split.fullUrl;
        doc.origin = entryOrigin;
        entry.url = split.storedUrl;
        entry.urlSecret = true;
        configChanged = true;
        credentialsChanged = true;
      }
    }
  }
  // Secrets of a server that is gone, or that now points somewhere else than
  // they were issued for, are dropped: a removed server's key must not come
  // back for whatever is later added under its name (MCP-LINK H2).
  for (const name of Object.keys(store)) {
    const entry = Object.hasOwn(servers, name) ? servers[name] : undefined;
    const doc = store[name];
    if (isRecord(entry) && typeof entry.url !== "string" && typeof entry.command === "string") {
      // A command server keeps an env-only doc.
      if (!isRecord(doc) || !isRecord(doc.env)) { delete store[name]; credentialsChanged = true; }
      continue;
    }
    if (isRecord(doc) && Object.hasOwn(doc, "env")) {
      // env values belong to command servers only
      delete doc.env;
      credentialsChanged = true;
    }
    const entryOrigin = isRecord(entry) && typeof entry.url === "string" ? originOf(entry.url) : undefined;
    if (entryOrigin === undefined || (isRecord(doc) && typeof doc.origin === "string" && doc.origin !== entryOrigin)) {
      delete store[name];
      credentialsChanged = true;
    }
  }
  for (const name of Object.keys(store)) if (isRecord(store[name]) && Object.keys(store[name]).length === 0) delete store[name];
  if (credentialsChanged) nextCredentials.mcpServerSecrets = store;
  return { config: nextConfig, credentials: nextCredentials, configChanged, credentialsChanged };
}

/** credentials with one link server's saved secrets removed (the server was
 * removed, or its link or sign-in kind changed). The input is not changed.
 * With `before`, a document saved at or after that time is kept: it was
 * entered after the change the harness reported (NEXT-T11 L-f). */
export function dropMcpServerSecrets(credentials, name, before) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) return credentials;
  if (!isRecord(credentials?.mcpServerSecrets) || !Object.hasOwn(credentials.mcpServerSecrets, name)) return credentials;
  const current = credentials.mcpServerSecrets[name];
  if (typeof before === "number" && isRecord(current) && typeof current.savedAt === "number" && current.savedAt >= before) return credentials;
  const store = { ...credentials.mcpServerSecrets };
  delete store[name];
  return { ...credentials, mcpServerSecrets: store };
}
