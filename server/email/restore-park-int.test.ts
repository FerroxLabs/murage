// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park, int wave 1: the owner routes pass the park_rev the owner saw (read before the phone's fresh-proof await) to the gate. A park that moved while the phone
// proof was pending answers confirm_expired (ownerRouteLine) and touches nothing at Flux. A3 left the routes passing no park_rev.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { prepareRestoredEmail } from "./restore.ts";
import { emailOwnerRoute, type OwnerRouteDeps } from "./owner-routes.ts";
import { createParkPort } from "./park-port.ts";
import { botScope, tokensFor } from "./owner-view.ts";
import { ownerRouteLine } from "../../shared/email-copy.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
let fake: FakeFlux, db: DatabaseSync, runtime: EmailRuntime, clock: number;
const botRec = (id: string) => ({ id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord);
const make = () => new EmailRuntime({
  accountKey: () => "sk-acct", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", now: () => clock,
  workspaceRoot: () => undefined, bot: botRec, deletionProof: () => true,
});
const svc = () => runtime.services()!;
const deletes = () => fake.calls("DELETE", /\/v1\/email\/inboxes\//);
const restores = () => fake.calls("POST", /\/v1\/email\/inboxes\/ibx_1\/restore$/);
const binding = { botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, step: null, opId: "op1", opStartedAt: null, policy: "auto", failure: null, updatedAt: 0 };
const boot = async () => {
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-tok", keyId: "key_owner" });
  runtime.secrets.setBotKey("b1", { token: "bot-key", keyId: "key_old" });
  await runtime.probe.refresh();
  runtime.stop();
};
/** A restore parked b1 (binding removal_parked, park row at park_rev 0). */
const parked = async () => {
  await boot();
  svc().store.insertBinding({ ...binding, state: "removal_parked" } as never);
  prepareRestoredEmail(db);
  await boot();
  await runtime.start();
  runtime.stop();
};
/** The phone's fresh proof is pending; while it is, the park moves (park_rev + 1). */
const deps = (moveDuringProof: boolean): OwnerRouteDeps => ({
  runtime, bot: id => (id === "b1" ? botRec("b1") : undefined), fluxKeyPresent: () => true, now: () => clock, parks: createParkPort(runtime),
  freshProof: async () => { if (moveDuringProof) svc().store.casPark("b1", svc().store.getPark("b1")!.parkRev, { address: "juniper@murage.email" }); return null; },
});
const phone = (d: OwnerRouteDeps, path: string, body: unknown) => emailOwnerRoute(d, { method: "POST", path, query: new URL(`http://x${path}`).searchParams, body, surface: "phone", botCredential: false });

beforeEach(() => {
  clock = 1_800_000_000_000; fake = new FakeFlux(); db = new DatabaseSync(":memory:");
  fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
  fake.always("GET", /^\/v1\/email\/settings$/, { status: 200, body: { limits: {} } });
  fake.on("GET", /\/inboxes\/ibx_1$/, () => ({ status: 200, body: { id: "ibx_1", state: "active" } }));
});
afterEach(() => runtime?.stop());

describe("restore park int: owner routes carry park_rev", () => {
  it("INT-1: phone Keep on a parked bot whose park moved during the proof is confirm_expired with the ownerRouteLine, and nothing is restored at Flux", async () => {
    await parked();
    expect(svc().store.getPark("b1")!.parkRev).toBe(0);
    const answer = await phone(deps(true), "/api/email/bots/b1/keep", {});
    expect(answer).toMatchObject({ status: 409, body: { code: "confirm_expired", error: ownerRouteLine("confirm_expired") } });
    expect(restores()).toHaveLength(0);
    expect(svc().store.getPark("b1")!.state).toBe("parked");
  });
  it("INT-2: phone Remove (bot route, confirm) on a park that moved during the proof is confirm_expired and sends no DELETE", async () => {
    await parked();
    db.exec("UPDATE email_bindings SET state='active' WHERE bot_id='b1'"); // the park record outlives the binding state: the bot route's own remove path
    const answer = await phone(deps(true), "/api/email/bots/b1/remove", { confirm: true });
    expect(answer).toMatchObject({ status: 409, body: { code: "confirm_expired", error: ownerRouteLine("confirm_expired") } });
    expect(deletes()).toHaveLength(0);
  });
  it("INT-3: with no move the same phone Remove goes through", async () => {
    await parked();
    db.exec("UPDATE email_bindings SET state='active' WHERE bot_id='b1'");
    fake.on("DELETE", /\/v1\/email\/inboxes\/ibx_1$/, () => ({ status: 200, body: { id: "ibx_1", state: "removing" } }));
    const answer = await phone(deps(false), "/api/email/bots/b1/remove", { confirm: true });
    expect(answer!.status).toBe(200);
    expect(svc().store.getPark("b1")).toMatchObject({ state: "remove_authorized", authorizedBy: "bot_section" });
  });
  it("INT-4: the tokened bot Remove (token minted on the bot row) also carries the park_rev: a park that moved during the proof is confirm_expired, no DELETE", async () => {
    await parked();
    db.exec("UPDATE email_bindings SET state=\x27active\x27 WHERE bot_id=\x27b1\x27");
    const token = tokensFor(runtime).mint(botScope(svc().store.getBinding("b1")!, "remove"), clock);
    const answer = await phone(deps(true), "/api/email/bots/b1/remove", { token });
    expect(answer).toMatchObject({ status: 409, body: { code: "confirm_expired", error: ownerRouteLine("confirm_expired") } });
    expect(deletes()).toHaveLength(0);
  });
});
