// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import cloud from "../locales/en-ux/cloud.json";
import { api } from "@/state/store";
import { OWNER_PROOF_HEADER, OwnerCodeError, actSentence, encodeProof, getOwnerCodeSession, onCloudHomePage, ownerCodeActions, ownerCodeRetryInit, readEmailCodeRefusal, type OwnerCodeDeps } from "./owner-code";
// the words this product never uses, built from pieces so the guard itself carries none of them
const BANNED = new RegExp(["\\b(?:sa", "fe|sa", "fely|sa", "fety|unsa", "fe)\\b"].join(""), "i");
const DASHES = /[\u2013\u2014]/;

const refusal = { error: "Needs a code.", code: "email_code", actToken: "tok.sig", label: "full_access", labelArg: "Dax" };
const PROOF = { payload: "eyJwIjoxfQ", signature: "c2ln" };
const home = { querySelector: () => ({ getAttribute: () => "home-1" }) } as unknown as Document;
const notHome = { querySelector: () => null } as unknown as Document;

function deps(answers: Array<{ status: number; body: unknown }>, onHomePage = true) {
  const posts: Array<{ path: string; body: any }> = [];
  const value: OwnerCodeDeps = {
    async post(path, body) { posts.push({ path, body }); const next = answers.shift(); if (!next) throw new Error("no answer"); return next; },
    now: () => 1_000_000,
    onHomePage: () => onHomePage,
  };
  return { value, posts };
}
const SENT = { status: 200, body: { challengeId: "c1", maskedEmail: "s***@gmail.com", resendIn: 30 } };
const VERIFIED = { status: 200, body: { proof: PROOF } };
const ready = () => vi.waitFor(() => expect(getOwnerCodeSession()?.phase).toBe("ready"));

afterEach(() => { vi.unstubAllGlobals(); ownerCodeActions.cancel(); });

describe("the interceptor stays out of the way", () => {
  it.each([
    ["a non-403 answer", 500, { code: "email_code", actToken: "t" }],
    ["a 403 without a code", 403, { error: "No." }],
    ["a 403 with another code", 403, { code: "fresh_auth", error: "x" }],
    ["a 403 email_code with no actToken", 403, { code: "email_code" }],
    ["a non-object body", 403, "nope"],
  ])("passes %s through (null: api() carries on)", async (_name, status, body) => {
    const d = deps([]);
    expect(await ownerCodeRetryInit({ method: "POST" }, status, body, d.value)).toBeNull();
    expect(d.posts).toEqual([]);
  });
  it("does nothing off a Cloud home page, even for a real email_code refusal and a changed one", async () => {
    const d = deps([], false);
    expect(await ownerCodeRetryInit({}, 403, refusal, d.value)).toBeNull();
    expect(await ownerCodeRetryInit({}, 403, { code: "fresh_auth_changed" }, d.value)).toBeNull();
    expect(d.posts).toEqual([]);
    expect(getOwnerCodeSession()).toBeNull();
  });
  it("a Cloud home page is the one that carries the murage-home-id meta tag", () => {
    expect(onCloudHomePage(home)).toBe(true);
    expect(onCloudHomePage(notHome)).toBe(false);
    expect(onCloudHomePage(undefined)).toBe(false);
  });
  it("reads only a well-formed refusal", () => {
    expect(readEmailCodeRefusal(403, refusal)).toEqual({ actToken: "tok.sig", label: "full_access", labelArg: "Dax" });
    expect(readEmailCodeRefusal(401, refusal)).toBeNull();
  });
});

describe("the code step", () => {
  it("sends, waits for the 6 digits, verifies, and hands back the encoded proof header", async () => {
    const d = deps([SENT, VERIFIED]);
    const run = ownerCodeRetryInit({ method: "PATCH", body: "{}", headers: { "x-a": "1" } }, 403, refusal, d.value);
    await ready();
    expect(getOwnerCodeSession()).toMatchObject({ maskedEmail: "s***@gmail.com", act: "turn on Full access for Dax" });
    ownerCodeActions.submit("123456");
    const init = await run;
    expect(d.posts).toEqual([
      { path: "/api/cloud/owner-code/send", body: { actToken: "tok.sig" } },
      { path: "/api/cloud/owner-code/verify", body: { actToken: "tok.sig", challengeId: "c1", code: "123456" } },
    ]);
    const header = (init!.headers as Record<string, string>)[OWNER_PROOF_HEADER];
    expect(header).toBe(encodeProof(PROOF));
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual(PROOF);
    expect(init).toMatchObject({ method: "PATCH", body: "{}", headers: { "x-a": "1" } });
    expect(getOwnerCodeSession()).toBeNull();
  });
  it("a wrong code keeps the dialog open with plain words and the next try can pass", async () => {
    const d = deps([SENT, { status: 400, body: { error: "wrong" } }, VERIFIED]);
    const run = ownerCodeRetryInit({}, 403, refusal, d.value);
    await ready();
    ownerCodeActions.submit("000000");
    await vi.waitFor(() => expect(getOwnerCodeSession()).toMatchObject({ phase: "ready", error: cloud["ux.cloud.ownerCode.wrong"] }));
    ownerCodeActions.submit("123456");
    expect(await run).toBeTruthy();
    expect(d.posts.filter((p) => p.path.endsWith("verify"))).toHaveLength(2);
  });
  it("an expired code says so and a new code can be sent after resendIn", async () => {
    const d = deps([SENT, { status: 400, body: { error: "expired" } }, { status: 200, body: { challengeId: "c2", maskedEmail: "s***@gmail.com", resendIn: 30 } }, VERIFIED]);
    const run = ownerCodeRetryInit({}, 403, refusal, d.value);
    await ready();
    ownerCodeActions.submit("111111");
    await vi.waitFor(() => expect(getOwnerCodeSession()?.error).toBe("That code has expired. We can send a new one."));
    ownerCodeActions.resend();
    await vi.waitFor(() => expect(d.posts.filter((p) => p.path.endsWith("send")).length).toBe(2));
    await ready();
    ownerCodeActions.submit("222222");
    await run;
    expect(d.posts.at(-1)!.body.challengeId).toBe("c2");
  });
  it("Send a new code does nothing while resendIn runs", async () => {
    const d = deps([SENT]);
    const run = ownerCodeRetryInit({}, 403, refusal, d.value).catch((e) => e);
    await ready();
    ownerCodeActions.resend();
    expect(d.posts).toHaveLength(1);
    ownerCodeActions.cancel();
    expect(await run).toBeInstanceOf(OwnerCodeError);
  });
  it("cancel fails the request with a cancel error the caller can show", async () => {
    const d = deps([SENT]);
    const run = ownerCodeRetryInit({}, 403, refusal, d.value).catch((e) => e);
    await ready();
    ownerCodeActions.cancel();
    const error = await run;
    expect(error).toMatchObject({ ownerCode: "cancelled", status: 403, message: "Cancelled. Nothing was changed." });
    expect(getOwnerCodeSession()).toBeNull();
  });
  it("the daily limit, a failed send and a failed check each say what happened and that nothing changed", async () => {
    const day = await ownerCodeRetryInit({}, 403, refusal, deps([{ status: 429, body: { error: "rate", retryIn: 80000, limit: "day" } }]).value).catch((e) => e);
    expect(day.message).toBe("That's a lot of codes for one day. Try again tomorrow.");
    const gap = await ownerCodeRetryInit({}, 403, refusal, deps([{ status: 429, body: { error: "rate", retryIn: 80000 / 4000, limit: "gap" } }]).value).catch((e) => e);
    expect(gap.message).not.toBe("That's a lot of codes for one day. Try again tomorrow.");
    const down = await ownerCodeRetryInit({}, 403, refusal, deps([{ status: 503, body: {} }]).value).catch((e) => e);
    expect(down.message).toBe("We couldn't send your code just now. Nothing was changed. Try again in a minute.");
    const d = deps([SENT, { status: 502, body: {} }]);
    const run = ownerCodeRetryInit({}, 403, refusal, d.value).catch((e) => e);
    await ready();
    ownerCodeActions.submit("123456");
    expect((await run).message).toBe("Nothing was changed. Try again in a minute.");
  });
  it("a changed request shows the changed words and sends no mail", async () => {
    const d = deps([]);
    const error = await ownerCodeRetryInit({}, 403, { code: "fresh_auth_changed", error: "x" }, d.value).catch((e) => e);
    expect(error).toMatchObject({ ownerCode: "changed", message: "This request changed. Review it again before you allow it." });
    expect(d.posts).toEqual([]);
    // a retry that already carries a proof and is asked for a code again is an ordinary refusal, never a second dialog
    expect(await ownerCodeRetryInit({ headers: { "X-Murage-Owner-Proof": "p" } }, 403, refusal, d.value)).toBeNull();
  });
  it("the changed words are the server's own FRESH_AUTH_COPY.changed", () => {
    const server = readFileSync(new URL("../../server/approval-fresh-auth.ts", import.meta.url), "utf8");
    expect(server).toContain(`changed: "${cloud["ux.cloud.ownerCode.changed"]}"`);
  });
});

describe("through api()", () => {
  const answer = (status: number, body: unknown) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body });
  /** A fetch that answers by path (the desktop-secret probe api() makes first gets a plain 404) and records the calls that matter. */
  function stubFetch(routes: Record<string, Array<ReturnType<typeof answer>>>) {
    const seen: Array<{ url: string; init: any }> = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      const next = routes[url]?.shift();
      if (!next) return answer(404, {});
      seen.push({ url, init });
      return next;
    });
    return seen;
  }
  const SEND = answer(200, { challengeId: "c1", maskedEmail: "s***@gmail.com", resendIn: 30 });
  it("retries the exact original request once, with the proof header, only once", async () => {
    vi.stubGlobal("document", home);
    const seen = stubFetch({ "/api/bots/b1": [answer(403, refusal), answer(200, { ok: true })], "/api/cloud/owner-code/send": [SEND], "/api/cloud/owner-code/verify": [answer(200, { proof: PROOF })] });
    const call = api("/api/bots/b1", { method: "PATCH", body: JSON.stringify({ computer: "full" }) });
    await ready();
    ownerCodeActions.submit("123456");
    expect(await call).toMatchObject({ ok: true });
    expect(seen.map((s) => s.url)).toEqual(["/api/bots/b1", "/api/cloud/owner-code/send", "/api/cloud/owner-code/verify", "/api/bots/b1"]);
    expect(seen[0]!.init.headers[OWNER_PROOF_HEADER]).toBeUndefined();
    expect(seen[3]!.init.headers[OWNER_PROOF_HEADER]).toBe(encodeProof(PROOF));
    expect(seen[3]!.init.body).toBe(seen[0]!.init.body);
    expect(seen[3]!.init.method).toBe("PATCH");
  });
  it("a retry that is refused again is thrown as the ordinary refusal: no second code", async () => {
    vi.stubGlobal("document", home);
    const seen = stubFetch({ "/api/bots/b1": [answer(403, refusal), answer(403, refusal)], "/api/cloud/owner-code/send": [SEND], "/api/cloud/owner-code/verify": [answer(200, { proof: PROOF })] });
    const call = api("/api/bots/b1", { method: "PATCH", body: "{}" }).catch((e) => e);
    await ready();
    ownerCodeActions.submit("123456");
    expect(await call).toMatchObject({ status: 403, body: { code: "email_code" } });
    expect(seen).toHaveLength(4);
  });
  it("off a Cloud home the 403 is thrown exactly as before and nothing else is fetched", async () => {
    vi.stubGlobal("document", notHome);
    const seen = stubFetch({ "/api/bots/b1": [answer(403, refusal)] });
    const error = await api("/api/bots/b1", { method: "PATCH", body: "{}" }).catch((e) => e);
    expect(error).toMatchObject({ status: 403, message: "Needs a code.", body: refusal });
    expect(seen.map((s) => s.url)).toEqual(["/api/bots/b1"]);
  });
  it("a non-403 failure and a 403 without a code are untouched on a home too", async () => {
    vi.stubGlobal("document", home);
    stubFetch({ "/api/x": [answer(403, { error: "No." })] });
    expect(await api("/api/x").catch((e) => e)).toMatchObject({ status: 403, message: "No." });
    stubFetch({ "/api/y": [answer(404, { error: "Gone." })] });
    expect(await api("/api/y").catch((e) => e)).toMatchObject({ status: 404, message: "Gone." });
  });
});

describe("act sentences and strings", () => {
  it("every label of the wire has a sentence, the bot name goes in, and an unknown label is generic", () => {
    const labels = ["full_access", "allow_request", "folder_trust", "restore_release", "delete", "bot_reach", "new_skill", "traffic_moved", "computer_viewer", "computer_command", "bot_widen", "device_remove", "config_change", "take_down_site", "fresh_door", "publish_allow", "other"];
    for (const label of labels) expect(cloud, label).toHaveProperty(`ux.cloud.ownerCode.act.${label}`);
    expect(actSentence("full_access", "Dax")).toBe("turn on Full access for Dax");
    expect(actSentence("full_access", undefined)).toBe("turn on Full access for this bot");
    expect(actSentence("other", undefined)).toBe("confirm this change");
    expect(actSentence("from_the_future", undefined)).toBe("confirm this change");
    expect(actSentence(undefined, undefined)).toBe("confirm this change");
  });
  it("every ux.cloud string is plain: no em or en dash, no banned words", () => {
    for (const [key, value] of Object.entries(cloud)) {
      expect(value, key).not.toMatch(DASHES);
      expect(value, key).not.toMatch(BANNED);
    }
    expect(cloud["ux.cloud.ownerCode.title"]).toBe("One more step.");
    expect(cloud["ux.cloud.ownerBanner.expired"]).toBe("To change settings, open Murage from murage.ai.");
  });
});
