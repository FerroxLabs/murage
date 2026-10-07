// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { expect, it, vi } from "vitest";
import { NETLIFY_API, createSite, deleteDeploy, deleteSite, deployZip, getSite, isPublicHttpsUrl, liveCheck, PublishError } from "./netlify.ts";

const TOKEN = "nfp_SECRET_TOKEN_123";
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const zip = Buffer.from("PK-fake");
const fail = async (run: () => Promise<unknown>) => { try { await run(); } catch (error) { return error as PublishError; } throw new Error("expected a failure"); };

it("creates a site by name, then deploys the zip to it, with the bearer on every call", async () => {
  const calls: { url: string; method: string; type: string | null; auth: string | null; body: unknown }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input), headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", type: headers.get("content-type"), auth: headers.get("authorization"), body: init?.body });
    return url.endsWith("/sites") ? json(201, { id: "site-1", name: "my-shop", ssl_url: "https://my-shop.netlify.app" }) : json(200, { id: "dep-1", site_id: "site-1", ssl_url: "https://my-shop.netlify.app", state: "uploaded" });
  });
  const site = await createSite({ token: TOKEN, name: "my-shop", fetchImpl });
  expect(site).toEqual({ siteId: "site-1", url: "https://my-shop.netlify.app" });
  const deploy = await deployZip({ token: TOKEN, siteId: "site-1", zip, fetchImpl });
  expect(deploy).toEqual({ siteId: "site-1", deployId: "dep-1", url: "https://my-shop.netlify.app" });
  expect(calls[0]).toMatchObject({ url: `${NETLIFY_API}/sites`, method: "POST", type: "application/json", auth: `Bearer ${TOKEN}` });
  expect(JSON.parse(String(calls[0]!.body))).toEqual({ name: "my-shop" });
  expect(calls[1]).toMatchObject({ url: `${NETLIFY_API}/sites/site-1/deploys`, method: "POST", type: "application/zip", auth: `Bearer ${TOKEN}` });
  expect(calls[1]!.body).toBe(zip);
});

it("reads an existing site for its address", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => json(200, { id: "site-9", ssl_url: "https://old.netlify.app", url: "http://old.netlify.app" }));
  expect(await getSite({ token: TOKEN, siteId: "site-9", fetchImpl })).toEqual({ siteId: "site-9", url: "https://old.netlify.app" });
  expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${NETLIFY_API}/sites/site-9`);
});

it("maps 401 and 403 to reconnect", async () => {
  for (const status of [401, 403]) {
    const error = await fail(() => deployZip({ token: TOKEN, siteId: "s", zip, fetchImpl: async () => json(status, { message: "nope", echo: TOKEN }) }));
    expect(error).toBeInstanceOf(PublishError);
    expect(error.code).toBe("reconnect");
    expect(error.message).toMatch(/reconnect Netlify/i);
  }
});

it("maps 429 to try again in a minute", async () => {
  const error = await fail(() => deployZip({ token: TOKEN, siteId: "s", zip, fetchImpl: async () => json(429, {}, { "retry-after": "30" }) }));
  expect(error.code).toBe("rate-limited");
  expect(error.message).toMatch(/try again in a minute/i);
});

it("maps 5xx and network failures to a plain retry", async () => {
  for (const make of [async () => json(502, { error: "bad gateway" }), async () => { throw new TypeError("fetch failed " + TOKEN); }]) {
    const error = await fail(() => deployZip({ token: TOKEN, siteId: "s", zip, fetchImpl: make as typeof fetch }));
    expect(error.code).toBe("host-down");
    expect(error.message).toMatch(/Netlify/);
  }
});

it("says plainly when the address is taken", async () => {
  const error = await fail(() => createSite({ token: TOKEN, name: "taken", fetchImpl: async () => json(422, { errors: { subdomain: ["must be unique"] } }) }));
  expect(error.code).toBe("name-taken");
  expect(error.message).toContain("taken");
});

it("never puts the token, or an upstream body, in an error", async () => {
  for (const status of [400, 401, 404, 422, 429, 500, 503]) {
    const error = await fail(() => createSite({ token: TOKEN, name: "x", fetchImpl: async () => json(status, { message: `bad ${TOKEN}`, authorization: `Bearer ${TOKEN}` }) }));
    expect(JSON.stringify({ message: error.message, code: error.code, stack: error.stack })).not.toContain(TOKEN);
    expect(error.message).not.toContain("bad ");
  }
});

it("refuses a site id that could change the request path", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const siteId of ["../users", "a/b", "a?b", "", "x".repeat(100)]) {
    expect((await fail(() => deployZip({ token: TOKEN, siteId, zip, fetchImpl }))).code).toBe("bad-id");
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("deletes a site and a deploy by id, and treats already gone as done", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  await deleteSite({ token: TOKEN, siteId: "site-1", fetchImpl });
  await deleteDeploy({ token: TOKEN, deployId: "dep-1", fetchImpl });
  expect(fetchImpl.mock.calls.map(call => [String(call[0]), call[1]?.method])).toEqual([[`${NETLIFY_API}/sites/site-1`, "DELETE"], [`${NETLIFY_API}/deploys/dep-1`, "DELETE"]]);
  await deleteSite({ token: TOKEN, siteId: "site-1", fetchImpl: async () => json(404, {}) });
  expect((await fail(() => deleteSite({ token: TOKEN, siteId: "site-1", fetchImpl: async () => json(401, {}) }))).code).toBe("reconnect");
});

it("live check passes on a 200 that carries the page, and retries until it does", async () => {
  const sleeps: number[] = [];
  let n = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => (++n < 3 ? new Response("Not Found", { status: 404 }) : new Response("<html><title>My Shop</title><body>hello</body></html>", { status: 200 })));
  const ok = await liveCheck({ url: "https://my-shop.netlify.app", expect: "My Shop", fetchImpl, sleep: async ms => { sleeps.push(ms); }, tries: 5 });
  expect(ok).toEqual({ live: true });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(sleeps).toHaveLength(2);
});

it("live check fails on a 200 with the wrong page, or never loading", async () => {
  const wrong = await liveCheck({ url: "https://x.netlify.app", expect: "My Shop", fetchImpl: async () => new Response("Site not found", { status: 200 }), sleep: async () => {}, tries: 2 });
  expect(wrong.live).toBe(false);
  const down = await liveCheck({ url: "https://x.netlify.app", expect: "My Shop", fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, sleep: async () => {}, tries: 2 });
  expect(down).toMatchObject({ live: false });
});

it("only opens public https addresses and follows no redirects", async () => {
  for (const bad of ["http://x.netlify.app", "https://127.0.0.1/", "https://localhost/", "https://[::1]/", "https://10.0.0.5/", "https://user:pw@x.netlify.app/", "https://x.netlify.app:8443/", "https://printer.local/", "https://intranet/"]) expect(isPublicHttpsUrl(bad)).toBe(false);
  expect(isPublicHttpsUrl("https://my-shop.netlify.app")).toBe(true);
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("<title>My Shop</title>", { status: 200 }));
  await liveCheck({ url: "https://my-shop.netlify.app", expect: "My Shop", fetchImpl, sleep: async () => {}, tries: 1 });
  expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
});

it("live check only fetches https addresses", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  expect((await liveCheck({ url: "http://x.netlify.app", expect: "a", fetchImpl, sleep: async () => {}, tries: 1 })).live).toBe(false);
  expect(fetchImpl).not.toHaveBeenCalled();
});
