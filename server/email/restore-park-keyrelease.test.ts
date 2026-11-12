// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park, kept-key release on Remove (r3.4d keptKeysProtected: a kept key LEAVES keptKeys only when its key is revoked or a Remove completes; invariants.current.ts line 76, r3.3i C).
// A Remove still in flight keeps the mark; a completed Remove, a finished park-only Remove and a finished orphan key release drop only the keys they ended.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { prepareRestoredEmail } from "./restore.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
let fake: FakeFlux;
let db: DatabaseSync;
let runtime: EmailRuntime;
let clock: number;
let botGone = false;
let waits: number[] = [];
let logs: string[] = [];

const make = () => new EmailRuntime({
  accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
  now: () => clock, sleep: async ms => { waits.push(ms); }, log: line => { logs.push(line); }, workspaceRoot: () => undefined, bot: id => (botGone ? undefined : ({ id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord)), deletionProof: () => true,
});
const boot = async () => {
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  runtime.secrets.setBotKey("b1", { token: "bot-key", keyId: "key_old" });
  await runtime.probe.refresh();
  await runtime.start();
  runtime.stop();
};
const svc = () => runtime.services()!;
const binding = { botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, step: null, opId: "op1", opStartedAt: null, policy: "auto", failure: null, updatedAt: 0 };
const restored = async (state: string) => {
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  await runtime.probe.refresh();
  runtime.stop();
  svc().store.insertBinding({ ...binding, state } as never);
  prepareRestoredEmail(db);
};
/** A Keep that succeeds (Flux says the inbox is active), after the restore parked a removing binding. */
const keepOk = async () => {
  fake.on("GET", /\/inboxes\/ibx_1$/, () => ({ status: 200, body: { id: "ibx_1", state: "active" } }));
  expect(await svc().bindings.keep("b1")).toMatchObject({ ok: true });
};
const revokes = () => fake.calls("DELETE", /bot-keys/);
const kept = (key: string) => svc().store.isKeptKey(key);
const inboxGone = () => fake.on("DELETE", /\/inboxes\/ibx_1$/, () => ({ status: 404, body: { error: { code: "inbox_not_found" } } }));
const revokeAnswers = (status: number) => fake.on("DELETE", /bot-keys\/key_old$/, () => (status === 204 ? { status } : { status, body: { error: { code: "server_error" } } }));

/** A kept binding (a restore parked it, Keep succeeded: key_old marked), another bot's key marked too, then the owner Removes it. */
const keptThenRemove = async (script: () => void) => {
  await restored("removing");
  await boot();
  await keepOk();
  svc().store.markKeptKey("key_other", "keep:b2", clock);
  expect(kept("key_old")).toBe(true);
  script();
  await svc().bindings.remove("b1");
};
/** A park with no binding (intent-only), both keys kept, owner Remove. */
const parkOnlyRemove = async (script: () => void) => {
  await restored("removal_parked");
  db.exec("DELETE FROM email_bindings WHERE bot_id='b1'");
  await boot();
  expect(svc().store.getPark("b1")).toMatchObject({ state: "parked" });
  svc().store.markKeptKey("key_old", "keep:b1", clock);
  svc().store.markKeptKey("key_other", "keep:b2", clock);
  script();
  await svc().bindings.remove("b1");
};

beforeEach(() => { clock = 1_800_000_000_000; botGone = false; waits = []; logs = []; fake = new FakeFlux(); db = new DatabaseSync(":memory:"); fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS }); });
afterEach(() => runtime?.stop());

describe("restore park keyrelease: a completed Remove releases the kept key (keptKeysProtected; r3.3i C)", () => {
  it("KR-1: Remove completes (DELETE 404, key revoked): the tombstone is removed and key_old is no longer kept", async () => {
    await keptThenRemove(() => { inboxGone(); revokeAnswers(204); });
    expect(svc().store.getTombstone("b1", "ibx_1")).toMatchObject({ state: "removed" });
    expect(revokes()).toHaveLength(1);
    expect(kept("key_old")).toBe(false);
  });
  it("KR-2: Remove accepted but still closing at Flux: the mark stays (a Keep can still come)", async () => {
    await keptThenRemove(() => {
      fake.on("DELETE", /\/inboxes\/ibx_1$/, () => ({ status: 202, body: { id: "ibx_1", state: "closing" } }));
      fake.on("GET", /\/inboxes\/ibx_1$/, () => ({ status: 200, body: { id: "ibx_1", state: "closing" } }));
    });
    expect(svc().store.getBinding("b1")?.state).toBe("remove_requested");
    expect(kept("key_old")).toBe(true);
  });
  it("KR-3: the release drops only the removed key; another bot's kept key stays marked", async () => {
    await keptThenRemove(() => { inboxGone(); revokeAnswers(204); });
    expect(kept("key_old")).toBe(false);
    expect(kept("key_other")).toBe(true);
  });
});

describe("restore park keyrelease: a park-only Remove and an orphan key release end the mark with the key", () => {
  it("KR-4: park-only Remove completes (DELETE 404, revoke 204): park gone, key_old released, key_other kept", async () => {
    await parkOnlyRemove(() => { inboxGone(); revokeAnswers(204); });
    expect(svc().store.getPark("b1")).toBeNull();
    expect(kept("key_old")).toBe(false);
    expect(kept("key_other")).toBe(true);
  });
  it("KR-5: park-only Remove whose revoke fails: the park stays and the mark stays", async () => {
    await parkOnlyRemove(() => { inboxGone(); revokeAnswers(500); });
    expect(svc().store.getPark("b1")).not.toBeNull();
    expect(kept("key_old")).toBe(true);
  });
  const orphanRelease = async (status: number) => {
    await restored("removal_parked");
    db.exec("DELETE FROM email_bindings WHERE bot_id='b1'");
    botGone = true;
    await boot();
    const park = svc().store.getPark("b1")!;
    svc().store.casPark("b1", park.parkRev, { state: "key_release", keyId: "key_old" });
    svc().store.markKeptKey("key_old", "keep:b1", clock);
    svc().store.markKeptKey("key_other", "keep:b2", clock);
    revokeAnswers(status);
    await svc().bindings.releaseOrphanKey("b1");
  };
  it("KR-6: an orphan key release whose revoke fails keeps the mark and the park", async () => {
    await orphanRelease(500);
    expect(svc().store.getPark("b1")).not.toBeNull();
    expect(kept("key_old")).toBe(true);
  });
  it("KR-7: an orphan key release whose revoke answers ok drops the mark with the key and the park; another key stays", async () => {
    await orphanRelease(204);
    expect(svc().store.getPark("b1")).toBeNull();
    expect(kept("key_old")).toBe(false);
    expect(kept("key_other")).toBe(true);
  });
});

/** A revoke that answered 404 is only a claim: the kept mark leaves only when one confirming read of the key also shows it absent. */
describe("restore park keyrelease: a key revoke 404 is confirmed by a read before the mark leaves", () => {
  const revoke404 = (body = true) => fake.on("DELETE", /bot-keys\/key_old$/, () => (body ? { status: 404, body: { error: { code: "key_not_found" } } } : { status: 404 }));
  const keyRead = (answer: () => { status: number; body?: unknown }) => fake.always("GET", /bot-keys\/key_old$/, answer);
  const keyReads = () => fake.calls("GET", /bot-keys\/key_old$/);
  const opsLines = () => logs.filter(line => line.startsWith("[email-ops] key_release_unconfirmed"));
  const absent = () => ({ status: 404, body: { error: { code: "key_not_found" } } });

  it("KR-8: Remove, revoke 404 then the read shows the key absent: one read, the mark is released, no alert", async () => {
    await keptThenRemove(() => { inboxGone(); revoke404(); keyRead(absent); });
    expect(svc().store.getTombstone("b1", "ibx_1")).toMatchObject({ state: "removed" });
    expect(keyReads()).toHaveLength(1);
    expect(kept("key_old")).toBe(false);
    expect(kept("key_other")).toBe(true);
    expect(opsLines()).toHaveLength(0);
  });
  it("KR-9: Remove, revoke 404 then the read shows the key present: the mark is kept and the key stays saved", async () => {
    await keptThenRemove(() => { inboxGone(); revoke404(); keyRead(() => ({ status: 200, body: { key_id: "key_old" } })); });
    expect(keyReads()).toHaveLength(1);
    expect(kept("key_old")).toBe(true);
    expect(runtime.secrets.botKey("b1")).toMatchObject({ keyId: "key_old" });
    expect(opsLines()).toHaveLength(0);
  });
  it("KR-10: Remove, revoke 404 then the read errors every time: 3 reads with the stated waits, the mark is kept, one alert line", async () => {
    await keptThenRemove(() => { inboxGone(); revoke404(); keyRead(() => ({ status: 400, body: { error: { code: "bad_request" } } })); });
    expect(keyReads()).toHaveLength(3);
    expect(waits).toEqual([2_000, 10_000]);
    expect(kept("key_old")).toBe(true);
    expect(runtime.secrets.botKey("b1")).toMatchObject({ keyId: "key_old" });
    expect(opsLines()).toHaveLength(1);
    expect(opsLines()[0]).toContain("inbox=ibx_1");
    expect(opsLines()[0]).not.toContain("juniper@");
  });
  it("KR-11: the read errors once, then shows the key absent: released after the retry, no alert", async () => {
    let n = 0;
    await keptThenRemove(() => { inboxGone(); revoke404(); keyRead(() => (++n === 1 ? { status: 400, body: { error: { code: "bad_request" } } } : absent())); });
    expect(keyReads()).toHaveLength(2);
    expect(waits).toEqual([2_000]);
    expect(kept("key_old")).toBe(false);
    expect(opsLines()).toHaveLength(0);
  });
  it("KR-12: a bodiless (dark) revoke 404 whose read is dark too proves nothing: the mark is kept and the alert is raised", async () => {
    await keptThenRemove(() => { inboxGone(); revoke404(false); keyRead(() => ({ status: 404 })); });
    expect(keyReads()).toHaveLength(3);
    expect(kept("key_old")).toBe(true);
    expect(opsLines()).toHaveLength(1);
  });
  it("KR-13: park-only Remove, revoke 404 and the read shows the key absent: park gone, mark released", async () => {
    await parkOnlyRemove(() => { inboxGone(); revoke404(); keyRead(absent); });
    expect(svc().store.getPark("b1")).toBeNull();
    expect(kept("key_old")).toBe(false);
    expect(kept("key_other")).toBe(true);
  });
  it("KR-14: park-only Remove, revoke 404 and the read errors: the park and the mark stay, one alert line", async () => {
    await parkOnlyRemove(() => { inboxGone(); revoke404(); keyRead(() => ({ status: 400, body: { error: { code: "bad_request" } } })); });
    expect(keyReads()).toHaveLength(3);
    expect(svc().store.getPark("b1")).not.toBeNull();
    expect(kept("key_old")).toBe(true);
    expect(opsLines()).toHaveLength(1);
  });
  it("KR-15: park-only Remove, revoke 404 and the read shows the key present: the park and the mark stay", async () => {
    await parkOnlyRemove(() => { inboxGone(); revoke404(); keyRead(() => ({ status: 200, body: {} })); });
    expect(svc().store.getPark("b1")).not.toBeNull();
    expect(kept("key_old")).toBe(true);
  });
  it("KR-16: Remove whose revoke fails outright (500): the mark is kept, the key stays saved", async () => {
    await keptThenRemove(() => { inboxGone(); revokeAnswers(500); });
    expect(kept("key_old")).toBe(true);
    expect(runtime.secrets.botKey("b1")).toMatchObject({ keyId: "key_old" });
  });
});
