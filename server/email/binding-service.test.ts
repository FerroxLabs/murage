// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Inbox setup and removal, crash-proof (design 2.5, 2.6, 9.2; F19 to F22), deletion intents (Astra R4, L2), policy sync (3.3), and the
// email tables' registration with the installation snapshot.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { FluxEmailClient } from "./flux-email-client.ts";
import { EmailSecretStore, emailCredentialProvider } from "./email-secrets.ts";
import { EMAIL_INDEXES, EMAIL_TABLES, EmailStore, initializeEmailTables } from "./email-store.ts";
import { EmailBindingService, SETUP_GIVE_UP_MS, SETUP_GIVE_UP_TRIES, SETUP_NO_ANSWER, SETUP_RETRY_MS } from "./binding-service.ts";
import { FakeFlux, fluxError, ownerOnly } from "../testing/fake-flux-email.ts";
import { readFileSync, readdirSync } from "node:fs";
import { bindingFailureLine } from "../../shared/email-copy.ts";
import { APP_SCHEMA_102_ADDITIONS } from "../installation-app-schema-downgrade.ts";
import { ADDED_TABLE_LIFECYCLE } from "../added-table-lifecycle.ts";
import { inspectInstallationDatabase } from "../installation-database-snapshot.ts";
import { initializeMessageTables } from "../message-tables.ts";

let clock = 0;
let fake: FakeFlux;
let store: EmailStore;
let secrets: EmailSecretStore;
let service: EmailBindingService;
let withdrawn: Array<[string, string]>;
let client: FluxEmailClient;

beforeEach(() => {
  clock = 1_800_000_000_000;
  fake = new FakeFlux();
  store = new EmailStore(new DatabaseSync(":memory:"));
  secrets = new EmailSecretStore();
  secrets.setOwner({ token: "owner-token", keyId: "key_owner" });
  client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100 });
  withdrawn = [];
  let n = 0;
  service = new EmailBindingService({ store, client, secrets, installId: "inst", now: () => clock, newId: () => `op-${++n}`, withdrawSends: (botId, reason) => { withdrawn.push([botId, reason]); } });
});

const minted = { status: 200, body: { key: "sk-email-1", key_id: "key_e1", label: "bot-email:b1" } };
const inbox = (patch: Record<string, unknown> = {}) => ({ status: 201, body: { id: "ibx_1", bot_id: "b1", address: "juniper@murage.email", state: "active", send_policy: "auto", ...patch } });

describe("setup (2.5, F21)", () => {
  it("mints the email:bot key, then the inbox, each with its op_id Idempotency-Key; the key lives only in the secret store", async () => {
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, inbox());
    const row = await service.enable("b1", { username: "juniper", displayName: "Juniper" });
    expect(row).toMatchObject({ state: "active", inboxId: "ibx_1", address: "juniper@murage.email", emailKeyRef: "key_e1", step: null });
    const [mint, create] = fake.requests;
    expect(mint.headers["idempotency-key"]).toBe("murage-key:inst:op-1");
    expect(mint.body).toEqual({ bot_id: "b1", scopes: ["email:bot"] });
    expect(create.headers["idempotency-key"]).toBe("murage-inbox:inst:op-1");
    expect(create.headers.authorization).toBe("Bearer owner-token");
    expect(create.body).toEqual({ bot_id: "b1", username: "juniper", display_name: "Juniper" });
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_e1" });
    expect(JSON.stringify(store.getBinding("b1"))).not.toContain("sk-email-1");
  });

  it("Flux #516: #3 is owner-only; a 403 owner_required fails the step with a clear owner line", async () => {
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, ownerOnly("someone-else", inbox()));
    const row = await service.enable("b1", {});
    expect(row).toMatchObject({ state: "failed", failure: "owner_required" });
    expect(bindingFailureLine(row!.failure)).toMatch(/^Only you can give a bot an address/);
    expect(bindingFailureLine(row!.failure)).not.toMatch(/\u2014|safe|Composio|\$/i);
  });

  it("Flux #516: the owner-only stub lets the email:owner token create the inbox", async () => {
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, ownerOnly("owner-token", inbox()));
    expect(await service.enable("b1", {})).toMatchObject({ state: "active" });
  });

  it("Flux #516: no bot-key code path ever calls #3 (createInbox is owner-credentialed and only the binding service calls it)", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const client = readFileSync(`${dir}flux-email-client.ts`, "utf8");
    const create = client.slice(client.indexOf("  createInbox("), client.indexOf("  listInboxes("));
    expect(create).toContain('{ kind: "owner" }');
    expect(create).not.toContain('kind: "bot"');
    expect(client.match(/"POST", "\/v1\/email\/inboxes"/g) ?? []).toHaveLength(1);
    const callers = readdirSync(dir).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts")).filter(name => readFileSync(`${dir}${name}`, "utf8").includes(".createInbox("));
    expect(callers).toEqual(["binding-service.ts"]);
  });

  it("F19: the email key is its own key (scope email:bot only, no spend fields)", async () => {
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, inbox());
    await service.enable("b1", {});
    expect(Object.keys(fake.requests[0].body as object).sort()).toEqual(["bot_id", "scopes"]);
  });

  it("r2.5: a bodiless 404 from bot-keys (Flux's key switch off) is dark: no failed row, no error card, the launch switch is read again", async () => {
    const refusals: string[] = [];
    const client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100 });
    service = new EmailBindingService({ store, client, secrets, installId: "inst", now: () => clock, newId: () => "op-1", onRefusal: code => refusals.push(code) });
    fake.on("POST", /bot-keys$/, { status: 404 });
    expect(await service.enable("b1", { username: "juniper", displayName: "Juniper" })).toBeNull();
    expect(store.getBinding("b1")).toBeNull();
    expect(refusals).toEqual(["email_not_enabled"]);
    expect(fake.calls("POST", /\/v1\/email\/inboxes$/)).toHaveLength(0);
  });

  it("r2.5 #3: 404 bot_not_found fails the step with a plain owner line; the body names bot_id and never bot_key_id", async () => {
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, fluxError(404, "bot_not_found"));
    const row = await service.enable("b1", { username: "juniper" });
    expect(row).toMatchObject({ state: "failed", failure: "bot_not_found" });
    expect(bindingFailureLine("bot_not_found")).toMatch(/^Flux has not linked this bot/);
    expect(bindingFailureLine("bot_not_found")).not.toMatch(/\u2014|safe|error/i);
    expect(fake.calls("POST", /\/v1\/email\/inboxes$/)[0].body).not.toHaveProperty("bot_key_id");
  });

  it("a crash (no answer) at the key step replays the same op_id on the next boot", async () => {
    fake.on("POST", /bot-keys$/, "reset");
    expect(await service.enable("b1", {})).toMatchObject({ state: "provisioning", step: "key", opId: "op-1" });
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, inbox());
    await service.reconcileBindings();
    expect(store.getBinding("b1")!.state).toBe("active");
    expect(fake.calls("POST", /bot-keys$/).map(call => call.headers["idempotency-key"])).toEqual(["murage-key:inst:op-1", "murage-key:inst:op-1"]);
  });

  it("no answer at a setup step: the tick runs it again with the same op_id after the wait, and it finishes with no restart", async () => {
    fake.on("POST", /bot-keys$/, "reset");
    expect(await service.enable("b1", {})).toMatchObject({ state: "provisioning", opId: "op-1" });
    await service.retryStalledSetups();
    expect(fake.calls("POST", /bot-keys$/)).toHaveLength(1); // the wait is not over
    clock += SETUP_RETRY_MS[0];
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, "reset");
    await service.retryStalledSetups();
    expect(store.getBinding("b1")).toMatchObject({ state: "provisioning", step: "inbox" });
    clock += SETUP_RETRY_MS[1];
    fake.on("POST", /\/v1\/email\/inboxes$/, inbox());
    await service.retryStalledSetups();
    expect(store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_1" });
    expect(fake.calls("POST", /bot-keys$/).map(call => call.headers["idempotency-key"])).toEqual(["murage-key:inst:op-1", "murage-key:inst:op-1"]);
    expect(fake.calls("POST", /\/v1\/email\/inboxes$/).map(call => call.headers["idempotency-key"])).toEqual(["murage-inbox:inst:op-1", "murage-inbox:inst:op-1"]);
    expect(store.getCursor("setup-retry:b1")).toBeNull();
  });

  it("after five runs with no answer setup shows failed with Retry; Retry replays the same op_id with a fresh budget", async () => {
    for (let i = 0; i < SETUP_GIVE_UP_TRIES; i++) fake.on("POST", /bot-keys$/, "reset");
    await service.enable("b1", {});
    for (let i = 1; i < SETUP_GIVE_UP_TRIES; i++) { clock += SETUP_RETRY_MS[i - 1]; await service.retryStalledSetups(); }
    expect(store.getBinding("b1")).toMatchObject({ state: "failed", failure: SETUP_NO_ANSWER });
    expect(fake.calls("POST", /bot-keys$/)).toHaveLength(SETUP_GIVE_UP_TRIES);
    expect(bindingFailureLine(SETUP_NO_ANSWER)).toContain("Press Retry");
    clock += 300_000;
    await service.retryStalledSetups();
    expect(fake.calls("POST", /bot-keys$/)).toHaveLength(SETUP_GIVE_UP_TRIES); // failed waits for the owner
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, inbox());
    expect(await service.enable("b1", {})).toMatchObject({ state: "active", opId: "op-1" });
    expect(fake.calls("POST", /bot-keys$/).at(-1)!.headers["idempotency-key"]).toBe("murage-key:inst:op-1");
  });

  it("the give-up budget survives a restart, and past 15 minutes the next unanswered run shows failed", async () => {
    fake.on("POST", /bot-keys$/, "reset");
    await service.enable("b1", {});
    const restarted = new EmailBindingService({ store, client, secrets, installId: "inst", now: () => clock, newId: () => "op-x", withdrawSends: () => undefined });
    clock += SETUP_GIVE_UP_MS;
    fake.on("POST", /bot-keys$/, "reset");
    await restarted.reconcileBindings();
    expect(store.getBinding("b1")).toMatchObject({ state: "failed", failure: SETUP_NO_ANSWER, opId: "op-1" });
  });

  it("two callers at once share one setup run", async () => {
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, inbox());
    const [first, second] = await Promise.all([service.enable("b1", {}), service.enable("b1", {})]);
    expect(first).toMatchObject({ state: "active" });
    expect(second).toMatchObject({ state: "active" });
    expect(fake.calls("POST", /bot-keys$/)).toHaveLength(1);
  });

  it("past Flux's 24 h window the key step starts over with a new op_id", async () => {
    fake.on("POST", /bot-keys$/, "reset");
    await service.enable("b1", {});
    clock += 24 * 3_600_000;
    fake.on("POST", /bot-keys$/, "reset");
    await service.advance("b1");
    expect(fake.calls("POST", /bot-keys$/).at(-1)!.headers["idempotency-key"]).toBe("murage-key:inst:op-2");
  });

  it("a key already in the secret store skips to the inbox step", async () => {
    secrets.setBotKey("b1", { token: "t", keyId: "key_prev" });
    fake.on("POST", /\/v1\/email\/inboxes$/, inbox());
    expect(await service.enable("b1", {})).toMatchObject({ state: "active", emailKeyRef: "key_prev" });
    expect(fake.calls("POST", /bot-keys$/)).toHaveLength(0);
  });

  it("409 inbox_exists is adopted (the inbox is read for its address)", async () => {
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, fluxError(409, "inbox_exists", { inbox_id: "ibx_old" }))
      .on("GET", /\/inboxes\/ibx_old$/, { status: 200, body: { id: "ibx_old", address: "old@murage.email", state: "active", send_policy: "ask" } });
    expect(await service.enable("b1", {})).toMatchObject({ state: "active", inboxId: "ibx_old", address: "old@murage.email", policy: "ask" });
  });

  it("a definite refusal fails the setup; Retry starts again with a new op_id and keeps the saved key", async () => {
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, fluxError(409, "username_unavailable"));
    expect(await service.enable("b1", { username: "juniper" })).toMatchObject({ state: "failed", failure: "username_unavailable" });
    fake.on("POST", /\/v1\/email\/inboxes$/, inbox());
    expect(await service.enable("b1", { username: "juniper2" })).toMatchObject({ state: "active", opId: "op-2" });
    expect(fake.calls("POST", /bot-keys$/)).toHaveLength(1);
  });
});

describe("removal (2.6, F22, F25)", () => {
  async function active() {
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, inbox());
    await service.enable("b1", {});
  }

  it("Flux #516: any 202 on #7 is remove_requested, whatever the state word (closing)", async () => {
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, inbox());
    await service.enable("b1", {});
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { id: "ibx_1", state: "closing" } }).on("GET", /\/inboxes\/ibx_1$/, inbox({ state: "closing" }));
    expect(await service.remove("b1")).toMatchObject({ state: "remove_requested" });
  });

  it("202 deleting is remove_requested, never done; email.inbox.deleted revokes the key and leaves a tombstone", async () => {
    await active();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { id: "ibx_1", state: "deleting" } }).on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "deleting" } });
    expect(await service.remove("b1")).toMatchObject({ state: "remove_requested" });
    expect(withdrawn).toEqual([["b1", "inbox_removed"]]);
    fake.on("DELETE", /bot-keys\/key_e1$/, { status: 204 });
    const tomb = await service.inboxDeleted("ibx_1");
    expect(tomb).toMatchObject({ botId: "b1", inboxId: "ibx_1", state: "removed", committed: true, keyId: "key_e1" });
    expect(tomb!.addressHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.getBinding("b1")).toBeNull();
    expect(secrets.botKey("b1")).toBeNull();
  });

  it("a crash during removal is carried on at boot; a 404 from #5 is done", async () => {
    await active();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, "reset");
    expect(await service.remove("b1")).toMatchObject({ state: "removing" });
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { state: "deleting" } }).on("GET", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")).on("DELETE", /bot-keys/, { status: 204 });
    await service.reconcileBindings();
    expect(store.getBinding("b1")).toBeNull();
    expect(store.getTombstone("b1", "ibx_1")).toMatchObject({ state: "removed" });
  });

  it("r2.5 #7: 202 closing records closing_until; a later #5 404 is deleted (key revoked, tombstone)", async () => {
    await active();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { object: "email.inbox", id: "ibx_1", state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
    expect(await service.remove("b1")).toMatchObject({ state: "remove_requested", closingUntil: "2026-12-01T00:00:00Z" });
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
    expect(await service.continueRemoval("b1")).toMatchObject({ state: "remove_requested" });
    fake.on("GET", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")).on("DELETE", /bot-keys\/key_e1$/, { status: 204 });
    expect(await service.continueRemoval("b1")).toMatchObject({ state: "removed", inboxId: "ibx_1" });
    expect(secrets.botKey("b1")).toBeNull();
  });

  it("Astra r1 High: a stale removal finishing after a new setup never erases the replacement binding or its key", async () => {
    await active();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { id: "ibx_1", state: "deleting" } }).on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "deleting" } });
    expect(await service.remove("b1")).toMatchObject({ state: "remove_requested" });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // the first completion (the deleted event) waits on its revoke; the second (a #5 404 on the next pass) finishes at once
    fake.on("DELETE", /bot-keys\/key_e1$/, async () => { await gate; return { status: 204 }; }).on("DELETE", /bot-keys\/key_e1$/, { status: 204 });
    const stale = service.inboxDeleted("ibx_1");
    fake.on("GET", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found"));
    expect(await service.continueRemoval("b1")).toMatchObject({ state: "removed", inboxId: "ibx_1" });
    expect(store.getBinding("b1")).toBeNull();
    // the owner sets the bot up again: a new op, key and inbox
    fake.on("POST", /bot-keys$/, { status: 200, body: { key: "sk-email-2", key_id: "key_e2", label: "bot-email:b1" } }).on("POST", /\/v1\/email\/inboxes$/, inbox({ id: "ibx_2", address: "juniper2@murage.email" }));
    expect(await service.enable("b1", {})).toMatchObject({ state: "active", inboxId: "ibx_2", emailKeyRef: "key_e2" });
    release();
    expect(await stale).toMatchObject({ inboxId: "ibx_1", state: "removed" });
    expect(store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_2", emailKeyRef: "key_e2" });
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_e2", token: "sk-email-2" });
    expect(fake.calls("DELETE", /bot-keys\/key_e2$/)).toHaveLength(0);
  });

  // Astra r2 High #4: a removal carries the generation it started from across every await; a replacement made meanwhile is never touched
  const gated = <T,>(reply: T) => { let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); return { release, reply: async () => { await gate; return reply; } }; };
  const setUpAgain = () => fake.on("POST", /bot-keys$/, { status: 200, body: { key: "sk-email-2", key_id: "key_e2", label: "bot-email:b1" } }).on("POST", /\/v1\/email\/inboxes$/, inbox({ id: "ibx_2", address: "juniper2@murage.email" }));
  const replacementIntact = () => {
    expect(store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_2", emailKeyRef: "key_e2" });
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_e2", token: "sk-email-2" });
    expect(fake.calls("DELETE", /bot-keys\/key_e2$/)).toHaveLength(0);
  };

  it("Astra r2 High #4 (a): a new setup that completes while a removal awaits the old inbox's read keeps its binding and key", async () => {
    await active();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { id: "ibx_1", state: "deleting" } }).on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "deleting" } });
    expect(await service.remove("b1")).toMatchObject({ state: "remove_requested" });
    const read = gated(fluxError(404, "inbox_not_found"));
    fake.on("GET", /\/inboxes\/ibx_1$/, read.reply);
    const stale = service.continueRemoval("b1"); // waits on #5 for the old inbox
    fake.on("DELETE", /bot-keys\/key_e1$/, { status: 204 });
    expect(await service.inboxDeleted("ibx_1")).toMatchObject({ inboxId: "ibx_1", state: "removed" });
    setUpAgain();
    expect(await service.enable("b1", {})).toMatchObject({ state: "active", inboxId: "ibx_2", emailKeyRef: "key_e2" });
    read.release();
    expect(await stale).toMatchObject({ inboxId: "ibx_2", state: "active" });
    replacementIntact();
    expect(store.getTombstone("b1", "ibx_2")).toBeNull();
  });

  it("Astra r2 High #4 (b): a normal removal clears the key and the binding; the binding delete is conditional on its generation", async () => {
    await active();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { id: "ibx_1", state: "deleting" } }).on("GET", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")).on("DELETE", /bot-keys\/key_e1$/, { status: 204 });
    const start = store.getBinding("b1")!;
    // a stale identity (another setup op, another key) deletes nothing, in one statement
    expect(store.deleteBindingGeneration({ ...start, opId: "op-other" })).toBe(false);
    expect(store.deleteBindingGeneration({ ...start, emailKeyRef: "key_other" })).toBe(false);
    expect(store.getBinding("b1")).not.toBeNull();
    expect(await service.remove("b1")).toMatchObject({ inboxId: "ibx_1", state: "removed", keyId: "key_e1" });
    expect(store.getBinding("b1")).toBeNull();
    expect(secrets.botKey("b1")).toBeNull();
    expect(fake.calls("DELETE", /bot-keys\/key_e1$/)).toHaveLength(1);
  });

  it("Astra r3: a rotation a crash cut short (new key saved, binding still names the old) is still revoked by the removal", async () => {
    await active();
    secrets.setBotKey("b1", { token: "sk-email-r", keyId: "key_r" }); // saved, then the app stopped before the binding recorded it
    expect(store.getBinding("b1")).toMatchObject({ emailKeyRef: "key_e1" });
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { id: "ibx_1", state: "deleting" } }).on("GET", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")).on("DELETE", /bot-keys\/key_r$/, { status: 204 });
    expect(await service.remove("b1")).toMatchObject({ inboxId: "ibx_1", state: "removed", keyId: "key_r" });
    expect(store.getBinding("b1")).toBeNull();
    expect(secrets.botKey("b1")).toBeNull();
    expect(fake.calls("DELETE", /bot-keys\/key_r$/)).toHaveLength(1);
  });

  it("Astra r2 High #4 (c): a removal a restart resumes never touches a binding set up while it waited", async () => {
    await active();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { id: "ibx_1", state: "deleting" } }).on("GET", /\/inboxes\/ibx_1$/, "reset");
    expect(await service.remove("b1")).toMatchObject({ state: "remove_requested" }); // the read never answered: the app stops here
    // restart: a new service over the same store and secrets; boot carries the removal on, its #5 read is slow
    const restarted = new EmailBindingService({ store, client, secrets, installId: "inst", now: () => clock, newId: () => `op-r${clock}` });
    const read = gated(fluxError(404, "inbox_not_found"));
    fake.on("GET", /\/inboxes\/ibx_1$/, read.reply);
    const boot = restarted.reconcileBindings();
    fake.on("DELETE", /bot-keys\/key_e1$/, { status: 204 });
    expect(await restarted.inboxDeleted("ibx_1")).toMatchObject({ inboxId: "ibx_1", state: "removed" });
    setUpAgain();
    expect(await restarted.enable("b1", {})).toMatchObject({ state: "active", inboxId: "ibx_2", emailKeyRef: "key_e2" });
    read.release();
    await boot;
    replacementIntact();
    expect(store.getTombstone("b1", "ibx_1")).toMatchObject({ state: "removed", keyId: "key_e1" });
  });

  it("Astra r1 Medium: email.inbox.deleted for a Flux-initiated closing inbox ends the binding (key revoked, tombstone)", async () => {
    await active();
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
    await service.refresh("b1");
    expect(store.getBinding("b1")).toMatchObject({ state: "closing" });
    fake.on("DELETE", /bot-keys\/key_e1$/, { status: 204 });
    expect(await service.inboxDeleted("ibx_1")).toMatchObject({ inboxId: "ibx_1", state: "removed" });
    expect(store.getBinding("b1")).toBeNull();
    expect(secrets.botKey("b1")).toBeNull();
  });

  it("r2.5: a bodiless bot-keys 404 on revoke is the dark switch, not a revoked key: the key stays saved", async () => {
    await active();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { state: "closing" } }).on("GET", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")).on("DELETE", /bot-keys\/key_e1$/, { status: 404 });
    await service.remove("b1");
    await service.continueRemoval("b1");
    expect(store.getBinding("b1")).toBeNull();
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_e1" });
  });

  it("Keep address (#37): a closing inbox comes back with the same address; the email key was never revoked", async () => {
    await active();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
    await service.remove("b1");
    fake.on("POST", /\/inboxes\/ibx_1\/restore$/, { status: 200, body: { id: "ibx_1", state: "active", address: "juniper@murage.email" } });
    expect(await service.keep("b1")).toMatchObject({ ok: true, row: { state: "active", closingUntil: null, address: "juniper@murage.email" } });
    expect(fake.calls("POST", /\/restore$/)[0]).toMatchObject({ body: { bot_id: "b1" }, headers: { authorization: "Bearer owner-token" } });
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_e1" });
    expect(fake.calls("DELETE", /bot-keys/)).toHaveLength(0);
    // a Flux-closed inbox (billing) restores to its pre-closing pause
    service.mirror("b1", "closing", "2026-12-02T00:00:00Z");
    fake.on("POST", /\/inboxes\/ibx_1\/restore$/, { status: 200, body: { id: "ibx_1", state: "paused" } });
    expect(await service.keep("b1")).toMatchObject({ ok: true, row: { state: "paused" } });
    expect(await service.keep("b1")).toEqual({ ok: false, code: "not_closing", status: 409 });
    service.mirror("b1", "closing", null);
    fake.on("POST", /\/inboxes\/ibx_1\/restore$/, fluxError(410, "restore_window_passed"));
    expect(await service.keep("b1")).toEqual({ ok: false, code: "restore_window_passed", status: 410 });
  });

  it("bot deletion: the intent is uncommitted until saveBots returns; boot settles it per its proof (R4, L2); the reaper removes", async () => {
    await active();
    service.recordDeletionIntent("b1");
    expect(store.getTombstone("b1", "ibx_1")).toMatchObject({ state: "removing", committed: false, reason: "bot_deleted" });
    // bot still there: dropped
    service.settleDeletionIntents(() => true, () => false);
    expect(store.getTombstone("b1", "ibx_1")).toBeNull();
    // bot absent, no proof: kept untouched for the next boot
    service.recordDeletionIntent("b1");
    service.settleDeletionIntents(() => false, () => false);
    expect(store.getTombstone("b1", "ibx_1")).toMatchObject({ committed: false });
    await service.reap();
    expect(fake.calls("DELETE", /\/inboxes\//)).toHaveLength(0); // the reaper acts only on committed intents
    // bot absent with its deletion proof: committed, and the reaper runs the removal
    service.settleDeletionIntents(() => false, () => true);
    expect(store.getTombstone("b1", "ibx_1")).toMatchObject({ committed: true });
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { state: "deleting" } }).on("GET", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")).on("DELETE", /bot-keys/, { status: 204 });
    await service.reap();
    expect(withdrawn).toEqual([["b1", "bot_deleted"]]);
    expect(store.getTombstone("b1", "ibx_1")).toMatchObject({ state: "removed", reason: "bot_deleted" });
    clock += 31 * 86_400_000;
    await service.reap();
    expect(store.getTombstone("b1", "ibx_1")).toBeNull();
  });

  it("saveBots failed: the intent leaves with the proof's rollback; commit marks it for the reaper", async () => {
    await active();
    service.recordDeletionIntent("b1");
    service.withdrawDeletionIntent("b1");
    expect(store.getTombstone("b1", "ibx_1")).toBeNull();
    service.recordDeletionIntent("b1");
    service.commitDeletionIntent("b1");
    expect(store.getTombstone("b1", "ibx_1")).toMatchObject({ committed: true });
  });
});

describe("the email setting kept in step with Flux (3.3)", () => {
  async function active() {
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, inbox());
    await service.enable("b1", {});
  }
  it("a change to ask applies at once even when Flux has not answered; boot re-sends the intent", async () => {
    await active();
    fake.on("PATCH", /\/inboxes\/ibx_1$/, "reset");
    expect(await service.setPolicy("b1", "ask")).toMatchObject({ policy: "ask" });
    expect(store.getPolicySync("b1")).toMatchObject({ state: "pending", policy: "ask" });
    fake.on("PATCH", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", send_policy: "ask" } });
    await service.reconcileBindings();
    expect(store.getPolicySync("b1")).toMatchObject({ state: "confirmed" });
    expect(fake.calls("PATCH", /\/inboxes\/ibx_1$/).map(call => call.body)).toEqual([{ send_policy: "ask" }, { send_policy: "ask" }]);
  });
  it("a change to auto applies only after Flux confirms", async () => {
    await active();
    fake.on("PATCH", /\/inboxes\/ibx_1$/, { status: 200, body: {} });
    await service.setPolicy("b1", "ask");
    fake.on("PATCH", /\/inboxes\/ibx_1$/, fluxError(403, "owner_required"));
    expect(await service.setPolicy("b1", "auto")).toMatchObject({ policy: "ask" });
    fake.on("PATCH", /\/inboxes\/ibx_1$/, { status: 200, body: {} });
    await service.reconcileBindings();
    expect(store.getBinding("b1")!.policy).toBe("auto");
  });
});

describe("the tables are registered (snapshot and lifecycle)", () => {
  it("every email table and index is on the additions list, and every table has a lifecycle entry", () => {
    for (const table of EMAIL_TABLES) { expect(APP_SCHEMA_102_ADDITIONS.tables).toContain(table); expect(ADDED_TABLE_LIFECYCLE[table], table).toBeDefined(); }
    for (const index of EMAIL_INDEXES) expect(APP_SCHEMA_102_ADDITIONS.indexes).toContain(index);
  });
  it("an archive that holds the email tables passes the installation inspector", () => {
    const db = new DatabaseSync(":memory:");
    initializeMessageTables(db);
    initializeEmailTables(db);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.exec("CREATE TABLE email_rogue (x)");
    expect(() => inspectInstallationDatabase(db)).toThrow();
  });
});
