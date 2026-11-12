// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park Batch B: owner view rows (OWNER-VIEW-WIRE-CONTRACT rounds 1 to 5), scoped tokens, per-route phone proof, orphan routes (T7a, T7b, T7c).
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { emailOwnerRoute, type OwnerRouteDeps, type OwnerRouteRequest } from "./owner-routes.ts";
import { PATH_PATTERNS, type ParkPort, type ParkRecord } from "./owner-view.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";
import { EMAIL_OWNER_COPY, EMAIL_OWNER_PROOF_THREAD, emailOwnerActionCard, emailOwnerActionRequestId, type EmailOwnerRow } from "../../shared/email-copy.ts";
import type { BotRecord } from "../store.ts";

const BOT = { id: "b1", name: "Juniper", threadId: "t-b1" };
const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: { max_inboxes: 5, inboxes_used: 0 } };
let fake: FakeFlux, db: DatabaseSync, runtime: EmailRuntime, clock: number;
let proofs: Array<{ threadId: string; requestId: string; card: { tool: string; title: string; subtitle: string } }>;
let proofAnswer: { status: number; body: Record<string, unknown> } | null;
let parks: ParkRecord[], portCalls: string[], bots: Record<string, typeof BOT>;

const port: ParkPort = {
  list: () => parks,
  keep: async (botId, expect) => { portCalls.push(`keep:${botId}:${expect.parkRev}`); return { ok: true }; },
  remove: async (botId, by, expect) => { portCalls.push(`remove:${botId}:${by}:${expect.parkRev}`); return { ok: true }; },
};
const deps = (): OwnerRouteDeps => ({
  runtime, bot: id => bots[id], fluxKeyPresent: () => true, now: () => clock, parks: port, restoreCheck: () => true, confirmRestoreCheck: () => true,
  freshProof: async (threadId, requestId, card) => { proofs.push({ threadId, requestId, card }); return proofAnswer; },
});
const call = (method: string, path: string, body?: unknown, patch: Partial<OwnerRouteRequest> = {}) =>
  emailOwnerRoute(deps(), { method, path, query: new URL(`http://x${path}`).searchParams, body, surface: "desktop", botCredential: false, ...patch });
const rowsOf = async (patch: Partial<OwnerRouteRequest> = {}): Promise<EmailOwnerRow[]> => ((await call("GET", "/api/email/status", undefined, patch))!.body as { rows: EmailOwnerRow[] }).rows;
const token = (rows: EmailOwnerRow[], rowId: string, kind: string) => rows.find(r => r.rowId === rowId)!.actions.find(a => a.kind === kind)!.tokenId!;
const park = (over: Partial<ParkRecord> = {}): ParkRecord => ({ botId: "gone1", parkId: "p1", parkRev: 3, address: "max@mail.example", inboxId: "in_2", keyIds: ["k2"], state: "parked", remoteDeleted: false, ...over });

beforeEach(async () => {
  clock = 1_800_000_000_000; fake = new FakeFlux(); db = new DatabaseSync(":memory:");
  proofs = []; proofAnswer = null; parks = []; portCalls = []; bots = { b1: BOT };
  runtime = new EmailRuntime({
    accountKey: () => "sk-acct", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", now: () => clock,
    workspaceRoot: () => undefined, bot: id => (id === "b1" ? BOT as unknown as BotRecord : undefined),
    cardHost: { botName: () => BOT.name, threadExists: () => true, card: () => null, appendCard: () => "m1", patchCard: () => undefined, outcome: () => undefined, activity: () => undefined, notify: () => undefined },
  });
  runtime.secrets.setOwner({ token: "owner-tok", keyId: "key_owner" });
  fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
  await runtime.probe.refresh();
  fake.always("GET", /^\/v1\/email\/settings$/, { status: 200, body: { limits: {} } });
  fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [{ id: "in_9", address: "old@mail.example", state: "active" }] } });
});

async function giveAddress(): Promise<void> {
  fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "bot-email-key", key_id: "key_b1" } });
  fake.on("POST", /^\/v1\/email\/inboxes$/, { status: 201, body: { id: "ibx_1", bot_id: "b1", address: "juniper@murage.email", state: "active", send_policy: "auto" } });
  expect((await call("POST", "/api/email/bots/b1/setup", { username: "juniper", displayName: "Juniper" }))?.status).toBe(200);
}

describe("owner view rows (wire contract)", () => {
  it("rows carry the contracted shape: rowId, threadId, fixed-template paths, tokens on every enabled Remove", async () => {
    await giveAddress(); parks = [park()];
    const rows = await rowsOf();
    const byId = Object.fromEntries(rows.map(r => [r.rowId, r]));
    expect(Object.keys(byId).sort()).toEqual(["bot:b1", "other_setup:in_9", "parked:gone1", "restore_check:home"]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["actions", "address", "botId", "botName", "inboxId", "keyIds", "line", "rowId", "section", "target", "threadId"]);
      expect(row.threadId).toBe(row.botId === "b1" ? "t-b1" : EMAIL_OWNER_PROOF_THREAD);
      for (const a of row.actions) { expect(PATH_PATTERNS.some(p => p.test(a.path)), a.path).toBe(true); if (a.kind === "remove") expect(a.tokenId).toBeTruthy(); }
    }
    expect(byId["parked:gone1"]!.actions.map(a => [a.kind, a.path])).toEqual([["keep", "/api/email/parked/gone1/keep"], ["remove", "/api/email/parked/gone1/remove"]]);
    expect(byId["restore_check:home"]!.actions[0]).toMatchObject({ kind: "confirm_inventory", path: "/api/email/restore/confirm-inventory" });
    // the line is the shared constant, and the constant is the approved English
    expect(byId["restore_check:home"]!.line).toBe("Check your email setup after the restore.");
  });
  it("round-trips the contract fixture shape (same keys and types per row, an action shape per fixture)", async () => {
    await giveAddress(); parks = [park()];
    const fixture = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./owner-view-fixtures.json", import.meta.url), "utf8")) as { homeView: { rows: Array<Record<string, unknown>> } };
    const rows = await rowsOf();
    for (const fx of fixture.homeView.rows) {
      const got = rows.find(r => r.section === fx.section)!;
      expect(got, String(fx.section)).toBeTruthy();
      // an orphan's bot is gone, so the server has no name to give it (the fixture invents one); every other key must match in type
      for (const key of Object.keys(fx)) { expect(key in got, key).toBe(true); if (fx.section === "parked" && key === "botName") continue; expect(typeof (got as unknown as Record<string, unknown>)[key]).toBe(typeof fx[key]); }
      for (const [i, a] of (fx.actions as Array<Record<string, unknown>>).entries()) expect(Object.keys(got.actions[i]!).sort()).toEqual(Object.keys(a).sort());
    }
  });
});

describe("T7a orphan Remove", () => {
  it("no token 409 confirm_expired; the view's token removes once; a bot credential gets 403; the phone needs its proof", async () => {
    parks = [park()];
    expect(await call("POST", "/api/email/parked/gone1/remove", {})).toMatchObject({ status: 409, body: { code: "confirm_expired", rowId: "parked:gone1" } });
    expect(portCalls).toEqual([]);
    const tok = token(await rowsOf(), "parked:gone1", "remove");
    expect((await call("POST", "/api/email/parked/gone1/remove", { token: tok }, { botCredential: true }))?.status).toBe(403);
    expect((await call("POST", "/api/email/parked/gone1/remove", { token: tok }))?.status).toBe(200);
    expect(portCalls).toEqual(["remove:gone1:orphan:3"]);
    // the phone: challenge first, then the exact card
    proofAnswer = { status: 401, body: { error: "proof", code: "fresh_auth_required" } };
    expect((await call("POST", "/api/email/parked/gone1/remove", { token: tok }, { surface: "phone" }))?.status).toBe(401);
    expect(portCalls.length).toBe(1);
    proofAnswer = null;
    expect((await call("POST", "/api/email/parked/gone1/remove", { token: tok }, { surface: "phone" }))?.status).toBe(200);
  });
  it("a token for another revision, another action or after expiry is refused", async () => {
    parks = [park()];
    const rows = await rowsOf();
    const keepTok = token(rows, "parked:gone1", "keep"), rmTok = token(rows, "parked:gone1", "remove");
    expect((await call("POST", "/api/email/parked/gone1/remove", { token: keepTok }))?.body.code).toBe("confirm_expired");
    parks = [park({ parkRev: 4 })];
    expect((await call("POST", "/api/email/parked/gone1/remove", { token: rmTok }))?.body.code).toBe("confirm_expired");
    parks = [park()];
    clock += 11 * 60_000;
    expect((await call("POST", "/api/email/parked/gone1/remove", { token: rmTok }))?.body.code).toBe("confirm_expired");
    expect(portCalls).toEqual([]);
  });
  it("while a Keep is pending, Remove answers exactly 409 keep_pending", async () => {
    parks = [park({ state: "keep_pending" })];
    expect(await call("POST", "/api/email/parked/gone1/remove", { token: "x" })).toMatchObject({ status: 409, body: { code: "keep_pending" } });
  });
});

describe("T7b orphan Keep", () => {
  it("the park's keep token runs one Keep with the park revision it showed", async () => {
    parks = [park()];
    const tok = token(await rowsOf(), "parked:gone1", "keep");
    expect((await call("POST", "/api/email/parked/gone1/keep", { token: tok }))?.status).toBe(200);
    expect(portCalls).toEqual(["keep:gone1:3"]);
    expect((await call("POST", "/api/email/parked/gone1/keep", {}))?.body.code).toBe("confirm_expired");
  });
});

describe("T7c address unknown", () => {
  it("an address null park shows the fallback line and Remove is still tokened", async () => {
    parks = [park({ address: null, inboxId: "in_unlisted" })];
    const rows = await rowsOf();
    const row = rows.find(r => r.rowId === "parked:gone1")!;
    expect(row.line).toContain(EMAIL_OWNER_COPY.parkedUnknownAddress);
    expect(row.address).toBeNull();
    expect((await call("POST", "/api/email/parked/gone1/remove", { token: token(rows, "parked:gone1", "remove") }))?.status).toBe(200);
  });
});

describe("other setup Remove (contract round 4: the phone proves too)", () => {
  it("tokened for desktop and phone; phone without a proof gets the challenge; a changed body field is refused", async () => {
    fake.on("DELETE", /^\/v1\/email\/inboxes\/in_9$/, { status: 202, body: { id: "in_9", state: "closing" } });
    const tok = token(await rowsOf(), "other_setup:in_9", "remove");
    proofAnswer = { status: 401, body: { error: "proof", code: "fresh_auth_required" } };
    expect((await call("POST", "/api/email/other-setups/in_9/remove", { token: tok }, { surface: "phone" }))?.status).toBe(401);
    expect(fake.requests.some(r => r.method === "DELETE")).toBe(false);
    proofAnswer = null;
    expect((await call("POST", "/api/email/other-setups/in_9/remove", { token: tok + "x" }, { surface: "phone" }))?.body.code).toBe("confirm_expired");
    expect((await call("POST", "/api/email/other-setups/in_9/remove", { token: tok }, { surface: "phone" }))?.status).toBe(200);
    expect(fake.requests.filter(r => r.method === "DELETE").length).toBe(1);
  });
});

describe("per-route phone proof: thread, card and request id are the shared ones", () => {
  it("each owner action POST signs the exact card against the contracted thread", async () => {
    parks = [park()];
    const rows = await rowsOf();
    const cases: Array<[string, string, Record<string, unknown>, string, string, string]> = [
      ["/api/email/parked/gone1/keep", "gone1", { token: token(rows, "parked:gone1", "keep") }, "parked_keep", "gone1", EMAIL_OWNER_PROOF_THREAD],
      ["/api/email/parked/gone1/remove", "gone1", { token: token(rows, "parked:gone1", "remove") }, "parked_remove", "gone1", EMAIL_OWNER_PROOF_THREAD],
      ["/api/email/other-setups/in_9/remove", "in_9", { token: token(rows, "other_setup:in_9", "remove") }, "other_setup_remove", "in_9", EMAIL_OWNER_PROOF_THREAD],
      ["/api/email/restore/confirm-inventory", "restore", { token: token(rows, "restore_check:home", "confirm_inventory") }, "confirm_inventory", "restore", EMAIL_OWNER_PROOF_THREAD],
      ["/api/email/bots/b1/try-again", "b1", {}, "try_again", "b1", "t-b1"],
    ];
    for (const [path, id, body, action, , thread] of cases) {
      proofs = [];
      await call("POST", path, body, { surface: "phone" });
      expect(proofs.length, path).toBe(1);
      expect(proofs[0]).toEqual({ threadId: thread, requestId: emailOwnerActionRequestId(action as never, id), card: emailOwnerActionCard(action as never, id, body) });
      expect(proofs[0]!.card.title).toBe(`Bot email: ${action.replace(/_/g, " ")}`);
    }
  });
  it("confirm_inventory is in the view and answers 200 with a check pending (r3.4d J2: the restore job is ready)", async () => {
    expect(await call("POST", "/api/email/restore/confirm-inventory", {})).toMatchObject({ status: 200 });
  });
});

describe("bot row Remove: tokened on the phone, desktop confirm still works", () => {
  it("a phone Remove carries the view's token, signs the bot's own thread, and answers the full home view", async () => {
    await giveAddress();
    fake.on("DELETE", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 202, body: { id: "ibx_1", state: "closing" } });
    const rows = await rowsOf();
    expect(rows.find(r => r.rowId === "bot:b1")!.actions.map(a => [a.kind, a.tokenId === null])).toEqual([["remove", false]]);
    const body = { token: token(rows, "bot:b1", "remove"), target: "bot:b1" };
    expect((await call("POST", "/api/email/bots/b1/remove", { ...body, token: "v1.1.bad" }, { surface: "phone" }))?.body).toMatchObject({ code: "confirm_expired", rowId: "bot:b1" });
    proofs = [];
    const answer = await call("POST", "/api/email/bots/b1/remove", body, { surface: "phone" });
    expect(answer?.status).toBe(200);
    expect(Array.isArray((answer!.body as { rows?: unknown }).rows)).toBe(true);
    expect(proofs.at(-1)).toEqual({ threadId: "t-b1", requestId: emailOwnerActionRequestId("remove", "b1"), card: emailOwnerActionCard("remove", "b1", body) });
  });
});
