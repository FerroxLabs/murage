import { createMemoryEmailSecrets } from "../testing/email-store-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EMAIL-ACCOUNT-CHANGE r5 test 10 fixture GENERATOR. Not part of the suite: it is copied as migration-fixture.gen.test.ts into a checkout of
// int/1019 (ae51f55c1) and run there, so the files it writes are what the int/1019 runtime itself writes:
//   email.db          the email SQLite database (file) after enable() minted bot B's key and createInbox got no answer (step=inbox, K_B saved)
//   credentials.json  the secret doc int/1019's persist hook handed the shell (owner token B, bot key K_B)
// Only fake tokens ("tok-owner-B", "tok-bot-B") are used; nothing here touches Flux or any user data.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { it, expect } from "vitest";
import { FluxEmailClient } from "./flux-email-client.ts";
import { emailCredentialProvider, type EmailSecretsDoc } from "./email-secrets.ts";
import { EmailStore } from "./email-store.ts";
import { EmailBindingService } from "./binding-service.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";

it("writes the int/1019 migration fixture", async () => {
  const out = process.env.FIXTURE_OUT!;
  expect(out).toBeTruthy();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const db = new DatabaseSync(`${out}/email.db`);
  const store = new EmailStore(db);
  let doc: EmailSecretsDoc = { bots: {} };
  const secrets = createMemoryEmailSecrets(saved => { doc = saved; });
  secrets.setOwner({ token: "tok-owner-B", keyId: "key_owner_B" });
  const fake = new FakeFlux();
  fake.on("POST", /bot-keys$/, { status: 200, body: { key: "tok-bot-B", key_id: "key_bot_B", label: "bot-email:b1" } }).on("POST", /\/v1\/email\/inboxes$/, "reset");
  const client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100 });
  let n = 0;
  const service = new EmailBindingService({ store, client, secrets, installId: "inst-fixture", now: () => 1_800_000_000_000, newId: () => `op-fixture-${++n}` });
  const row = await service.enable("b1", { username: "juniper", displayName: "Juniper" });
  expect(row).toMatchObject({ state: "provisioning", step: "inbox", emailKeyRef: "key_bot_B", inboxId: null });
  db.close();
  writeFileSync(`${out}/credentials.json`, JSON.stringify(doc, null, 2));
});
