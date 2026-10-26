// Settings > About > Get Murage news: the way back to the list after a skip.
// `joinNews` is what the button runs; it only ever talks to its own server.
import { describe, expect, it } from "vitest";

import { sellsOnPrice } from "@/lib/first-run-copy-rules";
import { NEWS_COPY, joinNews } from "./NewsSignupSettings";

function fake(answer: unknown | (() => Promise<unknown>)) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  return {
    calls,
    deps: { api: async (path: string, init?: RequestInit) => { calls.push({ path, init }); return typeof answer === "function" ? (answer as () => Promise<unknown>)() : answer; } },
  };
}

describe("Get Murage news", () => {
  it("posts the trimmed address and the profile name to the local server only", async () => {
    const box = fake({ ok: true });
    expect(await joinNews({ email: "  Sam@Example.com ", name: " Sam " }, box.deps)).toBe("ok");
    expect(box.calls).toHaveLength(1);
    expect(box.calls[0].path).toBe("/api/subscribe");
    expect(JSON.parse(String(box.calls[0].init?.body))).toEqual({ email: "sam@example.com", name: "Sam", from: "settings" });
  });

  it("sends nothing for a non-address", async () => {
    const box = fake({ ok: true });
    expect(await joinNews({ email: "sam@exa" }, box.deps)).toBe("invalid");
    expect(box.calls).toHaveLength(0);
  });

  it("says it did not go through when the local server could not take it", async () => {
    expect(await joinNews({ email: "sam@example.com" }, fake(() => Promise.reject(new Error("down"))).deps)).toBe("failed");
    expect(await joinNews({ email: "sam@example.com" }, fake({ ok: false, reason: "invalid-email" }).deps)).toBe("invalid");
  });

  it("keeps the house copy rules", () => {
    for (const line of Object.values(NEWS_COPY)) {
      expect(line).not.toMatch(/[—–]/);
      expect(line).not.toMatch(/\b(safe|safely|safety|unsafe|composio)\b/i);
      expect(sellsOnPrice(line)).toBeNull();
    }
    expect(NEWS_COPY.title).toBe("Get Murage news");
  });
});
