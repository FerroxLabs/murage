// R4-FLAG ruling (MurageMain, LASTRESORT 1018): hostRequest never turns an
// unreadable host reply into `{}`. A malformed or non-JSON body seals the
// proxy (A3c); a refusal raised while the body is read is rethrown unchanged
// (D4, design line 399).
import { beforeEach, describe, expect, it, vi } from "vitest";

const release = vi.hoisted(() => {
  process.env.MURAGE_BROWSER_URL = "http://127.0.0.1:9";
  process.env.MURAGE_BROWSER_TOKEN = "r4flag-test-token";
  process.env.MURAGE_BOT_ID = "r4flag-bot";
  delete process.env.MURAGE_CRED_FILE;
  return { lost: [] as string[] };
});

vi.mock("../proxy-turn-release.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../proxy-turn-release.ts")>()),
  sendProxyFrame: () => undefined,
  proxyTransportLost: (role: string) => { release.lost.push(role); },
  proxyUpstreamResponse: (_role: string, response: Response) => response,
}));

import { hostRequest } from "./browser-proxy.ts";

const reply = (response: Response) => (async () => response) as unknown as typeof fetch;

describe("browser-proxy hostRequest decode (R4-FLAG)", () => {
  beforeEach(() => { release.lost.length = 0; });

  it("R4-FLAG browser: a malformed or non-JSON host reply seals instead of returning {}", async () => {
    // red-at-4bf670e33: the D4 fallback resolved this 200 reply as {}.
    await expect(hostRequest("snapshot", {}, reply(new Response("<html>not json", { status: 200, headers: { "content-type": "text/html" } }))))
      .rejects.toThrow("MEMORY_CONTEXT_REVOKED");
    expect(release.lost).toEqual(["browser"]);
    await expect(hostRequest("snapshot", {}, reply(new Response("", { status: 404 })))).rejects.toThrow("MEMORY_CONTEXT_REVOKED");
    expect(release.lost).toEqual(["browser", "browser"]);
  });

  it("R4-FLAG browser: a refusal raised while reading the body is rethrown unchanged", async () => {
    const refusal = Object.assign(new Error("MEMORY_CONTEXT_REVOKED"), { code: "MEMORY_CONTEXT_REVOKED" });
    const response = new Response("{}", { status: 200 });
    Object.defineProperty(response, "json", { value: () => Promise.reject(refusal) });
    await expect(hostRequest("snapshot", {}, reply(response))).rejects.toBe(refusal);
    expect(release.lost).toEqual([]);
  });
});
