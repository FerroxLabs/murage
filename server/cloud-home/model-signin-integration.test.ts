// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { s256Challenge } from "../../electron/model-signin-oauth.mjs";
import { SIGNIN_CONNECTION_IDS } from "../../electron/model-signin-presets.mjs";
import type { ProviderCatalog } from "../../shared/provider-connections.ts";
import { CloudSessions, type CloudScope } from "../cloud-sessions.ts";
import { cloudBodies, createCloudRequestAuth, stepPurpose } from "../cloud-request-auth.ts";
import { handleModelGateway } from "../model-gateway.ts";
import { ModelSignIns } from "../model-signin.ts";
import { applyProviderRoute } from "../provider-routing.ts";
import { createCloudModelSignInApi } from "./model-signin-api.ts";
import { createCloudModelSignInClient } from "./model-signin-wire.ts";
import { CLOUD_MODEL_SIGNINS_KEY, createHomeModelSignIn, HomeSignInError, type HomeSignInProvider } from "./model-signin.ts";
import { SealedSecretStore } from "./secrets.ts";
import { createSupervisorPort } from "./supervisor-port.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

// Protocol/preconditions: real Ed25519 owner pairing and body-bound assertions;
// disposable sealed storage; actual HTTP/auth/RPC/supervisor/manager/registry.
// Only IPC delivery and all provider fetch responses are fake. Node HTTP remains
// real loopback. Advance exactly five seconds AFTER start HTTP has completed;
// never run all timers (refresh and HTTP/RPC deadlines are intentionally bounded).
// Expected result: each owner/provider combination connects, reloads from sealed
// storage, routes via a gateway capability, then revokes that capability on exit.
const origin = "https://home.example", base = "/api/cloud/model-signins";
const verifier = "v".repeat(43);
const idToken = `x.${Buffer.from(JSON.stringify({ email: "owner@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture", chatgpt_plan_type: "plus" } })).toString("base64url")}.x`;
const tokens = { access_token: "synthetic-provider-access", refresh_token: "synthetic-provider-refresh", id_token: idToken, expires_in: 3600 };
let cleanup: Array<() => void | Promise<void>>;
beforeEach(() => {
  cleanup = [];
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1_800_000_000_000);
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
});
afterEach(async () => {
  try { for (const close of cleanup.reverse()) await close(); }
  finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
});
function pair(sessions: CloudSessions, scope: CloudScope) {
  const key = generateKeyPairSync("ed25519"), factorKey = generateKeyPairSync("ed25519");
  const code = sessions.mint({ account: "owner", scope, publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), assertionKey: factorKey.publicKey.export({ type: "spki", format: "pem" }).toString() });
  const message = Buffer.from(`murage-pair:${sessions.environmentId}:${code}:owner`);
  return { ...sessions.redeem(code, "owner", sign(null, message, key.privateKey).toString("base64url"), sign(null, message, factorKey.privateKey).toString("base64url")), factorKey };
}
type Device = ReturnType<typeof pair>;
function factor(sessions: CloudSessions, device: Device, method: string, path: string, body: unknown = {}) {
  const purpose = stepPurpose(method, path, body), challenge = sessions.challenge(device.deviceId, purpose), at = Date.now();
  const signature = sign(null, Buffer.from(`murage:${sessions.environmentId}:${device.deviceId}:${purpose}:${challenge}:${at}`), device.factorKey.privateKey).toString("base64url");
  return { "x-murage-step-up": Buffer.from(JSON.stringify({ challenge, at, signature })).toString("base64url") };
}
async function fixture(provider: HomeSignInProvider) {
  const directory = mkdtempSync(join(tmpdir(), "cloud-signin-composed-")), key = Buffer.alloc(32, 17);
  cleanup.push(() => removeTempDirSync(directory));
  const sessions = new CloudSessions(new DatabaseSync(join(directory, "sessions.db")));
  cleanup.push(() => sessions.db.close());
  let store = new SealedSecretStore(directory, "synthetic-machine", key);
  store.patch({ fluxApiKey: "unrelated-preserved" });
  const challenge = provider === "chatgpt"
    ? { device_auth_id: "private-device", user_code: "CODE-1", interval: "5" }
    : { device_code: "private-device", user_code: "CODE-1", verification_uri: "https://auth.x.ai/device", expires_in: 900, interval: 5 };
  const replies = [challenge, ...(provider === "chatgpt" ? [{ authorization_code: "private-code", code_verifier: verifier, code_challenge: s256Challenge(verifier) }] : []), tokens];
  const urls = provider === "chatgpt"
    ? ["https://auth.openai.com/api/accounts/deviceauth/usercode", "https://auth.openai.com/api/accounts/deviceauth/token", "https://auth.openai.com/oauth/token"]
    : ["https://auth.x.ai/oauth2/device/code", "https://auth.x.ai/oauth2/token"];
  const providerFetch = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    expect(String(url)).toBe(urls.shift());
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected synthetic provider request");
    return Response.json(reply);
  });
  let signIns = new ModelSignIns({ env: {} });
  const privateMessages: object[] = [];
  let client: ReturnType<typeof createCloudModelSignInClient>;
  const send = (message: object) => {
    privateMessages.push(message);
    if (!client.receive(message)) signIns.apply(message);
  };
  const makeManager = () => createHomeModelSignIn({ store, env: {}, fetch: providerFetch as typeof fetch, publish: entries => send({ type: "murage:model-signin", entries }) });
  let manager = makeManager();
  const makePort = () => createSupervisorPort({ store, modelSignIn: manager, send, generation: () => 7, remintConnectedApps: async credentials => credentials });
  let supervisor = makePort();
  client = createCloudModelSignInClient(message => { void supervisor.handle(message, 7); });
  cleanup.push(() => { client.dispose(); supervisor.dispose(); manager.dispose(); store.close(); });
  await supervisor.handle({ type: "murage:cloud-model-signin-ready" }, 7);
  const remove = vi.fn(async (_provider: HomeSignInProvider) => {});
  const auth = createCloudRequestAuth({ sessions, publicOrigin: origin, bootstrapSecret: () => undefined });
  const api = createCloudModelSignInApi({ environmentId: sessions.environmentId, activeDevice: id => Boolean(sessions.device(id)), invoke: input => client.request(input), invalidateOwner: id => client.invalidate(id), removeConnection: remove,
    readBody: async (req, max) => {
      const cached = cloudBodies.get(req);
      if (cached) { if (cached.bytes > max) throw new HomeSignInError("invalid-request"); return cached.body; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks); if (bytes.length > max) throw new HomeSignInError("invalid-request");
      return bytes.length ? JSON.parse(bytes.toString()) : {};
    },
  });
  const upstream = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => provider === "chatgpt"
    ? new Response('data: {"type":"response.completed","response":{"id":"synthetic-response","status":"completed","output":[]}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } })
    : Response.json({ id: "synthetic-response", choices: [] }));
  const catalog = (id: string): ProviderCatalog => ({ connectionId: id, stale: false, assurance: "catalog-only", models: [] });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, origin);
    if (await handleModelGateway(req, res, url.pathname, { signIns, catalog, fetch: upstream as typeof fetch })) return;
    if (await auth(req, res, url)) return;
    if (await api(req, res, url)) return;
    res.writeHead(404).end();
  });
  cleanup.push(async () => { if (server.listening) { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const publicReplies: unknown[] = [];
  const call = (method: string, path: string, device?: Device, body?: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: any; cache?: string }>((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: "home.example", origin, ...(device ? { authorization: `Bearer ${device.accessToken}` } : {}), ...(bytes ? { "content-type": "application/json", "content-length": String(bytes.length) } : {}), ...headers } }, res => {
      const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => { const text = Buffer.concat(chunks).toString(); const result = { status: res.statusCode!, body: text ? JSON.parse(text) : null, cache: res.headers["cache-control"] }; publicReplies.push(result); resolve(result); });
    }); req.on("error", reject); req.end(bytes);
  });
  return { sessions, providerFetch, privateMessages, publicReplies, upstream, call, remove, port,
    registry: () => signIns,
    document: () => JSON.parse(store.getAll()[CLOUD_MODEL_SIGNINS_KEY]),
    sealed: () => readFileSync(join(directory, "credentials.enc"), "utf8"),
    async restart() {
      supervisor.dispose(); manager.dispose(); store.close();
      store = new SealedSecretStore(directory, "synthetic-machine", key);
      signIns = new ModelSignIns({ env: {} }); manager = makeManager(); supervisor = makePort();
      await supervisor.handle({ type: "murage:cloud-model-signin-ready" }, 7);
    },
  };
}

describe("paired owner HTTP to actual home custody and private gateway", () => {
  it.each([
    ["chatgpt", "owner-desktop"], ["chatgpt", "owner-phone"],
    ["supergrok", "owner-desktop"], ["supergrok", "owner-phone"],
  ] as const)("%s / %s connects, reloads and revokes through the composed path", async (provider, scope) => {
    const h = await fixture(provider), owner = pair(h.sessions, scope), other = pair(h.sessions, scope);
    const startPath = `${base}/${provider}/start`, id = SIGNIN_CONNECTION_IDS[provider];
    expect((await h.call("GET", base, owner)).status).toBe(200);
    expect((await h.call("POST", startPath, owner, {})).status).toBe(403);
    expect(h.providerFetch).not.toHaveBeenCalled();
    const assertion = factor(h.sessions, owner, "POST", startPath);
    const begun = await h.call("POST", startPath, owner, {}, assertion);
    expect(begun).toMatchObject({ status: 202, cache: "no-store", body: { provider, state: "waiting", userCode: "CODE-1" } });
    expect((await h.call("POST", startPath, owner, {}, assertion)).status).toBe(403);
    const attemptPath = `${base}/${provider}/attempts/${begun.body.attemptId}`;
    expect((await h.call("GET", attemptPath, other)).status).toBe(404);
    expect((await h.call("GET", attemptPath, owner)).body.state).toBe("waiting");
    expect(h.providerFetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await h.call("GET", attemptPath, owner)).body.state).toBe("connected");
    expect((await h.call("GET", base, owner)).body.providers).toEqual(expect.arrayContaining([expect.objectContaining({ provider, state: "connected" })]));
    expect(h.providerFetch).toHaveBeenCalledTimes(provider === "chatgpt" ? 3 : 2);
    expect(h.document()[provider].refreshToken).toBe(tokens.refresh_token);
    expect(h.registry().bearer(id)?.accessToken).toBe(tokens.access_token);
    const oldKey = h.registry().issueGatewayKey(id);
    await h.restart();
    expect(h.registry().verifyGatewayKey(id, `Bearer ${oldKey}`)).toBe(false);
    expect(h.registry().bearer(id)?.accessToken).toBe(tokens.access_token);
    expect((await h.call("GET", attemptPath, owner)).status).toBe(404);
    expect((await h.call("GET", base, owner)).body.providers).toEqual(expect.arrayContaining([expect.objectContaining({ provider, state: "connected" })]));
    const gatewayKey = h.registry().issueGatewayKey(id), gatewayPath = `/api/model-gateway/${id}/v1`;
    const gatewayHeaders = { authorization: `Bearer ${gatewayKey}` };
    expect((await h.call("GET", `${gatewayPath}/models`, undefined, undefined, gatewayHeaders)).status).toBe(200);
    expect((await h.call("GET", `${gatewayPath}/models`, undefined, undefined, { authorization: `Bearer ${tokens.access_token}` })).status).toBe(401);
    const inferencePath = provider === "chatgpt" ? "responses" : "chat/completions";
    const inference = await h.call("POST", `${gatewayPath}/${inferencePath}`, undefined, { model: "synthetic-model", input: "hello", messages: [] }, gatewayHeaders);
    expect(inference.status).toBe(200);
    expect(h.upstream).toHaveBeenCalledTimes(1);
    expect(new Headers(h.upstream.mock.calls[0][1]?.headers).get("authorization")).toBe(`Bearer ${tokens.access_token}`);
    expect(String(h.upstream.mock.calls[0][0])).toBe(provider === "chatgpt" ? "https://chatgpt.com/backend-api/codex/responses" : "https://api.x.ai/v1/chat/completions");
    const engineEnv: NodeJS.ProcessEnv = {};
    const bound = applyProviderRoute("openai-compat", engineEnv, { connectionId: id, preset: provider, protocol: "openai", baseUrl: `http://127.0.0.1:${h.port}${gatewayPath}`, apiKey: gatewayKey, model: "synthetic-model", revision: h.registry().records()[0].revision });
    try {
      const engine = JSON.stringify([engineEnv, bound.args]);
      expect(engine).toContain(gatewayKey);
      const publicText = JSON.stringify(h.publicReplies), privateText = JSON.stringify(h.privateMessages);
      expect(privateText).toContain(tokens.access_token);
      for (const secret of [tokens.access_token, tokens.refresh_token, idToken, "private-device", verifier]) {
        expect(publicText).not.toContain(secret); expect(engine).not.toContain(secret); expect(h.sealed()).not.toContain(secret);
      }
      expect(privateText).not.toContain(tokens.refresh_token); expect(privateText).not.toContain(idToken);
    } finally { bound.cleanup(); }
    const endPath = scope === "owner-desktop" ? `${base}/${provider}/sign-out` : `${base}/${provider}`;
    const method = scope === "owner-desktop" ? "POST" : "DELETE";
    expect((await h.call(method, endPath, owner, {}, factor(h.sessions, owner, method, endPath))).status).toBe(204);
    expect(h.registry().bearer(id)).toBeNull();
    expect(h.registry().verifyGatewayKey(id, `Bearer ${gatewayKey}`)).toBe(false);
    expect((await h.call("GET", `${gatewayPath}/models`, undefined, undefined, gatewayHeaders)).status).toBe(401);
    expect(h.document()).toEqual({});
    if (method === "DELETE") expect(h.remove).toHaveBeenCalledExactlyOnceWith(provider);
    else expect(h.remove).not.toHaveBeenCalled();
    await h.restart();
    expect(h.registry().bearer(id)).toBeNull();
    expect((await h.call("GET", base, owner)).body.providers).toEqual(expect.arrayContaining([expect.objectContaining({ provider, state: "signed-out" })]));
    expect(h.providerFetch).toHaveBeenCalledTimes(provider === "chatgpt" ? 3 : 2);
  });
});
