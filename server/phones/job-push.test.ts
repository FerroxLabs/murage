// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S15: the phone job push hooks. A parked job pushes once to the chosen phone, a job that ends unleased withdraws it,
// and nothing of the job (action, say, arguments, result) rides on the push.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { PushStore, initializeMobilePush } from "../mobile-push-store.ts";
import { PushOutbox } from "../mobile-push-outbox.ts";
import { pushDetail } from "../mobile-push-detail.ts";
import { deviceJobPush } from "./job-push.ts";
import type { PhoneJobInfo } from "./jobs.ts";

const B1 = "3f6c1a52-8d1e-4b7a-9c2e-5a0d7e41b9f3";
const B2 = "a1b2c3d4-e5f6-4a1b-8c2d-9e0f1a2b3c4d";
const info: PhoneJobInfo = {
  operationId: "00000000-0000-4000-8000-000000000001", deviceId: "d2", eventRef: "e".repeat(64), capability: "calendar", action: "calendar.read",
  botId: "scout", say: "SECRET read your calendar for today", phoneName: "Sean's phone", threadId: "t1", expiresAt: 1_120_000,
};
function rig(over: { capable?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  initializeMobilePush(db);
  const store = new PushStore(db);
  store.putBinding({ bindingId: B1, deviceId: "d1", publisherToken: "murage_pt_1", createdAt: 1 });
  store.putBinding({ bindingId: B2, deviceId: "d2", publisherToken: "murage_pt_2", createdAt: 2 });
  const sender = { publish: vi.fn(async () => "accepted" as const) };
  const outbox = new PushOutbox({
    store, sender, now: () => 1_000_000,
    world: { visible: () => true, present: () => true, badge: () => 0, latestMessageId: () => undefined, stillPending: () => true, risk: () => "unrated", timeSensitive: () => false, actionable: () => false, deviceJobCapable: () => over.capable !== false },
  });
  const hooks = deviceJobPush({ bindingIdForDevice: (id) => store.bindingForDevice(id)?.bindingId ?? null, outbox });
  return { store, outbox, sender, hooks };
}

describe("deviceJobPush", () => {
  it("park queues one push for the chosen phone's binding only, expiring with the job", async () => {
    const t = rig();
    t.hooks.park(info);
    expect(t.store.latestForRequest(B1, info.operationId)).toBeNull();
    expect(t.store.latestForRequest(B2, info.operationId)).toMatchObject({ category: "device-job", state: "pending", expiresAt: info.expiresAt, threadId: "t1" });
    await t.outbox.flush();
    expect(t.sender.publish).toHaveBeenCalledTimes(1);
  });
  it("nothing of the job rides on the push: not the relay event, the stored row, or the detail text", async () => {
    const t = rig();
    t.hooks.park({ ...info, say: "ARGS-AND-RESULT-MARKER", action: "calendar.read" });
    await t.outbox.flush();
    const [, event] = t.sender.publish.mock.calls[0] as unknown as [unknown, unknown];
    const row = t.store.latestForRequest(B2, info.operationId);
    const detail = pushDetail(row!, { bot: () => ({ id: "scout", name: "Scout", threadId: "t1" }), message: () => { throw new Error("never read"); }, prefs: undefined, previewContent: true, deviceJob: () => ({ capability: "calendar" }) }, new Date());
    for (const text of [JSON.stringify(event), JSON.stringify(row), JSON.stringify(detail)]) expect(text).not.toMatch(/ARGS-AND-RESULT-MARKER|SECRET|calendar\.read|Sean's phone/);
    expect(detail.body).toBe("Scout wants to use your calendar. Open Murage to allow it.");
  });
  it("park for a phone with no binding, or one that cannot run jobs, queues nothing and does not throw", () => {
    const t = rig();
    expect(() => t.hooks.park({ ...info, deviceId: "unknown" })).not.toThrow();
    const u = rig({ capable: false });
    u.hooks.park(info);
    expect(u.store.latestForRequest(B2, info.operationId)).toBeNull();
  });
  it("withdraw drops an unsent push, and replaces a delivered one", async () => {
    const t = rig();
    t.hooks.park(info);
    t.hooks.withdraw(info);
    expect(t.store.latestForRequest(B2, info.operationId)!.state).toBe("dropped");
    const u = rig();
    u.hooks.park(info);
    await u.outbox.flush();
    u.hooks.withdraw(info);
    expect(u.store.latestForRequest(B2, info.operationId)).toMatchObject({ category: "resolved", resolvedBy: "elsewhere" });
  });
});
