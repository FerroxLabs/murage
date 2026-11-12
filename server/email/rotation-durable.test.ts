// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Keystore fix round 1, H1: a Cloud key rotation does not rebind, revoke the old key or drop its intent until the supervisor acknowledged the new key durably.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
let fake: FakeFlux, db: DatabaseSync, runtime: EmailRuntime, durable: boolean;

const make = () => new EmailRuntime({
  accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
  now: () => 1_800_000_000_000, workspaceRoot: () => undefined, bot: id => ({ id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord), deletionProof: () => false,
  secretsDurable: async () => durable,
});

beforeEach(async () => {
  fake = new FakeFlux(); db = new DatabaseSync(":memory:"); durable = false;
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
  await runtime.probe.refresh();
  runtime.services()!.store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, state: "active", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: 1_800_000_000_000 } as never);
  runtime.secrets.setBotKey("b1", { token: "bot-old", keyId: "key_old" });
});
afterEach(() => runtime.stop());

describe("H1 rotation waits for the durable acknowledgement", () => {
  it("not acknowledged: save_pending, the binding keeps the old key, the old key is not revoked, the intent stays; acknowledged on the next call: all three complete", async () => {
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "bot-new", key_id: "key_new" } });
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "active" } });
    fake.on("DELETE", /^\/api\/desktop\/bot-keys\/key_old$/, { status: 200, body: {} });
    const services = runtime.services()!;
    expect(await services.bindings.rotateKey("b1", () => true)).toEqual({ ok: false, code: "save_pending" });
    expect(services.store.getBinding("b1")!.emailKeyRef).toBe("key_old");
    expect(fake.calls("DELETE", /^\/api\/desktop\/bot-keys\/key_old$/)).toHaveLength(0);
    expect(services.store.getCursor("rotate:b1")).not.toBeNull();
    durable = true;
    expect(await services.bindings.rotateKey("b1", () => true)).toEqual({ ok: true });
    expect(services.store.getBinding("b1")!.emailKeyRef).toBe("key_new");
    expect(fake.calls("DELETE", /^\/api\/desktop\/bot-keys\/key_old$/)).toHaveLength(1);
    expect(services.store.getCursor("rotate:b1")).toBeNull();
  });
});
