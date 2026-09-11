import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TelegramChannel } from "./telegram-channel.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const message = (id: number, text: string, extra = {}) => ({ update_id: id, message: { message_id: id + 1, date: 1, from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" }, text, ...extra } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telegram-channel-")); roots.push(root);
  let updates: any[] = [];
  const transport = { getUpdates: vi.fn(async () => updates), sendMessage: vi.fn(async () => ({ chatId: "7", messageId: 1 })) };
  const enqueue = vi.fn(() => ({ id: "run" }));
  const options = { file: join(root, "channel.json"), transport, botIdentityId: "123", targetBotId: "fixture-bot", enqueue, runResult: () => ({ status: "completed", output: "Done" }) };
  return { options, transport, enqueue, updates: (value: any[]) => { updates = value; } };
}
it("explains exact expired pairing once without binding or enqueueing", async () => {
  const f = fixture(); let now = 1000;
  const channel = new TelegramChannel({ ...f.options, now: () => now });
  const pairing = channel.beginPairing(); now = pairing.expiresAt;
  expect(channel.status().pairingExpired).toBe(true);
  f.updates([message(1, `/pair ${"0".repeat(64)}`)]); await channel.pollOnce();
  expect(f.transport.sendMessage).not.toHaveBeenCalled();
  f.updates([message(2, `/pair ${pairing.code}`), message(3, `/pair ${pairing.code}`)]); await channel.pollOnce();
  expect(f.transport.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expect.stringContaining("pairing code expired") }));
  expect(channel.status().paired).toBe(false); expect(f.enqueue).not.toHaveBeenCalled();
});
it("pairs only exact private human challenge then persists and deduplicates delivery across restart", async () => {
  const f = fixture(), channel = new TelegramChannel(f.options), challenge = channel.beginPairing();
  expect(readFileSync(f.options.file, "utf8")).not.toContain(challenge.code);
  f.updates([message(1, `/pair ${challenge.code}`, { forward_origin: {} }), message(2, `/pair ${challenge.code}`, { chat: { id: 7, type: "group" } })]);
  await channel.pollOnce(); expect(channel.status().paired).toBe(false);
  f.updates([message(3, `/pair ${challenge.code}`)]); await channel.pollOnce();
  expect(channel.status().paired).toBe(true); expect(f.enqueue).not.toHaveBeenCalled();
  f.updates([message(4, "ignore me", { from: { id: 8, is_bot: false } }), message(5, "do work")]);
  await channel.pollOnce(); expect(f.enqueue).toHaveBeenCalledTimes(1);
  expect(f.enqueue.mock.calls[0]).toEqual([{ deliveryId: "telegram:123:5", prompt: expect.stringContaining("UNTRUSTED TELEGRAM") }]);
  expect(f.transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: "7", text: "Done" }));
  const restarted = new TelegramChannel(f.options); await restarted.pollOnce();
  expect(f.enqueue).toHaveBeenCalledTimes(1); expect(f.transport.sendMessage).toHaveBeenCalledTimes(1);
});
it("persists acceptance before enqueue and retries only through stable scheduler dedup after failure", async () => {
  const f = fixture(), channel = new TelegramChannel(f.options), challenge = channel.beginPairing();
  f.updates([message(1, `/pair ${challenge.code}`)]); await channel.pollOnce();
  f.enqueue.mockImplementationOnce(() => { expect(JSON.parse(readFileSync(f.options.file, "utf8")).records[0].state).toBe("accepted"); throw new Error("private cause"); });
  f.updates([message(2, "work")]); await channel.pollOnce();
  expect(channel.status().error).toBe("channel-operation-failed");
  const restarted = new TelegramChannel(f.options); await restarted.pollOnce();
  expect(f.enqueue).toHaveBeenCalledTimes(2);
  expect(f.enqueue.mock.calls[0]).toEqual(f.enqueue.mock.calls[1]);
});
it("never retries uncertain sends or crash-stale sending records", async () => {
  const f = fixture(), channel = new TelegramChannel(f.options), challenge = channel.beginPairing();
  f.updates([message(1, `/pair ${challenge.code}`)]); await channel.pollOnce();
  f.transport.sendMessage.mockRejectedValueOnce(new Error("private token timeout"));
  f.updates([message(2, "work")]); await channel.pollOnce();
  expect(channel.status().uncertain).toBe(1);
  const state = JSON.parse(readFileSync(f.options.file, "utf8")); state.records[0].state = "sending"; writeFileSync(f.options.file, JSON.stringify(state));
  const restarted = new TelegramChannel(f.options); await restarted.pollOnce();
  expect(restarted.status().uncertain).toBe(1); expect(f.transport.sendMessage).toHaveBeenCalledTimes(1);
});
it("revoke invalidates an in-flight poll and textual approvals never enqueue", async () => {
  const f = fixture(), channel = new TelegramChannel(f.options), challenge = channel.beginPairing();
  f.updates([message(1, `/pair ${challenge.code}`)]); await channel.pollOnce();
  f.updates([message(2, "/approve anything")]); await channel.pollOnce();
  expect(f.enqueue).not.toHaveBeenCalled(); expect(f.transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Murage app") }));
  let resolve!: (updates: any[]) => void;
  f.transport.getUpdates.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = channel.pollOnce(); await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  expect(channel.pollOnce()).toBe(pending); channel.revoke(); resolve([message(3, "work")]); await pending;
  expect(f.enqueue).not.toHaveBeenCalled(); expect(channel.status()).toMatchObject({ enabled: false, paired: false });
});
it("refuses corruption and different bot identity preserving bytes", () => {
  const f = fixture(); new TelegramChannel(f.options).beginPairing();
  expect(() => new TelegramChannel({ ...f.options, botIdentityId: "456" })).toThrow();
  writeFileSync(f.options.file, "corrupt-private-token");
  expect(() => new TelegramChannel(f.options)).toThrow("original data was preserved");
  expect(readFileSync(f.options.file, "utf8")).toBe("corrupt-private-token");
});

it("a text reply the approvals manager captures as a question answer is never enqueued as a prompt (ASK3)", async () => {
  const f = fixture(), channel = new TelegramChannel({ ...f.options, transport: { ...f.transport, answerCallbackQuery: vi.fn(async () => {}) },
    approvals: {
      pending: () => [{ id: "card", fingerprint: "fp", summary: "Ember has a question", questions: [{ id: "q1", question: "Which name?", options: [], multiSelect: false, allowOther: true }] }],
      resolve: vi.fn(async () => true),
      answer: vi.fn(async () => ({ ok: true as const })),
    } });
  const challenge = channel.beginPairing();
  f.updates([message(1, `/pair ${challenge.code}`)]); await channel.pollOnce();
  expect(channel.status().paired).toBe(true);
  // the question is published with a keyboard; the owner taps "Reply with text"
  expect(f.transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ keyboard: expect.any(Array) }));
  const calls = f.transport.sendMessage.mock.calls as unknown as Array<[{ keyboard?: Array<Array<{ text: string; data: string }>> }]>;
  const write = calls.find(call => call[0].keyboard)![0].keyboard!.flat().find(item => item.text === "Reply with text")!;
  f.updates([{ update_id: 2, callback_query: { id: "cb", from: { id: 7, is_bot: false }, message: { message_id: 1, chat: { id: 7, type: "private" } }, data: write.data } }]);
  await channel.pollOnce();
  f.updates([message(3, "Call it Aurora")]); await channel.pollOnce();
  expect(f.enqueue).not.toHaveBeenCalled();
  expect(channel.status().pending).toBe(0);
  // and an ordinary message afterwards is a prompt again
  f.updates([message(4, "now do the work")]); await channel.pollOnce();
  expect(f.enqueue).toHaveBeenCalledExactlyOnceWith({ deliveryId: "telegram:123:4", prompt: expect.stringContaining("now do the work") });
});
