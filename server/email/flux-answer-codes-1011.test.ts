// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.11: Flux's real answers on the email routes (verified against the Flux proxy, master), one row per code. Each row checks the shared
// mapping (fluxEmailAnswer / eligibilityLine), the credential health verdict (key-health.ts) and what GET /api/email/status says on the
// Bot email card after the capability read answers that way (capabilities.ts + owner-routes.ts), through a real EmailRuntime and the
// fake-Flux stub. Only a 401 is a dead key; a 403 is a scope, switch, account or bot state; 429 and 5xx change nothing on screen.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { emailOwnerRoute } from "./owner-routes.ts";
import { classifyKeyHealth, EmailKeyHealth, isKeyRejection, type KeyHealthState } from "./key-health.ts";
import { classifyResponse, type CredentialRef } from "./flux-email-client.ts";
import { codeLine, EMAIL_LINES } from "./tools.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";
import {
  activityLine, EMAIL_KEY_HEALTH_COPY, EMAIL_OWNER_COPY, EMAIL_SETUP_COPY, eligibilityLine, FLUX_EMAIL_ANSWER_COPY, FLUX_EMAIL_STATE_CODES,
  fluxEmailAnswer, ownerRouteLine, type FluxEmailAnswerKind,
} from "../../shared/email-copy.ts";
import type { BotRecord } from "../store.ts";

const ACCOUNT = "sk-flux-dashboard-fixture";
const OWNER = "owner-fixture-token";
const BOT = { id: "b1", name: "Juniper", threadId: "t-b1" };
const CAPS = { enabled: true, available: true, account_state: "active", limits: {} };
const OWNER_REF: CredentialRef = { kind: "owner" };

let fake: FakeFlux;
let runtime: EmailRuntime;

beforeEach(() => {
  fake = new FakeFlux();
  const db = new DatabaseSync(":memory:");
  runtime = new EmailRuntime({
    accountKey: () => ACCOUNT, database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", now: () => 1_800_000_000_000,
    workspaceRoot: () => undefined, bot: id => (id === BOT.id ? BOT as unknown as BotRecord : undefined),
    cardHost: { botName: () => BOT.name, threadExists: () => true, card: () => null, appendCard: () => "m1", patchCard: () => undefined, outcome: () => undefined, activity: () => undefined, notify: () => undefined },
  });
});
const signInOwner = () => runtime.secrets.setOwner({ token: OWNER, keyId: "key_owner" });

const status = () => emailOwnerRoute(
  { runtime, bot: id => (id === BOT.id ? BOT : undefined), fluxKeyPresent: () => true, freshProof: async () => null },
  { method: "GET", path: "/api/email/status", query: new URLSearchParams(), body: undefined, surface: "desktop", botCredential: false },
);
const capsAnswer = (code: number, error: string) => fake.on("GET", /^\/v1\/email\/capabilities$/, { status: code, body: { error, message: "" } });
const notAvailable = (extra: Record<string, string> = {}) => ({ status: 404, body: { error: EMAIL_OWNER_COPY.notAvailable, ...extra } });

type Row = { status: number; code: string; kind: FluxEmailAnswerKind; line: string | null; health: Exclude<KeyHealthState, "ok"> | null; card: Record<string, string> | "unchanged" };
const ROWS: Row[] = [
  // 1. a dead key: the existing line, kept
  { status: 401, code: "unauthorized", kind: "dead_key", line: EMAIL_SETUP_COPY.fluxKeyRefused, health: "rejected", card: { fluxRefused: EMAIL_SETUP_COPY.fluxKeyRefused } },
  // 2. a valid key without email scope (a dashboard key): sign in mints email:owner, NOT dead
  { status: 403, code: "email_scope_required", kind: "sign_in", line: "Sign in with Flux to connect email.", health: "scope", card: { fluxSignIn: "Sign in with Flux to connect email." } },
  // 4. email not turned on (send only): turn it on, never "not on for your account yet"
  { status: 403, code: "email_not_enabled", kind: "turn_on", line: FLUX_EMAIL_ANSWER_COPY.turnOn, health: "email_off", card: { fluxLine: FLUX_EMAIL_ANSWER_COPY.turnOn } },
  // 5. account or bot states: never a dead key
  ...[...FLUX_EMAIL_STATE_CODES].map((code): Row => ({
    status: 403, code, kind: "account_state", line: ownerRouteLine(code),
    health: code === "bot_paused" || code === "account_email_paused" ? "paused" : null, card: { fluxLine: ownerRouteLine(code) },
  })),
  // 6. transient: nothing changes
  { status: 503, code: "capability_unavailable", kind: "transient", line: null, health: "outage", card: "unchanged" },
  { status: 429, code: "rate_limit_error", kind: "transient", line: null, health: null, card: "unchanged" },
  { status: 500, code: "internal_error", kind: "transient", line: null, health: "outage", card: "unchanged" },
  { status: 502, code: "bad_gateway", kind: "transient", line: null, health: "outage", card: "unchanged" },
  // 7. the plan
  { status: 402, code: "premium_locked", kind: "plan", line: "Your plan doesn't include email.", health: "not_eligible", card: { fluxLine: "Your plan doesn't include email." } },
];

describe("Flux email answers, one row per code (1.0.11)", () => {
  it("the table covers every code the Flux proxy answers on the email routes", () => {
    expect(ROWS.map(row => row.code).sort()).toEqual([
      "account_email_paused", "bad_gateway", "bot_pause_requires_support", "bot_paused", "capability_unavailable", "email_not_enabled", "email_scope_required",
      "inbox_pending_owner", "internal_error", "owner_required", "premium_locked", "rate_limit_error", "recipient_approval_required", "recipient_blocked",
      "suppression_locked", "unauthorized",
    ]);
  });

  it.each(ROWS.map(row => [`${row.status} ${row.code}`, row] as const))("%s", async (_name, row) => {
    // the shared mapping
    expect(fluxEmailAnswer(row.status, row.code)).toEqual({ kind: row.kind, line: row.line });
    expect(isKeyRejection(row.status, row.code)).toBe(row.kind === "dead_key");
    // the owner token's health verdict, and its line (a transient outage shows nothing)
    const verdict = classifyKeyHealth(OWNER_REF, classifyResponse(row.status, { error: row.code, message: "" }, "key_owner"));
    expect(verdict).toBe(row.health);
    if (row.status === 403) expect(verdict).not.toBe("rejected");
    if (row.health && row.health !== "outage") expect(EMAIL_KEY_HEALTH_COPY[row.health]).toBeTruthy();
    // the Bot email card after the capability read answers this way
    if (row.card === "unchanged") {
      fake.on("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
      await runtime.probe.refresh();
      expect((await status())?.status).toBe(200);
      capsAnswer(row.status, row.code);
      await runtime.probe.refresh();
      expect(runtime.probe.emailEnabled()).toBe(true);
      expect((await status())?.status).toBe(200);
    } else {
      capsAnswer(row.status, row.code);
      await runtime.probe.refresh();
      expect(await status()).toEqual(notAvailable(row.card));
      expect(runtime.probe.accountKeyRefused()).toBe(row.kind === "dead_key");
    }
  });

  it("3. a 200 with eligible: false names its reason", async () => {
    const reasons: Array<[string, string]> = [
      ["not_rolled_out", "Not on for your account yet."], ["support_denied", "Not on for your account yet."],
      ["not_funded", "Add credit to use email."], ["capacity", "Email is full right now. Try again later."],
    ];
    for (const [reason, line] of reasons) {
      expect(eligibilityLine(reason)).toBe(line);
      fake.on("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: { enabled: true, available: true, eligible: false, reason } });
      await runtime.probe.refresh();
      expect(await status(), reason).toEqual(notAvailable({ fluxLine: line }));
    }
    // a reason Flux has not named, or none: the plain not-available answer
    expect(eligibilityLine("something_new")).toBeNull();
    fake.on("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: { enabled: true, available: true, eligible: false } });
    await runtime.probe.refresh();
    expect(await status()).toEqual(notAvailable());
  });

  it("2. after a 403 email_scope_required, signing in moves the capability read to the email:owner key, and a 200 there turns email on", async () => {
    capsAnswer(403, "email_scope_required");
    await runtime.probe.refresh();
    expect(fake.calls("GET", /capabilities$/)[0]!.headers.authorization).toBe(`Bearer ${ACCOUNT}`);
    expect(runtime.probe.useOwnerKey()).toBe(true);
    signInOwner();
    fake.on("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
    await runtime.probe.refresh();
    expect(fake.calls("GET", /capabilities$/)[1]!.headers.authorization).toBe(`Bearer ${OWNER}`);
    expect(runtime.probe.emailEnabled()).toBe(true);
    expect((await status())?.status).toBe(200);
  });

  it("2. after a restart with the owner token saved, one read retries on it at once; a 401 there asks for the email sign-in, not the router key", async () => {
    signInOwner();
    capsAnswer(403, "email_scope_required");
    fake.on("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
    await runtime.probe.refresh();
    expect(fake.calls("GET", /capabilities$/).map(call => call.headers.authorization)).toEqual([`Bearer ${ACCOUNT}`, `Bearer ${OWNER}`]);
    expect(runtime.probe.emailEnabled()).toBe(true);
    capsAnswer(401, "unauthorized");
    await runtime.probe.refresh();
    expect(runtime.probe.accountKeyRefused()).toBe(false);
    expect(await status()).toEqual(notAvailable({ fluxSignIn: FLUX_EMAIL_ANSWER_COPY.signIn }));
  });

  it("6. a transient answer never replaces a definite state on the same key (G15 keeps the tools off)", () => {
    const health = new EmailKeyHealth({ now: () => 1_000 });
    health.observe({ kind: "bot", botId: "b1" }, classifyResponse(401, { error: "unauthorized", message: "" }, "key_b1"));
    health.observe({ kind: "bot", botId: "b1" }, classifyResponse(500, { error: "internal_error", message: "" }, "key_b1"));
    expect(health.rejected("b1", "key_b1")).toBe(true);
    expect(health.line("bot:b1", "key_b1")).toBe(EMAIL_KEY_HEALTH_COPY.rejected);
    // the backoff still runs beside the kept state
    expect(health.gate({ kind: "bot", botId: "b1" })).toMatchObject({ kind: "refused", status: 503, code: "capability_unavailable" });
    health.observe({ kind: "bot", botId: "b2" }, classifyResponse(503, { error: "capability_unavailable", message: "" }, "key_b2"));
    expect(health.line("bot:b2", "key_b2")).toBeNull();
  });

  it("3. an account already on with eligible: false keeps its controls and still says why", async () => {
    signInOwner();
    fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: { ...CAPS, eligible: false, reason: "not_funded" } });
    await runtime.probe.refresh();
    expect(runtime.probe.emailEnabled()).toBe(true);
    const answer = await status();
    expect(answer?.status).toBe(200);
    expect(answer?.body).toMatchObject({ reasonLine: "Add credit to use email." });
  });

  it("send results: the owner's activity line and the bot's line say what to do for scope, switch and plan", () => {
    expect(activityLine("refused", null, "email_scope_required")).toBe("Not sent: sign in with Flux to connect email");
    expect(activityLine("refused", null, "email_not_enabled")).toBe("Not sent: turn on email in Settings > Bot email");
    expect(activityLine("refused", null, "premium_locked")).toBe("Not sent: your plan doesn't include email");
    expect(activityLine("refused", null, "invalid_recipient")).toBe("Not sent: Flux did not accept it");
    expect(codeLine("premium_locked")).toBe(EMAIL_LINES.notInPlan);
    expect(codeLine("email_not_enabled")).toBe(EMAIL_LINES.emailOff);
    expect(ownerRouteLine("email_not_enabled")).toBe(FLUX_EMAIL_ANSWER_COPY.turnOn);
    expect(ownerRouteLine("premium_locked")).toBe(FLUX_EMAIL_ANSWER_COPY.plan);
    for (const code of FLUX_EMAIL_STATE_CODES) expect(ownerRouteLine(code), code).not.toBe(EMAIL_OWNER_COPY.actionFailed);
  });

  it("copy rules: plain words, no em dashes, never the forbidden word", () => {
    const lines = [...Object.values(FLUX_EMAIL_ANSWER_COPY), ...[...FLUX_EMAIL_STATE_CODES].map(ownerRouteLine), EMAIL_LINES.notInPlan, EMAIL_LINES.emailOff, EMAIL_KEY_HEALTH_COPY.scope];
    for (const line of lines) { expect(line).not.toMatch(/—/); expect(line).not.toMatch(/\bsafe\b/i); }
  });
});
