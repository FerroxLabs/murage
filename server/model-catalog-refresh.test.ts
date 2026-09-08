import { afterEach, expect, it, vi } from "vitest";
import { startModelCatalogRefresh, MODEL_CATALOG_REFRESH_MS } from "./model-catalog-refresh.ts";
afterEach(() => vi.useRealTimers());
it("checks due metadata on startup and while open, without overlapping refreshes", async () => {
  vi.useFakeTimers(); let finish!: () => void;
  const refresh = vi.fn((_signal: AbortSignal) => new Promise<void>(resolve => { finish = resolve; }));
  const stop = startModelCatalogRefresh(refresh); await Promise.resolve();
  expect(refresh).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(MODEL_CATALOG_REFRESH_MS); expect(refresh).toHaveBeenCalledOnce();
  finish(); await vi.advanceTimersByTimeAsync(60_000); expect(refresh).toHaveBeenCalledTimes(2);
  const stopped = stop(); expect(refresh.mock.calls[1][0].aborted).toBe(true);
  finish(); await stopped; await vi.advanceTimersByTimeAsync(MODEL_CATALOG_REFRESH_MS);
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("drains a failed discovery and keeps future daily checks available", async () => {
  vi.useFakeTimers(); const refresh = vi.fn(async () => { throw new Error("catalog offline"); });
  const stop = startModelCatalogRefresh(refresh);
  await vi.advanceTimersByTimeAsync(60_000); expect(refresh).toHaveBeenCalledTimes(2);
  await stop();
});
