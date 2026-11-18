// SPDX-License-Identifier: AGPL-3.0-or-later
// The Vercel bypass reaches Flux's staging app from a staging Worker, and nothing else.
import { describe, expect, it } from "vitest";
import { ensureFluxAccount } from "../src/flux-grants.ts";

const BYPASS = "x-vercel-protection-bypass";
const STAGING_APP = "https://app-staging.fluxrouter.ai";

async function headersSent(env: Record<string, string>): Promise<Headers> {
  let sent = new Headers();
  const doFetch = async (_url: string, init?: RequestInit) => {
    sent = new Headers(init?.headers);
    return new Response(JSON.stringify({ flux_account_id: "acct", created: true }), { status: 200 });
  };
  await ensureFluxAccount({ FLUX_CLOUD_SERVICE_TOKEN: "token", ...env } as unknown as Env, doFetch, { murageAccountId: "a", email: "a@example.com", emailVerified: false });
  return sent;
}

describe("ensureFluxAccount: staging Vercel bypass", () => {
  it("sends the header from staging to the staging app", async () => {
    const sent = await headersSent({ MURAGE_ENV: "staging", FLUX_APP_BASE: STAGING_APP, FLUX_STAGING_VERCEL_BYPASS: " fake-bypass " });
    expect(sent.get(BYPASS)).toBe("fake-bypass");
    expect(sent.get("authorization")).toBe("Bearer token");
  });
  it.each([
    ["a live Worker", { MURAGE_ENV: "live", FLUX_APP_BASE: STAGING_APP, FLUX_STAGING_VERCEL_BYPASS: "fake-bypass" }],
    ["another host", { MURAGE_ENV: "staging", FLUX_APP_BASE: "https://fluxrouter.ai", FLUX_STAGING_VERCEL_BYPASS: "fake-bypass" }],
    ["the default host", { MURAGE_ENV: "staging", FLUX_STAGING_VERCEL_BYPASS: "fake-bypass" }],
    ["an empty secret", { MURAGE_ENV: "staging", FLUX_APP_BASE: STAGING_APP, FLUX_STAGING_VERCEL_BYPASS: "   " }],
    ["no secret", { MURAGE_ENV: "staging", FLUX_APP_BASE: STAGING_APP }],
  ])("sends no header with %s", async (_label, env) => {
    expect((await headersSent(env)).has(BYPASS)).toBe(false);
  });
});
