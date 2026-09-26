// The phone keeps a page open for days; the computer updates Murage under
// it. The next lazy screen then asks for a chunk whose hashed name no longer
// exists, and the tap does nothing. One reload fetches the new shell. A
// sessionStorage stamp makes it ONE: a chunk that is genuinely broken must
// surface its error, not reload the page in a loop.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { CHUNK_RELOAD_KEY, CHUNK_RELOAD_WINDOW_MS, installChunkReload, shouldReloadForChunk } from "./chunk-reload";

function fixture(initial: Record<string, string> = {}, options: { denied?: boolean } = {}) {
  const values = new Map(Object.entries(initial));
  let handler: ((event: Event) => void) | undefined;
  let now = 1_000_000;
  const reload = vi.fn();
  const target = { addEventListener: vi.fn((_: string, h: any) => { handler = h; }), removeEventListener: vi.fn() };
  const storage = {
    getItem: (key: string) => { if (options.denied) throw new Error("denied"); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (options.denied) throw new Error("denied"); values.set(key, value); },
  };
  const stop = installChunkReload({ target, storage: () => storage, reload, now: () => now });
  const fail = () => { const event = { preventDefault: vi.fn() } as unknown as Event; handler!(event); return event; };
  return { fail, reload, values, stop, target, advance: (ms: number) => { now += ms; } };
}

describe("a missing chunk after an update", () => {
  it("reloads once and swallows the error it replaces", () => {
    const f = fixture();
    const event = f.fail();
    expect(f.reload).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(f.values.get(CHUNK_RELOAD_KEY)).toBe("1000000");
  });

  it("does not reload again inside the window, so a broken chunk cannot loop", () => {
    const f = fixture({ [CHUNK_RELOAD_KEY]: "1000000" });
    const event = f.fail();
    expect(f.reload).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("reloads again for a later update in the same session", () => {
    const f = fixture({ [CHUNK_RELOAD_KEY]: "1000000" });
    f.advance(CHUNK_RELOAD_WINDOW_MS);
    f.fail();
    expect(f.reload).toHaveBeenCalledOnce();
  });

  it("never reloads when the stamp cannot be written — that would be the loop", () => {
    const f = fixture({}, { denied: true });
    f.fail();
    expect(f.reload).not.toHaveBeenCalled();
  });

  it("reads a garbled or future stamp as none", () => {
    expect(shouldReloadForChunk("garbage", 5)).toBe(true);
    expect(shouldReloadForChunk("99999999", 5)).toBe(true);
    expect(shouldReloadForChunk(null, 5)).toBe(true);
  });

  it("is installed before the first render", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    expect(main.indexOf("installChunkReload(browserChunkReloadDeps());")).toBeGreaterThan(-1);
    expect(main.indexOf("installChunkReload(")).toBeLessThan(main.indexOf("createRoot("));
  });
});
