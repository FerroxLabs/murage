// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cpCall, CP_USER_AGENT } from "./cp-client.ts";

const SECRET = "s".repeat(40);
type Seen = { url: string; init: RequestInit };
const make = (answer: () => Response | Promise<Response>) => {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return answer(); }) as unknown as typeof fetch;
  return { seen, fetchImpl };
};
const base = (fetchImpl: typeof fetch) => ({ fetch: fetchImpl, adminUrl: "https://cp.example/", homeId: "home_1", secret: () => SECRET, generation: () => 3, now: () => 1_800_000_000_000, nonce: () => "n".repeat(24) });

describe("home to control plane client", () => {
  it("signs the exact body with HMAC-SHA256 over the domain string, with the named user agent", async () => {
    const { seen, fetchImpl } = make(() => Response.json({ status: "none" }));
    const result = await cpCall("terms-proof", { homeTermsVersion: "2026-10-10" }, base(fetchImpl));
    expect(result).toEqual({ ok: true, status: 200, body: { status: "none" } });
    const { url, init } = seen[0];
    expect(url).toBe("https://cp.example/v1/homes/home_1/home/terms-proof");
    const headers = init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe(CP_USER_AGENT);
    expect(headers["user-agent"]).toBe("murage-home/1 (cp-client)");
    const body = init.body as string;
    expect(headers["x-murage-home-signature"]).toBe(createHmac("sha256", SECRET).update("murage-home-to-cp-v1\n" + body).digest("hex"));
    expect(headers["x-murage-home-signature"]).not.toBe(createHmac("sha256", SECRET).update(body).digest("hex"));
    expect(JSON.parse(body)).toEqual({ homeTermsVersion: "2026-10-10", operation: "terms-proof", timestamp: 1_800_000_000, nonce: "n".repeat(24), generation: 3 });
  });

  it("a field cannot override the operation, timestamp, nonce or generation", async () => {
    const { seen, fetchImpl } = make(() => Response.json({}));
    await cpCall("owner-event", { operation: "x", generation: 99, timestamp: 1, nonce: "z" }, base(fetchImpl));
    expect(JSON.parse(seen[0].init.body as string)).toMatchObject({ operation: "owner-event", generation: 3, timestamp: 1_800_000_000 });
  });

  it("fails closed: non-2xx, network error, timeout, missing secret, plain http", async () => {
    expect(await cpCall("terms-proof", {}, base(make(() => new Response("{}", { status: 503 })).fetchImpl))).toMatchObject({ ok: false, status: 503 });
    expect(await cpCall("terms-proof", {}, base((async () => { throw new Error("down"); }) as unknown as typeof fetch))).toEqual({ ok: false, status: 0 });
    const hang = (async (_u: string, init: RequestInit) => new Promise((_r, reject) => { init.signal!.addEventListener("abort", () => reject(new Error("aborted"))); })) as unknown as typeof fetch;
    expect(await cpCall("terms-proof", {}, { ...base(hang), timeoutMs: 20 })).toEqual({ ok: false, status: 0 });
    const noFetch = make(() => Response.json({}));
    expect(await cpCall("terms-proof", {}, { ...base(noFetch.fetchImpl), secret: () => undefined })).toEqual({ ok: false, status: 0 });
    expect(await cpCall("terms-proof", {}, { ...base(noFetch.fetchImpl), adminUrl: "http://cp.example" })).toEqual({ ok: false, status: 0 });
    expect(noFetch.seen).toHaveLength(0);
  });
});
