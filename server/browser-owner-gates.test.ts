// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The handler-level gates for the owner's browser on a Cloud home (browser-owner-gates.ts), with the real identity helpers.
import { createHash, generateKeyPairSync } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { approvalDigestSync } from "./approval-fresh-auth.ts";
import { browserCardGate, browserStandingRefusal, homeConfigView, markOwnerProven, onOwnerBrowser, ownerCodeGate, ownerProvenFor, setBrowserOwnerAct } from "./browser-owner-gates.ts";
import type { CloudOwnerAct } from "./cloud-request-auth.ts";
import { setCloudIdentity } from "./cloud-request-identity.ts";
import { cardActDigest } from "./cloud-home/owner-code.ts";
import type { CloudDevice } from "./cloud-sessions.ts";
import { publishAnswerAllowed } from "./publish/publish-ops.ts";

const pem = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "pem", type: "spki" }).toString();
const device = (over: Partial<CloudDevice> = {}): CloudDevice & { accessHash: string } => ({ id: "dev-1", account: "owner", scope: "browser", publicKey: pem(), assertionKey: pem(), revoked: 0, factor: "remembered-owner", accessHash: "hash-1", ...over });
function request(dev: CloudDevice | undefined, headers: Record<string, string> = {}): IncomingMessage {
  const headersObject = { ...headers } as IncomingMessage["headers"];
  if (dev) setCloudIdentity(headersObject, dev);
  return { headers: headersObject } as IncomingMessage;
}
/** A code service that accepts a proof of the form `ok:<act>` and mints `tok:<act>` tokens. */
const service = (): CloudOwnerAct & { spent: string[] } => {
  const spent: string[] = [];
  return { spent, token: (input) => `tok:${input.label}:${input.act}`, doorFresh: () => false,
    verifyProof: (req, _device, act) => { const ok = req.headers["x-murage-owner-proof"] === `ok:${act}` && !spent.includes(act); if (ok) spent.push(act); return ok; } };
};
beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); });
afterEach(() => { vi.unstubAllEnvs(); setBrowserOwnerAct(undefined); });

describe("ownerCodeGate", () => {
  test("no proof: 403 email_code carrying a token for exactly this act", async () => {
    setBrowserOwnerAct(service());
    const refused = await ownerCodeGate(request(device()), "act-1", "allow_request");
    expect(refused).toMatchObject({ status: 403, body: { code: "email_code", actToken: "tok:allow_request:act-1", label: "allow_request" } });
  });
  test("a valid proof for the act passes and is remembered for the rest of the request", async () => {
    const svc = service(); setBrowserOwnerAct(svc);
    const req = request(device(), { "x-murage-owner-proof": "ok:act-1" });
    expect(await ownerCodeGate(req, "act-1", "allow_request")).toBeNull();
    expect(ownerProvenFor(req.headers, "act-1")).toBe(true);
    expect(await ownerCodeGate(req, "act-1", "allow_request")).toBeNull();
    expect(svc.spent).toEqual(["act-1"]);
  });
  test("a proof for another act (the card changed) is fresh_auth_changed", async () => {
    setBrowserOwnerAct(service());
    const refused = await ownerCodeGate(request(device(), { "x-murage-owner-proof": "ok:act-1" }), "act-2", "allow_request");
    expect(refused).toMatchObject({ status: 403, body: { code: "fresh_auth_changed", error: "This request changed. Review it again before you allow it." } });
  });
  test("no code service fails closed", async () => {
    const refused = await ownerCodeGate(request(device(), { "x-murage-owner-proof": "ok:act-1" }), "act-1", "allow_request");
    expect(refused?.status).toBe(403);
    expect(refused?.body.code).not.toBeUndefined();
    expect(refused?.body.actToken).toBeUndefined();
  });
  test("a chat-only browser, the phone and a non-home process never get a code route", async () => {
    setBrowserOwnerAct(service());
    for (const other of [device({ factor: false }), device({ scope: "owner-phone" }), device({ scope: "owner-desktop" })]) {
      expect((await ownerCodeGate(request(other), "a", "allow_request"))?.body.code).toBeUndefined();
      expect(onOwnerBrowser(request(other).headers)).toBe(false);
    }
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    expect(onOwnerBrowser(request(device()).headers)).toBe(false);
  });
});

describe("browserCardGate", () => {
  const card = (over: Record<string, unknown> = {}) => ({ requestId: "req-1", tool: "Bash", summary: "ls", title: "Run", subtitle: "ls", riskReason: "none", ...over });
  const run = (req: IncomingMessage, c: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
    browserCardGate(req, { threadId: "t1", requestId: "req-1", behavior: "allow", card: c as never, digest: (x) => approvalDigestSync("t1", "req-1", x as never), ...extra });
  const actFor = (c: Record<string, unknown>, reason: string, decision = "allow") => cardActDigest({ threadId: "t1", requestId: "req-1", decision, approvalDigest: approvalDigestSync("t1", "req-1", c as never), riskReason: reason });

  test("a stamped none card needs no code; a card with no stamp does", async () => {
    setBrowserOwnerAct(service());
    expect(await run(request(device()), card())).toBeNull();
    expect((await run(request(device()), card({ riskReason: undefined })))?.body.code).toBe("email_code");
  });
  test("a pay card, a message-then-pay batch stamp and a credential card need a code", async () => {
    setBrowserOwnerAct(service());
    for (const riskReason of ["pay", "delete", "credential"]) expect((await run(request(device()), card({ riskReason })))?.body.code).toBe("email_code");
  });
  test("the code is bound to the card and the decision: right proof passes, changed card gives fresh_auth_changed", async () => {
    setBrowserOwnerAct(service());
    const c = card({ riskReason: "pay" });
    const proofHeader = { "x-murage-owner-proof": `ok:${actFor(c, "pay")}` };
    expect(await run(request(device(), proofHeader), c)).toBeNull();
    const changed = card({ riskReason: "pay", summary: "something else" });
    expect((await run(request(device(), proofHeader), changed))?.body.code).toBe("fresh_auth_changed");
    // the same card for the other decision is another act
    expect((await run(request(device(), proofHeader), c, { allowForTask: true }))?.body.code).toBe("fresh_auth_changed");
  });
  test("a passing card is remembered as proven for the same request (publish uses this)", async () => {
    setBrowserOwnerAct(service());
    const c = card({ riskReason: "pay", requestId: "publish-1" });
    const act = cardActDigest({ threadId: "t1", requestId: "req-1", decision: "allow", approvalDigest: approvalDigestSync("t1", "req-1", c as never), riskReason: "pay" });
    const req = request(device(), { "x-murage-owner-proof": `ok:${act}` });
    expect(ownerProvenFor(req.headers, "card:t1:req-1")).toBe(false);
    expect(await run(req, c)).toBeNull();
    expect(ownerProvenFor(req.headers, "card:t1:req-1")).toBe(true);
  });
  test("publish Allow reaches a code with the publish label, and publishAnswerAllowed takes only a proven browser", async () => {
    setBrowserOwnerAct(service());
    const refused = await run(request(device()), card({ requestId: "publish-1", riskReason: "none" }), { requestId: "publish-1" });
    expect(refused?.body).toMatchObject({ code: "email_code", label: "publish_allow" });
    expect(publishAnswerAllowed("publish-1", "allow", "elsewhere")).toBe(false);
    expect(publishAnswerAllowed("publish-1", "allow", "proven")).toBe(true);
    expect(publishAnswerAllowed("publish-1", "allow", "desktop")).toBe(true);
    expect(publishAnswerAllowed("publish-1", "deny", "elsewhere")).toBe(true);
    expect(publishAnswerAllowed("req-1", "allow", "elsewhere")).toBe(true);
  });
  test("a card that is gone is 409, not a code", async () => {
    setBrowserOwnerAct(service());
    expect(await run(request(device()), undefined)).toMatchObject({ status: 409, body: { code: "fresh_auth_gone" } });
  });
  test("the approval digest the phone signs is unchanged by the stamp", () => {
    const base = { tool: "Bash", title: "Run", subtitle: "ls", summary: "ls" };
    expect(approvalDigestSync("t1", "r1", { ...base, riskReason: "pay" } as never)).toBe(approvalDigestSync("t1", "r1", base as never));
    expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64);
  });
});

describe("browserStandingRefusal", () => {
  const bodies: Array<[string, Record<string, unknown>]> = [
    ["noLimits", { noLimits: true }], ["acknowledgeNoLimits", { acknowledgeNoLimits: true }], ["unlimited", { permissionMode: "unlimited" }],
    ["local computer", { computer: "local" }], ["host consent allowed", { hostComputerConsent: "allowed" }], ["local auto", { acknowledgeLocalAuto: true }], ["always", { alwaysAllow: [] }],
  ];
  test.each(bodies)("%s is refused for the owner browser whatever else it carries", (_name, body) => {
    expect(browserStandingRefusal(request(device(), { "x-murage-owner-proof": "ok:anything" }).headers, body)).toMatchObject({ status: 403, body: { code: "no_computer" } });
  });
  test("decline, ask, null and ordinary settings pass", () => {
    for (const body of [{ hostComputerConsent: "declined" }, { hostComputerConsent: "ask" }, { hostComputerConsent: null }, { computer: "off" }, { noLimits: false }, { name: "x" }, { permissionMode: "auto" }])
      expect(browserStandingRefusal(request(device()).headers, body)).toBeNull();
  });
  test("desktop, phone, chat-only and a non-home process are unchanged", () => {
    for (const other of [device({ scope: "owner-desktop", factor: false }), device({ scope: "owner-phone", factor: false }), device({ factor: false })])
      expect(browserStandingRefusal(request(other).headers, { noLimits: true, computer: "local" })).toBeNull();
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    expect(browserStandingRefusal(request(device()).headers, { noLimits: true })).toBeNull();
  });
});

describe("homeConfigView", () => {
  test("an owner browser: owner true, until from its factor, never a computer", () => {
    expect(homeConfigView(request(device()).headers, "desktop", (id) => (id === "dev-1" ? 123 : undefined)))
      .toEqual({ surface: "desktop", owner: true, ownerUntil: 123, computer: false, cloudOwnerBrowser: true });
  });
  test("a chat-only browser is not told it is the desktop and is not the owner", () => {
    expect(homeConfigView(request(device({ factor: false })).headers, "desktop", () => 5)).toEqual({ surface: "remote", owner: false, computer: false, cloudOwnerBrowser: true });
  });
  test("the phone and the desktop keep their surface and are not owner browsers", () => {
    expect(homeConfigView(request(device({ scope: "owner-phone", factor: false })).headers, "desktop", () => 5)?.surface).toBe("desktop");
    expect(homeConfigView(request(device({ scope: "owner-desktop", factor: false })).headers, "desktop", () => 5)).toMatchObject({ surface: "desktop", owner: false });
  });
  test("off a home the answer is unchanged: no extra fields", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    expect(homeConfigView(request(device()).headers, "desktop", () => 5)).toBeUndefined();
    markOwnerProven({}, "x");
  });
});
