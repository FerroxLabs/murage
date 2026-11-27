// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The announcements host can be unreachable (no DNS, no route, a hung connection). The fetch must then be quiet:
// no throw, no unhandled rejection, no console line, no retry before the next six-hour tick, start() not waited on,
// and the local API the window reads still answers 200 with no notices (so there is nothing for the window to toast).
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCEMENT_REFRESH_MS, ANNOUNCEMENT_TIMEOUT_MS, Announcements, announcementSource, handleAnnouncementsApi } from "./announcements.ts";

const raw = Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!, "base64url").toString("base64");
// The real feed URL with a real key slot: the shape the app has once the production key is pasted in.
const source = announcementSource({}, [raw])!;

/** What undici throws when the name does not resolve. */
const dnsFailure = (code = "ENOTFOUND") => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`getaddrinfo ${code}`), { code }) });
const service = (fetchImpl: typeof fetch) => new Announcements({ dir: mkdtempSync(join(tmpdir(), "murage-ann-down-")), source, fetchImpl });

let output: ReturnType<typeof vi.spyOn>[];
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
beforeEach(() => {
  vi.useFakeTimers();
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  output = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const consoleLines = () => output.reduce((sum, spy) => sum + spy.mock.calls.length, 0);

describe("announcements when the host is unreachable", () => {
  it("the production source asks only the fixed feed host, so the case below is the one users would hit", () => {
    expect(new URL(source.feedUrl).hostname).toBe("murage.ai");
    expect(source.feedUrl).toBe("https://murage.ai/murage/announcements.json");
    expect(source.signatureUrl).toBe("https://murage.ai/murage/announcements.json.sig");
  });

  it("refresh() asks the network for exactly the murage.ai feed and its .sig, and nothing else", async () => {
    const asked: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown) => { asked.push(String(url)); return new Response("", { status: 404 }); });
    await service(fetchImpl as unknown as typeof fetch).refresh();
    expect(asked.sort()).toEqual(["https://murage.ai/murage/announcements.json", "https://murage.ai/murage/announcements.json.sig"]);
  });

  for (const status of [404, 403, 500]) {
    it(`a file that is missing or refused (HTTP ${status}) resolves false: no throw, no console line, no retry before the next tick`, async () => {
      const fetchImpl = vi.fn(async () => new Response("not here", { status }));
      const announcements = service(fetchImpl as unknown as typeof fetch);
      await expect(announcements.refresh()).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_REFRESH_MS - 1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(consoleLines()).toBe(0);
      expect(unhandled).toEqual([]);
      expect(announcements.visible("1.0.19")).toEqual([]);
      const answer = await handleAnnouncementsApi({ method: "GET", path: "/api/announcements", version: "1.0.19", readBody: async () => null }, announcements);
      expect(answer).toEqual({ status: 200, body: { show: true, items: [] } });
    });
  }

  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]) {
    it(`a ${code} failure resolves false: no throw, no console line, one request each for the feed and signature, no retry`, async () => {
      const fetchImpl = vi.fn(async () => { throw dnsFailure(code); });
      const announcements = service(fetchImpl as unknown as typeof fetch);
      await expect(announcements.refresh()).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_REFRESH_MS - 1);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(consoleLines()).toBe(0);
      expect(unhandled).toEqual([]);
      expect(announcements.current()).toBeNull();
      expect(announcements.visible("1.0.19")).toEqual([]);
    });
  }

  it("start() does not wait on the network and a hung host is cut off at the ten-second deadline", async () => {
    let aborted = 0;
    const hung = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted++; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
    }));
    const announcements = service(hung as unknown as typeof fetch);
    const returned = announcements.start();
    expect(returned).toBeUndefined();
    expect(hung).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_TIMEOUT_MS);
    expect(aborted).toBe(2);
    announcements.stop();
    expect(consoleLines()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it("start() retries only on the six-hour tick: two requests per tick, none in between", async () => {
    const fetchImpl = vi.fn(async () => { throw dnsFailure(); });
    const announcements = service(fetchImpl as unknown as typeof fetch);
    announcements.start();
    await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_REFRESH_MS - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_REFRESH_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    announcements.stop();
    expect(consoleLines()).toBe(0);
    expect(unhandled).toEqual([]);
  });

  it("the local API the window reads still answers 200 with no notices, so there is nothing to toast", async () => {
    const announcements = service((async () => { throw dnsFailure(); }) as unknown as typeof fetch);
    await announcements.refresh();
    const answer = await handleAnnouncementsApi({ method: "GET", path: "/api/announcements", version: "1.0.19", readBody: async () => null }, announcements);
    expect(answer).toEqual({ status: 200, body: { show: true, items: [] } });
  });

  it("concurrent refreshes while the host is down share one pair of requests", async () => {
    const fetchImpl = vi.fn(async () => { throw dnsFailure(); });
    const announcements = service(fetchImpl as unknown as typeof fetch);
    await Promise.all([announcements.refresh(), announcements.refresh(), announcements.refresh()]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
