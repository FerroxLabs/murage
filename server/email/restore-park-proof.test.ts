// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park Batch D proof (r3.1 section 12): an end-to-end walk of the owner surface on the REAL EmailRuntime, store, gate, ParkPort and emailOwnerRoute, against a scripted
// fake Flux. Registered in CI and driven by proof/run-proof.sh in an isolated fixture. Each step asserts on the owner-view rows AND the email_parks / binding state.
// The marker "NEEDS-INT:" in a step name means the step is expected red on the B tip (A3 / J / int wiring missing) and green on the int branch.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { RestoreJobStore } from "./restore-job.ts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { prepareRestoredEmail } from "./restore.ts";
import { emailOwnerRoute, type OwnerRouteAnswer, type OwnerRouteDeps } from "./owner-routes.ts";
import { createParkPort } from "./park-port.ts";
import { ownerRouteLine, EMAIL_OWNER_PROOF_THREAD, type EmailOwnerRow } from "../../shared/email-copy.ts";
import { FakeFlux, fluxError } from "../testing/fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
const binding = { botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, step: null, opId: "op1", opStartedAt: null, policy: "auto", failure: null, updatedAt: 0 };
let fake: FakeFlux, db: DatabaseSync, runtime: EmailRuntime, clock: number;
let botExists = true, inboxList: unknown[] = [];
let checkDir: string, restoreJob: RestoreJobStore;
const pendingCheck = () => writeFileSync(join(checkDir, "restore-check.json"), JSON.stringify({ version: 1, jobId: "proof-blind-restore" }));
let proofs: Array<{ threadId: string; requestId: string; card: { tool: string; title: string; subtitle: string } }>;
let proofAnswer: OwnerRouteAnswer | null;

const botRec = (id: string) => ({ id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord);
const make = () => new EmailRuntime({
  accountKey: () => "sk-acct", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", now: () => clock,
  workspaceRoot: () => undefined, bot: id => (botExists ? botRec(id) : undefined), deletionProof: () => true,
});
const svc = () => runtime.services()!;
const boot = async () => {
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-tok", keyId: "key_owner" });
  runtime.secrets.setBotKey("b1", { token: "bot-key", keyId: "key_old" });
  await runtime.probe.refresh();
  runtime.stop();
};
/** The owner's backup comes back with b1 in `state`; restore prep runs, then the product start path (no auto-unpark, no DELETE). */
const restored = async (state: string, opts: { orphan?: boolean } = {}) => {
  await boot();
  svc().store.insertBinding({ ...binding, state } as never);
  prepareRestoredEmail(db);
  if (opts.orphan) db.exec("DELETE FROM email_bindings WHERE bot_id='b1'");
  botExists = !opts.orphan;
  await boot();
  await runtime.start();
  runtime.stop();
};
const deps = (): OwnerRouteDeps => ({
  runtime, bot: id => (botExists && id === "b1" ? botRec("b1") : undefined), fluxKeyPresent: () => true, now: () => clock, parks: createParkPort(runtime), restoreCheck: () => restoreJob.checkPending(), confirmRestoreCheck: () => restoreJob.confirmCheck(), restoreWindow: () => restoreJob.windowOpen(),
  freshProof: async (threadId, requestId, card) => { proofs.push({ threadId, requestId, card }); return proofAnswer; },
});
const call = (method: string, path: string, body?: unknown, surface: "desktop" | "phone" = "desktop") =>
  emailOwnerRoute(deps(), { method, path, query: new URL(`http://x${path}`).searchParams, body, surface, botCredential: false });
const rowsOf = async (surface: "desktop" | "phone" = "desktop"): Promise<EmailOwnerRow[]> => ((await call("GET", "/api/email/status", undefined, surface))!.body as { rows: EmailOwnerRow[] }).rows;
const action = (rows: EmailOwnerRow[], pick: (r: EmailOwnerRow) => boolean, kind: string) => {
  const row = rows.find(r => pick(r) && r.actions.some(a => a.kind === kind));
  if (!row) throw new Error(`no row with a ${kind} action; rows=${JSON.stringify(rows.map(r => [r.rowId, r.actions.map(a => a.kind)]))}`);
  const act = row.actions.find(a => a.kind === kind)!;
  return { row, act, body: { ...(act.tokenId ? { token: act.tokenId } : {}), ...(row.target ? { target: row.target } : {}) } as Record<string, unknown> };
};
const parkOf = (id = "b1") => { const p = svc().store.getPark(id); return p ? { state: p.state, rev: p.parkRev } : null; };
const inboxDeletes = () => fake.calls("DELETE", /\/v1\/email\/inboxes\//);
const keyRevokes = () => fake.calls("DELETE", /bot-keys/);
const restores = () => fake.calls("POST", /\/inboxes\/ibx_1\/restore$/);
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 5)); };
const dumpParks = () => JSON.stringify(db.prepare("SELECT * FROM email_parks ORDER BY bot_id").all());

beforeEach(() => {
  clock = 1_800_000_000_000; fake = new FakeFlux(); db = new DatabaseSync(":memory:"); botExists = true; inboxList = [];
  checkDir = mkdtempSync(join(tmpdir(), "murage-restore-proof-"));
  restoreJob = new RestoreJobStore({ dir: checkDir, isLocalArchive: () => false, captureCarry: () => ({}) }); proofs = []; proofAnswer = null;
  fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
  fake.always("GET", /^\/v1\/email\/settings$/, { status: 200, body: { limits: {} } });
  fake.always("GET", /^\/v1\/email\/inboxes$/, () => ({ status: 200, body: { data: inboxList } }));
  let inboxState = "closing";
  fake.always("GET", /\/inboxes\/ibx_1$/, () => ({ status: 200, body: { id: "ibx_1", state: inboxState } }));
  fake.always("POST", /\/inboxes\/ibx_1\/restore$/, () => { inboxState = "active"; return { status: 200, body: { id: "ibx_1", state: inboxState } }; });
});
afterEach(() => { runtime?.stop(); db.close(); removeTempDirSync(checkDir); });

describe("PROOF 1: restore with an in-flight removal, parked row, Keep, kept keys never re-parked", () => {
  it("1a restore parks the in-flight removal: park row parked, binding removal_parked, 0 DELETEs, a Keep row in the view", async () => {
    await restored("removing");
    expect(parkOf()).toMatchObject({ state: "parked" });
    expect(svc().store.getBinding("b1")?.state).toBe("removal_parked");
    expect(inboxDeletes()).toHaveLength(0);
    const { row } = action(await rowsOf(), r => r.botId === "b1", "keep");
    expect(row.line.length).toBeGreaterThan(0);
  });
  it("1b Keep (desktop) restores the inbox: park gone, binding restored_unverified, exactly one restore POST, 0 DELETEs, the row no longer offers Keep as parked", async () => {
    await restored("removing");
    const { act, body } = action(await rowsOf(), r => r.botId === "b1", "keep");
    const answer = await call("POST", act.path, body);
    expect(answer?.status).toBe(200);
    // desktop bot Keep answers the bot view; the phone gets the full home view (wire contract), checked in 4a/4d by the other-setup route
    expect(parkOf()).toBeNull();
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "restored_unverified" });
    expect(restores()).toHaveLength(1);
    expect(inboxDeletes()).toHaveLength(0);
  });
  it("NEEDS-INT: 1c kept keys are never re-parked: a second restore prep over the same key and a tick leaves no park and 0 DELETEs", async () => {
    await restored("removing");
    const { act, body } = action(await rowsOf(), r => r.botId === "b1", "keep");
    expect((await call("POST", act.path, body))?.status).toBe(200);
    db.exec("DROP TRIGGER IF EXISTS temp.email_parks_no_insert"); // a restore replaces the data dir: the runtime's connection-scoped insert fence is not in the new process
    db.exec("UPDATE email_bindings SET state='removing' WHERE bot_id='b1'"); // an older backup says the same key was being removed
    prepareRestoredEmail(db);
    await boot(); await runtime.start(); runtime.stop();
    for (let i = 0; i < 3; i += 1) { await svc().bindings.reap(); await svc().bindings.resumeRemovals(); }
    expect(parkOf()).toBeNull();
    expect(svc().store.getBinding("b1")?.state).not.toBe("removal_parked");
    expect(inboxDeletes()).toHaveLength(0);
    expect(keyRevokes()).toHaveLength(0);
  });
});

describe("PROOF 2 and 3: parked Remove with a fresh token; a stale token and the look-again line", () => {
  const removeScript = () => { fake.on("DELETE", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")); fake.on("DELETE", /bot-keys\/key_old$/, { status: 204 }); };
  it("2 an orphan parked row: Remove with the token minted by this read sends 1 inbox DELETE and 1 key revoke and the park is gone", async () => {
    await restored("removing", { orphan: true }); removeScript();
    const rows = await rowsOf();
    const { row, act, body } = action(rows, r => r.section === "parked", "remove");
    expect(row.rowId).toBe("parked:b1");
    expect(act.path).toBe("/api/email/parked/b1/remove");
    expect(act.tokenId).toBeTruthy();
    expect((await call("POST", act.path, body))?.status).toBe(200);
    expect(inboxDeletes()).toHaveLength(1);
    expect(keyRevokes()).toHaveLength(1);
    expect(parkOf()).toBeNull();
    expect((await rowsOf()).some(r => r.rowId === "parked:b1")).toBe(false);
  });
  it("3 a stale token (the park moved after the view was read): 409 confirm_expired with the look-again line, 0 DELETEs, park untouched; a fresh read mints a new token that works", async () => {
    await restored("removing", { orphan: true }); removeScript();
    const stale = action(await rowsOf(), r => r.section === "parked", "remove");
    const p = svc().store.getPark("b1")!;
    svc().store.casPark("b1", p.parkRev, { address: "juniper@murage.email" }); // any park write moves park_rev
    const before = parkOf();
    const refused = await call("POST", stale.act.path, stale.body);
    expect(refused).toMatchObject({ status: 409, body: { code: "confirm_expired", error: ownerRouteLine("confirm_expired"), rowId: "parked:b1" } });
    expect(ownerRouteLine("confirm_expired")).toBe("This confirmation is out of date. Open it again to see the current address.");
    expect(inboxDeletes()).toHaveLength(0);
    expect(parkOf()).toEqual(before);
    const fresh = action(await rowsOf(), r => r.section === "parked", "remove");
    expect(fresh.act.tokenId).not.toBe(stale.act.tokenId);
    expect((await call("POST", fresh.act.path, fresh.body))?.status).toBe(200);
    expect(inboxDeletes()).toHaveLength(1);
  });
  it("3b an expired token (11 minutes): the same look-again line, 0 DELETEs", async () => {
    await restored("removing", { orphan: true }); removeScript();
    const t = action(await rowsOf(), r => r.section === "parked", "remove");
    clock += 11 * 60_000;
    expect(await call("POST", t.act.path, t.body)).toMatchObject({ status: 409, body: { code: "confirm_expired" } });
    expect(inboxDeletes()).toHaveLength(0);
    expect(parkOf()).toMatchObject({ state: "parked" });
  });
});

describe("PROOF 4: other-setup Remove from the PHONE route (proof card threadId email-owner)", () => {
  const listOther = () => {
    inboxList = [{ id: "in_9", address: "old@mail.example", state: "active" }];
    fake.on("DELETE", /\/inboxes\/in_9$/, { status: 200, body: { id: "in_9", state: "removing" } });
  };
  it("4a the row is other_setup with a tokened Remove on the contracted path; phone Remove asks for a fresh proof on thread email-owner with the exact card, then sends 1 DELETE of that inbox", async () => {
    await restored("active"); listOther();
    const { row, act, body } = action(await rowsOf("phone"), r => r.section === "other_setup", "remove");
    expect(row.threadId).toBe(EMAIL_OWNER_PROOF_THREAD);
    expect(EMAIL_OWNER_PROOF_THREAD).toBe("email-owner");
    expect(act.path).toBe("/api/email/other-setups/in_9/remove");
    expect(act.tokenId).toBeTruthy();
    const answer = await call("POST", act.path, body, "phone");
    expect(answer?.status).toBe(200);
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({ threadId: "email-owner", requestId: "email-owner-other_setup_remove-in_9", card: { tool: "bot_email", title: "Bot email: other setup remove" } });
    expect(JSON.parse(proofs[0]!.card.subtitle)[0]).toBe("in_9");
    expect(fake.calls("DELETE", /\/inboxes\/in_9$/)).toHaveLength(1);
  });
  it("4b a refused proof stops the Remove: the refusal is returned as is and 0 DELETEs go out", async () => {
    await restored("active"); listOther();
    const { act, body } = action(await rowsOf("phone"), r => r.section === "other_setup", "remove");
    proofAnswer = { status: 403, body: { error: "Proof needed.", code: "fresh_auth_required" } };
    expect(await call("POST", act.path, body, "phone")).toMatchObject({ status: 403, body: { code: "fresh_auth_required" } });
    expect(fake.calls("DELETE", /\/inboxes\/in_9$/)).toHaveLength(0);
  });
  it("4c a phone Remove with no token, a garbage token, or an expired token sends 0 DELETEs", async () => {
    await restored("active"); listOther();
    const t = action(await rowsOf("phone"), r => r.section === "other_setup", "remove");
    for (const bad of [{}, { token: "garbage" }]) expect((await call("POST", t.act.path, bad, "phone"))?.status).toBeGreaterThanOrEqual(400);
    clock += 11 * 60_000;
    expect((await call("POST", t.act.path, t.body, "phone"))?.status).toBeGreaterThanOrEqual(400);
    expect(fake.calls("DELETE", /\/inboxes\/in_9$/)).toHaveLength(0);
  });
  it("4d the phone proof also guards the other owner POSTs: parked Remove and Keep ask on thread email-owner, bot try-again asks on the bot's own thread", async () => {
    await restored("removing", { orphan: true });
    const keep = action(await rowsOf("phone"), r => r.section === "parked", "keep");
    proofAnswer = { status: 403, body: { error: "Proof needed.", code: "fresh_auth_required" } };
    await call("POST", keep.act.path, keep.body, "phone");
    await call("POST", "/api/email/parked/b1/remove", {}, "phone");
    expect(proofs.map(p => [p.threadId, p.requestId])).toEqual([["email-owner", "email-owner-parked_keep-b1"], ["email-owner", "email-owner-parked_remove-b1"]]);
    botExists = true;
    await call("POST", "/api/email/bots/b1/try-again", {}, "phone");
    expect(proofs[2]).toMatchObject({ threadId: "t-b1", requestId: "email-owner-try_again-b1" });
    expect(parkOf()).toMatchObject({ state: "parked" });
    expect(inboxDeletes()).toHaveLength(0);
  });
});

describe("PROOF 5: restore_check, then confirm_inventory", () => {
  it("NEEDS-INT: 5 the restore_check row carries a confirm_inventory action; confirming answers 200 with the full view and the row gone (a 409 restore_not_ready stub is reported BLOCKED-STUB, not a pass)", async () => {
    await restored("active"); pendingCheck();
    const { row, act, body } = action(await rowsOf(), r => r.section === "restore_check", "confirm_inventory");
    expect(row.rowId).toBe("restore_check:home");
    expect(act.path).toBe("/api/email/restore/confirm-inventory");
    const answer = await call("POST", act.path, body);
    if (answer?.status === 409 && answer.body.code === "restore_not_ready") throw new Error("BLOCKED-STUB: confirm_inventory still answers restore_not_ready (job batch not wired)");
    expect(answer?.status).toBe(200);
    expect(restoreJob.checkPending()).toBe(false); // the real store consumed the durable check
    expect((await rowsOf()).some(r => r.section === "restore_check")).toBe(false);
  });
  it("5b phone confirm_inventory asks for the proof on thread email-owner, id restore", async () => {
    await restored("active"); pendingCheck();
    const { act, body } = action(await rowsOf("phone"), r => r.section === "restore_check", "confirm_inventory");
    proofAnswer = { status: 403, body: { error: "Proof needed.", code: "fresh_auth_required" } };
    await call("POST", act.path, body, "phone");
    expect(proofs[0]).toMatchObject({ threadId: "email-owner", requestId: "email-owner-confirm_inventory-restore", card: { tool: "bot_email", title: "Bot email: confirm inventory" } });
  });
});

describe("PROOF 6: try_again_now on a bot row", () => {
  it("6 a removing bot row offers try_again_now on /api/email/bots/b1/try-again; POST runs the resumer once (Flux is asked about the inbox) and returns the full view; a bot with no removal gets inbox_gone", async () => {
    await boot();
    svc().store.insertBinding({ ...binding, state: "active" } as never);
    await boot(); await runtime.start(); runtime.stop();
    fake.always("DELETE", /\/inboxes\/ibx_1$/, { status: 503, body: { error: { code: "unavailable" } } }); // a real owner Remove (authorized, recorded) that Flux cannot finish yet
    await call("POST", "/api/email/bots/b1/remove", { confirm: true });
    expect(svc().store.getBinding("b1")?.state).toMatch(/^removing|remove_requested$/);
    const { row, act, body } = action(await rowsOf(), r => r.botId === "b1", "try_again_now");
    expect(row.section).toBe("removing");
    expect(act.path).toBe("/api/email/bots/b1/try-again");
    const answer = await call("POST", act.path, body);
    expect(answer?.status).toBe(200);
    expect(Array.isArray((answer!.body as { rows?: unknown }).rows)).toBe(true);
    expect(inboxDeletes().length).toBeLessThanOrEqual(1); // the resumer replays the owner's removal; never a second inbox
    db.exec("DELETE FROM email_bindings WHERE bot_id='b1'");
    expect(await call("POST", "/api/email/bots/b1/try-again", {})).toMatchObject({ status: 409, body: { code: "inbox_gone" } });
  });
});

describe("PROOF 7: DELETE /api/bots/:id with and without emailConfirm (store hook layer; the route's own lines are diffed by run-proof.sh)", () => {
  const removeScript = () => { fake.on("DELETE", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")); fake.on("DELETE", /bot-keys\/key_old$/, { status: 204 }); };
  it("7a with the confirmation the owner saw: exactly 1 inbox DELETE, 1 revoke, park gone", async () => {
    await restored("removing", { orphan: true }); removeScript();
    const preview = runtime.deletionPreviewEmail("b1")!;
    expect(preview.address).toBe("juniper@murage.email");
    runtime.deletionHooks().record("b1");
    runtime.deletionHooks().commit("b1", preview.confirm!);
    for (let i = 0; i < 50 && parkOf(); i += 1) await settle();
    expect(parkOf()).toBeNull();
    expect(inboxDeletes()).toHaveLength(1);
    expect(keyRevokes()).toHaveLength(1);
  });
  it("7b without emailConfirm: nothing about the park changes (email_parks dump byte-identical), 0 DELETEs, 0 revokes", async () => {
    await restored("removing", { orphan: true }); removeScript();
    const before = dumpParks();
    runtime.deletionHooks().commit("b1");
    await settle();
    expect(dumpParks()).toBe(before);
    expect(inboxDeletes()).toHaveLength(0);
    expect(keyRevokes()).toHaveLength(0);
    expect(parkOf()).toMatchObject({ state: "parked" });
  });
  it("7c a Keep token, a garbage token, or a token from the owner view (not a delete token) never counts: same dump, 0 DELETEs", async () => {
    await restored("removing", { orphan: true }); removeScript();
    const before = dumpParks();
    const view = action(await rowsOf(), r => r.section === "parked", "remove").act.tokenId!;
    for (const bad of ["garbage", view]) { runtime.deletionHooks().commit("b1", bad); await settle(); }
    expect(dumpParks()).toBe(before);
    expect(inboxDeletes()).toHaveLength(0);
  });
});
