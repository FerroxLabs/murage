// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { s256Challenge } from "../../electron/model-signin-oauth.mjs";
import { SIGNIN_CONNECTION_IDS } from "../../electron/model-signin-presets.mjs";
import { setCloudIdentity } from "../cloud-request-identity.ts";
import { ModelSignIns } from "../model-signin.ts";
import { createAccountSignInCleanup } from "./model-signin-account.ts";
import { createCloudModelSignInApi } from "./model-signin-api.ts";
import { CLOUD_MODEL_SIGNINS_KEY, createHomeModelSignIn, HomeSignInError, type HomeSignInActor, type HomeSignInProvider, type HomeSignInRequest } from "./model-signin.ts";
import { SealedSecretStore } from "./secrets.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const actor = { environmentId: "fixture-home", deviceId: "fixture-owner" };
const verifier = "v".repeat(43);
const code = { authorization_code: "fixture-code", code_verifier: verifier, code_challenge: s256Challenge(verifier) };
const idToken = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.x`;
const tokens = { access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: idToken, expires_in: 3600 };
const challenge = (provider: HomeSignInProvider) => provider === "chatgpt"
  ? { device_auth_id: "fixture-device", user_code: "CODE-1", interval: "5" }
  : { device_code: "fixture-device", user_code: "CODE-1", verification_uri: "https://auth.x.ai/device", expires_in: 900, interval: 5 };
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
let cleanup: Array<() => void>;
beforeEach(() => { cleanup = []; vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
afterEach(() => { for (const fn of cleanup.reverse()) fn(); vi.useRealTimers(); });

function fixture(replies: Array<Response | (() => Promise<Response>)>) {
  const directory = mkdtempSync(join(tmpdir(), "home-signin-account-"));
  const store = new SealedSecretStore(directory, "fixture-machine", Buffer.alloc(32, 7));
  const gateway = new ModelSignIns({ env: {} });
  const fetcher = vi.fn(async () => {
    const next = replies.shift();
    if (!next) throw new Error("Unexpected fixture provider request");
    return typeof next === "function" ? next() : next;
  });
  const manager = createHomeModelSignIn({ store, env: {}, fetch: fetcher as typeof fetch,
    publish: entries => { gateway.apply({ type: "murage:model-signin", entries }); },
  });
  cleanup.push(() => { manager.dispose(); store.close(); removeTempDirSync(directory); });
  return { store, gateway, manager, fetcher };
}

// This is the post-auth API seam: the actual WeakMap carries an already verified
// owner identity. Real signed-factor HTTP coverage lives in model-signin-api.test.
function ownerRequest(deviceId = "other-fixture-owner") {
  const req = { method: "POST", headers: {} } as IncomingMessage;
  setCloudIdentity(req.headers, { id: deviceId, account: "fixture-account", scope: "owner-phone", publicKey: "fixture", assertionKey: "fixture", revoked: 0, factor: false });
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, writableFinished: false,
    writeHead: vi.fn(), end: vi.fn(),
  });
  return { req, res, response: res as unknown as ServerResponse, url: new URL("https://home.example/api/cloud/model-signins/chatgpt/start") };
}

describe("account deletion sign-in admission", () => {
  it("fences a concurrent API start while the second remove waits and clears a pre-fence late acquisition", async () => {
    const lateToken = deferred<Response>();
    const h = fixture([
      Response.json(challenge("supergrok")), Response.json(tokens),
      Response.json(challenge("chatgpt")), Response.json(code), Response.json(tokens),
      Response.json(challenge("chatgpt")), Response.json(code), () => lateToken.promise,
    ]);
    await h.manager.dispatch({ operation: "start", provider: "supergrok", actor });
    await vi.advanceTimersByTimeAsync(5000);
    await h.manager.dispatch({ operation: "start", provider: "chatgpt", actor });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.gateway.bearer(SIGNIN_CONNECTION_IDS.chatgpt)).not.toBeNull();
    expect(h.gateway.bearer(SIGNIN_CONNECTION_IDS.supergrok)).not.toBeNull();
    const pendingActor = { ...actor, deviceId: "pending-fixture-owner" };
    const pending = await h.manager.dispatch({ operation: "start", provider: "chatgpt", actor: pendingActor }) as { attemptId: string };
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.fetcher).toHaveBeenCalledTimes(8);

    const enteredSecond = deferred<void>(), releaseSecond = deferred<void>();
    const order: string[] = [];
    const account = createAccountSignInCleanup({
      invalidateAll: () => { order.push("invalidate-all"); h.manager.invalidateOwner({ all: true }); },
      remove: async (provider, owner) => {
        order.push(`remove:${provider}`);
        if (provider === "supergrok") { enteredSecond.resolve(); await releaseSecond.promise; }
        return h.manager.dispatch({ operation: "remove", provider, actor: owner });
      },
    });
    const invoke = vi.fn((request: HomeSignInRequest) => h.manager.dispatch(request));
    const api = createCloudModelSignInApi({ environmentId: actor.environmentId,
      activeDevice: () => account.admissionOpen(), invoke,
      invalidateOwner: deviceId => h.manager.invalidateOwner({ deviceId, all: false }), readBody: async () => ({}),
    });
    let completed = false;
    const deletion = account.removeAccount(actor).then(() => { completed = true; });
    expect(account.admissionOpen()).toBe(false);
    expect(order).toEqual(["invalidate-all", "remove:chatgpt"]);
    await enteredSecond.promise;
    expect(completed).toBe(false);
    expect(h.gateway.bearer(SIGNIN_CONNECTION_IDS.chatgpt)).toBeNull();
    expect(h.gateway.bearer(SIGNIN_CONNECTION_IDS.supergrok)).not.toBeNull();

    const call = ownerRequest();
    expect(await api(call.req, call.response, call.url)).toBe(true);
    expect(call.res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(invoke).not.toHaveBeenCalled();
    lateToken.resolve(Response.json({ ...tokens, access_token: "late-access", refresh_token: "late-refresh" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.manager.dispatch({ operation: "attempt", provider: "chatgpt", attemptId: pending.attemptId, actor: pendingActor })).toMatchObject({ state: "cancelled" });
    expect(JSON.parse(h.store.getAll()[CLOUD_MODEL_SIGNINS_KEY])).not.toHaveProperty("chatgpt");
    expect(h.gateway.bearer(SIGNIN_CONNECTION_IDS.chatgpt)).toBeNull();

    releaseSecond.resolve(); await deletion;
    expect(order).toEqual(["invalidate-all", "remove:chatgpt", "remove:supergrok"]);
    expect(completed).toBe(true); expect(account.admissionOpen()).toBe(false);
    expect(JSON.parse(h.store.getAll()[CLOUD_MODEL_SIGNINS_KEY])).toEqual({});
    expect(h.gateway.records()).toEqual([]);
    expect(h.fetcher).toHaveBeenCalledTimes(8);
  });

  it("rechecks admission after an already authenticated API request waits for its body", async () => {
    const body = deferred<unknown>(), remove = deferred<void>();
    const account = createAccountSignInCleanup({ invalidateAll: vi.fn(), remove: () => remove.promise });
    const invoke = vi.fn(async (_request: HomeSignInRequest) => null), invalidated = vi.fn();
    const api = createCloudModelSignInApi({ environmentId: actor.environmentId, activeDevice: () => account.admissionOpen(),
      invoke, invalidateOwner: invalidated, readBody: () => body.promise,
    });
    const call = ownerRequest();
    const response = api(call.req, call.response, call.url);
    const deletion = account.removeAccount(actor);
    body.resolve({}); await response;
    expect(invoke).not.toHaveBeenCalled();
    expect(call.res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(invalidated).toHaveBeenCalledExactlyOnceWith("other-fixture-owner");
    remove.resolve(); await deletion;
  });

  it("keeps a concurrent delete from reopening admission and permits retry after cleanup failure", async () => {
    const enteredSecond = deferred<void>(), releaseSecond = deferred<void>();
    let fail = true;
    const order: string[] = [];
    const remove = vi.fn(async (provider: HomeSignInProvider, _owner: HomeSignInActor) => {
      order.push(`remove:${provider}`);
      if (provider === "supergrok" && fail) { enteredSecond.resolve(); await releaseSecond.promise; throw new HomeSignInError("storage"); }
      return null;
    });
    const account = createAccountSignInCleanup({ invalidateAll: () => { order.push("invalidate-all"); }, remove });
    const first = account.removeAccount(actor);
    const failed = expect(first).rejects.toMatchObject({ code: "storage" });
    await enteredSecond.promise;
    await expect(account.removeAccount({ ...actor, deviceId: "other-owner" })).rejects.toMatchObject({ code: "busy" });
    expect(account.admissionOpen()).toBe(false);
    expect(remove).toHaveBeenCalledTimes(2);
    releaseSecond.resolve(); await failed;
    expect(account.admissionOpen()).toBe(true);

    fail = false;
    const retry = account.removeAccount(actor);
    expect(account.admissionOpen()).toBe(false);
    await retry;
    expect(order).toEqual(["invalidate-all", "remove:chatgpt", "remove:supergrok", "invalidate-all", "remove:chatgpt", "remove:supergrok"]);
    expect(account.admissionOpen()).toBe(false);
    await expect(account.removeAccount(actor)).rejects.toMatchObject({ code: "busy" });
    expect(account.admissionOpen()).toBe(false);
    expect(remove).toHaveBeenCalledTimes(4);
  });
});
