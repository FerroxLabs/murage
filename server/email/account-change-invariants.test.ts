import { createMemoryEmailSecrets } from "../testing/email-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { EmailSecretStore, emailCredentialProvider, type EmailSecretsSaveMeta } from "./email-secrets.ts";
import { EmailStore } from "./email-store.ts";
import { EmailBindingService } from "./binding-service.ts";
import { FluxEmailClient } from "./flux-email-client.ts";
import { expectedBotKey } from "./retired-keys.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function rig() {
  const db = new DatabaseSync(":memory:"); dbs.push(db);
  const store = new EmailStore(db), fake = new FakeFlux();
  let meta: EmailSecretsSaveMeta | undefined;
  const secrets = createMemoryEmailSecrets((_doc, saved) => { meta = saved; return true; });
  secrets.replaceAll({ owner: { token: "owner-A", keyId: "owner_A" }, bots: {} });
  const client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null, (bot, inbox) => expectedBotKey(store, bot, inbox)) });
  let n = 0;
  const bindings = new EmailBindingService({ store, client, secrets, installId: "fixture", newId: () => `operation-${++n}` });
  fake.always("POST", /bot-keys$/, { status: 201, body: { key: "bot-K2", key_id: "key_K2" } });
  fake.always("GET", /inboxes$/, { status: 200, body: { data: [{ id: "inbox_A", bot_id: "b1", address: "bot@murage.email", state: "active" }] } });
  fake.always("POST", /inboxes$/, { status: 201, body: { id: "inbox_A", address: "bot@murage.email", state: "active" } });
  fake.always("GET", /inboxes\/inbox_A$/, { status: 200, body: { id: "inbox_A", state: "active" } });
  return { store, fake, secrets, bindings, ack: () => secrets.ack({ ...meta, keyIds: ["key_K2", "owner_A"] }) };
}
function binding(store: EmailStore, state: "active" | "restored_unverified", keyId = "key_K1") {
  store.insertBinding({ botId: "b1", inboxId: "inbox_A", address: "bot@murage.email", username: "bot", displayName: "Bot", emailKeyRef: keyId, fluxAccountId: "account_A", state, step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: Date.now() });
}

describe("account-change database references require durable key proof", () => {
  it("setup leaves its key reference unset until the shell reads that key back", async () => {
    const r = rig();
    const pending = r.bindings.enable("b1", { username: "bot" });
    try {
      await expect.poll(() => r.secrets.botKey("b1")?.keyId).toBe("key_K2");
      expect(r.store.getBinding("b1")?.emailKeyRef).toBeNull();
      expect(r.fake.calls("POST", /inboxes$/)).toHaveLength(0);
    } finally { r.ack(); await pending; }
    expect(r.store.getBinding("b1")?.emailKeyRef).toBe("key_K2");
  });

  it("adoption leaves the old durable reference until the replacement is acknowledged", async () => {
    const r = rig(); binding(r.store, "restored_unverified");
    r.secrets.replaceAll({ owner: r.secrets.owner(), bots: { b1: { token: "bot-K1", keyId: "key_K1" } } });
    const pending = r.bindings.reconnect("b1");
    try {
      await expect.poll(() => r.secrets.botKey("b1")?.keyId).toBe("key_K2");
      expect(r.store.getBinding("b1")?.emailKeyRef).toBe("key_K1");
    } finally { r.ack(); await pending; }
    expect(r.store.getBinding("b1")?.emailKeyRef).toBe("key_K2");
  });

  it("healing cannot commit a saved candidate before its durable acknowledgement", async () => {
    const r = rig(); binding(r.store, "active");
    r.secrets.setBotKey("b1", { token: "bot-K2", keyId: "key_K2" });
    const pending = r.bindings.healKeys();
    try {
      await expect.poll(() => r.fake.calls("GET", /inbox_A$/).length).toBe(1);
      expect(r.store.getBinding("b1")?.emailKeyRef).toBe("key_K1");
    } finally { r.ack(); await pending; }
    expect(r.store.getBinding("b1")?.emailKeyRef).toBe("key_K2");
  });
});

it("a backend that returns no acknowledgement never makes a new key durable", () => {
  const store = new EmailSecretStore(() => false);
  store.setBotKey("b1", { token: "unacknowledged", keyId: "key_pending" });
  expect(store.isDurable("key_pending")).toBe(false);
});
