// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park: runtime invariant for park.refused_kept (restore-reducer.ts parkBinding line 108, REFUSED-KEPT-REACH.md).
// MurageMain ruled the state unreachable (witness: direct-drive test M3 in s23.test.ts). If product code ever enters it, ONE ops alert line is written, the data is kept, nothing changes.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
let fake: FakeFlux;
let db: DatabaseSync;
let runtime: EmailRuntime;
let clock: number;
let logs: string[];

const make = () => new EmailRuntime({
  accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
  now: () => clock, workspaceRoot: () => undefined, bot: id => ({ id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord), deletionProof: () => true,
  log: (line: string) => { logs.push(line); },
});
const svc = () => runtime.services()!;
const deletes = () => fake.calls("DELETE", /\/v1\/email\/inboxes\//);
const binding = { botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, step: null, opId: "op1", opStartedAt: null, policy: "auto", failure: null, updatedAt: 1, revision: 1, closingUntil: null, createdAt: 1 };
const ops = () => logs.filter(l => l.startsWith("[email-ops]"));

beforeEach(async () => {
  clock = 1_800_000_000_000; logs = []; fake = new FakeFlux(); db = new DatabaseSync(":memory:");
  fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  runtime.secrets.setBotKey("b1", { token: "bot-key", keyId: "key_old" });
  await runtime.probe.refresh();
  runtime.stop();
});
afterEach(() => runtime?.stop());

describe("restore park runtime invariant: park.refused_kept is never silent", () => {
  it("RK-1: a lease-less removing binding on a kept key writes ONE ops line, keeps the data, changes nothing", async () => {
    svc().store.insertBinding({ ...binding, state: "removing" } as never);
    svc().store.markKeptKey("key_old", "keep:b1", clock);
    const before = JSON.stringify(svc().store.getBinding("b1"));
    await svc().bindings.resumeRemovals();
    await svc().bindings.resumeRemovals(); // a second tick must not repeat the line
    expect(ops()).toHaveLength(1);
    const line = ops()[0];
    expect(line).toContain("park_refused_kept");
    expect(line).toContain("bot=b1");
    expect(line).toContain("inbox=ibx_1");
    expect(line.toLowerCase()).not.toContain("juniper@murage.email");
    expect(line).not.toMatch(/[\u2013\u2014]|\b(safe|unsafe|safety|free|forge)\b|will fail/i);
    expect(JSON.stringify(svc().store.getBinding("b1"))).toBe(before);
    expect(svc().store.getBinding("b1")?.state).toBe("removing");
    expect(svc().store.getPark("b1")).toBeNull();
    expect(svc().store.isKeptKey("key_old")).toBe(true);
    expect(deletes()).toHaveLength(0);
  });
  it("RK-2: without a kept key the same binding is parked and no refused_kept line is written", async () => {
    svc().store.insertBinding({ ...binding, state: "removing" } as never);
    await svc().bindings.resumeRemovals();
    expect(ops().filter(l => l.includes("park_refused_kept"))).toHaveLength(0);
    expect(svc().store.getBinding("b1")?.state).toBe("removal_parked");
  });
  it("RK-3: a throwing ops sink never changes the outcome (data kept)", async () => {
    runtime = new EmailRuntime({
      accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
      now: () => clock, workspaceRoot: () => undefined, bot: id => ({ id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord), deletionProof: () => true,
      log: () => { throw new Error("sink down"); },
    });
    await runtime.probe.refresh(); runtime.stop();
    svc().store.insertBinding({ ...binding, state: "removing" } as never);
    svc().store.markKeptKey("key_old", "keep:b1", clock);
    await svc().bindings.resumeRemovals();
    expect(svc().store.getBinding("b1")?.state).toBe("removing");
    expect(svc().store.isKeptKey("key_old")).toBe(true);
  });
});
