// R4-FLAG ruling (MurageMain, LASTRESORT 1018): dweb api() never turns an
// unreadable daemon reply into `{}`. A malformed or non-JSON body seals the
// proxy (A3c); a refusal raised while the body is read is rethrown unchanged
// (D4, design line 399).
import { beforeEach, describe, expect, it, vi } from "vitest";

const release = vi.hoisted(() => ({ lost: [] as string[], next: undefined as undefined | (() => Promise<Response>) }));

// dweb-proxy.ts is a stdio entrypoint; keep it off the worker's stdin.
vi.mock("node:readline", () => ({ default: { createInterface: () => ({ on: () => undefined }) } }));
vi.mock("../proxy-turn-release.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../proxy-turn-release.ts")>()),
  sendProxyFrame: () => undefined,
  proxyTransportLost: (role: string) => { release.lost.push(role); },
  proxyFetch: () => release.next!(),
}));

import { api } from "./dweb-proxy.ts";

describe("dweb-proxy api decode (R4-FLAG)", () => {
  beforeEach(() => { release.lost.length = 0; release.next = undefined; });

  it("R4-FLAG dweb: a malformed or non-JSON daemon reply seals instead of returning {}", async () => {
    // red-at-4bf670e33: the D4 fallback resolved this 200 reply as {}.
    release.next = async () => new Response("<html>not json", { status: 200, headers: { "content-type": "text/html" } });
    await expect(api("/ping")).rejects.toThrow();
    expect(release.lost).toEqual(["dweb"]);
    release.next = async () => new Response("", { status: 404 });
    await expect(api("/api/repo/status")).rejects.toThrow();
    expect(release.lost).toEqual(["dweb", "dweb"]);
  });

  it("R4-FLAG dweb: a refusal raised while reading the body is rethrown unchanged", async () => {
    const refusal = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
    const response = new Response("{}", { status: 200 });
    Object.defineProperty(response, "json", { value: () => Promise.reject(refusal) });
    release.next = async () => response;
    await expect(api("/ping")).rejects.toBe(refusal);
    expect(release.lost).toEqual([]);
  });
});
