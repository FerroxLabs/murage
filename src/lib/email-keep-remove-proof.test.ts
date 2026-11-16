// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// secret-scan: fixture (fake addresses and fake tokens)
// 1.0.19 Settings email Keep/Remove on the phone (contract rounds 4 and 5): the fresh device proof applies to EVERY owner action POST.
// Nothing about the proof flow is replaced here except the native device prompt (`window.murageNative.approveWithDevice`): the real
// respondWithFreshAuth detects the challenge, checks the digest of the card on screen against the server's, asks the device and
// resumes the one request.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalDigest } from "../../shared/approval-digest";
import { emailOwnerActionCard, emailOwnerActionRequestId } from "../../shared/email-copy.ts";
import { approvalDigestSync } from "../../server/approval-fresh-auth.ts";
import { createHttpEmailKeepRemoveClient, parseView, type Call, type EmailActionKind } from "./email-keep-remove-client";
import { resetNativeShellForTest } from "./native-shell";

// The restore-park wrapper tests at the end of this file run against a stand-in for respondWithFreshAuth (no native bridge); every
// other test in this file uses the real one. The stand-in is on only inside that describe.
let useStandIn = false;
const wrapperProofs: Array<{ threadId: string; requestId: string; decision?: string; card?: { subtitle: string; title: string } }> = [];
vi.mock("./fresh-auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("./fresh-auth")>();
  return {
    ...original,
    respondWithFreshAuth: ((...args: Parameters<typeof original.respondWithFreshAuth>) => {
      if (!useStandIn) return original.respondWithFreshAuth(...args);
      const post = args[0] as unknown as (extra?: Record<string, unknown>) => Promise<unknown>;
      const context = args[1] as unknown as (typeof wrapperProofs)[number];
      return (async () => {
        try { return await post(); } catch (error) {
          const { status, body } = error as { status?: number; body?: { code?: string } };
          if (status !== 403 || body?.code !== "fresh_auth") throw error;
          wrapperProofs.push(context);
          return post({ freshAuth: { nonce: "n".repeat(43), signature: "fake-signature" } });
        }
      })();
    }) as typeof original.respondWithFreshAuth,
  };
});

afterEach(() => { vi.unstubAllGlobals(); resetNativeShellForTest(); });

const NONCE = "n".repeat(43);
const FRESH = { freshAuth: { nonce: NONCE, signature: "sig" } };
const device = (approve: (args: unknown) => unknown) => vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["approveWithDevice"] }), approveWithDevice: approve });
const row = (section: string, kind: EmailActionKind, path: string, over: Record<string, unknown> = {}) => parseView({ rows: [{
  rowId: `${section}:r1`, section, botId: "b1", inboxId: "in1", keyIds: [], threadId: "thr-1", target: "t:1", address: "a@example.test", botName: "Ava", line: "",
  actions: [{ kind, tokenId: "v1.1.tok", enabled: true, path }], ...over,
}] }).rows[0]!;

/** The server: the first POST (no proof) is challenged with the digest of the card the server expects; the proved one is answered. */
function server(expected: { threadId: string; requestId: string; card: { tool: string; title: string; subtitle: string } }, digestOver?: string) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const call: Call = async (path, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push({ path, body });
    if (!("freshAuth" in body)) {
      const digest = digestOver ?? await approvalDigest(expected.threadId, expected.requestId, expected.card);
      throw Object.assign(new Error("proof"), { status: 403, body: { code: "fresh_auth", challenge: { v: 1, nonce: NONCE, digest, decision: "allow", expiresAt: 99 } } });
    }
    return { rows: [] };
  };
  return { call, posts };
}
const subtitle = (id: string, ...pairs: Array<[string, string]>) => JSON.stringify([id, ...pairs]);

/** One case per owner action route: the route, the action kind, the row, and the request id and card the server digests. */
const ROUTES: Array<{ name: string; kind: EmailActionKind; path: string; section: string; thread: string; requestId: string; title: string; subtitle: string }> = [
  { name: "bots/:id/keep", kind: "keep", path: "/api/email/bots/b1/keep", section: "bot", thread: "thr-1", requestId: "email-owner-keep-b1", title: "Bot email: keep", subtitle: subtitle("b1", ["target", "t:1"], ["token", "v1.1.tok"]) },
  { name: "bots/:id/remove", kind: "remove", path: "/api/email/bots/b1/remove", section: "bot", thread: "thr-1", requestId: "email-owner-remove-b1", title: "Bot email: remove", subtitle: subtitle("b1", ["target", "t:1"], ["token", "v1.1.tok"]) },
  { name: "bots/:id/try-again", kind: "try_again_now", path: "/api/email/bots/b1/try-again", section: "removing", thread: "thr-1", requestId: "email-owner-try_again-b1", title: "Bot email: try again", subtitle: subtitle("b1", ["target", "t:1"], ["token", "v1.1.tok"]) },
  { name: "parked/:id/keep", kind: "keep", path: "/api/email/parked/b1/keep", section: "parked", thread: "email-owner", requestId: "email-owner-parked_keep-b1", title: "Bot email: parked keep", subtitle: subtitle("b1", ["target", "t:1"], ["token", "v1.1.tok"]) },
  { name: "parked/:id/remove", kind: "remove", path: "/api/email/parked/b1/remove", section: "parked", thread: "email-owner", requestId: "email-owner-parked_remove-b1", title: "Bot email: parked remove", subtitle: subtitle("b1", ["target", "t:1"], ["token", "v1.1.tok"]) },
  { name: "other-setups/:id/remove", kind: "remove", path: "/api/email/other-setups/in1/remove", section: "other_setup", thread: "email-owner", requestId: "email-owner-other_setup_remove-in1", title: "Bot email: other setup remove", subtitle: subtitle("in1", ["target", "t:1"], ["token", "v1.1.tok"]) },
  { name: "restore/confirm-inventory", kind: "confirm_inventory", path: "/api/email/restore/confirm-inventory", section: "restore_check", thread: "email-owner", requestId: "email-owner-confirm_inventory-restore", title: "Bot email: confirm inventory", subtitle: subtitle("restore", ["target", "t:1"], ["token", "v1.1.tok"]) },
];

describe("a phone's fresh proof on every owner action POST (the real respondWithFreshAuth)", () => {
  for (const route of ROUTES) {
    it(`${route.name}: the challenge is checked, the device signs it and the same request resumes with the proof`, async () => {
      const approve = vi.fn(async (_args: unknown) => ({ signature: "sig" }));
      device(approve);
      const card = { tool: "bot_email", title: route.title, subtitle: route.subtitle };
      const { call, posts } = server({ threadId: route.thread, requestId: route.requestId, card });
      const answer = await createHttpEmailKeepRemoveClient(call).act(row(route.section, route.kind, route.path, { threadId: route.thread }), route.kind);
      expect(answer).toEqual({ ok: true, view: { rows: [] }, body: { rows: [] } });
      expect(approve).toHaveBeenCalledTimes(1);
      expect(approve.mock.calls[0]![0]).toMatchObject({ threadId: route.thread, requestId: route.requestId, nonce: NONCE, decision: "allow" });
      expect(posts.map((p) => p.path)).toEqual([route.path, route.path]);
      expect(posts[0]!.body).toEqual({ token: "v1.1.tok", target: "t:1" });
      expect(posts[1]!.body).toEqual({ token: "v1.1.tok", target: "t:1", ...FRESH });
    });
  }
  it("a tokenless bot-row Keep is proved too, over its target alone", async () => {
    const approve = vi.fn(async () => ({ signature: "sig" }));
    device(approve);
    const card = { tool: "bot_email", title: "Bot email: keep", subtitle: subtitle("b1", ["target", "t:1"]) };
    const { call, posts } = server({ threadId: "thr-1", requestId: "email-owner-keep-b1", card });
    const keep = row("bot", "keep", "/api/email/bots/b1/keep", { actions: [{ kind: "keep", tokenId: null, enabled: true, path: "/api/email/bots/b1/keep" }] });
    expect(await createHttpEmailKeepRemoveClient(call).act(keep, "keep")).toEqual({ ok: true, view: { rows: [] }, body: { rows: [] } });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(posts[0]!.body).toEqual({ target: "t:1" });
    expect(posts[1]!.body).toEqual({ target: "t:1", ...FRESH });
  });
  it("an empty-string target is echoed in the POST body and bound in the proof card", async () => {
    const approve = vi.fn(async () => ({ signature: "sig" }));
    device(approve);
    const card = { tool: "bot_email", title: "Bot email: parked keep", subtitle: subtitle("b1", ["target", ""], ["token", "v1.1.tok"]) };
    const { call, posts } = server({ threadId: "email-owner", requestId: "email-owner-parked_keep-b1", card });
    const parked = row("parked", "keep", "/api/email/parked/b1/keep", { target: "", threadId: "email-owner" });
    expect(parked.target).toBe("");
    expect(await createHttpEmailKeepRemoveClient(call).act(parked, "keep")).toEqual({ ok: true, view: { rows: [] }, body: { rows: [] } });
    expect(posts[0]!.body).toEqual({ token: "v1.1.tok", target: "" });
    expect(posts[1]!.body).toEqual({ token: "v1.1.tok", target: "", ...FRESH });
  });

  it("the person cancelling the device prompt ends it: nothing is resumed, the answer is a refusal", async () => {
    const approve = vi.fn(async () => { throw new Error("cancelled"); });
    device(approve);
    const { call, posts } = server({ threadId: "email-owner", requestId: "email-owner-parked_remove-b1", card: { tool: "bot_email", title: "Bot email: parked remove", subtitle: subtitle("b1", ["target", "t:1"], ["token", "v1.1.tok"]) } });
    const answer = await createHttpEmailKeepRemoveClient(call).act(row("parked", "remove", "/api/email/parked/b1/remove", { threadId: "email-owner" }), "remove");
    expect(answer).toMatchObject({ ok: false });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1);
  });
  it("a device that gives no signature ends it: nothing is resumed", async () => {
    device(async () => ({}));
    const { call, posts } = server({ threadId: "email-owner", requestId: "email-owner-parked_remove-b1", card: { tool: "bot_email", title: "Bot email: parked remove", subtitle: subtitle("b1", ["target", "t:1"], ["token", "v1.1.tok"]) } });
    const answer = await createHttpEmailKeepRemoveClient(call).act(row("parked", "remove", "/api/email/parked/b1/remove", { threadId: "email-owner" }), "remove");
    expect(answer).toMatchObject({ ok: false });
    expect(posts).toHaveLength(1);
  });
  it("a server digest that is not the card on screen is refused before the device is asked", async () => {
    const approve = vi.fn(async () => ({ signature: "sig" }));
    device(approve);
    const { call, posts } = server({ threadId: "email-owner", requestId: "x", card: { tool: "bot_email", title: "x", subtitle: "x" } }, "f".repeat(64));
    const answer = await createHttpEmailKeepRemoveClient(call).act(row("parked", "keep", "/api/email/parked/b1/keep", { threadId: "email-owner" }), "keep");
    expect(answer).toMatchObject({ ok: false });
    expect(approve).not.toHaveBeenCalled();
    expect(posts).toHaveLength(1);
  });
});

describe("a row with no threadId is refused locally (contract round 5)", () => {
  for (const route of ROUTES) {
    it(`${route.name}: no request is sent, signed or unsigned`, async () => {
      const approve = vi.fn(async () => ({ signature: "sig" }));
      device(approve);
      const { call, posts } = server({ threadId: "x", requestId: "x", card: { tool: "bot_email", title: "x", subtitle: "x" } });
      const answer = await createHttpEmailKeepRemoveClient(call).act(row(route.section, route.kind, route.path, { threadId: undefined }), route.kind);
      expect(answer).toMatchObject({ ok: false, status: null, code: "no_thread", rowId: `${route.section}:r1` });
      expect(posts).toHaveLength(0);
      expect(approve).not.toHaveBeenCalled();
    });
  }
  it("an empty threadId is no threadId", async () => {
    const { call, posts } = server({ threadId: "x", requestId: "x", card: { tool: "bot_email", title: "x", subtitle: "x" } });
    expect(await createHttpEmailKeepRemoveClient(call).act(row("parked", "keep", "/api/email/parked/b1/keep", { threadId: "" }), "keep")).toMatchObject({ ok: false, code: "no_thread" });
    expect(posts).toHaveLength(0);
  });
});

describe("the proof card is the shared one (contract round 5), with a fixed vector", () => {
  const body = { token: "v1.1.tok", target: "t:1", freshAuth: { nonce: NONCE, signature: "sig" } };
  it("requestId and card come from shared/email-copy.ts: title, tool, string-only sorted subtitle, 256 slice", () => {
    expect(emailOwnerActionRequestId("parked_keep", "b1")).toBe("email-owner-parked_keep-b1");
    expect(emailOwnerActionRequestId("parked_keep", "x".repeat(400))).toHaveLength(256);
    expect(emailOwnerActionCard("parked_keep", "b1", body)).toEqual({ tool: "bot_email", title: "Bot email: parked keep", subtitle: '["b1",["target","t:1"],["token","v1.1.tok"]]' });
  });
  it("the digest of thread email-owner, that request id and that card is one fixed value, the same from the page and the server", async () => {
    const card = emailOwnerActionCard("parked_keep", "b1", body);
    const fromPage = await approvalDigest("email-owner", emailOwnerActionRequestId("parked_keep", "b1"), card);
    const fromServer = approvalDigestSync("email-owner", "email-owner-parked_keep-b1", card);
    expect(fromServer).toBe(fromPage);
    expect(fromPage).toBe("bc00f3cce79e7f071d57936e7d5203d7027547bf20a8c26a0a1c4cea5dec4cce");
  });
});

// The restore-park tests (batch side), kept whole: the same wrapper and the same routes, against the stand-in.
describe("the freshProof wrapper on every owner action POST (stand-in for the device prompt)", () => {
  beforeEach(() => { useStandIn = true; wrapperProofs.length = 0; });
  afterEach(() => { useStandIn = false; });
  const WRAPPER_FRESH = { freshAuth: { nonce: "n".repeat(43), signature: "fake-signature" } };
  function challengingCall() {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const call: Call = async (path, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push({ path, body });
      if (!("freshAuth" in body)) throw Object.assign(new Error("proof"), { status: 403, body: { code: "fresh_auth", challenge: {} } });
      return { rows: [] };
    };
    return { call, posts };
  }
  const WRAPPER_ROUTES: Array<{ name: string; kind: EmailActionKind; path: string; section: string; requestId: string; title: string; subtitle: string }> = [
    { name: "bots/:id/keep", kind: "keep", path: "/api/email/bots/b1/keep", section: "bot", requestId: "email-owner-keep-b1", title: "Bot email: keep", subtitle: JSON.stringify(["b1", ["target", "t:1"], ["token", "v1.1.tok"]]) },
    { name: "bots/:id/remove", kind: "remove", path: "/api/email/bots/b1/remove", section: "bot", requestId: "email-owner-remove-b1", title: "Bot email: remove", subtitle: JSON.stringify(["b1", ["target", "t:1"], ["token", "v1.1.tok"]]) },
    { name: "bots/:id/try-again", kind: "try_again_now", path: "/api/email/bots/b1/try-again", section: "removing", requestId: "email-owner-try_again-b1", title: "Bot email: try again", subtitle: JSON.stringify(["b1", ["target", "t:1"], ["token", "v1.1.tok"]]) },
    { name: "parked/:id/keep", kind: "keep", path: "/api/email/parked/b1/keep", section: "parked", requestId: "email-owner-parked_keep-b1", title: "Bot email: parked keep", subtitle: JSON.stringify(["b1", ["target", "t:1"], ["token", "v1.1.tok"]]) },
    { name: "parked/:id/remove", kind: "remove", path: "/api/email/parked/b1/remove", section: "parked", requestId: "email-owner-parked_remove-b1", title: "Bot email: parked remove", subtitle: JSON.stringify(["b1", ["target", "t:1"], ["token", "v1.1.tok"]]) },
    { name: "other-setups/:id/remove", kind: "remove", path: "/api/email/other-setups/in1/remove", section: "other_setup", requestId: "email-owner-other_setup_remove-in1", title: "Bot email: other setup remove", subtitle: JSON.stringify(["in1", ["target", "t:1"], ["token", "v1.1.tok"]]) },
    { name: "restore/confirm-inventory", kind: "confirm_inventory", path: "/api/email/restore/confirm-inventory", section: "restore_check", requestId: "email-owner-confirm_inventory-restore", title: "Bot email: confirm inventory", subtitle: JSON.stringify(["restore", ["target", "t:1"], ["token", "v1.1.tok"]]) },
  ];
  for (const route of WRAPPER_ROUTES) {
    it(`${route.name}: a challenge goes through the freshProof wrapper and the same request resumes`, async () => {
      const { call, posts } = challengingCall();
      const answer = await createHttpEmailKeepRemoveClient(call).act(row(route.section, route.kind, route.path), route.kind);
      expect(answer).toEqual({ ok: true, view: { rows: [] }, body: { rows: [] } });
      expect(wrapperProofs).toHaveLength(1);
      expect(wrapperProofs[0]).toMatchObject({ threadId: "thr-1", requestId: route.requestId, decision: "allow" });
      expect(wrapperProofs[0]!.card).toMatchObject({ title: route.title, subtitle: route.subtitle });
      expect(posts.map((p) => p.path)).toEqual([route.path, route.path]);
      expect(posts[0]!.body).toEqual({ token: "v1.1.tok", target: "t:1" });
      expect(posts[1]!.body).toEqual({ token: "v1.1.tok", target: "t:1", ...WRAPPER_FRESH });
    });
  }
  it("a tokenless bot-row Keep is proved too, over its target alone", async () => {
    const { call, posts } = challengingCall();
    const keep = row("bot", "keep", "/api/email/bots/b1/keep", { actions: [{ kind: "keep", tokenId: null, enabled: true, path: "/api/email/bots/b1/keep" }] });
    expect(await createHttpEmailKeepRemoveClient(call).act(keep, "keep")).toEqual({ ok: true, view: { rows: [] }, body: { rows: [] } });
    expect(wrapperProofs).toHaveLength(1);
    expect(wrapperProofs[0]!.card!.subtitle).toBe(JSON.stringify(["b1", ["target", "t:1"]]));
    expect(posts[0]!.body).toEqual({ target: "t:1" });
    expect(posts[1]!.body).toEqual({ target: "t:1", ...WRAPPER_FRESH });
  });
  it("the REAL respondWithFreshAuth (stand-in off, only the device prompt stubbed): challenge, device signature, resumed request, success", async () => {
    useStandIn = false;
    const approve = vi.fn(async (_args: unknown) => ({ signature: "sig" }));
    device(approve);
    const card = { tool: "bot_email", title: "Bot email: parked keep", subtitle: subtitle("b1", ["target", "t:1"], ["token", "v1.1.tok"]) };
    const { call, posts } = server({ threadId: "thr-1", requestId: "email-owner-parked_keep-b1", card });
    const answer = await createHttpEmailKeepRemoveClient(call).act(row("parked", "keep", "/api/email/parked/b1/keep"), "keep");
    expect(answer).toEqual({ ok: true, view: { rows: [] }, body: { rows: [] } });
    expect(wrapperProofs).toHaveLength(0);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0]).toMatchObject({ threadId: "thr-1", requestId: "email-owner-parked_keep-b1", nonce: NONCE, decision: "allow" });
    expect(posts.map((p) => p.path)).toEqual(["/api/email/parked/b1/keep", "/api/email/parked/b1/keep"]);
    expect(posts[0]!.body).toEqual({ token: "v1.1.tok", target: "t:1" });
    expect(posts[1]!.body).toEqual({ token: "v1.1.tok", target: "t:1", ...FRESH });
  });
  // MAIN RULING 2026-11-13 R34: client refuses locally without threadId (contract r5: never sent unsigned); was 403 fresh_auth
  it("a row with no threadId is refused locally as no_thread: zero POSTs, no wrapper, no proof", async () => {
    const { call, posts } = challengingCall();
    const answer = await createHttpEmailKeepRemoveClient(call).act(row("parked", "remove", "/api/email/parked/b1/remove", { threadId: undefined }), "remove");
    expect(answer).toMatchObject({ ok: false, status: null, code: "no_thread" });
    expect(wrapperProofs).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });
});
