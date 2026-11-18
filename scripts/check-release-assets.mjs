// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Read-only release CHECK. Authentication is confined to GitHub API metadata;
// downloads are probed anonymously, exactly as the packaging callers use them.
// API-ID pins are probed through the asset's browser_download_url (the same
// asset, served from the release CDN) because anonymous api.github.com calls
// share a 60/hour per-IP limit. 403/429 responses are retried a bounded number
// of times, honoring Retry-After and X-RateLimit-Reset; a 404 still fails.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentBrowserReleaseUrl, resolveAgentBrowserReleaseAsset, cloudHomeReleaseAsset } from "../server/browser-engine-release.ts";
import { BUILD_INPUTS } from "./fetch-build-input.mjs";
import { RUST_INPUTS } from "./install-browser-rust.mjs";

export function releaseAssetRef(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.search || parsed.hash) return null;
  const path = parsed.pathname.split("/").slice(1).map(decodeURIComponent);
  // Tags may contain "/" (apple-codesign/0.29.0): every segment between
  // "download" and the asset name belongs to the tag.
  if (parsed.hostname === "github.com" && path.length >= 6 && path[2] === "releases" && path[3] === "download" && path.slice(4).every(Boolean)) {
    return { repo: `${path[0]}/${path[1]}`, tag: path.slice(4, -1).join("/"), name: path.at(-1) };
  }
  if (parsed.hostname === "api.github.com" && path.length === 6 && path[0] === "repos" && path[3] === "releases" && path[4] === "assets" && /^\d+$/.test(path[5])) {
    return { repo: `${path[1]}/${path[2]}`, assetId: path[5] };
  }
  return null;
}

export function pinnedReleaseAssets({ signalPin = JSON.parse(readFileSync(new URL("../server/channels/signal/runtime-pin.json", import.meta.url), "utf8")) } = {}) {
  const pins = [];
  // Desktop resolution must not inherit the calling Cloud builder's role.
  const role = process.env.MURAGE_CLOUD_ROLE;
  try {
    delete process.env.MURAGE_CLOUD_ROLE;
    for (const [index, target] of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-musl-arm64", "linux-musl-x64", "linux-x64", "win32-x64"].entries()) {
      const [platform, arch] = target.replace("linux-musl-", "linux-").split("-");
      const asset = resolveAgentBrowserReleaseAsset(platform, arch, target.includes("musl"));
      pins.push({ id: `D${String(27 + index).padStart(3, "0")}`, url: agentBrowserReleaseUrl(asset), sha256: asset.sha256, bytes: asset.bytes });
    }
  } finally {
    if (role === undefined) delete process.env.MURAGE_CLOUD_ROLE;
    else process.env.MURAGE_CLOUD_ROLE = role;
  }
  for (const [id, arch] of [["D038", "x64"], ["D040", "arm64"]]) {
    const asset = cloudHomeReleaseAsset(arch);
    pins.push({ id, url: asset.url, sha256: asset.sha256, bytes: asset.bytes });
  }
  // These archives cannot ship until G0 and all five post-G0 gates pass.
  if (signalPin.g0 !== null) {
    for (const [id, target] of [["D044", "darwin-arm64"], ["D045", "win32-x64"], ["D046", "linux-x64"]]) {
      pins.push({ id, ...signalPin.releaseInputs[target] });
    }
  }
  // Include every reviewed build-input URL (also Chromium and source archives),
  // not just the conditionally required app assets. Non-GitHub inputs need
  // anonymous availability; GitHub assets additionally need published releases.
  for (const [id, pin] of Object.entries(BUILD_INPUTS)) {
    for (const url of pin.urls) pins.push({ id, url, sha256: pin.sha256, bytes: pin.bytes });
  }
  pins.push({ id: "D100", ...RUST_INPUTS.manifest });
  for (const pin of Object.values(RUST_INPUTS.components)) pins.push({ id: "D100", ...pin });
  return pins;
}

export const RATE_LIMIT_TRIES = 3;
export const RATE_LIMIT_BUDGET_MS = 90_000;

/** Wait before retrying a 403/429: Retry-After, else X-RateLimit-Reset, else exponential backoff. */
export function rateLimitDelayMs(response, attempt, now = Date.now()) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now) + 1000;
  return 5000 * 2 ** (attempt - 1);
}

export async function checkReleaseAssets({ pins = pinnedReleaseAssets(), token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN,
  fetchImpl = globalThis.fetch, sleep = ms => new Promise(done => setTimeout(done, ms)), budgetMs = RATE_LIMIT_BUDGET_MS } = {}) {
  if (!token?.trim()) throw Error("Release asset CHECK requires GH_TOKEN or GITHUB_TOKEN with contents:read for both release repositories");
  // One shared wait budget for the whole CHECK keeps the job bounded even when every URL is limited.
  let waitedMs = 0;
  const withRateLimitRetry = async (request, label) => {
    for (let attempt = 1; ; attempt++) {
      const response = await request();
      // 403/429 = rate limit; 502/503/504 = transient GitHub gateway errors (D047 adoptium 504, 11-18).
      if (response.status !== 403 && response.status !== 429 && ![502, 503, 504].includes(response.status)) return response;
      const delay = rateLimitDelayMs(response, attempt);
      await response.body?.cancel();
      if (attempt >= RATE_LIMIT_TRIES || waitedMs + delay > budgetMs) {
        throw Error(`${label} HTTP ${response.status} after ${attempt} tries (rate limited or forbidden; retry budget ${Math.round(budgetMs / 1000)} s)`);
      }
      waitedMs += delay;
      await sleep(delay);
    }
  };
  const api = async path => {
    let response;
    try {
      response = await withRateLimitRetry(() => fetchImpl(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
        redirect: "error", signal: AbortSignal.timeout(30_000),
      }), "GitHub metadata");
    } catch (error) { throw Error(error.message.startsWith("GitHub metadata HTTP") ? error.message : "GitHub metadata request failed"); }
    if (!response.ok) { await response.body?.cancel(); throw Error(`GitHub metadata HTTP ${response.status}`); }
    return response.json();
  };
  const paginate = async path => {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await api(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw Error("Invalid GitHub metadata list");
      all.push(...rows);
      if (rows.length < 100) return all;
    }
    throw Error("GitHub metadata pagination limit reached");
  };
  const repositories = new Map(), releasesByTag = new Map(), releaseAssets = new Map(), checked = new Set();
  const failures = [];
  const anonymousProbe = async (url, binaryRelease) => {
    if (checked.has(url)) return;
    const probe = async method => fetchImpl(url, { method, redirect: "follow",
      headers: { Accept: "application/octet-stream", ...(method === "GET" ? { Range: "bytes=0-0" } : {}) },
      signal: AbortSignal.timeout(30_000) });
    const attempt = async () => {
      const response = await probe("HEAD");
      if (response.status !== 405) return response;
      await response.body?.cancel();
      return probe("GET");
    };
    let response;
    try { response = await withRateLimitRetry(attempt, "Anonymous asset"); }
    catch (error) { throw Error(error.message.startsWith("Anonymous asset HTTP") ? error.message : "Anonymous asset request failed"); }
    await response.body?.cancel();
    if (!response.ok) throw Error(`Anonymous asset HTTP ${response.status}`);
    if (response.url && new URL(response.url).protocol !== "https:") throw Error("Anonymous asset redirect is not HTTPS");
    if (binaryRelease && response.headers.get("content-type")?.includes("json")) throw Error("Anonymous asset returned metadata instead of bytes");
    checked.add(url);
  };
  for (const pin of pins) {
    try {
      const ref = releaseAssetRef(pin.url);
      if (new URL(pin.url).protocol !== "https:" || !/^[0-9a-f]{64}$/.test(pin.sha256)) throw Error("Invalid release asset pin");
      if (!ref) { await anonymousProbe(pin.url, false); continue; }
      // Look a release up by tag instead of paginating every release: repos with thousands of
      // releases (adoptium) time out (HTTP 504) on deep /releases pages.
      const releaseByTag = async tag => {
        const k = `${ref.repo}@${tag}`;
        repositories.set(ref.repo, true);
        if (!releasesByTag.has(k)) {
          try { releasesByTag.set(k, await api(`/repos/${ref.repo}/releases/tags/${tag.split("/").map(encodeURIComponent).join("/")}`)); }
          catch (error) { if (error.message === "GitHub metadata HTTP 404") releasesByTag.set(k, undefined); else throw error; }
        }
        return releasesByTag.get(k);
      };
      let release, asset;
      if (ref.assetId) {
        asset = await api(`/repos/${ref.repo}/releases/assets/${ref.assetId}`);
        const canonical = releaseAssetRef(asset.browser_download_url);
        if (!canonical || canonical.repo !== ref.repo || String(asset.id) !== ref.assetId) throw Error("Asset metadata differs from pin");
        release = await releaseByTag(canonical.tag);
      } else release = await releaseByTag(ref.tag);
      if (release && release.tag_name !== (ref.assetId ? releaseAssetRef(asset.browser_download_url).tag : ref.tag)) release = undefined;
      if (!release) throw Error("Release missing or inaccessible to token");
      if (release.draft !== false) throw Error("Release is draft (anonymous download returns 404)");
      if (!release.published_at) throw Error("Release has no publication timestamp");
      const key = `${ref.repo}/${release.id}`;
      if (!releaseAssets.has(key)) releaseAssets.set(key, await paginate(`/repos/${ref.repo}/releases/${release.id}/assets`));
      asset = releaseAssets.get(key).find(row => ref.assetId ? String(row.id) === ref.assetId : row.name === ref.name);
      if (!asset || asset.state !== "uploaded" || !(asset.size > 0)) throw Error("Pinned asset missing or not uploaded");
      const canonical = releaseAssetRef(asset.browser_download_url);
      if (!canonical || canonical.repo !== ref.repo || canonical.tag !== release.tag_name || canonical.name !== asset.name) throw Error("Asset URL differs from release");
      if (pin.bytes !== undefined && pin.bytes !== asset.size) throw Error("Asset size differs from pin");
      if (asset.digest?.startsWith("sha256:") && asset.digest !== `sha256:${pin.sha256}`) throw Error("Asset SHA-256 metadata differs from pin");
      // An api.github.com pin is the same asset (ID and canonical URL checked above);
      // its anonymous bytes are proven via the CDN-backed download URL, not the rate-limited API.
      await anonymousProbe(ref.assetId ? asset.browser_download_url : pin.url, true);
    } catch (error) { failures.push(`${pin.id}: ${pin.url}: ${error.message}`); }
  }
  if (failures.length) throw Error(`Release asset CHECK failed:\n${failures.join("\n")}`);
  return { pins: pins.length, urls: checked.size, repositories: repositories.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error("usage: node scripts/check-release-assets.mjs (token in environment only)");
    const result = await checkReleaseAssets();
    console.log(`Release asset CHECK passed: ${result.pins} pins, ${result.urls} anonymous URLs`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
