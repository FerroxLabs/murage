import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomeModelSignIn, CLOUD_MODEL_SIGNINS_KEY, type HomeSignInProvider } from "./model-signin.ts";
import { SealedSecretStore } from "./secrets.ts";
import { s256Challenge } from "../../electron/model-signin-oauth.mjs";
import { removeTempDirSync } from "../testing/cleanup.ts";
const actor = { environmentId: "env-one", deviceId: "phone-one" };
const verifier = "v".repeat(43);
const idToken = `x.${Buffer.from(JSON.stringify({ email: "owner@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "plus" } })).toString("base64url")}.x`;
const tokens = { access_token: "fake-access-secret", refresh_token: "fake-refresh-secret", id_token: idToken, expires_in: 3600 };
const challenge = (provider: HomeSignInProvider) => provider === "chatgpt" ? { device_auth_id: "private-device", user_code: "CODE-1", interval: "5" } : { device_code: "private-device", user_code: "CODE-1", verification_uri: "https://auth.x.ai/device", expires_in: 900, interval: 5 };
const code = { authorization_code: "private-code", code_verifier: verifier, code_challenge: s256Challenge(verifier) };
let cleanup: (() => void)[];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); cleanup = []; });
afterEach(() => { for (const fn of cleanup.reverse()) fn(); vi.useRealTimers(); });
function fixture(replies: Array<Response | (() => Promise<Response>)>) {
  const directory = mkdtempSync(join(tmpdir(), "cloud-signin-")), key = Buffer.alloc(32, 7);
  const store = new SealedSecretStore(directory, "fake-machine", key);
  store.patch({ fluxApiKey: "unrelated-preserved" });
  const writes = vi.spyOn(store, "patch"), published: unknown[] = [];
  const fetcher = vi.fn(async () => { const next = replies.shift(); if (!next) throw new Error("unexpected request"); return typeof next === "function" ? next() : next; });
  const manager = createHomeModelSignIn({ store, env: {}, fetch: fetcher as typeof fetch, publish: entries => published.push(entries) });
  cleanup.push(() => { manager.dispose(); store.close(); removeTempDirSync(directory); });
  return { manager, store, writes, published, fetcher, directory, key };
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
async function start(h: ReturnType<typeof fixture>, provider: HomeSignInProvider = "chatgpt") {
  const result = await h.manager.dispatch({ operation: "start", provider, actor });
  if (!result || !("attemptId" in result) || !("userCode" in result) || typeof result.userCode !== "string") throw new Error("fixture did not receive its sign-in challenge");
  return result;
}
async function status(h: ReturnType<typeof fixture>, attemptId: string, provider: HomeSignInProvider = "chatgpt") { return h.manager.dispatch({ operation: "attempt", provider, attemptId, actor }); }
describe("real headless home factory and sealed custody", () => {
  it.each(["chatgpt", "supergrok"] as const)("%s completes exact device wire, publishes only private access and reloads durable identity", async provider => {
    const h = fixture([json(challenge(provider)), ...(provider === "chatgpt" ? [json(code)] : []), json(tokens)]);
    const begun = await start(h, provider);
    expect(begun).toMatchObject({ provider, state: "waiting", userCode: "CODE-1" });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await status(h, begun.attemptId, provider)).toMatchObject({ state: "connected" });
    const calls = h.fetcher.mock.calls as unknown as Array<[string, RequestInit]>;
    for (const [, init] of calls) expect(init.redirect).toBe("error");
    if (provider === "chatgpt") {
      expect(JSON.parse(String(calls[0][1].body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
      expect(JSON.parse(String(calls[1][1].body))).toEqual({ device_auth_id: "private-device", user_code: "CODE-1" });
      expect(Object.fromEntries(new URLSearchParams(String(calls[2][1].body)))).toEqual({ grant_type: "authorization_code", client_id: "app_EMoamEEZ73f0CkXaXp7hrann", code: "private-code", code_verifier: verifier, redirect_uri: "https://auth.openai.com/deviceauth/callback" });
    } else {
      expect(Object.fromEntries(new URLSearchParams(String(calls[0][1].body)))).toEqual({ client_id: "b1a00492-073a-47ea-816f-4c329264a828", scope: "openid profile offline_access grok-cli:access api:access", referrer: "murage" });
      expect(Object.fromEntries(new URLSearchParams(String(calls[1][1].body)))).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "private-device", client_id: "b1a00492-073a-47ea-816f-4c329264a828" });
      expect(calls).toHaveLength(2);
    }
    expect(h.store.getAll().fluxApiKey).toBe("unrelated-preserved");
    expect(h.writes.mock.calls.every(([patch]) => Object.keys(patch).join() === CLOUD_MODEL_SIGNINS_KEY)).toBe(true);
    const publicJson = JSON.stringify([begun, await status(h, begun.attemptId, provider), await h.manager.dispatch({ operation: "status", actor })]);
    for (const secret of [tokens.access_token, tokens.refresh_token, idToken, "private-device", verifier]) expect(publicJson).not.toContain(secret);
    expect(JSON.stringify(h.published)).toContain(tokens.access_token);
    expect(JSON.stringify(h.published)).not.toContain(tokens.refresh_token);
    expect(JSON.stringify(h.published)).not.toContain(idToken);
    const reloaded = new SealedSecretStore(h.directory, "fake-machine", h.key);
    expect(JSON.parse(reloaded.getAll()[CLOUD_MODEL_SIGNINS_KEY])[provider].refreshToken).toBe(tokens.refresh_token); reloaded.close();
  });
  it.each(["cancel", "revoke", "suspend", "disconnect", "signOut", "remove"])("%s fences a late token response", async action => {
    let release!: (response: Response) => void;
    const h = fixture([json(challenge("chatgpt")), json(code), () => new Promise(resolve => { release = resolve; })]);
    const begun = await start(h); await vi.advanceTimersByTimeAsync(5000);
    if (action === "revoke") h.manager.invalidateOwner({ deviceId: actor.deviceId, all: false });
    else if (action === "suspend") h.manager.invalidateOwner({ all: true });
    else if (action === "disconnect") h.manager.disconnect(0);
    else await h.manager.dispatch({ operation: action as "cancel" | "signOut" | "remove", provider: "chatgpt", attemptId: begun.attemptId, actor });
    release(json(tokens)); await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(h.store.getAll())).not.toContain(tokens.refresh_token);
    expect(JSON.stringify(h.published)).not.toContain(tokens.access_token);
    expect(await status(h, begun.attemptId)).toMatchObject({ state: "cancelled" });
  });
  it("binds attempts to stable actor, bounds starts and status never polls", async () => {
    const h = fixture([json(challenge("chatgpt"))]); const begun = await start(h);
    await expect(start(h)).rejects.toMatchObject({ code: "rate-limited" });
    await expect(h.manager.dispatch({ operation: "attempt", provider: "chatgpt", attemptId: begun.attemptId, actor: { ...actor, deviceId: "other" } })).rejects.toMatchObject({ code: "not-found" });
    await status(h, begun.attemptId); await status(h, begun.attemptId); expect(h.fetcher).toHaveBeenCalledTimes(1);
    h.manager.dispose();
    const restarted = createHomeModelSignIn({ store: h.store, fetch: h.fetcher as typeof fetch, publish: () => {} });
    await expect(restarted.dispatch({ operation: "attempt", provider: "chatgpt", attemptId: begun.attemptId, actor })).rejects.toMatchObject({ code: "not-found" }); restarted.dispose();
  });
  it("refresh is single-flight; signout wins delayed rotation", async () => {
    let release!: (response: Response) => void;
    const h = fixture([json(challenge("supergrok")), json(tokens), () => new Promise(resolve => { release = resolve; })]);
    await start(h, "supergrok"); await vi.advanceTimersByTimeAsync(5000);
    const a = h.manager.internalRefresh("supergrok"), b = h.manager.internalRefresh("supergrok");
    expect(a).toBe(b);
    await h.manager.dispatch({ operation: "signOut", provider: "supergrok", actor });
    release(json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }));
    await a; expect(JSON.parse(h.store.getAll()[CLOUD_MODEL_SIGNINS_KEY])).toEqual({});
    expect(JSON.stringify(h.published)).not.toContain("rotated-access");
  });
  it.each(["dispose", "signOut"])("%s clears rotated-token storage retry timers", async action => {
    const h = fixture([json(challenge("supergrok")), json(tokens), json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 })]);
    await start(h, "supergrok"); await vi.advanceTimersByTimeAsync(5000);
    h.writes.mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    expect(await h.manager.internalRefresh("supergrok")).toBe(false);
    if (action === "dispose") h.manager.dispose();
    else await h.manager.dispatch({ operation: "signOut", provider: "supergrok", actor });
    expect(vi.getTimerCount()).toBe(0);
    const writes = h.writes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.writes).toHaveBeenCalledTimes(writes);
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(h.published)).not.toContain("rotated-access");
  });
  it("rotation persistence failure retries storage, never spends another refresh grant", async () => {
    const h = fixture([json(challenge("supergrok")), json(tokens), json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 })]);
    await start(h, "supergrok"); await vi.advanceTimersByTimeAsync(5000);
    h.writes.mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    expect(await h.manager.internalRefresh("supergrok")).toBe(false);
    expect(JSON.stringify(h.published)).not.toContain("rotated-access");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(h.store.getAll()[CLOUD_MODEL_SIGNINS_KEY]).supergrok.refreshToken).toBe("rotated-refresh");
    expect(JSON.stringify(h.published)).toContain("rotated-access");
  });
});
