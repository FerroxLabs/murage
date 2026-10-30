// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot email in the app (BOT-EMAIL-MURAGE-109 2.0, 2.5, 2.6, 3.3, 3.5, 6, 8): hidden unless the status route says on, the section 8 Flux line
// only when the server sends it, the price line never inside the phone apps, the buttons each state offers, and an owner act posting the
// exact body the server digests. Plus the house copy rules over every owner-facing word.
import { describe, expect, it } from "vitest";
import { emailOwnerAct, emailSectionActions, OWNER_ROUTE, emailSectionOffered, priceLine, readEmailStatus, setEmailAccount, signInEmailOwner } from "./bot-email";
import { EMAIL_KEY_HEALTH_COPY as KEY_HEALTH_LINES } from "../../shared/email-copy.ts";
import { EMAIL_CARD_COPY, EMAIL_OWNER_COPY, EMAIL_POLICY_COPY, EMAIL_SETUP_COPY, EMAIL_TRUST_COPY, checkLine, emailOwnerActionCard, ownerRouteLine, type EmailStatusView } from "../../shared/email-copy.ts";

const VIEW: EmailStatusView = { enabled: true, accountState: "active", termsVersion: "v1", priceNote: "One cost line.", limits: {}, removing: [] };
const failing = (status: number, body: unknown) => async () => { throw Object.assign(new Error("x"), { status, body }); };

describe("the status read (2.0, section 8)", () => {
  it("on only when the server says enabled: true; a 404 is off; the Flux line only when the server sends it", async () => {
    expect(await readEmailStatus(async () => VIEW)).toEqual({ kind: "on", view: VIEW });
    expect(await readEmailStatus(failing(404, { error: "Bot email is not available." }))).toEqual({ kind: "off" });
    expect(await readEmailStatus(failing(404, { error: "x", fluxOff: EMAIL_SETUP_COPY.fluxOff }))).toEqual({ kind: "flux-off", line: EMAIL_SETUP_COPY.fluxOff });
    expect(await readEmailStatus(async () => ({ enabled: false }))).toEqual({ kind: "off" });
    // a failed read (5xx, network) is not "off": the stub must not claim the account is waiting for a rollout
    expect(await readEmailStatus(failing(500, { error: "x" }))).toEqual({ kind: "error" });
    expect(await readEmailStatus(async () => { throw new TypeError("Failed to fetch"); })).toEqual({ kind: "error" });
    expect(emailSectionOffered({ kind: "on", view: VIEW })).toBe(true);
    for (const state of [{ kind: "off" }, { kind: "loading" }, { kind: "error" }, { kind: "flux-off", line: "x" }] as const) expect(emailSectionOffered(state)).toBe(false);
  });

  it("asks for a fresh capability read when Settings opens", async () => {
    const paths: string[] = [];
    await readEmailStatus(async path => { paths.push(path); return VIEW; }, true);
    expect(paths).toEqual(["/api/email/status?refresh=1"]);
  });

  it("the price line shows on the desktop and never inside the phone apps", () => {
    expect(priceLine(VIEW, false)).toBe("One cost line.");
    expect(priceLine(VIEW, true)).toBeNull();
    expect(priceLine({ ...VIEW, priceNote: undefined }, false)).toBeNull();
  });
});

describe("the bot's Email section (2.5, 2.6, section 6)", () => {
  it("offers what each state allows", () => {
    expect(emailSectionActions({ state: null })).toEqual(["give"]);
    expect(emailSectionActions({ state: "active" })).toEqual(["pause", "remove"]);
    expect(emailSectionActions({ state: "paused" })).toEqual(["resume", "remove"]);
    expect(emailSectionActions({ state: "failed" })).toEqual(["retry", "remove"]);
    expect(emailSectionActions({ state: "restored_unverified" })).toEqual(["reconnect", "remove"]);
    for (const state of ["provisioning", "removing", "account_off"]) expect(emailSectionActions({ state })).toEqual([]);
  });

  it("r2.5 closing: Remove's 202 closing and a Flux-closed inbox both offer Keep address, posted to the keep route", async () => {
    expect(emailSectionActions({ state: "remove_requested" })).toEqual(["keep"]);
    expect(emailSectionActions({ state: "closing" })).toEqual(["keep"]);
    expect(OWNER_ROUTE.keep).toBe("keep");
  });

  it("r2.5 lines are plain words: a send held by closing is a plain card line, and the closing codes read as what to do", () => {
    expect(EMAIL_CARD_COPY.approvedUnsent(checkLine("inbox_closing"))).toBe("You said Send. It has not gone out yet: this address is closing. Choose Keep address in the bot's Email settings to bring it back.");
    const lines = ["inbox_closing", "not_closing", "restore_window_passed", "inbox_account_mismatch", "email_dark"].map(ownerRouteLine);
    expect(lines[4]).toBe(EMAIL_OWNER_COPY.notAvailable);
    for (const line of [...lines, EMAIL_OWNER_COPY.removingLine("a@murage.email", "2026-12-01T00:00:00Z"), EMAIL_OWNER_COPY.keepAddress]) expect(line).not.toMatch(/\u2014|safe|unsafe|safety/i);
    expect(EMAIL_OWNER_COPY.removingLine("a@murage.email")).toBe("Removing a@murage.email");
  });

  it("an owner act posts the body to its route; the proof card binds exactly the body's words", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    await emailOwnerAct("b1", "t1", "trust_add", { entry: "jane@acme.test" }, async (path, init) => { calls.push({ path, body: JSON.parse(String(init?.body)) }); return {}; });
    expect(calls).toEqual([{ path: "/api/email/bots/b1/trusted-add", body: { entry: "jane@acme.test" } }]);
    expect(emailOwnerActionCard("trust_add", "b1", { entry: "jane@acme.test", freshAuth: { nonce: "n" } })).toEqual(emailOwnerActionCard("trust_add", "b1", { entry: "jane@acme.test" }));
    expect(emailOwnerActionCard("trust_add", "b1", { entry: "a@b.test" })).not.toEqual(emailOwnerActionCard("trust_add", "b1", { entry: "c@d.test" }));
  });

  it("account Off is sent only with the confirm", async () => {
    const bodies: unknown[] = [];
    const fake = async (_path: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return {}; };
    await setEmailAccount(false, { confirm: true }, fake);
    await setEmailAccount(true, { acceptTermsVersion: "v1" }, fake);
    expect(bodies).toEqual([{ on: false, confirm: true }, { on: true, acceptTermsVersion: "v1" }]);
  });
});

describe("house copy rules", () => {
  it("no em dashes, never the forbidden words, no prices in Murage's own words", () => {
    const words: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") words.push(value);
      else if (typeof value === "function") { const out = (value as (...args: string[]) => unknown)("Juniper", "jane@acme.test"); if (typeof out === "string") words.push(out); }
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    [EMAIL_OWNER_COPY, EMAIL_POLICY_COPY, EMAIL_SETUP_COPY, EMAIL_TRUST_COPY, EMAIL_CARD_COPY].forEach(walk);
    for (const code of ["domain_allow_not_available", "pause_cooloff", "owner_required", "sends_in_flight", "rotation_expired", "revoke_pending", "x"]) words.push(ownerRouteLine(code));
    words.push(...Object.values(KEY_HEALTH_LINES));
    expect(words.length).toBeGreaterThan(40);
    for (const line of words) {
      expect(line, line).not.toMatch(/[—–]/);
      expect(line, line).not.toMatch(/\b(safe|safely|safety|unsafe|composio)\b/i);
      expect(line, line).not.toMatch(/[$€£]\s?\d/);
    }
  });
});

describe("credentials and key health (2.3, 2.4, section 8)", () => {
  it("a refused key offers Reconnect on a live binding; a pause or a fine key keeps the usual buttons", () => {
    expect(emailSectionActions({ state: "active", keyRejected: true })).toEqual(["reconnect", "remove"]);
    expect(emailSectionActions({ state: "paused", keyRejected: true })).toEqual(["reconnect", "remove"]);
    expect(emailSectionActions({ state: "active", keyRejected: false })).toEqual(["pause", "remove"]);
    expect(emailSectionActions({ state: null, keyRejected: true })).toEqual(["give"]);
  });

  it("the owner sign-in runs only in the desktop shell and never hands a token to the page", async () => {
    expect(await signInEmailOwner(undefined)).toBeNull();
    let started = 0;
    expect(await signInEmailOwner({ start: async () => { started++; return { ok: true }; }, cancel: async () => {} })).toBeNull();
    expect(await signInEmailOwner({ start: async () => ({ ok: false, code: "cancelled", message: "Sign-in was cancelled. Nothing was changed." }), cancel: async () => {} }))
      .toBe("Sign-in was cancelled. Nothing was changed.");
    expect(started).toBe(1);
  });

  it("the import offer and the key line use the design's words", () => {
    expect(EMAIL_SETUP_COPY.importOffer).toBe("This bot had an email address where it came from. Give it one here?");
    expect(KEY_HEALTH_LINES.rejected).toBe("Email is not reachable: Flux did not accept the saved key.");
  });
});
