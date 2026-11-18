// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { checkReleaseAssets, pinnedReleaseAssets, rateLimitDelayMs, releaseAssetRef } from "./check-release-assets.mjs";

function fixture() {
  const data = JSON.parse(readFileSync(new URL("./fixtures/release-assets.json", import.meta.url)));
  const calls = [];
  const pins = Object.values(data.assets).flat().map((asset, index) => ({
    id: `fixture-${index}`, url: asset.browser_download_url, bytes: asset.size, sha256: "1".repeat(64),
  }));
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    if (parsed.hostname === "github.com") return new Response(null, { status: data.anonymousStatus ?? 200 });
    expect(options.headers.Authorization).toBe("Bearer fixture");
    expect(options.redirect).toBe("error");
    const path = parsed.pathname.replace(`/repos/${data.repo}`, "");
    if (path === "/releases") {
      // Optional first page forces traversal past 100 unrelated releases.
      if (data.paginated && parsed.searchParams.get("page") === "1") return Response.json(Array.from({ length: 100 }, (_, id) => ({ id: 100 + id, tag_name: `old-${id}` })));
      return Response.json(data.releases);
    }
    const assets = path.match(/^\/releases\/(\d+)\/assets$/);
    if (assets) return Response.json(data.assets[assets[1]] ?? []);
    const asset = path.match(/^\/releases\/assets\/(\d+)$/);
    if (asset) return Response.json(Object.values(data.assets).flat().find(row => row.id === Number(asset[1])));
    throw Error("Unexpected fixture request");
  };
  const sleeps = [];
  return { data, calls, pins, fetchImpl, token: "fixture", sleeps, sleep: async ms => { sleeps.push(ms); } };
}

it("accepts only public uploaded assets, including API-ID alternates and paginated releases; never sends a token to downloads", async () => {
  const f = fixture(); f.data.paginated = true;
  f.pins.push({ ...f.pins[0], url: "https://api.github.com/repos/fixture/runtime/releases/assets/10" });
  // API-ID anonymous probes use octet-stream rather than authenticated metadata.
  const fetchMetadata = f.fetchImpl;
  f.fetchImpl = (url, options) => {
    if (!options.method) return fetchMetadata(url, options);
    f.calls.push({ url, options });
    return Promise.resolve(new Response(null));
  };
  // The API-ID alternate is the same asset as pin 0, so its anonymous bytes are proven
  // once through that browser_download_url (2 URLs), never via anonymous api.github.com.
  expect(await checkReleaseAssets(f)).toEqual({ pins: 3, urls: 2, repositories: 1 });
  for (const { options } of f.calls.filter(call => call.options.method)) expect(options.headers).not.toHaveProperty("Authorization");
  expect(f.calls.filter(call => call.options.method).map(call => new URL(call.url).hostname)).toEqual(["github.com", "github.com"]);
  expect(f.calls.filter(call => new URL(call.url).pathname.endsWith("/releases"))).toHaveLength(2);
});

it.each(["browser", "signal"])("rejects a draft %s release even when authenticated metadata and asset downloads succeed", async kind => {
  const f = fixture(); f.data.releases[kind === "browser" ? 0 : 1].draft = true;
  await expect(checkReleaseAssets(f)).rejects.toThrow("Release is draft");
});

it.each(["release", "asset", "incomplete", "size", "digest", "anonymous", "unpublished"])("rejects %s failures in the release fixture", async failure => {
  const f = fixture();
  if (failure === "release") f.data.releases.pop();
  if (failure === "asset") f.data.assets["2"] = [];
  if (failure === "incomplete") f.data.assets["2"][0].state = "new";
  if (failure === "size") f.data.assets["2"][0].size++;
  if (failure === "digest") f.data.assets["1"][0].digest = `sha256:${"2".repeat(64)}`;
  if (failure === "anonymous") f.data.anonymousStatus = 404;
  if (failure === "unpublished") f.data.releases[1].published_at = null;
  await expect(checkReleaseAssets(f)).rejects.toThrow("Release asset CHECK failed");
});

it("fails closed on token, API permissions, and transport errors without printing credentials", async () => {
  const f = fixture();
  await expect(checkReleaseAssets({ ...f, token: "" })).rejects.toThrow("requires GH_TOKEN");
  await expect(checkReleaseAssets({ ...f, fetchImpl: async () => new Response(null, { status: 403 }) })).rejects.toThrow("metadata HTTP 403");
  await expect(checkReleaseAssets({ ...f, fetchImpl: async () => { throw Error("fixture credential must not appear"); } })).rejects.not.toThrow("fixture credential");
});

it("handles HEAD-not-supported with an anonymous bounded GET", async () => {
  const f = fixture(), metadata = f.fetchImpl, probes = [];
  f.fetchImpl = async (url, options) => {
    if (!options.method) return metadata(url, options);
    probes.push(options);
    return new Response(null, { status: options.method === "HEAD" ? 405 : 206 });
  };
  await checkReleaseAssets(f);
  expect(probes.map(row => row.method)).toEqual(["HEAD", "GET", "HEAD", "GET"]);
  expect(probes[1].headers).toEqual({ Accept: "application/octet-stream", Range: "bytes=0-0" });
});

it("also rejects a missing non-GitHub build input without sending credentials", async () => {
  const options = [];
  await expect(checkReleaseAssets({ token: "fixture", pins: [{ id: "source", url: "https://assets.fixture/source.tar.gz", sha256: "1".repeat(64) }],
    fetchImpl: async (_url, request) => { options.push(request); return new Response(null, { status: 404 }); },
  })).rejects.toThrow("Anonymous asset HTTP 404");
  expect(options[0].headers).not.toHaveProperty("Authorization");
});

it("derives all twelve blocked D-rows from shipped pins and gates the release before packaging", () => {
  const signalPin = JSON.parse(readFileSync(new URL("../server/channels/signal/runtime-pin.json", import.meta.url)));
  const pins = pinnedReleaseAssets({ signalPin: { ...signalPin, g0: { reviewed: true } } });
  expect(pins.slice(0, 12).map(pin => pin.id)).toEqual(["D027", "D028", "D029", "D030", "D031", "D032", "D033", "D038", "D040", "D044", "D045", "D046"]);
  expect(pins.slice(0, 12).every(pin => releaseAssetRef(pin.url))).toBe(true);
  expect(pins.every(pin => new URL(pin.url).protocol === "https:")).toBe(true);
  const workflow = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs.prepare.steps;
  const checkIndex = steps.findIndex(step => step.run === "node scripts/check-release-assets.mjs");
  const signalIndex = steps.findIndex(step => step.run === "node scripts/signal-release-check.mjs");
  expect(checkIndex, "release asset CHECK step must exist").toBeGreaterThanOrEqual(0);
  expect(signalIndex, "Signal release gate step must exist").toBeGreaterThanOrEqual(0);
  expect(checkIndex).toBeLessThan(signalIndex);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(steps[checkIndex].env.GH_TOKEN).toBe("${{ github.token }}");
});


it('omits only D044-D046 when G0 is null and restores them for any non-null G0', () => {
  const signalPin = JSON.parse(readFileSync(new URL('../server/channels/signal/runtime-pin.json', import.meta.url)));
  const enabled = pinnedReleaseAssets({ signalPin: { ...signalPin, g0: { reviewed: true } } });
  const disabled = pinnedReleaseAssets({ signalPin: { ...signalPin, g0: null } });
  expect(disabled).toEqual(enabled.filter(pin => !['D044', 'D045', 'D046'].includes(pin.id)));
  expect(enabled.filter(pin => ['D044', 'D045', 'D046'].includes(pin.id))).toHaveLength(3);
  expect(pinnedReleaseAssets()).toEqual(disabled);
});

// Upstream tags may contain "/" (apple-codesign/0.29.0, D062). The release
// download URL then has one path segment per tag part, and the API-ID alternate
// must still resolve to that release instead of failing as changed metadata.
function slashedTagFixture() {
  const f = fixture();
  f.data.releases.push({ id: 3, tag_name: "tool/1.0", draft: false, published_at: "2026-01-01T00:00:00Z" });
  f.data.assets["3"] = [{ id: 30, name: "tool.tar.gz", state: "uploaded", size: 7,
    browser_download_url: "https://github.com/fixture/runtime/releases/download/tool/1.0/tool.tar.gz" }];
  f.pins = [
    { id: "slashed", url: "https://github.com/fixture/runtime/releases/download/tool/1.0/tool.tar.gz", bytes: 7, sha256: "1".repeat(64) },
    { id: "slashed", url: "https://api.github.com/repos/fixture/runtime/releases/assets/30", bytes: 7, sha256: "1".repeat(64) },
  ];
  const metadata = f.fetchImpl;
  f.fetchImpl = (url, options) => options.method ? (f.calls.push({ url, options }), Promise.resolve(new Response(null))) : metadata(url, options);
  return f;
}

it("parses release download URLs whose tag contains slashes", () => {
  expect(releaseAssetRef("https://github.com/fixture/runtime/releases/download/tool/1.0/tool.tar.gz"))
    .toEqual({ repo: "fixture/runtime", tag: "tool/1.0", name: "tool.tar.gz" });
  expect(releaseAssetRef("https://github.com/fixture/runtime/releases/download/v1/a.tgz")).toEqual({ repo: "fixture/runtime", tag: "v1", name: "a.tgz" });
  for (const url of ["https://github.com/fixture/runtime/releases/download/a.tgz", "https://github.com/fixture/runtime/releases/download/tool//a.tgz",
    "https://github.com/fixture/runtime/releases/latest/download/a.tgz", "https://github.com/fixture/runtime/releases/download/tool/1.0/"])
    expect(releaseAssetRef(url), url).toBeNull();
});

it("accepts a published slashed-tag asset by URL and API ID, and checks it against the release metadata", async () => {
  // Both pins name asset 30; its anonymous bytes are proven once via the download URL.
  const ok = slashedTagFixture();
  expect(await checkReleaseAssets(ok)).toEqual({ pins: 2, urls: 1, repositories: 1 });
  expect(ok.calls.filter(call => call.options.method).map(call => call.url)).toEqual(["https://github.com/fixture/runtime/releases/download/tool/1.0/tool.tar.gz"]);
  // The download URL is now checked against release metadata, not only probed anonymously.
  const size = slashedTagFixture(); size.pins[0].bytes = 8;
  await expect(checkReleaseAssets(size)).rejects.toThrow("slashed: https://github.com/fixture/runtime/releases/download/tool/1.0/tool.tar.gz: Asset size differs from pin");
  const draft = slashedTagFixture(); draft.data.releases[2].draft = true;
  await expect(checkReleaseAssets(draft)).rejects.toThrow("Release is draft");
});

it("recognises every shipped GitHub release-download and asset-API pin as a release asset", () => {
  const signalPin = JSON.parse(readFileSync(new URL("../server/channels/signal/runtime-pin.json", import.meta.url)));
  const github = pinnedReleaseAssets({ signalPin: { ...signalPin, g0: { reviewed: true } } })
    .filter(pin => /^https:\/\/(github\.com\/[^/]+\/[^/]+\/releases\/|api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/)/.test(pin.url));
  expect(github.map(pin => pin.id)).toContain("D062");
  expect(github.filter(pin => !releaseAssetRef(pin.url)).map(pin => `${pin.id} ${pin.url}`)).toEqual([]);
});

// Rate limits (release draft rehearsal 4: "Anonymous asset HTTP 403" on API-ID
// alternates). The anonymous probe must not use api.github.com, 403/429 is retried
// within a bounded budget, and 404 or mismatched metadata still fails at once.
function anonymousSequence(statuses, headers = {}) {
  const f = fixture(), metadata = f.fetchImpl, probes = [];
  f.fetchImpl = async (url, options) => {
    if (!options.method) return metadata(url, options);
    probes.push(url);
    const status = statuses.length > 1 ? statuses.shift() : statuses[0];
    return new Response(null, { status, headers: status === 200 ? {} : headers });
  };
  f.pins = [f.pins[0]];
  return { f, probes };
}

it("passes an anonymous 403 followed by 200, waiting the Retry-After seconds", async () => {
  const { f, probes } = anonymousSequence([403, 200], { "Retry-After": "7" });
  expect(await checkReleaseAssets(f)).toEqual({ pins: 1, urls: 1, repositories: 1 });
  expect(probes).toHaveLength(2);
  expect(f.sleeps).toEqual([7000]);
});

it("fails a persistent anonymous 403 after three tries with a clear rate-limit message", async () => {
  const { f, probes } = anonymousSequence([403]);
  await expect(checkReleaseAssets(f)).rejects.toThrow(
    "fixture-0: https://github.com/fixture/runtime/releases/download/browser-v1/browser: Anonymous asset HTTP 403 after 3 tries (rate limited or forbidden; retry budget 90 s)");
  expect(probes).toHaveLength(3);
  expect(f.sleeps).toEqual([5000, 10000]);
});

it("fails an anonymous 404 at once, without retrying", async () => {
  const { f, probes } = anonymousSequence([404]);
  await expect(checkReleaseAssets(f)).rejects.toThrow("browser-v1/browser: Anonymous asset HTTP 404");
  expect(probes).toHaveLength(1);
  expect(f.sleeps).toEqual([]);
});

it("never waits past the shared budget: a reset beyond 90 s fails without sleeping", async () => {
  const reset = String(Math.ceil(Date.now() / 1000) + 600);
  const { f, probes } = anonymousSequence([429], { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset });
  await expect(checkReleaseAssets(f)).rejects.toThrow("Anonymous asset HTTP 429 after 1 tries");
  expect(probes).toHaveLength(1);
  expect(f.sleeps).toEqual([]);
  const budget = anonymousSequence([429], { "Retry-After": "60" });
  budget.f.pins = fixture().pins.slice(0, 2);
  await expect(checkReleaseAssets(budget.f)).rejects.toThrow("Release asset CHECK failed");
  expect(budget.f.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(90_000);
});

it("retries authenticated metadata 429 honoring X-RateLimit-Reset, then still checks the asset", async () => {
  const f = fixture(), metadata = f.fetchImpl, now = Date.now();
  let limited = true;
  f.fetchImpl = async (url, options) => {
    if (!options.method && limited) { limited = false; return new Response(null, { status: 429, headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.ceil(now / 1000) + 20) } }); }
    return options.method ? new Response(null) : metadata(url, options);
  };
  expect(await checkReleaseAssets(f)).toEqual({ pins: 2, urls: 2, repositories: 1 });
  expect(f.sleeps).toHaveLength(1);
  expect(f.sleeps[0]).toBeGreaterThan(15_000);
  expect(f.sleeps[0]).toBeLessThanOrEqual(22_000);
  expect(rateLimitDelayMs(new Response(null, { headers: { "Retry-After": new Date(now + 30_000).toUTCString() } }), 1, now)).toBeGreaterThan(28_000);
});

it("probes an API-ID pin through its CDN download URL and still fails a 404 or metadata mismatch there", async () => {
  const api = "https://api.github.com/repos/fixture/runtime/releases/assets/20";
  const missing = anonymousSequence([200]); missing.f.pins = [{ ...missing.f.pins[0], id: "api", url: api }];
  const inner = missing.f.fetchImpl;
  missing.f.fetchImpl = async (url, options) => options.method && url.endsWith("/signal.tar.gz") ? new Response(null, { status: 404 }) : inner(url, options);
  await expect(checkReleaseAssets(missing.f)).rejects.toThrow(`api: ${api}: Anonymous asset HTTP 404`);
  const ok = anonymousSequence([200]); ok.f.pins = [{ ...ok.f.pins[0], id: "api", url: api }];
  expect(await checkReleaseAssets(ok.f)).toEqual({ pins: 1, urls: 1, repositories: 1 });
  expect(ok.probes).toEqual(["https://github.com/fixture/runtime/releases/download/signal-v1/signal.tar.gz"]);
  const moved = anonymousSequence([200]); moved.f.pins = [{ ...moved.f.pins[0], id: "api", url: api }];
  moved.f.data.assets["2"][0].browser_download_url = "https://github.com/other/runtime/releases/download/signal-v1/signal.tar.gz";
  await expect(checkReleaseAssets(moved.f)).rejects.toThrow(`api: ${api}: Asset metadata differs from pin`);
  expect(moved.probes).toEqual([]);
  const size = anonymousSequence([200]); size.f.pins = [{ ...size.f.pins[0], id: "api", url: api, bytes: 5 }];
  await expect(checkReleaseAssets(size.f)).rejects.toThrow(`api: ${api}: Asset size differs from pin`);
});
