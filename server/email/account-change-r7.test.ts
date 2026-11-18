import { legacyEmailDecisionFixture } from "./testing/legacy-decision-fixture.ts";
import type { ServiceAuthority } from "../narrow-denials.ts";
import { createMemoryEmailSecrets } from "../testing/email-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EMAIL-ACCOUNT-CHANGE r7 and r8 (designs/EMAIL-ACCOUNT-CHANGE-r7.md, -r8.md): tests 22 to 26b. A send refused locally (the owner is unproven,
// nothing left the process) records no attempt and lands by the fresh row; a held `prepared` row resumes on the tick, expires at 72 h; a
// `dispatching` row never carries a due time and boot moves it to unknown.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { FluxEmailClient } from "./flux-email-client.ts";
import { EmailSecretStore, emailCredentialProvider } from "./email-secrets.ts";
import { EmailStore, type SendRow } from "./email-store.ts";
import { EmailBindingService } from "./binding-service.ts";
import { EmailSendService, FENCE_RETRY_MS, HOLD_LIFETIME_MS, RECONCILE_GAPS_MS } from "./send-service.ts";
import type { EmailDraft } from "./canonical.ts";
import { FakeFlux, fluxError, type FakeReply } from "../testing/fake-flux-email.ts";

const OWNER_B = { token: "tok-owner-B", keyId: "key_owner_B" };
const OWNER_C = { token: "tok-owner-C", keyId: "key_owner_C" };
const T0 = 1_800_000_000_000;
const sentOk = (id = "msg_1"): FakeReply => ({ status: 200, body: { object: "email.send", status: "sent", message_id: id } });
const draft = (): EmailDraft => ({ kind: "send", to: ["jane@acme.test"], cc: [], subject: "Thursday", text: "Hi Jane", attachments: [], replyTo: null });
const okInbox: FakeReply = { status: 200, body: { id: "ibx_1", state: "active" } };
const heldReply: FakeReply = { status: 202, body: { status: "pending_approval", held_id: "h1", approval: { id: "apr_1", held_ids: ["h1"], state: "pending" } } };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

let authority: ServiceAuthority;
let clock: number;
let fake: FakeFlux;
let store: EmailStore;
let secrets: EmailSecretStore;
let client: FluxEmailClient;
let bindings: EmailBindingService;
let send: EmailSendService;

function rig(opts: { proven?: boolean } = {}) {
  clock = T0;
  fake = new FakeFlux();
  store = new EmailStore(new DatabaseSync(":memory:"));
  secrets = createMemoryEmailSecrets();
  secrets.setOwner(OWNER_B);
  secrets.setBotKey("b1", { token: "tok-bot-B", keyId: "key_K_B" });
  wire();
  store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_K_B", fluxAccountId: null, state: "active", step: null, opId: "op-1", opStartedAt: clock, policy: "auto", failure: null, updatedAt: clock });
  if (opts.proven) store.setCursor("inbox-owner:b1", JSON.stringify({ ownerRef: OWNER_B.keyId, inboxId: "ibx_1", at: clock }), clock);
  store.addTrusted("b1", "jane@acme.test", "allow", "owner", clock);
}
function wire() {
  let n = 0;
  client = new FluxEmailClient({
    fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100,
    gate: ref => (ref.kind === "bot" && ref.charge === true && bindings.ownerProven(ref.botId) === false ? { kind: "local_refused", code: "owner_unproven" } as const : null),
  });
  bindings = new EmailBindingService({ store, client, secrets, installId: "inst", now: () => clock, newId: () => `op-new-${++n}`, withdrawUndispatched: botId => { send.withdrawUndispatchedForBot(botId, "account_off"); } });
  send = new EmailSendService({ store, client, authorityFor: () => authority, installId: "inst", now: () => clock, newId: () => `send-${++n}-${clock}`, fence: botId => bindings.holdsSends(botId), ownerRefFor: botId => bindings.ownerRefFor(botId) });
}
const posts = () => fake.calls("POST", /\/messages$/);
const rowOf = (): SendRow => store.sendsOfGeneration("b1", 1)[0]!;
const prove = async () => { fake.on("GET", /\/v1\/email\/inboxes\/ibx_1$/, okInbox); await bindings.proveOwners(true); };
const ticks = async (count: number) => { for (let i = 0; i < count; i++) { clock += FENCE_RETRY_MS; await send.tick(); } };
/** Hold the inbox lock so the work under test is parked between its CAS into dispatching/approving and the client call, run `during`, then release. */
async function parked<T>(start: () => Promise<T>, during: () => void): Promise<T> {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const holding = send.locks.exclusive("ibx_1", () => wait);
  const running = start();
  await sleep(10);
  during();
  release();
  await holding;
  return running;
}
const switchOwner = () => secrets.setOwner(OWNER_C);
const submitDraft = (holdForOwner = false) => send.submit({ botId: "b1", generation: 1, threadId: "t1", draft: draft(), holdForOwner });
/** Switch the owner right after the CAS into `approving` (the race r7 H7 names), before any client call. */
function switchAfterApprovingCas() {
  const original = store.casSend.bind(store);
  store.casSend = (sendId, revision, patch, at) => { const next = original(sendId, revision, patch, at); if (next && patch.state === "approving") switchOwner(); return next; };
}

beforeEach(async () => { authority = await legacyEmailDecisionFixture(); rig({ proven: true }); });
afterEach(() => { /* the in-memory store goes with the rig */ });

describe("22 H6, H7: a locally refused dispatch lands by the fresh row", () => {
  it("22 Stop then refusal: the row settles withdrawn(stopped), zero sends, zero #23, and still none after the proof", async () => {
    await parked(() => submitDraft(), () => { void send.stop("b1", 1); switchOwner(); });
    expect(rowOf()).toMatchObject({ state: "withdrawn", code: "stopped", attempts: [] });
    expect(posts()).toHaveLength(0);
    await prove();
    await ticks(10);
    expect(posts()).toHaveLength(0);
    expect(fake.calls("DELETE", /\/held\//)).toHaveLength(0);
    expect(fake.calls("POST", /\/replies$|\/reply$/)).toHaveLength(0);
  });

  it("22b refusal then Stop: prepared, then withdrawn(stopped); zero sends after the proof", async () => {
    await parked(() => submitDraft(), () => switchOwner());
    expect(rowOf()).toMatchObject({ state: "prepared", attempts: [] });
    await send.stop("b1", 1);
    expect(rowOf()).toMatchObject({ state: "withdrawn", code: "stopped" });
    await prove();
    await ticks(10);
    expect(posts()).toHaveLength(0);
  });

  it("22c owner Send refused: back to awaiting_owner, ownerSent false, receipt null, no attempt, no automatic send after the proof", async () => {
    const held = (await submitDraft(true)) as { row: SendRow };
    expect(held.row.state).toBe("awaiting_owner");
    await parked(() => send.ownerSend(held.row.sendId, held.row.revision), () => switchOwner());
    expect(rowOf()).toMatchObject({ state: "awaiting_owner", ownerSent: false, receipt: null, attempts: [] });
    expect(posts()).toHaveLength(0);
    await prove();
    await ticks(10);
    expect(posts()).toHaveLength(0);
    expect(rowOf().state).toBe("awaiting_owner");
  });

  it("22d owner Retry refused: back to approved_unsent(owner_check), same idemSuffix, attempts unchanged; the next Retry reuses the Idempotency-Key", async () => {
    const created = (await submitDraft(true)) as { row: SendRow };
    fake.on("POST", /\/messages$/, fluxError(503, "capability_unavailable"));
    await send.ownerSend(created.row.sendId, created.row.revision);
    const unsent = rowOf();
    expect(unsent.state).toBe("approved_unsent");
    expect(unsent.attempts).toHaveLength(1);
    await parked(() => send.retry(unsent), () => switchOwner());
    expect(rowOf()).toMatchObject({ state: "approved_unsent", code: "owner_check", idemSuffix: unsent.idemSuffix });
    expect(rowOf().attempts).toHaveLength(1);
    expect(posts()).toHaveLength(1);
    await prove();
    fake.on("POST", /\/messages$/, sentOk());
    await send.retry(rowOf());
    expect(posts()).toHaveLength(2);
    expect(posts()[1]!.headers["idempotency-key"]).toBe(posts()[0]!.headers["idempotency-key"]);
    expect(rowOf().state).toBe("sent");
  });

  it("22e Approve refused after the CAS into approving: back to held, receipt unused, try_later, never unknown; retryHeld back to approved_unsent with the #32 counter unchanged", async () => {
    fake.on("POST", /\/messages$/, heldReply);
    await submitDraft();
    const row = rowOf();
    expect(row).toMatchObject({ state: "held", approvalId: "apr_1" });
    fake.on("GET", /\/v1\/email\/approvals\/apr_1$/, { status: 200, body: { id: "apr_1", state: "pending", held: [{ id: "h1", client_reference: row.sendId, state: "pending", text: "Hi Jane", subject: "Thursday", to: ["jane@acme.test"], cc: [], attachments: [] }] } });
    switchAfterApprovingCas();
    const answer = await send.ownerSend(row.sendId, row.revision);
    expect(answer.status).toBe("retry_later");
    expect(rowOf()).toMatchObject({ state: "held", ownerSent: true });
    expect(rowOf().receipt).toMatchObject({ used: false });
    expect(fake.calls("POST", /\/approvals\/apr_1\/approve$/)).toHaveLength(0);
    // retryHeld: a held hold that failed a check, same race
    rig({ proven: true });
    fake.on("POST", /\/messages$/, heldReply);
    await submitDraft();
    const second = rowOf();
    store.casSend(second.sendId, second.revision, { state: "approved_unsent", code: "send_failed" }, clock);
    switchAfterApprovingCas();
    const retried = await send.retry(rowOf());
    expect(retried.status).toBe("retry_later");
    expect(rowOf()).toMatchObject({ state: "approved_unsent", code: "owner_check" });
    expect(rowOf().attempts.filter(item => item.route === "#32")).toHaveLength(0);
    expect(fake.calls("POST", /\/held\/h1\/send$/)).toHaveLength(0);
  });
});

describe("23 to 25: G1, the 72 h limit, and a fenced reconcile read", () => {
  it("23 tick resume: after the proof, with no restart and no wait, the held prepared send goes out on the next tick, exactly once", async () => {
    switchOwner();
    await submitDraft();
    expect(rowOf().state).toBe("prepared");
    fake.on("POST", /\/messages$/, sentOk());
    await prove();
    await send.tick();
    await send.tick();
    expect(posts()).toHaveLength(1);
    expect(rowOf().state).toBe("sent");
  });

  it("24 72 h limit: a held prepared row whose #5 never answers settles expired(owner_unproven) with zero sends", async () => {
    switchOwner();
    await submitDraft();
    fake.always("GET", /\/v1\/email\/inboxes\/ibx_1$/, "reset");
    clock += HOLD_LIFETIME_MS - 60_000;
    await send.tick();
    expect(rowOf().state).toBe("prepared");
    clock += 120_000;
    await send.tick();
    expect(rowOf()).toMatchObject({ state: "expired", code: "owner_unproven" });
    expect(posts()).toHaveLength(0);
  });

  it("25 fenced reconcile read: an unknown row on a U3 binding is still unknown after the 2 h step; the next read after the proof settles it", async () => {
    fake.on("POST", /\/messages$/, "reset");
    await submitDraft();
    expect(rowOf().state).toBe("unknown");
    switchOwner();
    fake.always("GET", /\/v1\/email\/inboxes\/ibx_1\/messages$/, { status: 200, body: { data: [] } });
    for (const gap of RECONCILE_GAPS_MS) { clock += gap + 1; await send.tick(); }
    clock += 5_400_001; await send.tick();
    expect(rowOf().state).toBe("unknown");
    expect(fake.calls("GET", /\/approvals$/)).toHaveLength(0);
    await prove();
    fake.always("GET", /\/v1\/email\/approvals$/, { status: 200, body: { data: [] } });
    clock += 300_001;
    await send.tick();
    expect(rowOf().state).toBe("unknown_expired");
    expect(posts()).toHaveLength(1);
  });
});

describe("26 and 26b: H8, no dispatching row keeps a due time", () => {
  it("26 crash on a resumed send: stored with dueAt null, boot moves it to unknown, the read-only reconcile settles it, zero sends, canRotate", async () => {
    switchOwner();
    await submitDraft();
    expect(rowOf().dueAt).not.toBeNull();
    fake.on("GET", /\/v1\/email\/inboxes\/ibx_1$/, okInbox);
    await bindings.proveOwners(true);
    clock += FENCE_RETRY_MS;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    void send.locks.exclusive("ibx_1", () => wait);
    void send.tick(); // the CAS into dispatching commits, then the call parks on the lock: the process "stops" here
    await sleep(10);
    expect(rowOf()).toMatchObject({ state: "dispatching", dueAt: null });
    wire(); // restart: new services over the same database
    await send.recover();
    expect(rowOf().state).toBe("unknown");
    fake.always("GET", /\/v1\/email\/inboxes\/ibx_1\/messages$/, { status: 200, body: { data: [] } }).always("GET", /\/v1\/email\/approvals$/, { status: 200, body: { data: [] } });
    expect(send.canRotate("b1")).toBe(false);
    for (let step = 0; step < 6 && rowOf().state === "unknown"; step++) { clock += 5_400_001; await send.tick(); }
    expect(rowOf().state).toBe("unknown_expired");
    expect(posts()).toHaveLength(0);
    expect(send.canRotate("b1")).toBe(true);
    void release; // the parked pre-crash call is abandoned, as a crashed process would
  });

  it("26b legacy row: a stored dispatching row with a non-null dueAt is moved to unknown by recover()", async () => {
    fake.on("POST", /\/messages$/, "reset");
    await submitDraft();
    const made = rowOf();
    store.casSend(made.sendId, made.revision, { state: "dispatching", dueAt: clock + FENCE_RETRY_MS }, clock);
    wire();
    await send.recover();
    expect(rowOf().state).toBe("unknown");
  });
});
