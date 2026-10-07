// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The desktop side of the owner's own MCP servers (MCP-LINK 3.4, 3.7, T11):
// what the renderer's `window.muragebox.mcpServers.*` calls reach through IPC.
// Every secret the owner types arrives here, is written to credentials.bin
// first, and only then is the harness handed its share over the commit route.
// The renderer never sends a secret to the harness and never gets one back.
//
// The harness contract this relies on (server/index.ts):
//  - GET /api/mcp/servers: the listing (names, masked links, never a value);
//  - GET /api/mcp/servers/<name>/oauth-target: the non-secret sign-in target;
//  - PUT /api/mcp/servers/<name>/secrets: the WHOLE projection of one doc, and
//    for a link server it must name the origin it was issued for (L-d): 400
//    without, 409 for another origin than the entry's;
//  - DELETE /api/mcp/servers/<name>/secrets and DELETE /api/mcp/servers/<name>.
import { guardedRequest } from "../../shared/guarded-http.mjs";
import { sameOrigin } from "../../shared/remote-mcp-url.mjs";
import { isHeadlessEnvironment } from "../model-signin-oauth.mjs";
import { clientOnly, handleSecretsStale, projectDoc, readServerDoc, SERVER_NAME, serverNames, withServerDoc } from "./custody.mjs";
import { discoverAuthorization } from "./discovery.mjs";
import { runSignInFlow, unionScopes } from "./flow.mjs";
import { createRefresher } from "./refresher.mjs";
import { revokeTokens } from "./revoke.mjs";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_HEADERS = 16;
const MAX_HEADER_VALUE = 8 * 1024;
const MAX_ENV = 64;
const MAX_ENV_VALUE = 16 * 1024;
const MAX_URL = 8 * 1024;

const fail = (error, message) => ({ ok: false, error, message });
const originOf = (url) => { try { const origin = new URL(url).origin; return origin === "null" ? undefined : origin; } catch { return undefined; } };
const hostOf = (url) => { try { return new URL(url).hostname || "this server"; } catch { return "this server"; } };

const MESSAGES = {
  headless: "Sign in needs the Murage desktop app.",
  notFound: "This server is not saved yet. Add it first.",
  invalid: "Murage could not use what was entered. Check it and try again.",
  stale: "This server changed while saving. Enter it again.",
  storage: "Murage could not save this to the secure store on this computer.",
  busy: "A sign-in for this server is already waiting in your browser.",
  notSignIn: "This server does not use sign-in.",
  unknown: "Something went wrong. Try again.",
  signedOutRevoked: (host) => `Signed out. Murage also signed you out of ${host}.`,
  signedOutForgot: (host) => `Signed out. Murage forgot this sign-in. To cut access completely, remove Murage from your ${host} account settings.`,
  removedRevoked: (host) => `Removed. Murage also signed you out of ${host}.`,
  removedForgot: (host) => `Removed. Murage forgot this sign-in. To cut access completely, remove Murage from your ${host} account settings.`,
  removedFailed: (host) => `Removed. Murage could not reach ${host} to sign out. To cut access completely, remove Murage from your ${host} account settings.`,
  signOutFailed: (host) => `Murage could not reach ${host} to sign out, so it did not sign you out there. This computer forgot the sign-in. To cut access completely, remove Murage from your ${host} account settings.`,
  flow: {
    cancelled: () => "Sign-in was cancelled.",
    denied: (host) => `${host} did not allow the sign-in.`,
    timeout: () => "Sign-in took too long. Try again.",
    port: () => "Murage could not open a sign-in window on this computer. Try again.",
    browser: () => "Murage could not open your browser. Try again.",
    refused: (host) => `${host} gave sign-in details Murage cannot use. Use an API key instead.`,
    "no-registration": (host) => `${host} does not let apps sign in this way. Use an API key instead.`,
    network: (host) => `Murage could not reach ${host}. Check your connection and try again.`,
    token: (host) => `${host} did not finish the sign-in. Try again.`,
  },
};

/**
 * @param {object} deps
 * @param {() => Record<string, unknown>} deps.readDocument  the latest credentials document
 * @param {(derive: (c: Record<string, unknown>) => unknown) => Promise<unknown>} deps.updateDocument  the one serialized writer
 * @param {(route: string, init?: { method?: string, body?: unknown }) => Promise<{ status: number, body?: any }>} deps.commit
 *   an authorized request to the harness (desktop proof plus the MCP commit token)
 * @param {(url: string) => Promise<void>} deps.openExternal
 * @param {() => import("node:http").Server} deps.createServer
 * @param {(line: string) => void} [deps.log]  never receives a value
 */
export function createMcpServers(deps) {
  const request = deps.request ?? guardedRequest;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const flows = new Map();

  const read = (name) => readServerDoc(deps.readDocument(), name);
  /** Serialized change of one doc. `derive` returns the next doc, null to remove it, undefined to leave it. Resolves the kept doc. */
  async function update(name, derive) {
    let kept;
    await deps.updateDocument((credentials) => {
      const next = derive(readServerDoc(credentials, name));
      if (next === undefined) return credentials;
      kept = next;
      return withServerDoc(credentials, name, next);
    });
    return kept;
  }

  /** Hand the harness the whole projection of one doc (a push replaces). A 404
   * or 409 means the entry is gone or now points elsewhere: main drops its
   * copy too, so nothing is ever sent to an address it was not issued for. */
  async function push(name, docOverride) {
    const doc = docOverride ?? read(name);
    const projection = projectDoc(doc);
    let answer;
    try {
      answer = projection
        ? await deps.commit(`/api/mcp/servers/${name}/secrets`, { method: "PUT", body: projection })
        : await deps.commit(`/api/mcp/servers/${name}/secrets`, { method: "DELETE" });
    } catch {
      log(`mcp server ${name}: the harness could not be reached to hand over its secrets`);
      return "offline";
    }
    if (answer.status === 200) return "ok";
    if (answer.status === 404 || answer.status === 409) {
      if (projection) {
        try { await update(name, (current) => current && JSON.stringify(projectDoc(current)) === JSON.stringify(projection) ? null : undefined); }
        catch { log(`mcp server ${name}: its saved secrets could not be dropped`); }
      }
      return "stale";
    }
    log(`mcp server ${name}: the harness refused its secrets (${answer.status})`);
    return "refused";
  }

  const refresher = createRefresher({
    read, update, push, request, now, log,
    setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout,
  });

  async function listing(name) {
    let answer;
    try { answer = await deps.commit("/api/mcp/servers", { method: "GET" }); } catch { return { error: "unknown" }; }
    if (answer.status !== 200 || !Array.isArray(answer.body?.servers)) return { error: "unknown" };
    const entry = answer.body.servers.find((row) => row?.name === name);
    return entry ? { entry } : { error: "not-found" };
  }

  function validSecrets(input, entry) {
    if (!isRecord(input)) return null;
    const keys = Object.keys(input);
    if (keys.length === 0 || keys.some((key) => !["headers", "url", "env"].includes(key))) return null;
    const out = {};
    if (entry.kind === "stdio") {
      if (input.headers !== undefined || input.url !== undefined || !isRecord(input.env)) return null;
      const names = Object.keys(input.env);
      if (names.length === 0 || names.length > MAX_ENV) return null;
      const allowed = new Set(Array.isArray(entry.envKeys) ? entry.envKeys : []);
      for (const [key, value] of Object.entries(input.env)) {
        if (!allowed.has(key) || typeof value !== "string" || value.length > MAX_ENV_VALUE || value.includes("\0")) return null;
      }
      out.env = { ...input.env };
      return out;
    }
    if (input.env !== undefined) return null;
    if (input.headers !== undefined) {
      if (!isRecord(input.headers)) return null;
      const names = Object.keys(input.headers);
      if (names.length === 0 || names.length > MAX_HEADERS) return null;
      const allowed = new Set(Array.isArray(entry.headerNames) ? entry.headerNames : []);
      for (const [key, value] of Object.entries(input.headers)) {
        if (!allowed.has(key) || typeof value !== "string" || !value || value.length > MAX_HEADER_VALUE || /[\r\n\0]/.test(value)) return null;
      }
      out.headers = { ...input.headers };
    }
    if (input.url !== undefined) {
      if (typeof input.url !== "string" || input.url.length > MAX_URL) return null;
      let parsed;
      try { parsed = new URL(input.url); } catch { return null; }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
      if (!sameOrigin(input.url, entry.url)) return null;
      out.url = input.url;
    }
    return out;
  }

  async function saveSecrets(name, input) {
    if (typeof name !== "string" || !SERVER_NAME.test(name)) return fail("invalid", MESSAGES.invalid);
    const found = await listing(name);
    if (found.error) return fail(found.error, found.error === "not-found" ? MESSAGES.notFound : MESSAGES.unknown);
    const entry = found.entry;
    const values = validSecrets(input, entry);
    if (!values) return fail("invalid", MESSAGES.invalid);
    const origin = entry.kind === "stdio" ? undefined : originOf(entry.url);
    if (entry.kind !== "stdio" && !origin) return fail("invalid", MESSAGES.invalid);
    try {
      await update(name, (current) => {
        // A doc issued for another address, or for the other kind of server, starts over.
        const base = current && (origin === undefined ? current.origin === undefined : current.origin === origin) ? current : {};
        const next = { ...base, savedAt: now() };
        if (origin) next.origin = origin;
        if (values.headers) next.headers = { ...(isRecord(base.headers) ? base.headers : {}), ...values.headers };
        if (values.url) next.url = values.url;
        if (values.env) next.env = { ...(isRecord(base.env) ? base.env : {}), ...values.env };
        return next;
      });
    } catch {
      return fail("storage", MESSAGES.storage);
    }
    const pushed = await push(name);
    if (pushed === "stale") return fail("stale", MESSAGES.stale);
    if (pushed !== "ok") return fail("unknown", MESSAGES.unknown);
    return { ok: true };
  }

  async function signIn(name) {
    if (isHeadlessEnvironment(deps.platform ?? process.platform, deps.env ?? process.env)) return fail("headless", MESSAGES.headless);
    if (typeof name !== "string" || !SERVER_NAME.test(name)) return fail("invalid", MESSAGES.invalid);
    if (flows.has(name)) return fail("busy", MESSAGES.busy);
    const flow = { finish: null, cancelled: false };
    flows.set(name, flow);
    try {
      const found = await listing(name);
      if (found.error) return fail(found.error, found.error === "not-found" ? MESSAGES.notFound : MESSAGES.unknown);
      if (found.entry.kind === "stdio" || found.entry.auth !== "oauth") return fail("not-sign-in", MESSAGES.notSignIn);
      let answer;
      try { answer = await deps.commit(`/api/mcp/servers/${name}/oauth-target`, { method: "GET" }); } catch { return fail("unknown", MESSAGES.unknown); }
      if (answer.status === 404) return fail("not-found", MESSAGES.notFound);
      if (answer.status === 409) return fail("not-sign-in", typeof answer.body?.error === "string" ? answer.body.error : MESSAGES.notSignIn);
      const target = answer.body;
      if (answer.status !== 200 || !isRecord(target) || typeof target.url !== "string" || !originOf(target.url)) return fail("unknown", MESSAGES.unknown);
      const host = hostOf(target.url);
      if (flow.cancelled) return fail("cancelled", MESSAGES.flow.cancelled(host));
      const discovery = await discoverAuthorization({
        url: target.url,
        ...(typeof target.resourceMetadataUrl === "string" ? { resourceMetadataUrl: target.resourceMetadataUrl } : {}),
        ...(target.local === "this-computer" || target.local === "local-network" ? { local: target.local } : {}),
      }, { request });
      if (!discovery.ok) return fail(discovery.error, discovery.message);
      if (flow.cancelled) return fail("cancelled", MESSAGES.flow.cancelled(host));
      const origin = originOf(target.url);
      const saved = read(name);
      const stored = saved?.origin === origin && isRecord(saved?.oauth) && saved.oauth.issuer === discovery.issuer ? saved.oauth : undefined;
      // Step-up (3.7 step 10): what was granted before, plus what the server asks for now.
      const scope = unionScopes(stored?.scope, typeof target.scopeHint === "string" && target.scopeHint ? target.scopeHint : discovery.scopesSupported);
      const local = target.local === "this-computer" || target.local === "local-network" ? target.local : undefined;
      const result = await runSignInFlow({ discovery, target: { url: target.url, ...(local ? { local } : {}) }, stored, scope }, {
        request, now, createServer: deps.createServer, openExternal: deps.openExternal,
        register: ({ finish }) => { flow.finish = finish; if (flow.cancelled) finish({ error: "cancelled" }); },
        onSettled: () => { flow.finish = null; },
      });
      if (!result.ok) {
        const message = MESSAGES.flow[result.error]?.(host) ?? MESSAGES.unknown;
        return fail(MESSAGES.flow[result.error] ? result.error : "unknown", message);
      }
      // Removed, signed out or cancelled while the code was being exchanged: the
      // grant the server just issued is revoked there, never just dropped here.
      const revokeIssued = () => revokeTokens(result.oauth, { request }).catch(() => undefined);
      if (flow.cancelled) { await revokeIssued(); return fail("cancelled", MESSAGES.flow.cancelled(host)); }
      await refresher.settle(name);
      try {
        await update(name, (current) => {
          const base = current && current.origin === origin ? current : {};
          return { ...base, origin, oauth: result.oauth, savedAt: now() };
        });
      } catch {
        return fail("storage", MESSAGES.storage);
      }
      refresher.forget(name);
      const pushed = await push(name);
      // Remove, sign-out or cancel can land after the check above, while the
      // grant was being saved or pushed: it is revoked and dropped all the same.
      if (flow.cancelled) {
        await revokeIssued();
        try {
          const kept = await update(name, (current) => current?.oauth?.accessToken === result.oauth.accessToken
            ? { ...current, oauth: clientOnly(current.oauth), savedAt: now() }
            : undefined);
          if (kept) await push(name);
        } catch { log(`mcp server ${name}: a cancelled sign-in could not be dropped`); }
        return fail("cancelled", MESSAGES.flow.cancelled(host));
      }
      if (pushed === "stale") { await revokeIssued(); return fail("stale", MESSAGES.stale); }
      if (pushed !== "ok") return fail("unknown", MESSAGES.unknown);
      refresher.schedule(name);
      return { ok: true };
    } catch {
      return fail("unknown", MESSAGES.unknown);
    } finally {
      if (flows.get(name) === flow) flows.delete(name);
    }
  }

  function cancelSignIn(name) {
    const flow = flows.get(name);
    if (!flow) return false;
    flow.cancelled = true;
    flow.finish?.({ error: "cancelled" });
    return true;
  }

  async function forgetTokens(name) {
    await update(name, (current) => current?.oauth ? { ...current, oauth: clientOnly(current.oauth), savedAt: now() } : undefined);
    refresher.forget(name);
    await push(name);
  }

  async function signOut(name) {
    if (typeof name !== "string" || !SERVER_NAME.test(name)) return fail("invalid", MESSAGES.invalid);
    cancelSignIn(name);
    await refresher.settle(name);
    const oauth = refresher.heldDoc(name)?.oauth ?? read(name)?.oauth;
    const host = hostOf(oauth?.resource);
    if (!oauth?.accessToken && !oauth?.refreshToken) return { ok: true, revoked: false, message: "Signed out." };
    const revoked = await revokeTokens(oauth, { request });
    // The local tokens are cleared even when the server could not be reached.
    try { await forgetTokens(name); } catch { return fail("storage", MESSAGES.storage); }
    if (!revoked.revoked && revoked.reason === "failed") return fail("network", MESSAGES.signOutFailed(host));
    return revoked.revoked
      ? { ok: true, revoked: true, message: MESSAGES.signedOutRevoked(host) }
      : { ok: true, revoked: false, message: MESSAGES.signedOutForgot(host) };
  }

  async function remove(name) {
    if (typeof name !== "string" || !SERVER_NAME.test(name)) return fail("invalid", MESSAGES.invalid);
    cancelSignIn(name);
    await refresher.settle(name);
    const oauth = refresher.heldDoc(name)?.oauth ?? read(name)?.oauth;
    let revoked = null, message = "Removed.";
    if (oauth?.accessToken || oauth?.refreshToken) {
      const host = hostOf(oauth.resource);
      const result = await revokeTokens(oauth, { request });
      revoked = result.revoked;
      message = result.revoked ? MESSAGES.removedRevoked(host) : result.reason === "failed" ? MESSAGES.removedFailed(host) : MESSAGES.removedForgot(host);
    }
    refresher.forget(name);
    try { await update(name, (current) => current ? null : undefined); }
    catch { log(`mcp server ${name}: its saved secrets could not be dropped; the next start drops them`); }
    let answer;
    try { answer = await deps.commit(`/api/mcp/servers/${name}`, { method: "DELETE" }); } catch { return fail("unknown", MESSAGES.unknown); }
    if (answer.status !== 200 && answer.status !== 404) return fail("unknown", typeof answer.body?.error === "string" ? answer.body.error : MESSAGES.unknown);
    return { ok: true, revoked, message };
  }

  /** After the harness starts: hand it every saved doc (each with its origin),
   * then refresh what expired while Murage was closed and schedule the rest. */
  async function resume({ now: at } = {}) {
    for (const name of serverNames(deps.readDocument())) {
      const result = await push(name);
      if (result === "ok") refresher.resume(name, at ?? now());
    }
  }

  return {
    saveSecrets,
    signIn,
    cancelSignIn,
    signOut,
    remove,
    resume,
    refresh: (name, options) => (typeof name === "string" && SERVER_NAME.test(name) ? refresher.refresh(name, options) : Promise.resolve(false)),
    handleTokenRejected: (name) => (typeof name === "string" && SERVER_NAME.test(name) ? refresher.refresh(name, { reactive: true }) : Promise.resolve(false)),
    handleSecretsStale: (message) => handleSecretsStale(message, { updateDocument: deps.updateDocument, log }),
    dispose() {
      for (const name of [...flows.keys()]) cancelSignIn(name);
      refresher.dispose();
    },
  };
}
