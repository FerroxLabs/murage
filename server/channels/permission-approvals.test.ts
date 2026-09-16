import { expect, it, vi } from "vitest";
import { PermissionApprovals, type PermissionAction } from "./permission-approvals.ts";
import type { TelegramApproval } from "../telegram-approvals.ts";

function fixture() {
  let now = 1000, active = true;
  let pending: TelegramApproval[] = [{ id: "card", fingerprint: "original", summary: "Write fixture.txt" }];
  const resolve = vi.fn(async () => true);
  const send = vi.fn(async (_input: Parameters<import("./permission-approvals.ts").PermissionMessages["send"]>[0]) => ({ messageId: "30" }));
  const settle = vi.fn(async (_input: Parameters<import("./permission-approvals.ts").PermissionMessages["settle"]>[0]) => {});
  const options = { provider: "discord" as const, applicationId: "10", ownerUserId: "20", dmId: "25", maxText: 2000,
    actions: { pending: () => pending, resolve }, messages: { send, settle }, active: () => active, now: () => now };
  const manager = new PermissionApprovals(options);
  const event = (deny = false): PermissionAction => ({ provider: "discord", applicationId: "10", userId: "20", channelId: "25", messageId: "30",
    actionId: send.mock.calls.at(-1)![0][deny ? "denyId" : "approveId"], ack: async () => {} });
  return { manager, options, event, send, settle, resolve, pending: (value: TelegramApproval[]) => { pending = value; },
    expire: () => { now += 600001; }, disconnect: () => { active = false; } };
}
it.each([false, true])("resolves the exact pending card once, deny=%s", async deny => {
  const f = fixture(); await f.manager.publish();
  expect(f.send.mock.calls[0][0].text).toContain("Write fixture.txt");
  expect(await f.manager.receive(f.event(deny))).toBe(true);
  expect(await f.manager.receive(f.event(deny))).toBe(false);
  expect(f.resolve).toHaveBeenCalledExactlyOnceWith({ id: "card", fingerprint: "original", summary: "Write fixture.txt" }, deny ? "deny" : "allow");
  expect(f.settle.mock.calls[0][0].text).toContain(deny ? "Denied." : "Approved once.");
});
it("rejects wrong provider, app, team, owner, DM, message and ordinary text without consuming the offer", async () => {
  const f = fixture(); await f.manager.publish();
  for (const patch of [{ provider: "slack" as const }, { applicationId: "11" }, { teamId: "T1" }, { userId: "21" },
    { channelId: "26" }, { messageId: "31" }, { actionId: "yes" }]) {
    expect(await f.manager.receive({ ...f.event(), ...patch })).toBe(false);
  }
  expect(f.resolve).not.toHaveBeenCalled(); expect(await f.manager.receive(f.event())).toBe(true);
});
it.each(["expired", "changed", "answered", "inactive", "cleared"])("rejects %s offers", async kind => {
  const f = fixture(); await f.manager.publish(); const event = f.event();
  if (kind === "expired") f.expire();
  if (kind === "changed") f.pending([{ id: "card", fingerprint: "changed", summary: "Delete fixture.txt" }]);
  if (kind === "answered") f.pending([]);
  if (kind === "inactive") f.disconnect();
  if (kind === "cleared") f.manager.clear();
  expect(await f.manager.receive(event)).toBe(false); expect(f.resolve).not.toHaveBeenCalled();
});
it("concurrent taps and failed decision or cosmetic edit never replay", async () => {
  const f = fixture(); await f.manager.publish();
  f.resolve.mockRejectedValueOnce(new Error("uncertain")); f.settle.mockRejectedValueOnce(new Error("offline"));
  await Promise.all([f.manager.receive(f.event()), f.manager.receive(f.event(true))]);
  await f.manager.publish(); expect(f.resolve).toHaveBeenCalledTimes(1); expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.settle.mock.calls[0][0].text).toContain("unconfirmed");
});
it("uncertain publication is not repeated and cannot authorize without a message receipt", async () => {
  const f = fixture(); f.send.mockRejectedValueOnce(new Error("uncertain"));
  await expect(f.manager.publish()).rejects.toThrow("uncertain"); await f.manager.publish();
  expect(f.send).toHaveBeenCalledTimes(1); expect(await f.manager.receive(f.event())).toBe(false);
  expect(f.resolve).not.toHaveBeenCalled();
});
it("never truncates a long summary or turns a question into a permission", async () => {
  const f = fixture(); f.pending([{ id: "long", fingerprint: "1", summary: "x".repeat(2000) },
    { id: "question", fingerprint: "2", summary: "Choose", questions: [{ id: "q", question: "Which?", options: [], multiSelect: false, allowOther: true }] }]);
  await f.manager.publish(); expect(f.send).not.toHaveBeenCalled();
});
it("restart uses a new nonce and rejects old buttons even for the same pending card", async () => {
  const f = fixture(); await f.manager.publish(); const old = f.event(); f.manager.clear();
  const restarted = new PermissionApprovals(f.options); await restarted.publish();
  expect(await restarted.receive(old)).toBe(false); expect(await restarted.receive(f.event())).toBe(true);
});
it("stop during publication aborts send and fences late receipts", async () => {
  const f = fixture(); let finish!: (value: { messageId: string }) => void;
  f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const publishing = f.manager.publish(); f.manager.clear();
  expect(f.send.mock.calls[0][0].signal.aborted).toBe(true);
  finish({ messageId: "30" }); await publishing;
  expect(await f.manager.receive(f.event())).toBe(false); expect(f.resolve).not.toHaveBeenCalled();
});
