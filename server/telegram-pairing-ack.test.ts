import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TelegramChannel } from "./telegram-channel.ts";
import { TelegramTransportError } from "./telegram-transport.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const confirmation = "Telegram is paired with Murage. Send a message here to chat with your Chief.";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telegram-pairing-ack-")); roots.push(root);
  let updates: any[] = [], now = 1000, current = true;
  const transport = { getUpdates: vi.fn(async () => updates), sendMessage: vi.fn(async (_input: { chatId: string; text: string }) => ({ chatId: "7", messageId: 1 })) };
  const enqueue = vi.fn(() => ({ id: "unexpected" })), runResult = vi.fn(() => null);
  const options = { file: join(root, "channel.json"), transport, botIdentityId: "123", targetBotId: "chief", enqueue, runResult, now: () => now, isCurrentTarget: () => current };
  const channel = new TelegramChannel(options), pairing = channel.beginPairing();
  const pairUpdate = (id = 1) => ({ update_id: id, message: { message_id: id, date: 1, from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" }, text: `/pair ${pairing.code}` } });
  updates = [pairUpdate()];
  return { channel, options, pairing, transport, enqueue, runResult, pairUpdate, updates: (value: any[]) => { updates = value; }, now: (value: number) => { now = value; }, current: (value: boolean) => { current = value; }, state: () => JSON.parse(readFileSync(options.file, "utf8")) };
}

it("persists binding, offset and confirmation before sending; duplicates and restart never run the bot", async () => {
  const f = fixture();
  f.transport.sendMessage.mockImplementationOnce(async () => {
    expect(f.state()).toMatchObject({ binding: { chatId: "7", senderId: "7" }, pairing: null, offset: 2, records: [{ prompt: "", response: confirmation, state: "sending" }] });
    return { chatId: "7", messageId: 1 };
  });
  await f.channel.pollOnce();
  await new TelegramChannel(f.options).pollOnce();
  expect(f.transport.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ chatId: "7", text: confirmation }));
  f.updates([f.pairUpdate(2)]); await f.channel.pollOnce();
  expect(f.transport.sendMessage.mock.calls.filter(([input]) => input.text === confirmation)).toHaveLength(1);
  expect(f.enqueue).not.toHaveBeenCalled(); expect(f.runResult).not.toHaveBeenCalled();
});

it("retries definite ack non-delivery at the durable deadline and stops after three attempts", async () => {
  const f = fixture(); f.transport.sendMessage.mockRejectedValue(new TelegramTransportError("rate-limit", { retryAfterSeconds: 12 }));
  await f.channel.pollOnce(); f.updates([]);
  const restarted = new TelegramChannel(f.options);
  f.now(12999); await restarted.pollOnce(); expect(f.transport.sendMessage).toHaveBeenCalledTimes(1);
  f.now(13000); await restarted.pollOnce(); expect(f.transport.sendMessage).toHaveBeenCalledTimes(2);
  f.now(25000); await restarted.pollOnce(); expect(f.transport.sendMessage).toHaveBeenCalledTimes(3);
  f.now(50000); await new TelegramChannel(f.options).pollOnce();
  expect(f.transport.sendMessage).toHaveBeenCalledTimes(3); expect(f.state().records[0]).toMatchObject({ state: "rejected", sendAttempts: 3 });
  expect(f.enqueue).not.toHaveBeenCalled(); expect(f.runResult).not.toHaveBeenCalled();
});

it.each([new TelegramTransportError("forbidden"), new Error("ambiguous fixture")])("does not replay rejected or ambiguous ack after restart (%s)", async error => {
  const f = fixture(); f.transport.sendMessage.mockRejectedValueOnce(error);
  await f.channel.pollOnce(); await new TelegramChannel(f.options).pollOnce();
  expect(f.state().records[0].state).toBe(error instanceof TelegramTransportError ? "rejected" : "uncertain");
  expect(f.transport.sendMessage).toHaveBeenCalledTimes(1); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.runResult).not.toHaveBeenCalled();
});

it.each(["revoke", "chief"])("fences an acknowledgement when %s changes during the poll", async fence => {
  const f = fixture();
  f.transport.getUpdates.mockImplementationOnce(async () => { if (fence === "revoke") f.channel.revoke(); else f.current(false); return [f.pairUpdate()]; });
  await f.channel.pollOnce();
  expect(f.channel.status().paired).toBe(false); expect(f.transport.sendMessage).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled(); expect(f.runResult).not.toHaveBeenCalled();
});

it("preserves an in-flight acknowledgement as uncertain when revoked and never sends it to a new owner", async () => {
  const f = fixture();
  f.transport.sendMessage.mockImplementationOnce(async () => { f.channel.revoke(); return { chatId: "7", messageId: 1 }; });
  await f.channel.pollOnce();
  expect(f.state().records[0].state).toBe("uncertain");
  await new TelegramChannel(f.options).pollOnce();
  expect(f.transport.sendMessage).toHaveBeenCalledTimes(1); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.runResult).not.toHaveBeenCalled();
});

it.each([false, true])("handles a 200-record re-pair queue without losing uncertain receipts (full=%s)", async full => {
  const f = fixture(), state = f.state();
  state.records = Array.from({ length: 200 }, (_, i) => ({ updateId: i, deliveryId: `telegram:123:${i}`, prompt: "", response: "old", state: full ? (i % 2 ? "rejected" : "uncertain") : i === 0 ? "uncertain" : "sent" }));
  state.offset = 200; writeFileSync(f.options.file, JSON.stringify(state)); f.updates([f.pairUpdate(200)]);
  const channel = new TelegramChannel(f.options); await channel.pollOnce();
  expect(channel.status()).toMatchObject({ paired: !full, error: full ? "pending-limit" : null });
  expect(f.state().offset).toBe(full ? 200 : 201);
  expect(f.state().records).toHaveLength(full ? 200 : 2);
  expect(f.state().records[0]).toEqual(state.records[0]);
  if (full) { expect(f.state()).toEqual(state); expect(f.transport.sendMessage).not.toHaveBeenCalled(); }
  else expect(f.transport.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: confirmation }));
  expect(f.enqueue).not.toHaveBeenCalled(); expect(f.runResult).not.toHaveBeenCalled();
});

it("does not acknowledge or bind an expired code", async () => {
  const f = fixture(); f.now(f.pairing.expiresAt); await f.channel.pollOnce();
  expect(f.channel.status()).toMatchObject({ paired: false, pairingExpired: true });
  expect(f.state().records).toEqual([]);
  expect(f.transport.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expect.stringContaining("pairing code expired") }));
  expect(f.enqueue).not.toHaveBeenCalled(); expect(f.runResult).not.toHaveBeenCalled();
});

it("clears capacity health after pending work completes and a poll accepts the next message", async () => {
  const f = fixture(), state = f.state(); let completed = false;
  state.binding = { chatId: "7", senderId: "7" }; state.pairing = null; state.offset = 200;
  state.records = Array.from({ length: 200 }, (_, i) => ({ updateId: i, deliveryId: `telegram:123:${i}`, prompt: "work", runId: `run-${i}`, state: "queued" }));
  writeFileSync(f.options.file, JSON.stringify(state));
  const next = f.pairUpdate(200); next.message.text = "next work"; f.updates([next]);
  const channel = new TelegramChannel({ ...f.options, runResult: () => completed ? { status: "completed", output: "Done" } : null });
  await channel.pollOnce(); expect(channel.status().error).toBe("pending-limit"); expect(f.state().offset).toBe(200);
  completed = true; await channel.pollOnce();
  expect(channel.status().error).toBeNull(); expect(f.state().offset).toBe(201);
  expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deliveryId: "telegram:123:200" }));
});
