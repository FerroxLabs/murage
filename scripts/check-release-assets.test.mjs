// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { checkReleaseAssets, pinnedReleaseAssets, releaseAssetRef } from "./check-release-assets.mjs";

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
  return { data, calls, pins, fetchImpl, token: "fixture" };
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
  expect(await checkReleaseAssets(f)).toEqual({ pins: 3, urls: 3, repositories: 1 });
  for (const { options } of f.calls.filter(call => call.options.method)) expect(options.headers).not.toHaveProperty("Authorization");
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
  const pins = pinnedReleaseAssets();
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
