import { createMemoryEmailSecrets } from "../testing/email-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EMAIL-ACCOUNT-CHANGE r4 section 1 (persist backend "none") and the 1.0.19 Cloud dead-end fix (CLOUD-EMAIL-KEYSTORE-1019): where no durable
// store for email keys exists (a Cloud home, plain Node, or a shell whose key store could not be read), bot email is off this run: no enable and no
// Reconnect (no Flux call), every bot key answers no credential, bindings are not changed, and the owner reads one plain line.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { FluxEmailClient } from "./flux-email-client.ts";
import { emailCredentialProvider } from "./email-secrets.ts";
import { EmailStore } from "./email-store.ts";
import { EmailBindingService } from "./binding-service.ts";
import { EMAIL_OWNER_COPY, ownerRouteLine } from "../../shared/email-copy.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";

function rig(unavailable: "cloud" | "store" | null) {
  const fake = new FakeFlux();
  const store = new EmailStore(new DatabaseSync(":memory:"));
  const secrets = createMemoryEmailSecrets(() => {}, { unavailable });
  secrets.setOwner({ token: "tok-owner", keyId: "key_owner" });
  const client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100 });
  const service = new EmailBindingService({ store, client, secrets, installId: "inst", now: () => 1_800_000_000_000 });
  return { fake, store, secrets, client, service };
}

describe.each(["cloud", "store"] as const)("no durable key store (%s)", why => {
  it("enable makes no row and no Flux call; Reconnect answers email_store_unavailable with no Flux call", async () => {
    const { fake, store, service } = rig(why);
    expect(await service.enable("b1", { username: "juniper", displayName: "Juniper" })).toBeNull();
    expect(store.getBinding("b1")).toBeNull();
    store.insertBinding({ botId: "b2", inboxId: "ibx_2", address: "x@murage.email", username: "x", displayName: "X", emailKeyRef: "key_x", fluxAccountId: null, state: "restored_unverified", step: null, opId: null, opStartedAt: null, policy: "auto", failure: "account_changed", updatedAt: 1 });
    expect(await service.reconnect("b2")).toEqual({ ok: false, code: "email_store_unavailable", status: 503 });
    expect(store.getBinding("b2")).toMatchObject({ state: "restored_unverified" });
    expect(fake.requests).toEqual([]);
  });

  it("the credential provider answers no credential for every bot key, even one that is held", async () => {
    const { secrets, client, fake } = rig(why);
    secrets.setBotKey("b1", { token: "tok-bot", keyId: "key_b1" });
    const answer = await client.listMessages({ kind: "bot", botId: "b1" }, "ibx_1");
    expect(answer).toMatchObject({ kind: "uncertain", reason: "no_credential" });
    expect(fake.requests).toEqual([]);
    expect(secrets.available).toBe(false);
  });
});

describe("a store that can hold keys is unchanged", () => {
  it("durable by default: enable starts a setup", async () => {
    const { fake, store, service, secrets } = rig(null);
    fake.on("POST", /bot-keys$/, "reset");
    await service.enable("b1", { username: "juniper" });
    expect(secrets.available).toBe(true);
    expect(store.getBinding("b1")).toMatchObject({ state: "provisioning" });
    expect(fake.calls("POST", /bot-keys$/)).toHaveLength(1);
  });
});

describe("the wiring and the words", () => {
  it("index.ts: an unsealed Cloud home is unavailable; a sealed Cloud home persists keys and fixtures acknowledge explicitly", () => {
    const index = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(index).toContain('secretsUnavailable: cloudHome ? cloudEmailStore ? undefined : "cloud" : utilityParentPort || process.env.MURAGE_TEST_EMAIL_STORE === "memory" ? undefined : "store"');
    expect(index).toContain('if (!cloudHome && !utilityParentPort && process.env.MURAGE_TEST_EMAIL_STORE === "memory")');
    expect(index).toContain('queueMicrotask(() => emailRuntime.secrets.ack({ ...meta, keyIds }))');
    expect(index).toContain('return postDesktopPrivateMessage({ type: EMAIL_SECRETS_SAVE, doc, rev: meta.rev, epoch: meta.epoch });');
  });
  it("the lines follow the copy rules and the route words match", () => {
    for (const line of [EMAIL_OWNER_COPY.cloudNotYet, EMAIL_OWNER_COPY.storeUnavailable, EMAIL_OWNER_COPY.signInNeedsApp]) expect(line).not.toMatch(/—|–|\b(safe|unsafe|safety|free|forge|will fail)\b/i);
    expect(ownerRouteLine("email_store_unavailable")).toBe(EMAIL_OWNER_COPY.storeUnavailable);
  });
});
