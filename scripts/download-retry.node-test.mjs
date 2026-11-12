import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchPinned, fetchWithRetry, isRetryableStatus, mirrorUrlFor } from "./download-retry.mjs";
import { stageLinuxCua } from "./cua-linux-release.mjs";
import { stageBackupAge } from "./prepare-backup-age.mjs";
const quiet = { sleep: async () => {}, log: () => {} };
const res = (status, body = "x") => new Response(status === 200 ? body : null, { status });

test("retryable statuses are transport trouble only", () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [200, 301, 400, 401, 403, 404, 410]) assert.equal(isRetryableStatus(s), false, String(s));
});
test("recovers after transient 504s and network errors", async () => {
  const seq = [() => res(504), () => { throw new TypeError("fetch failed"); }, () => res(200, "ok")];
  let calls = 0;
  const r = await fetchWithRetry("https://x.test/a", {}, { ...quiet, fetchImpl: async () => seq[calls++]() });
  assert.equal(r.ok, true); assert.equal(calls, 3); assert.equal(await r.text(), "ok");
});
test("a 404 is never retried", async () => {
  let calls = 0;
  const r = await fetchWithRetry("https://x.test/a", {}, { ...quiet, fetchImpl: async () => { calls++; return res(404); } });
  assert.equal(r.status, 404); assert.equal(calls, 1);
});
test("exhaustion returns a failed response with the last status and uses capped backoff", async () => {
  const delays = []; let calls = 0;
  const r = await fetchWithRetry("https://x.test/a", {}, { attempts: 5, baseDelayMs: 1000, maxDelayMs: 3000, log: () => {}, sleep: async ms => { delays.push(ms); }, fetchImpl: async () => { calls++; return res(504); } });
  assert.equal(r.ok, false); assert.equal(r.status, 504); assert.equal(calls, 5);
  assert.deepEqual(delays, [1000, 2000, 3000, 3000]);
});
test("age staging: a wrong archive is still rejected after a successful retry download", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "retry-age-"));
  const real = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? res(504) : res(200, "not the pinned archive"));
  const realSetTimeout = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, 0, ...a);
  try {
    await assert.rejects(stageBackupAge({ root: path.resolve(new URL("../", import.meta.url).pathname), target: "linux-x64" }), /BACKUP_AGE_(ARCHIVE_MISMATCH|DOWNLOAD_FAILED)/);
    assert.equal(calls, 3); // 504, then wrong bytes from upstream and from the mirror
  } finally { globalThis.fetch = real; globalThis.setTimeout = realSetTimeout; safeWipeSync(root); }
});
test("CUA linux: retries 504 then fails closed on exhaustion; 404 is immediate; bad bytes still mismatch", async () => {
  const mk = () => mkdtempSync(path.join(tmpdir(), "retry-cua-"));
  const opts = (fetchImpl, root) => ({ rootDirectory: root, platform: "linux", arch: "x64", fetchImpl, downloadAttempts: 3, downloadRetryDelayMs: 1, sleep: async () => {} });
  let r1 = mk(), c = 0;
  await assert.rejects(stageLinuxCua(opts(async () => { c++; return res(504); }, r1)), /HTTP 504/); assert.equal(c, 6);
  let r2 = mk(); c = 0;
  await assert.rejects(stageLinuxCua(opts(async () => { c++; return res(404); }, r2)), /HTTP 404/); assert.equal(c, 2);
  let r3 = mk(); c = 0;
  await assert.rejects(stageLinuxCua(opts(async () => (++c === 1 ? res(503) : res(200, "wrong bytes")), r3)), /size does not match|checksum mismatch/); assert.equal(c, 2);
  for (const d of [r1, r2, r3]) safeWipeSync(d);
});

test("a body that drops mid-download is retried and no partial bytes escape", async () => {
  let calls = 0;
  const broken = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("par")); c.error(new Error("socket hang up")); } }), { status: 200 });
  const r = await fetchWithRetry("https://x.test/a", {}, { ...quiet, fetchImpl: async () => (++calls < 3 ? broken() : res(200, "whole")) });
  assert.equal(calls, 3); assert.equal(await r.text(), "whole");
});
test("an oversized body fails closed without retrying", async () => {
  let calls = 0;
  const r = await fetchWithRetry("https://x.test/a", {}, { ...quiet, maxBytes: 4, fetchImpl: async () => { calls++; return res(200, "too long"); } });
  assert.equal(r.ok, false); assert.equal(calls, 1);
});
test("mirror base rejects credentials, query and fragments", () => {
  for (const base of ["https://u:p@m.test/x/", "https://m.test/x/?a=1", "https://m.test/x/#f"]) assert.equal(mirrorUrlFor(UP, { MURAGE_PACKAGE_MIRROR_BASE: base }), null, base);
  assert.equal(mirrorUrlFor(UP, { MURAGE_PACKAGE_MIRROR_BASE: "https://m.test/x/" }), "https://m.test/x/age-v1.3.2-linux-amd64.tar.gz");
});
const UP = "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz";
test("mirror url keeps the upstream file name, can be disabled, rejects odd bases", () => {
  assert.equal(mirrorUrlFor(UP, {}), "https://github.com/FerroxLabs/murage/releases/download/build-mirror-1/age-v1.3.2-linux-amd64.tar.gz");
  assert.equal(mirrorUrlFor(UP, { MURAGE_PACKAGE_MIRROR_BASE: "off" }), null);
  assert.equal(mirrorUrlFor(UP, { MURAGE_PACKAGE_MIRROR_BASE: "http://insecure.test/" }), null);
  assert.equal(mirrorUrlFor(UP, { MURAGE_PACKAGE_MIRROR_BASE: "https://m.test/x" }), null);
});
test("fetchPinned falls back to the mirror only after upstream retries are exhausted", async () => {
  const urls = [];
  const r = await fetchPinned(UP, {}, { ...quiet, attempts: 3, env: {}, fetchImpl: async u => { urls.push(u); return u === UP ? res(504) : res(200, "mirror bytes"); } });
  assert.equal(r.ok, true); assert.equal(await r.text(), "mirror bytes");
  assert.deepEqual(urls.map(u => u === UP), [true, true, true, false]);
});
test("fetchPinned returns the upstream failure when both fail, and skips the mirror when off", async () => {
  let calls = 0;
  const both = await fetchPinned(UP, {}, { ...quiet, attempts: 2, env: {}, fetchImpl: async () => { calls++; return res(504); } });
  assert.equal(both.ok, false); assert.equal(both.status, 504); assert.equal(calls, 4);
  calls = 0;
  await fetchPinned(UP, {}, { ...quiet, attempts: 2, env: { MURAGE_PACKAGE_MIRROR_BASE: "off" }, fetchImpl: async () => { calls++; return res(504); } });
  assert.equal(calls, 2);
});
test("age staging: bytes served by the mirror are still held to the pinned sha256", async () => {
  const real = globalThis.fetch; const seen = [];
  globalThis.fetch = async u => { seen.push(String(u)); return String(u).includes("build-mirror") ? res(200, "tampered mirror bytes") : res(504); };
  const realSetTimeout = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, 0, ...a);
  try {
    await assert.rejects(stageBackupAge({ root: path.resolve(new URL("../", import.meta.url).pathname), target: "linux-x64" }), /BACKUP_AGE_(ARCHIVE_MISMATCH|DOWNLOAD_FAILED)/);
    assert.ok(seen.some(u => u.includes("build-mirror")));
  } finally { globalThis.fetch = real; globalThis.setTimeout = realSetTimeout; }
});
test("CUA linux: falls back to the mirror and still rejects tampered bytes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "retry-cua-m-")); const seen = [];
  const fetchImpl = async u => { seen.push(u); return u.includes("build-mirror") ? res(200, "tampered") : res(504); };
  await assert.rejects(stageLinuxCua({ rootDirectory: root, platform: "linux", arch: "x64", fetchImpl, downloadAttempts: 2, downloadRetryDelayMs: 1, sleep: async () => {} }), /size does not match|checksum mismatch/);
  assert.equal(seen.length, 3); assert.ok(seen[2].includes("build-mirror-1/cua-driver-rs-0.19.3-linux-x86_64-binary.tar.gz"));
  safeWipeSync(root);
});

// Cache-first pinned downloads (cache, then upstream, then mirror; every source verified).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const pinOf = (text) => createHash("sha256").update(text).digest("hex");
const cacheEnv = (dir) => ({ MURAGE_PACKAGE_DOWNLOAD_CACHE: dir });
test("pinned download: a verified cache entry is used with no network", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dl-cache-"));
  try {
    writeFileSync(path.join(dir, pinOf("good")), "good");
    const fetchImpl = async () => { throw new Error("network must not be touched"); };
    const response = await fetchPinned("https://example.com/t.tgz", {}, { ...quiet, fetchImpl, sha256: pinOf("good"), env: cacheEnv(dir) });
    assert.equal(await response.text(), "good");
  } finally { safeWipeSync(dir); }
});
test("pinned download: a poisoned cache entry is discarded, then fetched and re-cached", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dl-cache-"));
  try {
    writeFileSync(path.join(dir, pinOf("good")), "evil");
    const fetchImpl = async () => res(200, "good");
    const response = await fetchPinned("https://example.com/t.tgz", {}, { ...quiet, fetchImpl, sha256: pinOf("good"), env: cacheEnv(dir) });
    assert.equal(await response.text(), "good");
    assert.equal(readFileSync(path.join(dir, pinOf("good")), "utf8"), "good");
  } finally { safeWipeSync(dir); }
});
test("pinned download: upstream 504s fall to the mirror; a wrong body is never returned or cached", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dl-cache-"));
  try {
    const urls = [];
    const fetchImpl = async (url) => { urls.push(String(url)); return String(url).includes("FerroxLabs") ? res(200, "good") : res(504); };
    const ok = await fetchPinned("https://example.com/t.tgz", {}, { ...quiet, fetchImpl, attempts: 2, sha256: pinOf("good"), env: cacheEnv(dir) });
    assert.equal(await ok.text(), "good");
    assert.equal(urls.filter((u) => u.startsWith("https://example.com/")).length, 2);
    const other = path.join(dir, "other");
    const wrong = await fetchPinned("https://example.com/u.tgz", {}, { ...quiet, fetchImpl: async () => res(200, "bad"), attempts: 1, sha256: pinOf("good2"), env: cacheEnv(other) });
    assert.equal(wrong.ok, false);
    assert.equal(existsSync(path.join(other, pinOf("good2"))), false);
  } finally { safeWipeSync(dir); }
});
test("pinned download: the token goes to github.com only and a rejected token retries anonymously", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { const auth = new Headers(init?.headers).get("authorization"); seen.push([String(url), auth]); return auth ? res(401) : res(200, "good"); };
  const env = { MURAGE_PACKAGE_GITHUB_TOKEN: "tok" };
  const ok = await fetchPinned("https://github.com/o/r/releases/download/v1/t.tgz", {}, { ...quiet, fetchImpl, attempts: 1, sha256: pinOf("good"), env });
  assert.equal(await ok.text(), "good");
  assert.deepEqual(seen.map(([, a]) => a), ["Bearer tok", null]);
  seen.length = 0;
  await fetchPinned("https://example.com/t.tgz", {}, { ...quiet, fetchImpl, attempts: 1, sha256: pinOf("good"), env });
  assert.ok(seen.every(([, a]) => a === null));
});
