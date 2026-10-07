import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.ts";
import { resetAppCatalogState } from "./app-catalog.ts";
import { listToolkits, setManagedBrokerAccess } from "./composio.ts";

beforeEach(() => resetAppCatalogState({ disk: true }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setManagedBrokerAccess(null); resetAppCatalogState({ disk: true }); });
// Each case gets its own managed broker identity, so catalogs never mix.
const project = (name: string): AppConfig => {
  setManagedBrokerAccess({ url: `https://broker.example.test/${name}`, token: "c".repeat(64) });
  return {};
};
// 0.1.61: an incomplete walk no longer throws an error the panel could only
// paint as a red line over a spinner. It falls back to the featured apps with
// the reason and the counts, the panel says so with Retry, and nothing
// partial is ever kept (L17 Part A).
const incomplete = { source: "curated", reason: "incomplete" };

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

  it("never lists the connection service itself as an app to connect", async () => {
    // 0.1.60 Mac pass: the Marketplace showed the service's own toolkit card,
    // by name, as an "Included" app. Product copy never names it.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [{ slug: "gmail" }, { slug: "COMPOSIO", name: "Composio" }, { slug: "slack" }] })));
    expect((await listToolkits(project("no-self"))).cards.map(card => card.slug)).toEqual(["gmail", "slack"]);
  });

  it("drops every card named for the connection service and never shows its name in a blurb", async () => {
    // Linux customer pass: the card still appeared under a sibling slug.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [
      { slug: "gmail", meta: { description: "Read and send email" } },
      { slug: "composio_search", name: "Composio Search" },
      { slug: "tooling", name: "Composio", meta: { description: "Composio enables AI Agents" } },
      { slug: "helper", name: "Helper", meta: { description: "Built on Composio for agents" } },
    ] })));
    const cards = (await listToolkits(project("no-self-siblings"))).cards;
    expect(cards.map(card => card.slug)).toEqual(["gmail", "helper"]);
    expect(JSON.stringify(cards)).not.toMatch(/composio/i);
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

  it.each([["http", "http"], ["json", "incomplete"], ["network", "incomplete"]])("falls back on an incomplete %s result without caching or upstream details", async (failure, reason) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
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
    const first = await listToolkits(cfg);
    expect(first).toMatchObject({ source: "curated", reason, detail: { loaded: 1 } });
    expect(JSON.stringify(first)).not.toContain("fake-private-upstream-detail");
    expect(await listToolkits(cfg)).toMatchObject({ source: "curated", reason });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("bounds cursor replay, total pages, and total records without unmarked partial output", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const replay = vi.fn(async () => Response.json({ items: [{ slug: "head" }], next_cursor: "same" }));
    vi.stubGlobal("fetch", replay);
    expect(await listToolkits(project("loop"))).toMatchObject(incomplete);
    expect(replay).toHaveBeenCalledTimes(2);
    let page = 0;
    const endless = vi.fn(async () => Response.json({ items: [{ slug: `tool-${page}` }], next_cursor: `page-${++page}` }));
    vi.stubGlobal("fetch", endless);
    expect(await listToolkits(project("ceiling"))).toMatchObject(incomplete);
    expect(endless).toHaveBeenCalledTimes(40);
    const oversized = vi.fn(async () => Response.json({ items: Array.from({ length: 20_001 }, (_, i) => ({ slug: `tool-${i}` })) }));
    vi.stubGlobal("fetch", oversized);
    expect(await listToolkits(project("records"))).toMatchObject(incomplete);
    expect(oversized).toHaveBeenCalledTimes(1);
  });

  // Upstream #1615: a walk that ends with no cursor on page 1 of 4, or that
  // replays one page behind fresh cursors, used to pass for the whole
  // catalog. It still fails closed, and now says how much arrived.
  it("refuses a catalog that stops before its own reported total, with N of M", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn(async () => Response.json({ items: [{ slug: "gmail" }], current_page: 1, total_pages: 4, total_items: 1540 }));
    vi.stubGlobal("fetch", fetcher);
    const cfg = project("stalled-total");
    expect(await listToolkits(cfg)).toMatchObject({ ...incomplete, detail: { loaded: 1, total: 1540 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("(incomplete) after 1 of 1,540 apps"));
    // nothing partial was cached
    expect(await listToolkits(cfg)).toMatchObject(incomplete);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refuses a catalog that ends early with only page counts to reveal it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => Response.json({ items: [{ slug: "gmail" }], current_page: 1, total_pages: 4 }));
    expect(await listToolkits(project("end-short"))).toMatchObject({ ...incomplete, detail: { loaded: 1, total: null } });
  });

  it("stops at the first replayed page instead of walking fresh cursors to the ceiling", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let page = 0;
    const stuck = vi.fn(async () => Response.json({ items: [{ slug: "gmail" }], current_page: 1, total_pages: 2, next_cursor: `fresh-${++page}` }));
    vi.stubGlobal("fetch", stuck);
    expect(await listToolkits(project("page-stuck"))).toMatchObject(incomplete);
    expect(stuck).toHaveBeenCalledTimes(2);
  });

  it("accepts the reported last page even when a cursor is still offered, and counts raw records against the total", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => Response.json(new URL(String(input)).searchParams.has("cursor")
      ? { items: [{ slug: "tail" }, { slug: "HEAD" }], current_page: 2, total_pages: 2, total_items: 3, next_cursor: "page-3" }
      : { items: [{ slug: "head" }], current_page: 1, total_pages: 2, total_items: 3, next_cursor: "page-2" }));
    vi.stubGlobal("fetch", fetcher);
    expect((await listToolkits(project("last-page"))).cards.map(card => card.slug)).toEqual(["head", "tail"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await listToolkits(project("cancel"), { signal: controller.signal })).toMatchObject({ source: "curated", reason: "cancelled" });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("discards a catalog when the selected backend changes mid-page", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = project("identity-old");
    vi.stubGlobal("fetch", async () => {
      project("identity-new");
      return Response.json({ items: [{ slug: "old-private-card" }], next_cursor: "next" });
    });
    expect(await listToolkits(cfg)).toMatchObject({ source: "curated", reason: "identity" });
    vi.stubGlobal("fetch", async () => Response.json({ items: [{ slug: "new-card" }] }));
    expect((await listToolkits(cfg)).cards.map(card => card.slug)).toEqual(["new-card"]);
  });

  it("retains curated fallback for a first-page failure, and says why", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));
    expect(await listToolkits(project("unavailable"))).toMatchObject({ source: "curated", reason: "http" });
  });
});
