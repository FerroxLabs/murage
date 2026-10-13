// RC3 item 5: a catalog refresh must not hammer an owner's LAN Ollama host.
// Eight engines each merging local models used to probe every host twice
// (16 sockets). One refresh is now one scope: one probe per address, and a
// background refresh never probes a user-added server on its own.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configureLocalServerStore } from "../local-servers.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { clearLocalContextCacheForTests, mergeLocalInject, runInLocalProbeScope } from "./local-inject.ts";

const ADDED = "http://127.0.0.1:19876";
const ENV = { VITEST: "true", MURAGE_PROBE_LOCAL_INJECT: "1" };
const BASE = { default: "keep", options: [{ id: "keep", label: "Keep" }] };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "murage-probe-scope-"));
  mkdirSync(join(root, "local-models"), { recursive: true });
  const now = Date.now();
  writeFileSync(
    join(root, "local-models", "local-servers.json"),
    JSON.stringify({
      version: 1,
      servers: [{ id: "srv_aabbccddeeff", name: "LAN", kind: "ollama", apiBase: `${ADDED}/v1`, createdAt: now, updatedAt: now }],
    }),
  );
  configureLocalServerStore(root);
  clearLocalContextCacheForTests();
});
afterEach(async () => {
  configureLocalServerStore(null);
  await removeTempDir(root);
});

function counting() {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(href);
    if (!href.startsWith(ADDED)) throw new TypeError("nothing listens here");
    const body = href.endsWith("/api/ps") ? { models: [] } : { object: "list", data: [{ id: "llama3:8b", object: "model" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { urls, fetchImpl };
}

const mergeEight = (fetchImpl: typeof fetch) =>
  Promise.all(Array.from({ length: 8 }, () => mergeLocalInject(BASE, ENV, fetchImpl, { driver: "piAgent" })));

describe("local probe scope", () => {
  it("a startup (background) refresh makes zero probes to user-added hosts", async () => {
    const { urls, fetchImpl } = counting();
    await runInLocalProbeScope(false, () => mergeEight(fetchImpl));
    expect(urls.filter((url) => url.startsWith(ADDED))).toEqual([]);
  });

  it("one refresh makes at most one probe per host, however many engines merge", async () => {
    const { urls, fetchImpl } = counting();
    const merged = await runInLocalProbeScope(true, () => mergeEight(fetchImpl));
    const added = urls.filter((url) => url.startsWith(ADDED));
    // /v1/models + /api/ps for one Ollama host, once.
    expect(added.length).toBeLessThanOrEqual(2);
    expect(merged[0]!.options.some((option) => option.id === "srv_aabbccddeeff::llama3:8b")).toBe(true);
    for (const base of new Set(urls.map((url) => new URL(url).origin))) {
      const perPath = urls.filter((url) => url.startsWith(base));
      expect(new Set(perPath).size).toBe(perPath.length);
    }
  });

  it("a later background refresh lists the stored result without calling the host", async () => {
    const first = counting();
    await runInLocalProbeScope(true, () => mergeLocalInject(BASE, ENV, first.fetchImpl, { driver: "piAgent" }));
    const later = counting();
    const merged = await runInLocalProbeScope(false, () => mergeLocalInject(BASE, ENV, later.fetchImpl, { driver: "piAgent" }));
    expect(later.urls.filter((url) => url.startsWith(ADDED))).toEqual([]);
    expect(merged.options.some((option) => option.id === "srv_aabbccddeeff::llama3:8b")).toBe(true);
  });
});
