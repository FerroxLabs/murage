// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The Netlify adapter: Murage's own REST calls, never the Netlify MCP's
// tools (those deploy through a local CLI). The bearer comes from the
// caller; it is sent only to NETLIFY_API, only in the Authorization header,
// and never reaches an error, a log or a result. Errors carry fixed
// plain-language text, not the response body.
import { PublishError } from "./errors.ts";

export const NETLIFY_API = "https://api.netlify.com/api/v1";
export { PublishError };

type Fetch = typeof fetch;
interface Call { token: string; fetchImpl?: Fetch }
const ID = /^[A-Za-z0-9-]{1,64}$/;
const UPLOAD_TIMEOUT_MS = 120_000, API_TIMEOUT_MS = 30_000;

function checkId(id: string): string {
  if (typeof id !== "string" || !ID.test(id)) throw new PublishError("bad-id", "That site id does not look right. Use the id I gave you when the site was published.");
  return id;
}

/** One request, with every failure turned into a PublishError. */
async function call(options: Call & { path: string; method: "GET" | "POST" | "DELETE"; type?: string; body?: string | Buffer; timeoutMs?: number; allow404?: boolean }): Promise<Response | null> {
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${NETLIFY_API}${options.path}`, {
      method: options.method,
      headers: { authorization: `Bearer ${options.token}`, "user-agent": "Murage", accept: "application/json", ...(options.type ? { "content-type": options.type } : {}) },
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new PublishError("host-down", "I could not reach Netlify. Nothing was changed. Check the internet connection and try again in a minute.");
  }
  if (response.ok) return response;
  void response.body?.cancel().catch(() => {});
  const { status } = response;
  if (status === 401 || status === 403) throw new PublishError("reconnect", "Netlify did not accept the sign-in. Please reconnect Netlify and try again.");
  if (status === 429) throw new PublishError("rate-limited", "Netlify is limiting how often I can publish. Please try again in a minute.");
  if (status === 404 && options.allow404) return null;
  if (status === 404) throw new PublishError("not-found", "Netlify has no site with that id. It may already be removed.");
  if (status === 422) throw new PublishError("name-taken", "That site address is already taken on Netlify. Pick a different site name.");
  if (status >= 500) throw new PublishError("host-down", "Netlify had a problem on its side. Nothing was changed. Please try again in a minute.");
  throw new PublishError("host-down", "Netlify refused the request. Nothing was changed.");
}

async function read(response: Response): Promise<Record<string, unknown>> {
  try { const value = await response.json() as unknown; return value && typeof value === "object" ? value as Record<string, unknown> : {}; } catch { return {}; }
}
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const secureUrl = (body: Record<string, unknown>, fallbackName?: string): string | undefined => {
  const url = text(body.ssl_url) ?? text(body.url);
  if (url) return url.replace(/^http:\/\//, "https://");
  return fallbackName ? `https://${fallbackName}.netlify.app` : undefined;
};

/** A new empty site with this name (its address is https://<name>.netlify.app). */
export async function createSite(options: Call & { name: string }): Promise<{ siteId: string; url: string }> {
  const response = (await call({ ...options, path: "/sites", method: "POST", type: "application/json", body: JSON.stringify({ name: options.name }) }))!;
  const body = await read(response), siteId = text(body.id) ?? text(body.site_id), url = secureUrl(body, options.name);
  if (!siteId || !url) throw new PublishError("host-down", "Netlify answered, but not in a way I understand. Nothing was published.");
  return { siteId, url };
}

export async function getSite(options: Call & { siteId: string }): Promise<{ siteId: string; url: string }> {
  const id = checkId(options.siteId);
  const body = await read((await call({ ...options, path: `/sites/${encodeURIComponent(id)}`, method: "GET" }))!);
  const url = secureUrl(body);
  if (!url) throw new PublishError("host-down", "Netlify answered, but not in a way I understand.");
  return { siteId: id, url };
}

/** Find the owner's site by its Netlify address (such as my-shop.netlify.app) and report the id Netlify
 * knows it by. Only an address of that shape is accepted, so the path can never be steered elsewhere. */
export async function findSiteByAddress(options: Call & { address: string }): Promise<{ siteId: string; url: string }> {
  const address = options.address;
  if (typeof address !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}\.netlify\.app$/.test(address)) throw new PublishError("bad-name", "That does not look like a Netlify site address.");
  const body = await read((await call({ ...options, path: `/sites/${encodeURIComponent(address)}`, method: "GET" }))!);
  const siteId = text(body.id) ?? text(body.site_id), url = secureUrl(body);
  if (!siteId || !ID.test(siteId) || !url) throw new PublishError("host-down", "Netlify answered, but not in a way I understand.");
  return { siteId, url };
}

/** Check the token with the cheapest read there is. True when Netlify accepts it. */
export async function tokenWorks(options: Call): Promise<boolean> {
  try { await call({ ...options, path: "/user", method: "GET" }); return true; }
  catch (error) { if (error instanceof PublishError && error.code === "reconnect") return false; throw error; }
}

/** Upload a zip as a new deploy of an existing site. */
export async function deployZip(options: Call & { siteId: string; zip: Buffer }): Promise<{ siteId: string; deployId: string; url: string }> {
  const id = checkId(options.siteId);
  const response = (await call({ ...options, path: `/sites/${encodeURIComponent(id)}/deploys`, method: "POST", type: "application/zip", body: options.zip, timeoutMs: UPLOAD_TIMEOUT_MS }))!;
  const body = await read(response), deployId = text(body.id) ?? text(body.deploy_id), url = secureUrl(body);
  if (!deployId || !url) throw new PublishError("host-down", "Netlify answered, but not in a way I understand. Check the site before trying again.");
  return { siteId: id, deployId, url };
}

/** The site a saved version belongs to, so a take-down names what it really removes. */
export async function getDeploy(options: Call & { deployId: string }): Promise<{ deployId: string; siteId: string | undefined }> {
  const id = checkId(options.deployId);
  const body = await read((await call({ ...options, path: `/deploys/${encodeURIComponent(id)}`, method: "GET" }))!);
  return { deployId: id, siteId: text(body.site_id) };
}

/** Take a whole site down. A site that is already gone counts as done. */
export async function deleteSite(options: Call & { siteId: string }): Promise<void> {
  await call({ ...options, path: `/sites/${encodeURIComponent(checkId(options.siteId))}`, method: "DELETE", allow404: true });
}
export async function deleteDeploy(options: Call & { deployId: string }): Promise<void> {
  await call({ ...options, path: `/deploys/${encodeURIComponent(checkId(options.deployId))}`, method: "DELETE", allow404: true });
}

/** A public web address of a named host: https, no IP literal, no local or internal names, no credentials. */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return false;
  return !/(^|\.)(localhost|local|internal|localdomain|lan|home|corp)$/.test(host);
}

async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value); size += value.length;
    if (size >= max) { void reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

/** GET the address until it answers 200 with the page we sent. No redirects are followed. */
export async function liveCheck(options: { url: string; expect: string; fetchImpl?: Fetch; sleep?: (ms: number) => Promise<void>; tries?: number; delayMs?: number; signal?: AbortSignal }): Promise<{ live: true } | { live: false; reason: string }> {
  if (!isPublicHttpsUrl(options.url)) return { live: false, reason: "the address is not a public secure web address" };
  const tries = options.tries ?? 8, sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let reason = "it did not answer";
  for (let attempt = 0; attempt < tries; attempt++) {
    if (options.signal?.aborted) return { live: false, reason: "the check was stopped" };
    if (attempt) await sleep(options.delayMs ?? 1500);
    try {
      const response = await (options.fetchImpl ?? fetch)(options.url, { redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), headers: { "user-agent": "Murage" } });
      const page = response.status === 200 ? await readCapped(response, 2_000_000) : (void response.body?.cancel().catch(() => {}), "");
      if (response.status === 200 && page.includes(options.expect)) return { live: true };
      reason = response.status === 200 ? "the page that loaded is not the one I sent" : `it answered with ${response.status}`;
    } catch { reason = "it did not answer"; }
  }
  return { live: false, reason };
}
