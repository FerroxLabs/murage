// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// secret-scan: fixture (fake addresses and fake tokens)
// OWNER-VIEW-WIRE-CONTRACT rounds 4 and 5: server rows and phone challenges agree
// with the client, including its pinned parked Keep proof vector.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalDigest, approvalDigestInput } from "../../shared/approval-digest.ts";
import { EMAIL_OWNER_PROOF_THREAD, emailOwnerActionCard, emailOwnerActionRequestId, type EmailOwnerRow } from "../../shared/email-copy.ts";
import { approvalDigestSync, FreshAuthGate } from "../approval-fresh-auth.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";
import { emailOwnerRoute, type OwnerRouteDeps } from "./owner-routes.ts";
import type { ParkRecord } from "./owner-view.ts";
import { EmailRuntime } from "./runtime.ts";

const NOW = 1_800_000_000_000;
const BOT = { id: "live-bot", name: "Fixture", threadId: "fixture-thread" };
const PINNED_DIGEST = "bc00f3cce79e7f071d57936e7d5203d7027547bf20a8c26a0a1c4cea5dec4cce";
const PINNED_CARD = { tool: "bot_email", title: "Bot email: parked keep", subtitle: '["b1",["target","t:1"],["token","v1.1.tok"]]' };
const PINNED_BODY = { token: "v1.1.tok", target: "t:1", freshAuth: { nonce: "n".repeat(43), signature: "fixture" } };
let db: DatabaseSync, runtime: EmailRuntime, fake: FakeFlux, deps: OwnerRouteDeps;

const call = (method: string, path: string, body: unknown = {}, surface: "desktop" | "phone" = "desktop") =>
  emailOwnerRoute(deps, { method, path, body, surface, query: new URLSearchParams(), botCredential: false });
const rows = async (surface: "desktop" | "phone" = "desktop"): Promise<EmailOwnerRow[]> => {
  const answer = await call("GET", "/api/email/status", {}, surface);
  expect(answer?.status).toBe(200);
  return answer!.body.rows as EmailOwnerRow[];
};

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  fake = new FakeFlux();
  runtime = new EmailRuntime({
    accountKey: () => "account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch,
    apiBase: "https://api.flux.test", appBase: "https://app.flux.test", now: () => NOW,
    workspaceRoot: () => undefined, bot: () => undefined,
  });
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "owner-key-fixture" });
  fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: { enabled: true, available: true, account_state: "active", limits: {} } });
  fake.always("GET", /^\/v1\/email\/settings$/, { status: 200, body: { limits: {} } });
  fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [{ id: "other-inbox", address: "other@example.test", state: "active" }] } });
  await runtime.probe.refresh();
  runtime.services()!.store.insertBinding({
    botId: BOT.id, inboxId: "live-inbox", address: "live@example.test", username: "fixture", displayName: "Fixture",
    emailKeyRef: "bot-key-fixture", fluxAccountId: null, state: "closing", closingUntil: null, step: null,
    opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: NOW,
  });
  const park: ParkRecord = { botId: "b1", parkId: "park-fixture", parkRev: 1, address: "parked@example.test", inboxId: "parked-inbox", keyIds: [], state: "parked", remoteDeleted: false };
  deps = {
    runtime, bot: id => id === BOT.id ? BOT : undefined, fluxKeyPresent: () => true, now: () => NOW,
    parks: { list: () => [park], keep: vi.fn(async () => ({ ok: true as const })), remove: vi.fn(async () => ({ ok: true as const })) },
    restoreCheck: () => true, confirmRestoreCheck: vi.fn(() => true), freshProof: vi.fn(async () => null),
  };
});

afterEach(() => { runtime.stop(); db.close(); });

describe("owner rows and fresh proof contract, rounds 4 and 5", () => {
  for (const surface of ["desktop", "phone"] as const) {
    it(`${surface}: all four row kinds carry the exact proof thread`, async () => {
      const emitted = await rows(surface);
      expect(emitted.map(row => [row.section, row.threadId])).toEqual([
        ["bot", "fixture-thread"], ["parked", "email-owner"], ["other_setup", "email-owner"], ["restore_check", "email-owner"],
      ]);
      expect(EMAIL_OWNER_PROOF_THREAD).toBe("email-owner");
      expect(emitted[0]!.actions.find(action => action.kind === "keep")).toMatchObject({ enabled: true, tokenId: null });
      for (const row of emitted) {
        expect(row.actions.length).toBeGreaterThan(0);
        for (const action of row.actions.filter(action => action.kind === "remove")) {
          expect(action.enabled).toBe(true);
          expect(action.tokenId).toEqual(expect.any(String));
          expect(action.tokenId!.length).toBeGreaterThan(0);
        }
      }
    });
  }

  it("a removing row uses its bot thread, or the owner scope after its bot is gone", async () => {
    const store = runtime.services()!.store;
    store.casBinding(BOT.id, store.getBinding(BOT.id)!.revision, { state: "removing" }, NOW);
    expect((await rows())[0]).toMatchObject({ section: "removing", threadId: BOT.threadId, actions: [{ kind: "try_again_now" }] });
    deps.bot = () => undefined;
    const removing = (await rows())[0]!;
    expect(removing.threadId).toBe("email-owner");
    expect(removing.actions.map(action => action.kind)).toEqual(["try_again_now"]);
    await call("POST", removing.actions[0]!.path, {}, "phone");
    expect(deps.freshProof).toHaveBeenCalledWith("email-owner", "email-owner-try_again-live-bot", {
      tool: "bot_email", title: "Bot email: try again", subtitle: '["live-bot"]',
    }, {});
  });

  it("a restored bot's enabled Keep is tokenless and succeeds on its own thread", async () => {
    const store = runtime.services()!.store;
    store.casBinding(BOT.id, store.getBinding(BOT.id)!.revision, { state: "removal_parked" }, NOW);
    const orphan = deps.parks!.list()[0]!;
    deps.parks!.list = () => [orphan, { ...orphan, botId: BOT.id, parkId: "live-park", inboxId: "live-inbox" }];
    const botRow = (await rows("phone"))[0]!;
    expect(botRow).toMatchObject({ section: "bot", threadId: "fixture-thread" });
    const keep = botRow.actions.find(action => action.kind === "keep")!;
    expect(keep).toMatchObject({ enabled: true, tokenId: null });
    const body = { target: botRow.target };
    const answer = await call("POST", keep.path, body, "phone");
    expect(answer).toMatchObject({ status: 200, body: { rows: expect.any(Array) } });
    expect(deps.freshProof).toHaveBeenCalledExactlyOnceWith("fixture-thread", "email-owner-keep-live-bot", {
      tool: "bot_email", title: "Bot email: keep", subtitle: '["live-bot",["target","park:live-park"]]',
    }, body);
    expect(deps.parks!.keep).toHaveBeenCalledExactlyOnceWith(BOT.id, { parkId: "live-park", parkRev: 1 });
  });

  const routes = [
    ["/api/email/bots/live-bot/keep", "fixture-thread", "keep", "live-bot"],
    ["/api/email/bots/live-bot/remove", "fixture-thread", "remove", "live-bot"],
    ["/api/email/bots/live-bot/try-again", "fixture-thread", "try_again", "live-bot"],
    ["/api/email/parked/b1/keep", "email-owner", "parked_keep", "b1"],
    ["/api/email/parked/b1/remove", "email-owner", "parked_remove", "b1"],
    ["/api/email/other-setups/other-inbox/remove", "email-owner", "other_setup_remove", "other-inbox"],
    ["/api/email/restore/confirm-inventory", "email-owner", "confirm_inventory", "restore"],
  ] as const;
  for (const [path, threadId, action, id] of routes) {
    it(`${path}: fresh proof binds the advertised thread and exact card before any action`, async () => {
      const gate = new FreshAuthGate({ now: () => NOW });
      deps.freshProof = vi.fn(async (thread, requestId, card, body) => {
        const result = gate.check({ device: { id: "fixture-device", cls: "app", key: "fixture-public-key" },
          threadId: thread, requestId, decision: "allow", digest: approvalDigestSync(thread, requestId, card), proof: body.freshAuth });
        return result.ok ? null : { status: result.status, body: result.body };
      });
      const before = fake.requests.length;
      const answer = await call("POST", path, PINNED_BODY, "phone");
      const card = { tool: "bot_email", title: `Bot email: ${action.replace(/_/g, " ")}`, subtitle: JSON.stringify([id, ["target", "t:1"], ["token", "v1.1.tok"]]) };
      expect(deps.freshProof).toHaveBeenCalledExactlyOnceWith(threadId, `email-owner-${action}-${id}`, card, PINNED_BODY);
      // Supply no signature to exercise a real challenge, rather than an invalid proof refusal.
      const challenged = await call("POST", path, { token: PINNED_BODY.token, target: PINNED_BODY.target }, "phone");
      expect(answer?.status).toBe(403);
      expect(challenged).toMatchObject({ status: 403, body: { code: "fresh_auth", error: expect.any(String), challenge: {
        decision: "allow", digest: approvalDigestSync(threadId, `email-owner-${action}-${id}`, card),
      } } });
      expect(challenged!.body).not.toHaveProperty("message");
      if (action === "parked_keep") expect((challenged!.body.challenge as { digest: string }).digest).toBe(PINNED_DIGEST);
      expect(fake.requests).toHaveLength(before);
      expect(deps.parks!.keep).not.toHaveBeenCalled();
      expect(deps.parks!.remove).not.toHaveBeenCalled();
      expect(deps.confirmRestoreCheck).not.toHaveBeenCalled();
    });
  }

  it("reproduces the client's pinned card, canonical digest input and SHA-256 exactly", async () => {
    const requestId = emailOwnerActionRequestId("parked_keep", "b1");
    const card = emailOwnerActionCard("parked_keep", "b1", PINNED_BODY);
    expect(requestId).toBe("email-owner-parked_keep-b1");
    expect(card).toEqual(PINNED_CARD);
    expect(JSON.parse(approvalDigestInput("email-owner", requestId, card))).toEqual([
      "murage-approval-digest/2", "email-owner", "email-owner-parked_keep-b1", "bot_email", "Bot email: parked keep",
      PINNED_CARD.subtitle, null, null, false, null, null, null, null, null, null, null, null, null,
    ]);
    expect(approvalDigestSync("email-owner", requestId, card)).toBe(PINNED_DIGEST);
    expect(await approvalDigest("email-owner", requestId, card)).toBe(PINNED_DIGEST);
    expect(emailOwnerActionRequestId("parked_keep", "x".repeat(400))).toHaveLength(256);
  });

  it("binds emailConfirm and empty targets, sorts string fields, and excludes the proof object", () => {
    expect(emailOwnerActionCard("parked_keep", "b1", { ...PINNED_BODY, target: "", emailConfirm: "fixture-confirm", count: 1, confirm: true })).toEqual({
      tool: "bot_email", title: "Bot email: parked keep", subtitle: '["b1",["emailConfirm","fixture-confirm"],["target",""],["token","v1.1.tok"]]',
    });
  });

  it("an expired parked token refuses with error, code and rowId, without message", async () => {
    expect(await call("POST", "/api/email/parked/b1/remove", { token: "expired-fixture" })).toEqual({
      status: 409, body: { error: "This confirmation is out of date. Open it again to see the current address.", code: "confirm_expired", rowId: "parked:b1" },
    });
  });
});
