import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";
import { listToolkits, setManagedBrokerAccess } from "./composio.ts";

afterEach(() => { vi.unstubAllGlobals(); setManagedBrokerAccess(null); });
const project = (name: string): AppConfig => ({ composio: { apiKey: `fake-catalog-${name}` } });
const incomplete = "The app catalog could not be loaded completely. Please retry.";

describe("marketplace catalog traversal", () => {
  it("loads beyond 500, deduplicates slugs and caches a complete result", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("limit")).toBe("500");
      return Response.json(url.searchParams.has("cursor")
        ? { items: [{ slug: "TOOL-0" }, { slug: "late-app", name: "Late app" }] }
        : { items: Array.from({ length: 500 }, (_, i) => ({ slug: `tool-${i}` })), next_cursor: "page+2/==" });
    });
    vi.stubGlobal("fetch", fetcher);
    const cfg = project("complete");
    const result = await listToolkits(cfg);
    expect(result.source).toBe("api");
    expect(result.cards).toHaveLength(501);
    expect(result.cards.at(-1)?.slug).toBe("late-app");
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("cursor")).toBe("page+2/==");
    expect(await listToolkits(cfg)).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("forwards managed cursors without exposing a project key", async () => {
    setManagedBrokerAccess({ url: "https://broker.example.test", token: "b".repeat(64) });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1/catalog");
      expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
      return Response.json(url.searchParams.has("cursor") ? { items: [{ slug: "tail" }] }
        : { items: [{ slug: "head" }], next_cursor: "page-2" });
    });
    vi.stubGlobal("fetch", fetcher);
    expect((await listToolkits({})).cards.map(card => card.slug)).toEqual(["head", "tail"]);
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get("cursor")).toBe("page-2");
  });

  it.each(["http", "json", "network"])("rejects an incomplete %s result without caching or upstream details", async failure => {
    let requests = 0;
    const fetcher = vi.fn(async () => {
      requests++;
      if (requests % 2 === 1) return Response.json({ items: [{ slug: "head" }], next_cursor: "next" });
      if (failure === "http") return new Response("fake-private-upstream-detail", { status: 502 });
      if (failure === "json") return new Response("fake-private-upstream-detail");
      throw new Error("fake-private-upstream-detail");
    });
    vi.stubGlobal("fetch", fetcher);
    const cfg = project(failure);
    await expect(listToolkits(cfg)).rejects.toThrow(incomplete);
    await expect(listToolkits(cfg)).rejects.toThrow(incomplete);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("bounds cursor replay, total pages, and total records without unmarked partial output", async () => {
    const replay = vi.fn(async () => Response.json({ items: [{ slug: "head" }], next_cursor: "same" }));
    vi.stubGlobal("fetch", replay);
    await expect(listToolkits(project("loop"))).rejects.toThrow(incomplete);
    expect(replay).toHaveBeenCalledTimes(2);
    let page = 0;
    const endless = vi.fn(async () => Response.json({ items: [{ slug: `tool-${page}` }], next_cursor: `page-${++page}` }));
    vi.stubGlobal("fetch", endless);
    await expect(listToolkits(project("ceiling"))).rejects.toThrow(incomplete);
    expect(endless).toHaveBeenCalledTimes(20);
    const oversized = vi.fn(async () => Response.json({ items: Array.from({ length: 10_001 }, (_, i) => ({ slug: `tool-${i}` })) }));
    vi.stubGlobal("fetch", oversized);
    await expect(listToolkits(project("records"))).rejects.toThrow(incomplete);
    expect(oversized).toHaveBeenCalledTimes(1);
  });

  it("stops on cancellation using one shared deadline signal", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      if (signals.length === 2) controller.abort();
      return Response.json({ items: [{ slug: "head" }], next_cursor: "next" });
    });
    vi.stubGlobal("fetch", fetcher);
    expect((await listToolkits(project("cancel"), { signal: controller.signal })).source).toBe("curated");
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("discards a catalog when the selected backend changes mid-page", async () => {
    const cfg = project("identity-old");
    vi.stubGlobal("fetch", async () => {
      cfg.composio!.apiKey = "fake-catalog-identity-new";
      return Response.json({ items: [{ slug: "old-private-card" }], next_cursor: "next" });
    });
    expect((await listToolkits(cfg)).source).toBe("curated");
    vi.stubGlobal("fetch", async () => Response.json({ items: [{ slug: "new-card" }] }));
    expect((await listToolkits(cfg)).cards.map(card => card.slug)).toEqual(["new-card"]);
  });

  it("retains curated fallback for a first-page failure", async () => {
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    expect((await listToolkits(project("unavailable"))).source).toBe("curated");
  });
});
