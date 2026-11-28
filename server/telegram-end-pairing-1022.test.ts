import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TelegramChannel } from "./telegram-channel.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
const message = (id: number, text: string) => ({ update_id: id, message: { message_id: id + 1, date: 1, from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" }, text } });
function fixture(targetBotId = "chief-a") {
  const root = mkdtempSync(join(tmpdir(), "telegram-end-")); roots.push(root);
  let updates: any[] = [];
  const transport = { getUpdates: vi.fn(async () => updates), sendMessage: vi.fn(async () => ({ chatId: "7", messageId: 1 })) };
  const options = { file: join(root, "channel.json"), transport, botIdentityId: "123", targetBotId, enqueue: vi.fn(() => ({ id: "run" })), runResult: () => ({ status: "completed", output: "Done" }) };
  return { options, transport, updates: (value: any[]) => { updates = value; } };
}
const record = (updateId: number, state: string) => ({ updateId, deliveryId: `telegram:123:${updateId}`, prompt: "p", state });
async function pairedWith(f: ReturnType<typeof fixture>, states: string[]) {
  const channel = new TelegramChannel(f.options), challenge = channel.beginPairing();
  f.updates([message(1, `/pair ${challenge.code}`)]); await channel.pollOnce(); f.updates([]);
  // The channel is built for a single owner; seed the in-flight rows the way a crash or slow send leaves them.
  const saved = JSON.parse(readFileSync(f.options.file, "utf8"));
  saved.records = states.map((state, i) => record(10 + i, state));
  writeFileSync(f.options.file, JSON.stringify(saved));
  return new TelegramChannel(f.options);
}
it("ending a pairing after a restart cancels queued rows and keeps the crash-stale sending row uncertain", async () => {
  const f = fixture();
  const channel = await pairedWith(f, ["accepted", "queued", "sending", "sent"]);
  expect(JSON.parse(readFileSync(f.options.file, "utf8")).records.map((r: any) => r.state)).toEqual(["accepted", "queued", "uncertain", "sent"]);
  channel.revoke();
  expect(JSON.parse(readFileSync(f.options.file, "utf8")).records.map((r: any) => r.state)).toEqual(["cancelled", "cancelled", "uncertain", "sent"]);
  const restarted = new TelegramChannel(f.options); f.transport.sendMessage.mockClear();
  await restarted.pollOnce();
  expect(restarted.status()).toMatchObject({ paired: false, enabled: false, pending: 0, uncertain: 1 });
  expect(f.transport.sendMessage).not.toHaveBeenCalled();
});
it("revoke on a live channel turns a sending row uncertain and a queued row cancelled", async () => {
  const f = fixture();
  const channel = new TelegramChannel(f.options), challenge = channel.beginPairing();
  f.updates([message(1, `/pair ${challenge.code}`)]); await channel.pollOnce(); f.updates([]);
  const state = (channel as any).state; state.records.push(record(20, "queued"), record(21, "sending"));
  channel.revoke();
  expect((channel as any).state.records.slice(-2).map((r: any) => r.state)).toEqual(["cancelled", "uncertain"]);
  expect(channel.status()).toMatchObject({ paired: false, pending: 0, uncertain: 1 });
});
it("pairing again after the Chief of staff changed is reported as target-changed and a fresh pairing follows the new Chief only", async () => {
  const f = fixture("chief-a");
  const channel = new TelegramChannel(f.options), challenge = channel.beginPairing();
  f.updates([message(1, `/pair ${challenge.code}`)]); await channel.pollOnce();
  expect(channel.resumeDisposition()).toBe("paired");
  const moved = new TelegramChannel({ ...f.options, targetBotId: "chief-b" });
  expect(moved.resumeDisposition()).toBe("target-changed");
  f.transport.sendMessage.mockClear(); f.updates([message(2, "work")]);
  await moved.pollOnce();
  expect(f.options.enqueue).not.toHaveBeenCalled();
  expect(f.transport.sendMessage).not.toHaveBeenCalled();
  expect(() => moved.beginPairing()).toThrow(/Revoke the existing/);
  moved.revoke();
  moved.beginPairing();
  expect(JSON.parse(readFileSync(f.options.file, "utf8"))).toMatchObject({ targetBotId: "chief-b", enabled: true, binding: null });
});
it("a pairing that was never started stays unpaired and polls nothing", async () => {
  const f = fixture();
  const channel = new TelegramChannel(f.options);
  expect(channel.resumeDisposition()).toBe("revoked");
  await channel.pollOnce();
  expect(f.transport.getUpdates).not.toHaveBeenCalled();
});
