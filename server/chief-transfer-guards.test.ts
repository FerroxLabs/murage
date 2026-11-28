// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CHIEF-TRANSFER-1023 W21 (the real manageBot, from a No-limits sender) and the D1 guard predicate behind PATCH /api/bots/:id (W3's matrix; the
// route itself is exercised over HTTP in chief-transfer-api.test.ts).
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { Store } from "./store.ts";
import { managedBotProfile, manageBot, organizationRevision } from "./bot-management.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const noLimitsThread = vi.hoisted(() => ({ on: true }));
vi.mock("./service-no-limits.ts", async importOriginal => ({ ...(await importOriginal<typeof import("./service-no-limits.ts")>()), serviceThreadNoLimits: () => noLimitsThread.on }));

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); noLimitsThread.on = true; });

function setup() {
  const store = new Store(() => ({ instanceId: "fixture", model: "model" }));
  const chief = store.createBot({ name: "Chief" });
  const second = store.createBot({ name: "Second" });
  store.setChiefOfStaff(chief.id, undefined, "workspace");
  const stage = vi.fn(() => ({ id: "x", pendingReview: true, startsWhen: "later" }));
  const options = { threadId: "thread-1", pendingWork: () => false, validateSelection: () => ({ instanceId: "fixture", model: "model" }), validateLeader: vi.fn(), revoke: vi.fn() };
  return { store, chief, second, options, stage };
}
const botsBytes = () => readFileSync(join(DATA_DIR, "bots.json"), "utf8");

describe("W21 manageBot set-lead on the workspace Chief", () => {
  for (const senderName of ["chief", "second"] as const) {
    for (const staged of [false, true]) {
      it(`refuses with 409 chief-transfer-required from the ${senderName} (No limits)${staged ? ", also when staging is on" : ""}`, () => {
        const w = setup();
        const sender = w[senderName];
        const before = botsBytes(), epoch = w.store.chiefEpoch;
        const request = { action: "set-lead", botId: w.chief.id, revision: managedBotProfile(w.chief).revision, organizationRevision: organizationRevision(w.store, sender, true) };
        let thrown: (Error & { status?: number; code?: string }) | undefined;
        try { manageBot(w.store, sender, request, { ...w.options, ...(staged ? { stage: w.stage } : {}) }); } catch (error) { thrown = error as Error; }
        expect(thrown?.status).toBe(409);
        expect(thrown?.code).toBe("chief-transfer-required");
        expect(thrown?.message).toContain("Choose a new Chief first");
        expect(w.stage).not.toHaveBeenCalled();
        expect(botsBytes()).toBe(before);
        expect(w.store.chiefEpoch).toBe(epoch);
        expect(w.store.bot(w.chief.id)).toMatchObject({ chiefOfStaff: true, chiefScope: "workspace" });
        expect(w.store.workspaceChief()?.id).toBe(w.chief.id);
      });
    }
  }
});

describe("D1 guard predicate (the matrix W3 drives over HTTP)", () => {
  it("guards the Chief's hide, demote and tier change, and a direct election on another bot, and nothing else", async () => {
    const { chiefTransferRequired } = await import("./chief-transfer.ts");
    const w = setup();
    const guard = (id: string, body: Record<string, unknown>) => chiefTransferRequired(w.store, id, body);
    expect(guard(w.chief.id, { hidden: true })).toBe(true);
    expect(guard(w.chief.id, { chiefOfStaff: false })).toBe(true);
    expect(guard(w.chief.id, { chiefScope: "section" })).toBe(true);
    expect(guard(w.second.id, { chiefOfStaff: true, chiefScope: "workspace" })).toBe(true);
    expect(guard(w.chief.id, { chiefScope: "workspace" })).toBe(false);
    expect(guard(w.chief.id, { title: "renamed" })).toBe(false);
    expect(guard(w.second.id, { hidden: true })).toBe(false);
    expect(guard(w.second.id, { chiefOfStaff: true })).toBe(false);
    w.store.setChiefOfStaff(null, undefined, "workspace");
    expect(w.store.workspaceChief()).toBeNull();
    expect(guard(w.second.id, { chiefOfStaff: true, chiefScope: "workspace" })).toBe(false);
  });
});
