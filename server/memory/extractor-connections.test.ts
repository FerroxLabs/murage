import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { memoryExtractorConnections, resolveMemoryExtractor } from "./extractor-connections.ts";

afterEach(() => vi.unstubAllGlobals());

describe("memory extractor connections", () => {
  it("offers Flux tiers using the existing key, without treating native login as extraction", () => {
    const native = { instanceId: "claude", displayName: "Claude", enabled: true } as ProviderInstance;
    const choices = memoryExtractorConnections([native], "fixture-key");
    expect(choices.map(item => item.instanceId)).toEqual(["@murage/flux-fast", "@murage/flux-standard", "@murage/flux-auto"]);
    expect(choices.every(item => item.eligible)).toBe(true);
    expect(memoryExtractorConnections([], null).every(item => !item.eligible)).toBe(true);
    expect(resolveMemoryExtractor(null, [])).toBeNull();
  });

  it("uses capability rather than a vendor allowlist, and excludes disabled connections", () => {
    const extractMemory = vi.fn();
    const connection = { instanceId: "custom", displayName: "Existing custom connection", enabled: true, extractMemory } as unknown as ProviderInstance;
    expect(memoryExtractorConnections([connection], null).at(-1)?.instanceId).toBe("custom");
    expect(resolveMemoryExtractor("custom", [{ ...connection, enabled: false }])).toBeNull();
    expect(resolveMemoryExtractor("missing", [connection])).toBeNull();
  });

  it("makes one capped tool-free request to Flux and rereads the key before sending", async () => {
    let key: string | null = "initial-fixture-key";
    const extract = resolveMemoryExtractor("@murage/flux-fast", [], () => key)!;
    const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "[]" } }] })));
    vi.stubGlobal("fetch", request);
    key = "replacement-fixture-key";
    expect(await extract("Owner prefers daily reports.", 100, new AbortController().signal)).toBe("[]");
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.fluxrouter.ai/v1/chat/completions");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ authorization: "Bearer replacement-fixture-key" });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "flux-fast", max_tokens: 100, stream: false });
    expect(body).not.toHaveProperty("tools");
    key = null;
    expect(() => extract("source", 100, new AbortController().signal)).toThrow("MEMORY_EXTRACTOR_UNAVAILABLE");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
