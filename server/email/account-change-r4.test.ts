import { legacyEmailDecisionFixture } from "./testing/legacy-decision-fixture.ts";
import type { ServiceAuthority } from "../narrow-denials.ts";
import { createMemoryEmailSecrets } from "../testing/email-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EMAIL-ACCOUNT-CHANGE r4 leftovers (designs/EMAIL-ACCOUNT-CHANGE-r4.md sections 1 to 3; vitest on Hetzner only, `--network none`):
//   R1  the server counts a key durable only when the shell's ack lists its key id (read-back by key id)
//   R2  rotation keeps the old key on disk (prev slot) until the new key is acked and the ref names it; revoke only after both
//   R3  a frozen held row is re-read (#20, retired key), never expired by age alone
import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { FluxEmailClient } from "./flux-email-client.ts";
import { EmailSecretStore, emailCredentialProvider, type EmailSecretsDoc, type EmailSecretsSaveMeta } from "./email-secrets.ts";
import { expectedBotKey } from "./retired-keys.ts";
import { EmailStore, type SendRow } from "./email-store.ts";
import { EmailBindingService } from "./binding-service.ts";
import { EmailSendService, FROZEN_REREAD_MS, FROZEN_UNREADABLE_LIMIT_MS, HOLD_LIFETIME_MS } from "./send-service.ts";
import type { EmailDraft } from "./canonical.ts";
import { FakeFlux, type FakeReply } from "../testing/fake-flux-email.ts";

const OWNER = { token: "tok-owner", keyId: "key_owner" };
const T0 = 1_800_000_000_000;
const draft = (): EmailDraft => ({ kind: "send", to: ["jane@acme.test"], cc: [], subject: "Thursday", text: "Hi Jane", attachments: [], replyTo: null });
const heldReply: FakeReply = { status: 202, body: { status: "pending_approval", held_id: "h1", approval: { id: "apr_1", held_ids: ["h1"], state: "pending" } } };

describe("R1 the ack names key ids", () => {
  it("a key is durable only when an ack's read-back list names it; a list without it leaves it pending and the tick pushes again", () => {
    let meta!: EmailSecretsSaveMeta;
    const secrets = createMemoryEmailSecrets((_doc, m) => { meta = m; return true; });
    secrets.setBotKey("b1", { token: "t1", keyId: "key_1" });
    expect(secrets.isDurable("key_1")).toBe(false);
    secrets.ack({ ...meta, keyIds: [] }); // the read-back did not find it
    expect(secrets.isDurable("key_1")).toBe(false);
    expect(secrets.resaveIfUnacked()).toBe(true);
    secrets.ack({ ...meta, keyIds: ["other"] });
    expect(secrets.isDurable("key_1")).toBe(false);
    secrets.ack({ ...meta, keyIds: ["key_1"] });
    expect(secrets.isDurable("key_1")).toBe(true);
  });
  it("an ack with no key id list is not an ack", () => {
    let meta!: EmailSecretsSaveMeta;
    const secrets = createMemoryEmailSecrets((_doc, m) => { meta = m; return true; });
    secrets.setBotKey("b1", { token: "t1", keyId: "key_1" });
    secrets.ack({ rev: meta.rev, epoch: meta.epoch });
    expect(secrets.isDurable("key_1")).toBe(false);
  });
});

let authority: ServiceAuthority;
let clock: number;
let fake: FakeFlux;
let store: EmailStore;
let secrets: EmailSecretStore;
let client: FluxEmailClient;
let bindings: EmailBindingService;
let send: EmailSendService;
let metas: EmailSecretsSaveMeta[];
let docs: EmailSecretsDoc[];
let autoAck: boolean;

function rig() {
  clock = T0; fake = new FakeFlux(); store = new EmailStore(new DatabaseSync(":memory:")); metas = []; docs = []; autoAck = true;
  secrets = createMemoryEmailSecrets((doc, meta) => { docs.push(JSON.parse(JSON.stringify(doc))); metas.push(meta); return !autoAck ? true : (queueMicrotask(() => secrets.ack({ ...meta, keyIds: Object.values(doc.bots).map(c => c.keyId).concat(Object.values(doc.prev ?? {}).map(c => c.keyId), Object.values(doc.retired ?? {}).map(c => c.keyId)) })), true); });
  secrets.setOwner(OWNER);
  secrets.setBotKey("b1", { token: "tok-K1", keyId: "key_K1" });
  let n = 0;
  client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null, (botId, inboxId) => expectedBotKey(store, botId, inboxId)), timeoutMs: 100 });
  bindings = new EmailBindingService({ store, client, secrets, installId: "inst", now: () => clock, newId: () => `op-${++n}` });
  send = new EmailSendService({ store, client, authorityFor: () => authority, installId: "inst", now: () => clock, newId: () => `send-${++n}-${clock}`, fence: botId => bindings.holdsSends(botId), ownerRefFor: botId => bindings.ownerRefFor(botId) });
  store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_K1", fluxAccountId: "acct_A", state: "active", step: null, opId: "op-0", opStartedAt: clock, policy: "auto", failure: null, updatedAt: clock });
  store.setCursor("inbox-owner:b1", JSON.stringify({ ownerRef: OWNER.keyId, inboxId: "ibx_1", at: clock }), clock);
  store.addTrusted("b1", "jane@acme.test", "allow", "owner", clock);
}
beforeEach(async () => { authority = await legacyEmailDecisionFixture(); rig(); });
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function rotationFixtures() {
  fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "tok-K2", key_id: "key_K2" } });
  fake.always("GET", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "active" } });
  fake.on("DELETE", /^\/api\/desktop\/bot-keys\/key_K1$/, { status: 200, body: {} });
}

describe("R2 rotation: the prev slot and revoke by ack", () => {
  it("the save that brings K2 keeps K1 on disk in the prev slot (the ref still names K1 until K2 is acked)", async () => {
    rotationFixtures();
    expect(await bindings.rotateKey("b1", () => true)).toEqual({ ok: true });
    const withK2 = docs.find(doc => doc.bots.b1?.keyId === "key_K2")!;
    expect(withK2.prev?.b1?.keyId).toBe("key_K1");
    expect(docs.at(-1)!.prev).toBeUndefined(); // the final save dropped the prev slot after the revoke
    expect(store.getBinding("b1")!.emailKeyRef).toBe("key_K2");
  });
  it("no ref commit and no revoke before K2's ack; the ack then lets the same call finish", async () => {
    rotationFixtures();
    autoAck = false;
    const first = await bindings.rotateKey("b1", () => true);
    expect(first.ok).toBe(false);
    expect(store.getBinding("b1")!.emailKeyRef).toBe("key_K1");
    expect(fake.calls("DELETE", /bot-keys/)).toHaveLength(0);
    expect(secrets.findBotKey("b1", "key_K1", "ibx_1")?.token).toBe("tok-K1"); // the named key is found (slot-blind) while K2 holds the bot slot
    const meta = metas.at(-1)!; const doc = docs.at(-1)!;
    secrets.ack({ ...meta, keyIds: [doc.bots.b1!.keyId, doc.prev!.b1!.keyId] });
    expect(await bindings.rotateKey("b1", () => true)).toEqual({ ok: true });
    expect(store.getBinding("b1")!.emailKeyRef).toBe("key_K2");
    expect(fake.calls("DELETE", /bot-keys\/key_K1$/)).toHaveLength(1);
    expect(secrets.prevKey("b1")).toBeNull();
    await flush();
  });
  it("the owner leaving between the save and the ref commit keeps K1 named, on disk and unrevoked", async () => {
    rotationFixtures();
    const original = secrets.whenDurable.bind(secrets);
    secrets.whenDurable = async (keyId: string, ms: number) => { const ok = await original(keyId, ms); secrets.setOwner({ token: "tok-owner-C", keyId: "key_owner_C" }); return ok; };
    const answer = await bindings.rotateKey("b1", () => true);
    expect(answer.ok).toBe(false);
    expect(store.getBinding("b1")!.emailKeyRef).toBe("key_K1");
    expect(fake.calls("DELETE", /bot-keys/)).toHaveLength(0);
    expect(secrets.findBotKey("b1", "key_K1", "ibx_1")).not.toBeNull();
  });
});

describe("R3 frozen holds are re-read, never expired by age alone", () => {
  async function frozenHold(): Promise<SendRow> {
    fake.on("POST", /\/messages$/, heldReply);
    await send.submit({ botId: "b1", generation: 1, threadId: "t1", draft: draft() });
    const row = store.sendsOfGeneration("b1", 1)[0]!;
    expect(row.state).toBe("held");
    // the owner leaves account A: the freeze writes the retired ref and the key stays readable through it
    store.setCursor("retired-keys", JSON.stringify([{ botId: "b1", inboxId: "ibx_1", keyId: "key_K1" }]), clock);
    return row;
  }
  const rowNow = () => store.sendsOfGeneration("b1", 1)[0]!;
  const approval = (state: string, held = "pending"): FakeReply => ({ status: 200, body: { id: "apr_1", state, held: [{ id: "h1", state: held, client_reference: rowNow().sendId }] } });

  it("72 h pass with no event: the row is read with the retired key and is not expired", async () => {
    await frozenHold();
    fake.always("GET", /\/v1\/email\/approvals\/apr_1$/, approval("pending"));
    clock += HOLD_LIFETIME_MS + 1;
    await send.tick(); // marks it due (first read)
    await send.tick();
    expect(fake.calls("GET", /approvals\/apr_1$/).length).toBeGreaterThan(0);
    expect(fake.calls("GET", /approvals\/apr_1$/)[0]!.headers.authorization).toBe("Bearer tok-K1");
    expect(rowNow().state).toBe("held");
    expect(rowNow().dueAt).not.toBeNull();
  });
  it("#20 says sent, send_failed, expired, cancelled or sending: each moves the row as designed", async () => {
    for (const [held, want] of [["sent", "sent"], ["send_failed", "approved_unsent"], ["expired", "expired"], ["cancelled", "withdrawn"], ["sending", "approving"]] as const) {
      rig();
      await frozenHold();
      fake.always("GET", /\/v1\/email\/approvals\/apr_1$/, approval("pending", held));
      await send.tick(); await send.tick();
      expect(rowNow().state, held).toBe(want);
    }
  });
  it.each(['sent', 'send_failed', 'expired', 'cancelled'] as const)('an adopted account reconciles its frozen approving hold as %s using only the retired key', async outcome => {
    const row = await frozenHold();
    secrets.replaceBotKey('b1', { token: 'tok-new-account', keyId: 'key_new' }, [{ inboxId: 'ibx_1', keyId: 'key_K1' }]);
    await flush();
    const bound = store.getBinding('b1')!;
    store.casBinding('b1', bound.revision, { inboxId: 'ibx_new', emailKeyRef: 'key_new', fluxAccountId: 'acct_B' }, clock);
    const before = fake.requests.length;
    expect((await send.ownerSend(row.sendId, rowNow().revision)).status).toBe('retry_later');
    expect((await send.approve(rowNow())).status).toBe('retry_later');
    expect(fake.requests).toHaveLength(before);
    fake.on('GET', /approvals\/apr_1$/, approval('pending', 'sending'));
    await send.tick(); await send.tick();
    expect(rowNow().state).toBe('approving');
    fake.always('GET', /inboxes\/ibx_1\/messages$/, { status: 200, body: { data: [] } });
    fake.always('GET', /approvals\/apr_1$/, approval('pending', outcome));
    await send.reconcile(rowNow());
    expect(rowNow().state).toBe(({ sent: 'sent', send_failed: 'approved_unsent', expired: 'expired', cancelled: 'withdrawn' } as const)[outcome]);
    const reads = fake.requests.filter(request => request.method === 'GET' && (/inboxes\/ibx_1\/messages$/.test(request.path) || /approvals\/apr_1$/.test(request.path)));
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(reads.every(request => request.headers.authorization === 'Bearer tok-K1')).toBe(true);
    expect(fake.requests.filter(request => request.method !== 'GET' && !/messages$/.test(request.path))).toEqual([]);
    expect(fake.calls('POST', /messages$/)).toHaveLength(1);
    expect(rowNow().sendId).toBe(row.sendId);
  });
  it("an unreadable hold keeps its credential and backs off; it ends unknown_expired only after the 7-day window", async () => {
    await frozenHold();
    fake.always("GET", /\/v1\/email\/approvals\/apr_1$/, { status: 503, body: {} });
    clock += HOLD_LIFETIME_MS + 1;
    await send.tick(); await send.tick();
    expect(rowNow().state).toBe("held");
    expect(rowNow().dueAt! - clock).toBeLessThanOrEqual(24 * 3_600_000);
    expect(secrets.findBotKey("b1", "key_K1", "ibx_1")).not.toBeNull();
    clock = rowNow().createdAt + HOLD_LIFETIME_MS + FROZEN_UNREADABLE_LIMIT_MS + 1;
    await send.tick();
    expect(rowNow().state).toBe("unknown_expired");
  });
  it("an event gap reads a frozen hold directly even when it is missing from the pending list", async () => {
    await frozenHold();
    fake.always("GET", /\/v1\/email\/approvals\/apr_1$/, approval("pending", "expired"));
    await send.afterEventGap(new Set());
    expect(rowNow().state).toBe("expired");
    expect(fake.calls("GET", /approvals\/apr_1$/)[0]!.headers.authorization).toBe("Bearer tok-K1");
  });
  it("a hold that is not frozen still expires by age", async () => {
    fake.on("POST", /\/messages$/, heldReply);
    await send.submit({ botId: "b1", generation: 1, threadId: "t1", draft: draft() });
    clock += HOLD_LIFETIME_MS + 1;
    await send.tick();
    expect(rowNow().state).toBe("expired");
    void FROZEN_REREAD_MS;
  });
});
