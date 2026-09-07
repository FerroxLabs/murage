import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ensureSecret, secretHeaders } = vi.hoisted(() => ({
  ensureSecret: vi.fn<() => Promise<string>>(),
  secretHeaders: vi.fn<() => Record<string, string>>(),
}));

vi.mock("@/lib/live-events", () => ({
  ensureDesktopSurfaceSecret: ensureSecret,
  desktopSurfaceHeaders: secretHeaders,
  desktopSurfaceSecretNeedsRetry: () => false,
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetModules();
  ensureSecret.mockReset().mockResolvedValue("fixture-secret");
  secretHeaders.mockReset().mockReturnValue({ "x-murage-surface-secret": "fixture-secret" });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("surface handshake", () => {
  it.each([503, 401, 403, 404])("retries after HTTP %s without remembering the fallback", async (status) => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(Response.json({ surface: "desktop" }));
    const { surface, knownSurface } = await import("./surface");

    expect(knownSurface()).toBeUndefined();
    expect(await surface()).toBe("remote");
    expect(knownSurface()).toBeUndefined();
    expect(await surface()).toBe("desktop");
    expect(knownSurface()).toBe("desktop");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ensureSecret).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { surface: "unknown" }, { surface: true }, ["desktop"], "desktop"])(
    "does not cache malformed successful body %j",
    async (body) => {
      fetchMock
        .mockResolvedValueOnce(Response.json(body))
        .mockResolvedValueOnce(Response.json({ surface: "desktop" }));
      const { surface, knownSurface } = await import("./surface");

      expect(await surface()).toBe("remote");
      expect(knownSurface()).toBeUndefined();
      expect(await surface()).toBe("desktop");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["transport", "json", "secret"])("recovers from a %s failure", async (failure) => {
    if (failure === "transport") fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    if (failure === "json") fetchMock.mockResolvedValueOnce(new Response("not json"));
    if (failure === "secret") ensureSecret.mockRejectedValueOnce(new Error("secret unavailable"));
    fetchMock.mockResolvedValueOnce(Response.json({ surface: "desktop" }));
    const { surface, knownSurface } = await import("./surface");

    expect(await surface()).toBe("remote");
    expect(knownSurface()).toBeUndefined();
    expect(await surface()).toBe("desktop");
    expect(knownSurface()).toBe("desktop");
    expect(fetchMock).toHaveBeenCalledTimes(failure === "secret" ? 1 : 2);
  });

  it.each(["desktop", "remote"] as const)("caches a validated %s answer", async (answer) => {
    fetchMock.mockResolvedValueOnce(Response.json({ surface: answer }));
    const { surface, knownSurface, isDesktopSurface } = await import("./surface");

    expect(await surface()).toBe(answer);
    expect(knownSurface()).toBe(answer);
    expect(await surface()).toBe(answer);
    expect(await isDesktopSurface()).toBe(answer === "desktop");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ensureSecret).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/config", {
      headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": "fixture-secret" },
    });
  });

  it("shares each in-flight attempt and waits for the secret before fetching", async () => {
    let resolveSecret!: (value: string) => void;
    ensureSecret.mockImplementationOnce(() => new Promise((resolve) => { resolveSecret = resolve; }));
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ surface: "desktop" }));
    const { surface, knownSurface } = await import("./surface");

    const first = surface();
    expect(surface()).toBe(first);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ensureSecret).toHaveBeenCalledTimes(1);
    resolveSecret("fixture-secret");
    expect(await first).toBe("remote");
    expect(knownSurface()).toBeUndefined();

    const retry = surface();
    expect(surface()).toBe(retry);
    expect(await retry).toBe("desktop");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ensureSecret).toHaveBeenCalledTimes(2);
  });
});
