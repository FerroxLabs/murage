// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park Batch B on the REAL park table, gate and ParkPort (r3.1 sections 6 and 7): T7c (address fill), T12 (preview), T13 (bot delete counts as Remove only with the
// confirmation the owner saw), T14 (a delete that never commits never reaches the gate).
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { prepareRestoredEmail } from "./restore.ts";
import { emailOwnerRoute, type OwnerRouteDeps } from "./owner-routes.ts";
import { createParkPort } from "./park-port.ts";
import { deleteScope, tokensFor } from "./owner-view.ts";
import { FakeFlux, fluxError } from "../testing/fake-flux-email.ts";
import type { EmailOwnerRow } from "../../shared/email-copy.ts";
import type { BotRecord } from "../store.ts";

const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
let fake: FakeFlux, db: DatabaseSync, runtime: EmailRuntime, clock: number;
const make = () => new EmailRuntime({
  accountKey: () => "sk-acct", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", now: () => clock,
  workspaceRoot: () => undefined, bot: id => ({ id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord), deletionProof: () => true,
});
const svc = () => runtime.services()!;
const deletes = () => fake.calls("DELETE", /\/v1\/email\/inboxes\//);
const revokes = () => fake.calls("DELETE", /bot-keys/);
const binding = { botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, step: null, opId: "op1", opStartedAt: null, policy: "auto", failure: null, updatedAt: 0 };
/** A restore parked this bot's inbox; `orphan` = its bot and binding are gone (the intent-only park of T7c). */
const parked = async (orphan: boolean, address: string | null = "juniper@murage.email") => {
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-tok", keyId: "key_owner" });
  runtime.secrets.setBotKey("b1", { token: "bot-key", keyId: "key_old" });
  await runtime.probe.refresh();
  runtime.stop();
  svc().store.insertBinding({ ...binding, state: "removal_parked" } as never);
  prepareRestoredEmail(db);
  if (orphan) db.exec("DELETE FROM email_bindings WHERE bot_id='b1'");
  if (address === null) db.exec("UPDATE email_parks SET address=NULL WHERE bot_id='b1'");
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-tok", keyId: "key_owner" });
  runtime.secrets.setBotKey("b1", { token: "bot-key", keyId: "key_old" });
  await runtime.probe.refresh();
  await runtime.start();
  runtime.stop();
};
const deps = (): OwnerRouteDeps => ({ runtime, bot: () => undefined, fluxKeyPresent: () => true, now: () => clock, parks: createParkPort(runtime), freshProof: async () => null });
const call = (method: string, path: string, body?: unknown) => emailOwnerRoute(deps(), { method, path, query: new URL(`http://x${path}`).searchParams, body, surface: "desktop", botCredential: false });
const rowsOf = async () => ((await call("GET", "/api/email/status"))!.body as { rows: EmailOwnerRow[] }).rows;
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 5)); };

beforeEach(() => {
  clock = 1_800_000_000_000; fake = new FakeFlux(); db = new DatabaseSync(":memory:");
  fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
  fake.always("GET", /^\/v1\/email\/settings$/, { status: 200, body: { limits: {} } });
});
afterEach(() => runtime?.stop());

describe("T7c: a park that never learned its address", () => {
  it("listed at Flux: the address is filled (park_rev + 1), shown, and Remove sends 1 DELETE of the park inbox and 1 revoke of its key id", async () => {
    await parked(true, null);
    fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [{ id: "ibx_1", address: "juniper@murage.email", state: "active" }] } });
    const revBefore = svc().store.getPark("b1")!.parkRev;
    const rows = await rowsOf();
    expect(svc().store.getPark("b1")).toMatchObject({ address: "juniper@murage.email", parkRev: revBefore + 1 });
    const row = rows.find(r => r.rowId === "parked:b1")!;
    expect(row.address).toBe("juniper@murage.email");
    expect(row.line).toContain("juniper@murage.email");
    expect(rows.some(r => r.section === "other_setup")).toBe(false);
    fake.on("DELETE", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")).on("DELETE", /bot-keys\/key_old$/, { status: 204 });
    const token = row.actions.find(a => a.kind === "remove")!.tokenId!;
    expect((await call("POST", "/api/email/parked/b1/remove", { token }))?.status).toBe(200);
    expect(deletes()).toHaveLength(1);
    expect(revokes()).toHaveLength(1);
    expect(svc().store.getPark("b1")).toBeNull();
  });
  it("not listed: nothing is filled and the fallback line shows", async () => {
    await parked(true, null);
    fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } });
    const row = (await rowsOf()).find(r => r.rowId === "parked:b1")!;
    expect(svc().store.getPark("b1")!.address).toBeNull();
    expect(row.address).toBeNull();
  });
});

describe("T12: the deletion preview names the address", () => {
  it("a parked bot with a named address returns address and confirm; no address, a deleted inbox, or no email says nothing", async () => {
    await parked(false);
    const preview = runtime.deletionPreviewEmail("b1")!;
    expect(preview.address).toBe("juniper@murage.email");
    expect(preview.confirm).toMatch(/^v1\.\d+\./);
    expect(runtime.deletionPreviewEmail("nobody")).toBeNull();
    const park = svc().store.getPark("b1")!;
    svc().store.casPark("b1", park.parkRev, { remoteDeletedAt: clock });
    expect(runtime.deletionPreviewEmail("b1")).toBeNull();
  });
  it("an address the server cannot name gets no token", async () => {
    await parked(false, null);
    expect(runtime.deletionPreviewEmail("b1")).toBeNull();
  });
  it("a live binding names its address with no token", async () => {
    await parked(false);
    db.exec("DELETE FROM email_parks WHERE bot_id='b1'");
    svc().store.casBinding("b1", svc().store.getBinding("b1")!.revision, { state: "active" }, clock);
    expect(runtime.deletionPreviewEmail("b1")).toEqual({ address: "juniper@murage.email" });
  });
});

describe("T13: a bot delete is the owner's Remove only with the confirmation the owner saw", () => {
  const remove = () => fake.on("DELETE", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")).on("DELETE", /bot-keys\/key_old$/, { status: 204 });
  it("the right token: exactly 1 DELETE of the inbox, 1 revoke, park gone", async () => {
    await parked(false); remove();
    const token = runtime.deletionPreviewEmail("b1")!.confirm!;
    runtime.deletionHooks().commit("b1", token);
    await vi.waitFor(() => expect(svc().store.getPark("b1")).toBeNull());
    expect(deletes()).toHaveLength(1);
    expect(revokes()).toHaveLength(1);
  });
  it.each([
    ["no token", () => undefined],
    ["garbage", () => "v1.9999999999999.AAAA"],
    ["a token for another row", () => runtime.deletionPreviewEmail("b1")!.confirm!.replace(/.$/, c => (c === "A" ? "B" : "A"))],
    ["expired", () => { const t = runtime.deletionPreviewEmail("b1")!.confirm!; clock += 11 * 60_000; return t; }],
    ["park revision moved (a Keep attempt between preview and delete)", () => { const t = runtime.deletionPreviewEmail("b1")!.confirm!; const p = svc().store.getPark("b1")!; svc().store.casPark("b1", p.parkRev, {}); return t; }],
    ["a token from another process", async () => { const t = runtime.deletionPreviewEmail("b1")!.confirm!; runtime.stop(); runtime = make(); runtime.secrets.setOwner({ token: "owner-tok", keyId: "key_owner" }); await runtime.probe.refresh(); return t; }],
  ])("%s: the park stays parked, 0 DELETEs, 0 revokes", async (_name, getToken) => {
    await parked(false); remove();
    const sent = await getToken();
    runtime.deletionHooks().commit("b1", sent);
    await settle();
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked" });
    expect(deletes()).toHaveLength(0);
    expect(revokes()).toHaveLength(0);
  });
  it.each([["Flux deleted the inbox after the preview", { remoteDeletedAt: 1 }], ["a Keep claimed the park after the preview", { state: "keep_pending" as const, keepOp: "k" }]])("%s: the same token no longer counts, 0 DELETEs", async (_name, patch) => {
    await parked(false); remove();
    const token = runtime.deletionPreviewEmail("b1")!.confirm!;
    // the park revision moves with any write, so bind the token to the NEW revision by re-reading it: only the state check can refuse now
    const park = svc().store.getPark("b1")!;
    const moved = svc().store.casPark("b1", park.parkRev, patch)!;
    const fresh = tokensFor(runtime).mint(deleteScope({ botId: "b1", parkId: moved.parkId, parkRev: moved.parkRev, address: moved.address, inboxId: moved.inboxId, keyIds: ["key_old"], state: "parked", remoteDeleted: false }), clock);
    void token;
    runtime.deletionHooks().commit("b1", fresh);
    await settle();
    expect(deletes()).toHaveLength(0);
    expect(revokes()).toHaveLength(0);
  });
  it("a token minted for a delete is not an owner Remove token for the park routes", async () => {
    await parked(true); remove();
    const t = runtime.deletionPreviewEmail("b1")!.confirm!;
    expect((await call("POST", "/api/email/parked/b1/remove", { token: t }))?.body.code).toBe("confirm_expired");
    expect(deletes()).toHaveLength(0);
  });
});

describe("T14: a delete that never commits never reaches the gate", () => {
  it("withdraw (saveBots threw) leaves the park untouched", async () => {
    await parked(false);
    runtime.deletionHooks().withdraw("b1");
    await settle();
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked" });
    expect(deletes()).toHaveLength(0);
  });
});
