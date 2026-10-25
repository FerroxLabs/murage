// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it } from "vitest";

import {
  ANY_ADDRESS, INSTANCE_MARK_TTL_MS, forgetAllInstanceMarks, forgetInstanceMark, KEY_REJECTED_REASON, keyRejected, looksLikeAuthFailure, noteInstanceAuthFailure, noteInstanceTurnOk,
  noteCatalogOutcome, noteKeyAccepted, noteKeyRejected, SIGN_IN_REJECTED_REASON, onKeyRejectionChange, rejectsKey, resetKeyRejectionsForTests, withInstanceMark,
} from "./key-rejections.ts";

beforeEach(() => resetKeyRejectionsForTests());

const body = (code: string, message: string) => JSON.stringify({ error: { code, message } });

describe("rejectsKey: only a bad key counts", () => {
  it("a 401 always does", () => expect(rejectsKey(401, "")).toBe(true));
  it("a 400 or 403 whose body names an invalid, revoked or expired key does", () => {
    expect(rejectsKey(400, body("invalid_api_key", "Incorrect API key provided"))).toBe(true);
    expect(rejectsKey(403, JSON.stringify({ error: { message: "This API key has been revoked." } }))).toBe(true);
    expect(rejectsKey(403, "Your api key is expired")).toBe(true);
  });
  it("quota, billing, rate-limit and model-access refusals do not", () => {
    expect(rejectsKey(403, body("insufficient_quota", "You exceeded your current quota"))).toBe(false);
    expect(rejectsKey(403, JSON.stringify({ error: { message: "Your key does not have access to model gpt-9" } }))).toBe(false);
    expect(rejectsKey(400, body("billing_hard_limit_reached", "Billing hard limit has been reached"))).toBe(false);
    expect(rejectsKey(429, "invalid api key")).toBe(false);
    expect(rejectsKey(500, "invalid api key")).toBe(false);
    expect(rejectsKey(400, "model not found")).toBe(false);
  });
});

describe("key marks", () => {
  it("a refused key is marked, a later success clears it, a different key starts clean", () => {
    let fired = 0;
    const stop = onKeyRejectionChange(() => { fired += 1; });
    noteKeyRejected("https://api.example.com/v1", "sk-bad");
    expect(keyRejected("https://api.example.com/v1/", "sk-bad")).toBe(true);
    expect(keyRejected("https://api.example.com/v1", "sk-new")).toBe(false);
    noteKeyRejected("https://api.example.com/v1", "sk-bad");
    expect(fired).toBe(1);
    noteKeyAccepted("https://api.example.com/v1", "sk-bad");
    expect(keyRejected("https://api.example.com/v1", "sk-bad")).toBe(false);
    expect(fired).toBe(2);
    stop();
  });
});

describe("engines with their own login", () => {
  const ready = { state: "available", authenticated: true, version: "1.0" } as const;
  it("an auth-class turn failure flips Ready to signed-out with a reason, and a good turn flips it back", () => {
    noteInstanceAuthFailure("opencode-1", 1000);
    expect(withInstanceMark("opencode-1", ready, 2000)).toMatchObject({ state: "available", authenticated: false, reason: KEY_REJECTED_REASON });
    expect(withInstanceMark("other", ready, 2000)).toEqual(ready);
    noteInstanceTurnOk("opencode-1");
    expect(withInstanceMark("opencode-1", ready, 2000)).toEqual(ready);
  });
  it("heals by itself after the TTL, and leaves unavailable engines alone", () => {
    noteInstanceAuthFailure("acp-1", 1000);
    expect(withInstanceMark("acp-1", ready, 1000 + INSTANCE_MARK_TTL_MS + 1)).toEqual(ready);
    noteInstanceAuthFailure("acp-2", 1000);
    const missing = { state: "unavailable", reason: "no cli" } as const;
    expect(withInstanceMark("acp-2", missing, 2000)).toEqual(missing);
  });
  it("reads auth-class failures from the words and ignores quota", () => {
    expect(looksLikeAuthFailure("Not logged in · Please run /login")).toBe(true);
    expect(looksLikeAuthFailure("Error: 401 Unauthorized, invalid API key")).toBe(true);
    expect(looksLikeAuthFailure("Your token has expired, sign in again")).toBe(true);
    expect(looksLikeAuthFailure("You exceeded your quota. Invalid billing.")).toBe(false);
    expect(looksLikeAuthFailure("The tool returned 4010 rows")).toBe(false);
  });
});

describe("saving a key, and the Settings Test button (item 139)", () => {
  const ready = { state: "available", authenticated: true, version: "1" } as const;
  it("a refusal learned from Test holds for the key at any address, and a good Test clears it", () => {
    noteKeyRejected(ANY_ADDRESS, "sk-tested");
    expect(keyRejected("https://api.one.example/v1", "sk-tested")).toBe(true);
    expect(keyRejected("https://api.two.example/v1", "sk-tested")).toBe(true);
    expect(keyRejected("https://api.one.example/v1", "sk-other")).toBe(false);
    noteKeyAccepted(ANY_ADDRESS, "sk-tested");
    expect(keyRejected("https://api.one.example/v1", "sk-tested")).toBe(false);
  });
  it("a good request at an address also ends a refusal Test noted for that key", () => {
    noteKeyRejected(ANY_ADDRESS, "sk-k");
    noteKeyAccepted("https://api.one.example/v1", "sk-k");
    expect(keyRejected("https://api.one.example/v1", "sk-k")).toBe(false);
  });
  it("saving a key clears that engine's mark at once and tells the app", () => {
    let fired = 0;
    const stop = onKeyRejectionChange(() => { fired += 1; });
    noteInstanceAuthFailure("claude-1");
    noteInstanceAuthFailure("codex-1");
    forgetInstanceMark("claude-1");
    expect(withInstanceMark("claude-1", ready)).toEqual(ready);
    expect(withInstanceMark("codex-1", ready)).toMatchObject({ authenticated: false });
    forgetAllInstanceMarks();
    expect(withInstanceMark("codex-1", ready)).toEqual(ready);
    expect(fired).toBe(4);
    forgetAllInstanceMarks();
    expect(fired).toBe(4);
    stop();
  });
});

describe("1.0.4 provider follow-ups", () => {
  it("M1: a 403 from a catalog refresh does not mark the key; a 401 does; a good answer clears it", () => {
    noteCatalogOutcome("sk-m1", "refused", "forbidden");
    expect(keyRejected(ANY_ADDRESS, "sk-m1")).toBe(false);
    noteCatalogOutcome("sk-m1", "refused", "unauthorized");
    expect(keyRejected(ANY_ADDRESS, "sk-m1")).toBe(true);
    noteCatalogOutcome("sk-m1", "ok");
    expect(keyRejected(ANY_ADDRESS, "sk-m1")).toBe(false);
  });
  it("L1: a good catalog refresh also clears a mark a refused turn set for the same key", () => {
    noteKeyRejected("https://api.one.example/v1", "sk-l1");
    expect(keyRejected("https://api.one.example/v1", "sk-l1")).toBe(true);
    noteKeyAccepted(ANY_ADDRESS, "sk-l1");
    expect(keyRejected("https://api.one.example/v1", "sk-l1")).toBe(false);
    noteKeyRejected("https://api.one.example/v1", "sk-l1");
    noteKeyAccepted(ANY_ADDRESS, "sk-other");
    expect(keyRejected("https://api.one.example/v1", "sk-l1")).toBe(true);
  });
  it("L2: a tool's error that mentions 401 is not an engine sign-in failure", () => {
    expect(looksLikeAuthFailure("MCP tool github failed: HTTP 401 from the server", { engineLevel: true })).toBe(false);
    expect(looksLikeAuthFailure("Tool call returned 401", { engineLevel: true })).toBe(false);
    expect(looksLikeAuthFailure("Not logged in · Please run /login", { engineLevel: true })).toBe(true);
    expect(looksLikeAuthFailure("unexpected status 401 Unauthorized: please sign in again", { engineLevel: true })).toBe(true);
  });
  it("L2: a subscription login says sign-in, not key", () => {
    const ready = { state: "available", authenticated: true, version: null } as never;
    noteInstanceAuthFailure("claude-9", Date.now(), { signIn: true });
    noteInstanceAuthFailure("opencode-9");
    expect(withInstanceMark("claude-9", ready)).toMatchObject({ authenticated: false, reason: SIGN_IN_REJECTED_REASON });
    expect(withInstanceMark("opencode-9", ready)).toMatchObject({ authenticated: false, reason: KEY_REJECTED_REASON });
    expect(SIGN_IN_REJECTED_REASON).not.toMatch(/key|—|–/i);
  });
});
