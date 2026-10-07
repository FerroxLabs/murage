// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where to sign in to an MCP server (MCP-LINK 3.7 steps 2 and 3): the
// protected resource metadata (RFC 9728), then the authorization server
// metadata (RFC 8414 / OIDC discovery) in the 2025-11-25 order. Every fetch goes
// through the guarded client with the server's local confirmation, so the same
// address rules as the probe and the relay apply (and redirects are at most 3,
// re-judged, https only). Refusals:
//  - the PRM `resource` is not the server URL (scheme, host, port equal; path
//    equal or a parent at a segment boundary);
//  - the metadata `issuer` is not the identifier the PRM named;
//  - S256 is not offered;
//  - an endpoint is not https, unless the owner confirmed the server local and
//    the endpoint stays in that class.
import { guardedRequest } from "../../shared/guarded-http.mjs";
import { LIMITS, classifyHostname, confirmationFor } from "../../shared/remote-mcp-url.mjs";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const trimSlash = (path) => (path.endsWith("/") ? path.slice(0, -1) : path);

function hostOf(url) {
  try { return new URL(url).hostname || "this server"; } catch { return "this server"; }
}

export function resourceMatches(resource, serverUrl) {
  let r, s;
  try { r = new URL(resource); s = new URL(serverUrl); } catch { return false; }
  if (r.search || r.hash || r.username || r.password) return false;
  if (r.protocol !== s.protocol || r.hostname !== s.hostname || r.port !== s.port) return false;
  const rp = trimSlash(r.pathname), sp = trimSlash(s.pathname);
  return rp === sp || rp === "" || sp.startsWith(`${rp}/`);
}

/** RFC 9728 3.1: the path-inserted well-known first, then the root one. */
export function prmUrls(serverUrl) {
  const url = new URL(serverUrl);
  const path = trimSlash(url.pathname);
  const root = `${url.origin}/.well-known/oauth-protected-resource`;
  return path ? [`${root}${path}`, root] : [root];
}

/** RFC 8414 3.1 and OIDC discovery, path variants first, then the root ones. */
export function asMetadataUrls(issuer) {
  const url = new URL(issuer);
  const path = trimSlash(url.pathname);
  const rootUrls = [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  if (!path) return rootUrls;
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
    ...rootUrls,
  ];
}

/** https anywhere a public class allows; http only for a server the owner
 * confirmed local, and only when the endpoint is in that same class. */
export function endpointAllowed(value, local) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password) return false;
  const addressClass = classifyHostname(url.hostname);
  const needs = confirmationFor(addressClass);
  if (needs === "refused") return false;
  if (url.protocol === "https:") return needs === null || needs === local;
  if (url.protocol === "http:") return typeof local === "string" && needs === local;
  return false;
}

/** GET one metadata document. {status, json} or throws (network, refused address). */
async function fetchJson(url, { local, request, signal }) {
  const response = await request({
    url, method: "GET", kind: "metadata", mode: "request", confirmed: local ?? null,
    headers: { accept: "application/json" }, maxBytes: LIMITS.metadataBytes, signal,
  });
  let json = null;
  if (response.status === 200) {
    try { json = JSON.parse(Buffer.from(response.body).toString("utf8")); } catch { json = null; }
  }
  return { status: response.status, json: isRecord(json) ? json : null };
}

const refused = (url) => ({ ok: false, error: "refused", message: `${hostOf(url)} gave sign-in details Murage cannot use. Use an API key instead.` });
const noSignIn = (url) => ({ ok: false, error: "no-registration", message: `${hostOf(url)} does not let apps sign in this way. Use an API key instead.` });
const network = (url) => ({ ok: false, error: "network", message: `Murage could not reach ${hostOf(url)}. Check your connection and try again.` });

/**
 * @param {{ url: string, resourceMetadataUrl?: string, local?: "this-computer" | "local-network" }} target
 * @param {{ request?: typeof guardedRequest, signal?: AbortSignal }} [options]
 */
export async function discoverAuthorization(target, options = {}) {
  const request = options.request ?? guardedRequest;
  const local = target.local ?? null;
  const serverUrl = target.url;
  const ctx = { local, request, signal: options.signal };
  let server;
  try { server = new URL(serverUrl); } catch { return refused(serverUrl); }
  if (server.protocol !== "https:" && server.protocol !== "http:") return refused(serverUrl);

  // 1. protected resource metadata
  const candidates = [];
  if (typeof target.resourceMetadataUrl === "string" && endpointAllowed(target.resourceMetadataUrl, local)) candidates.push(target.resourceMetadataUrl);
  for (const url of prmUrls(serverUrl)) if (!candidates.includes(url)) candidates.push(url);
  let prm = null, reached = false;
  for (const url of candidates) {
    try {
      const answer = await fetchJson(url, ctx);
      reached = true;
      if (answer.json && typeof answer.json.resource === "string" && Array.isArray(answer.json.authorization_servers)) { prm = answer.json; break; }
    } catch { /* try the next place */ }
  }
  if (!prm) return reached ? noSignIn(serverUrl) : network(serverUrl);
  if (!resourceMatches(prm.resource, serverUrl)) return refused(serverUrl);
  const issuer = prm.authorization_servers[0];
  if (typeof issuer !== "string") return refused(serverUrl);
  let issuerUrl;
  try { issuerUrl = new URL(issuer); } catch { return refused(serverUrl); }
  if (issuerUrl.search || issuerUrl.hash || !endpointAllowed(issuer, local)) return refused(serverUrl);

  // 2. authorization server metadata
  let meta = null;
  reached = false;
  for (const url of asMetadataUrls(issuer)) {
    try {
      const answer = await fetchJson(url, ctx);
      reached = true;
      if (answer.json) { meta = answer.json; break; }
    } catch { /* try the next place */ }
  }
  if (!meta) return reached ? noSignIn(serverUrl) : network(serverUrl);
  if (typeof meta.issuer !== "string" || trimSlash(meta.issuer) !== trimSlash(issuer)) return refused(serverUrl);
  if (!Array.isArray(meta.code_challenge_methods_supported) || !meta.code_challenge_methods_supported.includes("S256")) return refused(serverUrl);
  const endpoint = (key, required) => {
    const value = meta[key];
    if (value === undefined && !required) return { ok: true, value: undefined };
    return typeof value === "string" && endpointAllowed(value, local) ? { ok: true, value } : { ok: false };
  };
  const authorization = endpoint("authorization_endpoint", true);
  const token = endpoint("token_endpoint", true);
  const registration = endpoint("registration_endpoint", false);
  const revocation = endpoint("revocation_endpoint", false);
  if (!authorization.ok || !token.ok || !registration.ok || !revocation.ok) return refused(serverUrl);
  const scopesSupported = Array.isArray(prm.scopes_supported) ? prm.scopes_supported.filter((scope) => typeof scope === "string" && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope)) : [];
  return {
    ok: true,
    serverUrl,
    host: hostOf(serverUrl),
    issuer,
    authorizationEndpoint: authorization.value,
    tokenEndpoint: token.value,
    ...(registration.value ? { registrationEndpoint: registration.value } : {}),
    ...(revocation.value ? { revocationEndpoint: revocation.value } : {}),
    issParameterSupported: meta.authorization_response_iss_parameter_supported === true,
    scopesSupported,
  };
}
