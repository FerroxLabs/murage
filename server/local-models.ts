// /api/local-models — Settings → Models → Local models (0.1.52 LM1).
//
// Desktop-only (DESKTOP_AUTHORITY_ROUTES + an explicit check here; the
// companion allowlist stays default-deny): these routes store an address and
// a key that engine configs are later written from, and they make the server
// send requests to a user-chosen address.
//
// The list route always answers, including when nothing runs, so the settings
// section can say exactly where Murage looked (spec V1).
import {
  contextPreflight,
  DEFAULT_PROMPT_TOKEN_ESTIMATE,
  ENGINE_PROMPT_TOKEN_ESTIMATE,
  isLocalServerKind,
  isValidLocalModelId,
  isValidLocalServerKey,
  isValidLocalServerName,
  LOCAL_DETECTION_TARGETS,
  LOCAL_MODELS_ERROR_STATUS,
  LOCAL_MODELS_ROUTE_PREFIX,
  LOCAL_SERVERS_MAX,
  localEnginesFor,
  localServerDisplayLabel,
  normalizeLocalServerAddress,
  USER_LOCAL_SERVER_ID,
  type LocalModelsErrorCode,
  type LocalModelsListResponse,
  type LocalModelView,
  type LocalServerKind,
  type LocalServerView,
  type LocalToolTestResponse,
  type RemoveLocalServerResponse,
} from "../shared/local-models.ts";
import { hiddenRoute, type DelegatedRequest, type DelegatedResult } from "./route-delegation.ts";
import {
  forgetLocalToolTests,
  localServerStoreConfigured,
  newLocalServerId,
  readLocalServers,
  saveLocalToolTest,
  userLocalServer,
  writeLocalServers,
  type StoredLocalServer,
} from "./local-servers.ts";
import {
  cachedLocalContext,
  cachedLocalTestFor,
  decodeInjectId,
  encodeInjectId,
  hostApiKey,
  LOCAL_HOSTS,
  localContextWindow,
  localHost,
  probeLocalHost,
  probeLocalHosts,
  type LocalHost,
  type LocalHostPage,
} from "./drivers/local-inject.ts";
import { runLocalToolProbe } from "./local-tool-probe.ts";
import {
  createOllamaContextCopy,
  detectLocalServerKind,
  isValidOllamaContextRequest,
  probeHost,
  readLoadedContext,
} from "./local-server-probe.ts";
import { removeLocalHostInjections } from "./local-inject-cleanup.ts";

type Env = Record<string, string | undefined>;

export interface LocalModelsRouteOptions {
  fetchImpl?: typeof fetch;
  /** Env the engine configs live under (HOME etc.) and host keys resolve from. */
  env?: () => Env;
  now?: () => number;
  /** Per-request probe timeout (tests shorten it). */
  probeTimeoutMs?: number;
}

function fail(code: LocalModelsErrorCode, error: string): DelegatedResult {
  return { status: LOCAL_MODELS_ERROR_STATUS[code], body: { error, code } };
}

const ADDRESS_ERRORS: Partial<Record<LocalModelsErrorCode, string>> = {
  "https-required": "Use https for this address. Plain http is only allowed for this computer, your home network or your tailnet.",
  "credentials-in-address": "Put the key in the API key field, not in the address.",
  "unsupported-scheme": "The address must start with http:// or https://.",
  "invalid-address": "That address is not valid. Try something like 192.168.1.20:8080.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJsonBody(request: DelegatedRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.readBody();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function modelView(host: LocalHost, page: LocalHostPage, model: string): LocalModelView {
  const test = cachedLocalTestFor(host.id, model);
  const context = page.contexts.get(model) ?? cachedLocalContext(host.id, model);
  return {
    id: encodeInjectId(host.id, model),
    model,
    loaded: page.loaded.has(model),
    ...(context ? { context } : {}),
    ...(test ? { test } : {}),
    engines: localEnginesFor(test),
  };
}

function serverView(page: LocalHostPage, stored: StoredLocalServer | undefined, checkedAt: number): LocalServerView {
  const { host } = page;
  return {
    id: host.id,
    name: stored?.name ?? host.label,
    label: host.label,
    kind: host.kind,
    address: host.baseUrl,
    source: stored ? "added" : "detected",
    editable: Boolean(stored),
    hasKey: Boolean(stored?.apiKey),
    status: page.reachable ? "running" : "not-answering",
    checkedAt,
    models: page.ids.map((model) => modelView(host, page, model)),
  };
}

function hostOf(stored: StoredLocalServer): LocalHost {
  return {
    id: stored.id,
    label: localServerDisplayLabel(stored.kind, stored.name),
    kind: stored.kind,
    baseUrl: stored.apiBase,
    apiKey: stored.apiKey ?? "local",
    source: "added",
    name: stored.name,
  };
}

function decodeServerId(raw: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (USER_LOCAL_SERVER_ID.test(id) || LOCAL_HOSTS.some((host) => host.id === id)) return id;
  return null;
}

/** An address already covered by automatic detection or another added server. */
function duplicateOf(apiBase: string, servers: readonly StoredLocalServer[], except?: string): boolean {
  if (LOCAL_HOSTS.some((host) => host.baseUrl === apiBase)) return true;
  return servers.some((server) => server.apiBase === apiBase && server.id !== except);
}

export function createLocalModelsRoute(options: LocalModelsRouteOptions = {}) {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const env = options.env ?? (() => process.env as Env);
  const now = options.now ?? Date.now;
  const running = new Set<string>();

  async function list(): Promise<LocalModelsListResponse> {
    const pages = await probeLocalHosts(env(), fetchImpl);
    const checkedAt = now();
    const servers: LocalServerView[] = [];
    for (const page of pages) {
      const stored = page.host.source === "added" ? userLocalServer(page.host.id) : undefined;
      // A built-in port that did not answer is listed under `looked`, not as a card.
      if (!stored && !page.reachable) continue;
      servers.push(serverView(page, stored, checkedAt));
    }
    return { servers, looked: LOCAL_DETECTION_TARGETS, checkedAt };
  }

  async function viewOf(stored: StoredLocalServer): Promise<LocalServerView> {
    const page = await probeLocalHost(hostOf(stored), env(), fetchImpl);
    return serverView(page, stored, now());
  }

  async function add(request: DelegatedRequest): Promise<DelegatedResult> {
    const body = await readJsonBody(request);
    if (!body) return fail("invalid-request", "Send the server address as JSON.");
    const address = normalizeLocalServerAddress(body.address);
    if (!address.ok) return fail(address.code, ADDRESS_ERRORS[address.code] ?? "That address is not valid.");
    if (body.name !== undefined && body.name !== "" && !isValidLocalServerName(body.name)) {
      return fail("invalid-name", "Use a name of up to 60 characters.");
    }
    if (body.apiKey !== undefined && body.apiKey !== "" && !isValidLocalServerKey(body.apiKey)) {
      return fail("invalid-key", "That API key is not valid.");
    }
    if (body.kind !== undefined && body.kind !== "auto" && !isLocalServerKind(body.kind)) {
      return fail("invalid-kind", "Choose a server type from the list, or Auto-detect.");
    }
    if (!localServerStoreConfigured()) return fail("store-unavailable", "Local model settings are not available right now.");
    const servers = readLocalServers();
    if (servers.length >= LOCAL_SERVERS_MAX) return fail("server-limit", `You can add up to ${LOCAL_SERVERS_MAX} servers.`);
    if (duplicateOf(address.apiBase, servers)) {
      return fail("duplicate-server", "Murage already checks this address. It is listed under Local models when it is running.");
    }
    const apiKey = typeof body.apiKey === "string" && body.apiKey ? body.apiKey : undefined;
    let kind: LocalServerKind;
    if (isLocalServerKind(body.kind)) {
      kind = body.kind;
    } else {
      const detection = await detectLocalServerKind(probeHost(address.apiBase, apiKey), env(), fetchImpl);
      kind = detection.kind ?? "openai";
    }
    const createdAt = now();
    const stored: StoredLocalServer = {
      id: newLocalServerId(new Set(servers.map((server) => server.id))),
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : new URL(address.apiBase).host,
      kind,
      apiBase: address.apiBase,
      ...(apiKey ? { apiKey } : {}),
      createdAt,
      updatedAt: createdAt,
    };
    writeLocalServers([...servers, stored]);
    return { status: 201, body: { server: await viewOf(stored) } };
  }

  async function update(id: string, request: DelegatedRequest): Promise<DelegatedResult> {
    const servers = readLocalServers();
    const current = servers.find((server) => server.id === id);
    if (!current) return fail("server-not-found", "That server is not in your list.");
    const body = await readJsonBody(request);
    if (!body) return fail("invalid-request", "Send the changes as JSON.");
    const next: StoredLocalServer = { ...current, updatedAt: now() };
    if (body.name !== undefined) {
      if (!isValidLocalServerName(body.name)) return fail("invalid-name", "Use a name of up to 60 characters.");
      next.name = body.name.trim();
    }
    if (body.kind !== undefined) {
      if (!isLocalServerKind(body.kind)) return fail("invalid-kind", "Choose a server type from the list.");
      next.kind = body.kind;
    }
    if (body.address !== undefined) {
      const address = normalizeLocalServerAddress(body.address);
      if (!address.ok) return fail(address.code, ADDRESS_ERRORS[address.code] ?? "That address is not valid.");
      if (duplicateOf(address.apiBase, servers, id)) {
        return fail("duplicate-server", "Murage already checks this address.");
      }
      next.apiBase = address.apiBase;
    }
    if (body.apiKey !== undefined) {
      if (body.apiKey === null || body.apiKey === "") delete next.apiKey;
      else if (isValidLocalServerKey(body.apiKey)) next.apiKey = body.apiKey;
      else return fail("invalid-key", "That API key is not valid.");
    }
    // Engine configs written for the old address or key would keep the stale
    // value (several writers never overwrite an existing entry), so remove
    // them now; the next turn writes fresh ones.
    const reroute = next.apiBase !== current.apiBase || next.apiKey !== current.apiKey;
    const cleanup = reroute ? removeLocalHostInjections(hostOf(current), env()) : [];
    if (next.apiBase !== current.apiBase) forgetLocalToolTests(id);
    writeLocalServers(servers.map((server) => (server.id === id ? next : server)));
    return { status: 200, body: { server: await viewOf(next), cleanup } };
  }

  function remove(id: string): DelegatedResult {
    const servers = readLocalServers();
    const current = servers.find((server) => server.id === id);
    if (!current) return fail("server-not-found", "That server is not in your list.");
    writeLocalServers(servers.filter((server) => server.id !== id));
    forgetLocalToolTests(id);
    // Spec A3: removing a server removes the engine entries it produced.
    const cleanup = removeLocalHostInjections(hostOf(current), env());
    const response: RemoveLocalServerResponse = { removed: id, cleanup };
    return { status: 200, body: response };
  }

  async function test(id: string, request: DelegatedRequest): Promise<DelegatedResult> {
    const host = localHost(id);
    if (!host) return fail("server-not-found", "That server is not in your list.");
    const body = await readJsonBody(request);
    if (!body || !isValidLocalModelId(body.model)) return fail("invalid-model", "Choose a model to test.");
    const model = body.model;
    const key = `${host.id}::${model}`;
    if (running.has(key)) return fail("busy", "This model is already being tested.");
    running.add(key);
    try {
      const context = await readLoadedContext(host, model, env(), fetchImpl);
      const result = await runLocalToolProbe({
        serverId: host.id,
        kind: host.kind,
        apiBase: host.baseUrl,
        apiKey: hostApiKey(host, env()),
        model,
        context,
        fetchImpl,
        ...(options.probeTimeoutMs ? { requestTimeoutMs: options.probeTimeoutMs } : {}),
        now,
      });
      saveLocalToolTest(result);
      const response: LocalToolTestResponse = { test: result, engines: localEnginesFor(result) };
      return { status: 200, body: response };
    } finally {
      running.delete(key);
    }
  }

  async function ollamaCopy(id: string, request: DelegatedRequest): Promise<DelegatedResult> {
    const host = localHost(id);
    if (!host) return fail("server-not-found", "That server is not in your list.");
    if (host.kind !== "ollama") return fail("not-ollama", "Only Ollama models need a copy with a bigger context.");
    const body = await readJsonBody(request);
    if (!body || !isValidOllamaContextRequest(body.model, body.numCtx)) {
      return fail("invalid-model", "Choose the Ollama model to copy.");
    }
    const result = await createOllamaContextCopy(
      host,
      body.model as string,
      typeof body.numCtx === "number" ? body.numCtx : undefined,
      env(),
      fetchImpl,
    );
    return { status: 200, body: result };
  }

  async function preflight(url: URL): Promise<DelegatedResult> {
    const inject = decodeInjectId(url.searchParams.get("model"));
    const host = inject ? localHost(inject.host) : undefined;
    if (!inject || !host) return fail("invalid-model", "Choose a local model.");
    const engine = url.searchParams.get("engine") ?? "";
    const rawTokens = url.searchParams.get("promptTokens");
    const promptTokens = rawTokens !== null && /^\d{1,7}$/.test(rawTokens)
      ? Number(rawTokens)
      : ENGINE_PROMPT_TOKEN_ESTIMATE[engine] ?? DEFAULT_PROMPT_TOKEN_ESTIMATE;
    const contextWindow =
      localContextWindow(inject.host, inject.model) ??
      (await readLoadedContext(host, inject.model, env(), fetchImpl)).contextWindow;
    return { status: 200, body: contextPreflight({ contextWindow, promptTokens }) };
  }

  return async function localModelsRoute(request: DelegatedRequest): Promise<DelegatedResult> {
    if (!request.desktop) return hiddenRoute();
    const { method } = request;
    const rest = request.path.slice(LOCAL_MODELS_ROUTE_PREFIX.length);
    if (rest === "" || rest === "/") {
      if (method !== "GET") return { status: 405, body: { error: "method not allowed" } };
      return { status: 200, body: await list() };
    }
    if (rest === "/preflight") {
      if (method !== "GET") return { status: 405, body: { error: "method not allowed" } };
      return preflight(request.url);
    }
    if (rest === "/servers") {
      if (method !== "POST") return { status: 405, body: { error: "method not allowed" } };
      return add(request);
    }
    const match = /^\/servers\/([^/]+)(?:\/(test|ollama-context-copy))?$/.exec(rest);
    const id = match ? decodeServerId(match[1]!) : null;
    if (!match || !id) return { status: 404, body: { error: "no such route" } };
    const action = match[2];
    if (action === "test") return method === "POST" ? test(id, request) : { status: 405, body: { error: "method not allowed" } };
    if (action === "ollama-context-copy") {
      return method === "POST" ? ollamaCopy(id, request) : { status: 405, body: { error: "method not allowed" } };
    }
    if (method === "PATCH") return update(id, request);
    if (method === "DELETE") return remove(id);
    return { status: 405, body: { error: "method not allowed" } };
  };
}

/** The route index.ts delegates `/api/local-models*` to. */
export const localModelsRoute = createLocalModelsRoute();
