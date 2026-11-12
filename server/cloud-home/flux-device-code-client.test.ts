// SPDX-License-Identifier: AGPL-3.0-or-later
// The real Flux contract (FluxMain, PR TradeCanyon/flux-router-app#274), mocked fetch. Field names here are the contract's, not guesses.
import { describe, expect, it, vi } from "vitest";
import { createFluxDeviceCodeClient, DEVICE_CAPABILITIES_PATH, DEVICE_CODE_PATH, DEVICE_REVOKE_PATH, DEVICE_TOKEN_PATH } from "./flux-device-code-client.ts";
import { MAX_POLL_INTERVAL_MS, revokeWithBackoff, runOwnerSignIn, SLOW_DOWN_STEP_MS, type FluxDeviceCodeClient } from "./email-owner-signin.ts";

import { FLUX_DEVICE_BASE } from "../flux-routing.ts";
import { recordedCapabilities, recordedCode } from "./flux-device-fixtures.ts";

const BASE = "https://fluxrouter.ai";
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const CAPS = {
  device_authorization_grant: true, client_id: "murage-cloud", scope: "email:owner", grant_type: GRANT,
  device_authorization_endpoint: `${BASE}/api/device/code`, token_endpoint: `${BASE}/api/device/token`, revocation_endpoint: `${BASE}/api/device/revoke`,
  verification_uri: `${BASE}/device`, expires_in: 900, interval: 5, slow_down_increment: 5, max_interval: 60, bot_keys: true,
};
const GOOD = { device_code: "dc", user_code: "WXYZ-1234", verification_uri: `${BASE}/device`, verification_uri_complete: `${BASE}/device?user_code=WXYZ-1234`, expires_in: 900, interval: 5 };
const TOKEN_OK = { api_key: "flx_owner_secret", key_prefix: "flx_own", name: "Murage Cloud", key_id: "key_o", account_id: "acct_1", scopes: ["email:owner"] };
const reply = (status: number, body?: unknown) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json" } });
/** Answers by path; capabilities and code default to the good shapes. */
function wire(over: { caps?: () => Response; code?: () => Response; token?: () => Response; revoke?: () => Response } = {}) {
  const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === DEVICE_CAPABILITIES_PATH) return (over.caps ?? (() => reply(200, CAPS)))();
    if (url.pathname === DEVICE_CODE_PATH) return (over.code ?? (() => reply(200, GOOD)))();
    if (url.pathname === DEVICE_TOKEN_PATH) return (over.token ?? (() => reply(400, { error: "authorization_pending" })))();
    if (url.pathname === DEVICE_REVOKE_PATH) return (over.revoke ?? (() => reply(204)))();
    void init; return reply(404, { error: "not_found" });
  });
  return { fetchMock, client: createFluxDeviceCodeClient({ baseUrl: BASE, fetch: fetchMock as unknown as typeof fetch }) };
}
const paths = (fetchMock: ReturnType<typeof wire>["fetchMock"]) => fetchMock.mock.calls.map(c => new URL(String(c[0])).pathname);
const bodyOf = (fetchMock: ReturnType<typeof wire>["fetchMock"], path: string) => JSON.parse(String(fetchMock.mock.calls.find(c => new URL(String(c[0])).pathname === path)![1]!.body));

describe("S1 the capabilities gate: no code is requested until bot_keys is true", () => {
  it.each([
    ["404 (flag off)", () => reply(404, { error: "not_found" })],
    ["bot_keys absent", () => reply(200, { ...CAPS, bot_keys: undefined })],
    ["bot_keys false", () => reply(200, { ...CAPS, bot_keys: false })],
    ["bot_keys a string", () => reply(200, { ...CAPS, bot_keys: "true" })],
    ["another client_id", () => reply(200, { ...CAPS, client_id: "flux-desktop" })],
    ["another scope", () => reply(200, { ...CAPS, scope: "email:owner email:send" })],
    ["another grant type", () => reply(200, { ...CAPS, grant_type: "authorization_code" })],
    ["a code endpoint on another origin", () => reply(200, { ...CAPS, device_authorization_endpoint: "https://evil.test/api/device/code" })],
    ["a token endpoint on another origin", () => reply(200, { ...CAPS, token_endpoint: "https://evil.test/api/device/token" })],
    ["a revocation endpoint on another origin", () => reply(200, { ...CAPS, revocation_endpoint: "https://evil.test/api/device/revoke" })],
    ["a non-JSON body", () => new Response("<html>", { status: 200 })],
    ["a 500", () => reply(500, {})],
  ])("capabilities %s: unavailable, and /api/device/code is never called", async (_name, caps) => {
    const { client, fetchMock } = wire({ caps });
    expect(await client.start()).toEqual({ state: "unavailable" });
    expect(paths(fetchMock)).toEqual([DEVICE_CAPABILITIES_PATH]);
  });
  it("a thrown fetch is unavailable", async () => {
    const client = createFluxDeviceCodeClient({ baseUrl: BASE, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect(await client.start()).toEqual({ state: "unavailable" });
  });
});

describe("start and poll use the real field names", () => {
  it("start without a home display name posts {client_id, scope} only and maps the reply; expires_in 900 is capped at 600 s", async () => {
    const { client, fetchMock } = wire();
    expect(await client.start()).toEqual({ deviceCode: "dc", userCode: "WXYZ-1234", verificationUrl: `${BASE}/device?user_code=WXYZ-1234`, intervalMs: 5000, expiresInMs: 600_000 });
    expect(paths(fetchMock)).toEqual([DEVICE_CAPABILITIES_PATH, DEVICE_CODE_PATH]);
    expect(bodyOf(fetchMock, DEVICE_CODE_PATH)).toEqual({ client_id: "murage-cloud", scope: "email:owner" });
  });
  it("S2 a verification_uri on another origin is refused; one on this origin without _complete is used", async () => {
    expect(await wire({ code: () => reply(200, { ...GOOD, verification_uri: "https://evil.test/device", verification_uri_complete: undefined }) }).client.start()).toEqual({ state: "unavailable" });
    const noComplete = await wire({ code: () => reply(200, { ...GOOD, verification_uri_complete: "https://evil.test/x" }) }).client.start();
    expect((noComplete as { verificationUrl: string }).verificationUrl).toBe(`${BASE}/device`);
  });
  it.each(["device_code", "user_code", "verification_uri", "expires_in", "interval"])("a code response without %s is unavailable", async field => {
    const body: Record<string, unknown> = { ...GOOD }; delete body[field];
    expect(await wire({ code: () => reply(200, body) }).client.start()).toEqual({ state: "unavailable" });
  });
  it("a 404 or 500 on /api/device/code is unavailable", async () => {
    expect(await wire({ code: () => reply(404, {}) }).client.start()).toEqual({ state: "unavailable" });
    expect(await wire({ code: () => reply(500, {}) }).client.start()).toEqual({ state: "unavailable" });
  });
  it.each([
    ["authorization_pending", { state: "pending" }],
    ["slow_down", { state: "slow_down" }],
    ["expired_token", { state: "expired" }],
    ["access_denied", { state: "denied" }],
    ["invalid_grant", { state: "expired" }],
  ])("poll posts {grant_type, device_code, client_id}; 400 %s", async (error, expected) => {
    const { client, fetchMock } = wire({ token: () => reply(400, { error }) });
    await client.start();
    expect(await client.poll("dc")).toEqual(expected);
    expect(bodyOf(fetchMock, DEVICE_TOKEN_PATH)).toEqual({ grant_type: GRANT, device_code: "dc", client_id: "murage-cloud" });
  });
  it("poll 200 reads api_key and key_id (not access_token); scopes must hold email:owner", async () => {
    const start = async (token: () => Response) => { const w = wire({ token }); await w.client.start(); return w.client.poll("dc"); };
    expect(await start(() => reply(200, TOKEN_OK))).toEqual({ state: "ok", owner: { token: "flx_owner_secret", keyId: "key_o" }, scoped: true });
    expect(await start(() => reply(200, { ...TOKEN_OK, scopes: ["email:send"] }))).toEqual({ state: "ok", owner: { token: "flx_owner_secret", keyId: "key_o" }, scoped: false });
    expect(await start(() => reply(200, { ...TOKEN_OK, scopes: undefined }))).toMatchObject({ state: "ok", scoped: false });
    // the old guessed name carries no token
    expect(await start(() => reply(200, { access_token: "tok", key_id: "key_o" }))).toEqual({ state: "unavailable" });
    expect(await start(() => reply(200, { key_id: "key_o" }))).toEqual({ state: "unavailable" });
    // any other 4xx or 5xx is transient: polling goes on until the code expires (M7)
    expect(await start(() => reply(400, { error: "server_error" }))).toEqual({ state: "retry" });
  });
});

describe("revoke: POST /api/device/revoke with the key as bearer", () => {
  it.each([[204, "revoked"], [401, "gone"], [503, "retry"], [404, "retry"], [500, "retry"]] as const)("%s means %s", async (status, expected) => {
    const { client, fetchMock } = wire({ revoke: () => reply(status, status === 401 ? { error: "invalid_token" } : { error: "temporarily_unavailable" }) });
    expect(await client.revoke("flx_owner_secret")).toBe(expected);
    const call = fetchMock.mock.calls.find(c => new URL(String(c[0])).pathname === DEVICE_REVOKE_PATH)!;
    expect(call[1]!.method).toBe("POST");
    expect((call[1]!.headers as Record<string, string>).authorization).toBe("Bearer flx_owner_secret");
  });
  it.each([[202, undefined, "revoked"], [401, "permission_denied", "retry"], [404, "gone", "gone"]] as const)("revoke %s with %s follows the terminal response contract", async (status, error, expected) => {
    const { client } = wire({ revoke: () => reply(status, { error }) });
    expect(await client.revoke("fixture-token")).toBe(expected);
  });
  it("a thrown fetch is retry (not revoked)", async () => {
    const client = createFluxDeviceCodeClient({ baseUrl: BASE, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect(await client.revoke("t")).toBe("retry");
  });
  it("S7 revokeWithBackoff: 503, 503, 204 retries with growing delay then stops; 401 stops at once", async () => {
    const answers = ["retry", "retry", "revoked"] as const; let i = 0;
    const sleeps: number[] = [];
    const client: FluxDeviceCodeClient = { start: async () => ({ state: "unavailable" }), poll: async () => ({ state: "unavailable" }), revoke: vi.fn(async () => answers[i++]!) };
    expect(await revokeWithBackoff(client, "t", { sleep: async ms => { sleeps.push(ms); } })).toBe("revoked");
    expect(client.revoke).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([5000, 10_000]);
    const gone: FluxDeviceCodeClient = { ...client, revoke: vi.fn(async () => "gone" as const) };
    expect(await revokeWithBackoff(gone, "t", { sleep: async () => { throw new Error("no retry"); } })).toBe("gone");
    expect(gone.revoke).toHaveBeenCalledTimes(1);
    const stopped = { ...client, revoke: vi.fn(async () => "retry" as const) };
    let calls = 0;
    expect(await revokeWithBackoff(stopped, "t", { sleep: async () => {}, stop: () => calls++ >= 2 })).toBe("stopped");
    expect(stopped.revoke).toHaveBeenCalledTimes(2);
  });
});

describe("S3 and S4 the poll loop follows the contract", () => {
  const START = { deviceCode: "dc", userCode: "U", verificationUrl: "https://x/", intervalMs: 5000, expiresInMs: 600_000 };
  const owner = { token: "t", keyId: "k" };
  const noToken = { code: () => {}, token: async () => true as const };
  it("slow_down three times then pending: intervals 5, 10, 15, 20 s; past 60 s it stays 60", async () => {
    const sleeps: number[] = [];
    const answers = [{ state: "slow_down" }, { state: "slow_down" }, { state: "slow_down" }, { state: "pending" }, { state: "ok", owner, scoped: true }] as const;
    let i = 0;
    const client: FluxDeviceCodeClient = { start: async () => START, poll: async () => answers[i++]!, revoke: async () => "revoked" };
    expect(await runOwnerSignIn(client, noToken, { sleep: async ms => { sleeps.push(ms); } })).toBe("done");
    expect(sleeps).toEqual([5000, 5000 + SLOW_DOWN_STEP_MS, 5000 + 2 * SLOW_DOWN_STEP_MS, 5000 + 3 * SLOW_DOWN_STEP_MS, 5000 + 3 * SLOW_DOWN_STEP_MS]);
    const long: number[] = [];
    let n = 0;
    const slow: FluxDeviceCodeClient = { start: async () => ({ ...START, intervalMs: 55_000, expiresInMs: 10_000_000 }), poll: async () => (n++ < 3 ? { state: "slow_down" } : { state: "denied" }), revoke: async () => "revoked" };
    await runOwnerSignIn(slow, noToken, { sleep: async ms => { long.push(ms); } });
    expect(long).toEqual([55_000, MAX_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS]);
  });
  it("no poll after the deadline (expires_in 900 is capped at 600 s by the client, the loop re-checks it)", async () => {
    const poll = vi.fn(async () => ({ state: "pending" as const }));
    let slept = 0;
    expect(await runOwnerSignIn({ start: async () => ({ ...START, intervalMs: 60_000, expiresInMs: 900_000 }), poll, revoke: async () => "revoked" }, noToken, { sleep: async ms => { slept += ms; }, now: () => slept })).toBe("expired");
    expect(slept).toBeLessThanOrEqual(660_000);
    expect(poll.mock.calls.length).toBeLessThanOrEqual(10);
  });
  it("S4 access_denied, expired_token and invalid_grant each end the attempt with no further poll", async () => {
    for (const [error, outcome] of [["access_denied", "denied"], ["expired_token", "expired"], ["invalid_grant", "expired"]] as const) {
      const w = wire({ token: () => reply(400, { error }) });
      expect(await runOwnerSignIn(w.client, noToken, { sleep: async () => {} })).toBe(outcome);
      expect(paths(w.fetchMock).filter(p => p === DEVICE_TOKEN_PATH)).toHaveLength(1);
    }
  });
  it("T0 stops after the one issued key even when a later poll would return invalid_grant", async () => {
    const script = [reply(200, TOKEN_OK), reply(400, { error: "invalid_grant" })];
    let n = 0;
    const w = wire({ token: () => script[n++]! });
    const token = vi.fn(async () => true as const);
    expect(await runOwnerSignIn(w.client, { code: () => {}, token }, { sleep: async () => {} })).toBe("done");
    expect(paths(w.fetchMock).filter(path => path === DEVICE_TOKEN_PATH)).toHaveLength(1);
    expect(token).toHaveBeenCalledTimes(1);
  });
  it("S5 a 200 without the email:owner scope: the token handler is never called, discard gets the key", async () => {
    const w = wire({ token: () => reply(200, { ...TOKEN_OK, scopes: ["email:send"] }) });
    const token = vi.fn(async () => true as const), discard = vi.fn();
    expect(await runOwnerSignIn(w.client, { code: () => {}, token, discard }, { sleep: async () => {} })).toBe("unavailable");
    expect(token).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith({ token: "flx_owner_secret", keyId: "key_o" });
  });
  it("end to end over the mocked wire: pending, slow_down, then the real 200; the flag-off 404 shows no code", async () => {
    const script = [reply(400, { error: "authorization_pending" }), reply(400, { error: "slow_down" }), reply(200, TOKEN_OK)];
    let n = 0;
    const w = wire({ token: () => script[n++]! });
    const token = vi.fn(async () => true as const);
    expect(await runOwnerSignIn(w.client, { code: () => {}, token }, { sleep: async () => {} })).toBe("done");
    expect(token).toHaveBeenCalledWith({ token: "flx_owner_secret", keyId: "key_o" });
    const off = wire({ caps: () => reply(404, {}) });
    expect(await runOwnerSignIn(off.client, { code: () => { throw new Error("no code shown"); }, token }, { sleep: async () => {} })).toBe("unavailable");
  });
  it("S2 the device_code reaches no event, only the user code and the page", async () => {
    const w = wire();
    const seen: unknown[] = [];
    await runOwnerSignIn(w.client, { code: info => seen.push(info), token: async () => true }, { sleep: async () => {}, maxPolls: 1 });
    expect(JSON.stringify(seen)).not.toContain("dc\"");
    expect(seen).toEqual([{ userCode: "WXYZ-1234", verificationUrl: `${BASE}/device?user_code=WXYZ-1234` }]);
  });
});

describe("H2 recorded app responses", () => {
  it("accepts recorded capabilities and code on the production device base", async () => {
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => Response.json(String(input).endsWith("capabilities") ? recordedCapabilities(FLUX_DEVICE_BASE) : recordedCode(FLUX_DEVICE_BASE)));
    const client = createFluxDeviceCodeClient({ baseUrl: FLUX_DEVICE_BASE, fetch: fetcher });
    expect(await client.start()).toMatchObject({ deviceCode: "fixture-device-code", userCode: "ABCD-1234", verificationUrl: `${FLUX_DEVICE_BASE}/device?user_code=ABCD-1234` });
  });
  it("refuses an arbitrary same-origin sign-in page and the other environment", async () => {
    for (const origin of ["https://attacker.test", "https://app-staging.fluxrouter.ai"]) {
      const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => Response.json(String(input).endsWith("capabilities") ? recordedCapabilities(origin) : recordedCode(origin)));
      const client = createFluxDeviceCodeClient({ baseUrl: origin, fetch: fetcher });
      expect(await client.start()).toEqual({ state: "unavailable" });
    }
  });
});

describe("T1 optional home display name", () => {
  it("sanitises emoji and cuts an existing 80 character name to 64", async () => {
    const homeLabel = "  🏠 " + "A".repeat(80) + " 🚀  ";
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json(String(input).endsWith("capabilities") ? recordedCapabilities(FLUX_DEVICE_BASE) : recordedCode(FLUX_DEVICE_BASE)));
    const client = createFluxDeviceCodeClient({ baseUrl: FLUX_DEVICE_BASE, fetch: fetcher, homeLabel });
    expect(await client.start()).toMatchObject({ userCode: "ABCD-1234" });
    const code = fetcher.mock.calls.find(([input]) => String(input).endsWith("/code"))!;
    expect(JSON.parse(String(code[1]!.body))).toEqual({ client_id: "murage-cloud", scope: "email:owner", home_label: "A".repeat(64) });
  });
  it.each([undefined, "", "  ", "🏠🚀<>\t\n"])("omits an absent or empty sanitised label: %s", async homeLabel => {
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json(String(input).endsWith("capabilities") ? recordedCapabilities(FLUX_DEVICE_BASE) : recordedCode(FLUX_DEVICE_BASE)));
    await createFluxDeviceCodeClient({ baseUrl: FLUX_DEVICE_BASE, fetch: fetcher, homeLabel }).start();
    const code = fetcher.mock.calls.find(([input]) => String(input).endsWith("/code"))!;
    expect(JSON.parse(String(code[1]!.body))).toEqual({ client_id: "murage-cloud", scope: "email:owner" });
  });
  it("keeps the permitted punctuation in a display name", async () => {
    const homeLabel = "Home . _ ' ( ) - 12";
    const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => Response.json(String(input).endsWith("capabilities") ? recordedCapabilities(FLUX_DEVICE_BASE) : recordedCode(FLUX_DEVICE_BASE)));
    await createFluxDeviceCodeClient({ baseUrl: FLUX_DEVICE_BASE, fetch: fetcher, homeLabel }).start();
    expect(JSON.parse(String(fetcher.mock.calls.find(([input]) => String(input).endsWith("/code"))![1]!.body)).home_label).toBe(homeLabel);
  });
});
