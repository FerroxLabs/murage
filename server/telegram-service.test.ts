import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TelegramService } from "./telegram-service.ts";
import type { TelegramTransport } from "./telegram-transport.ts";

it("verifies identity before polling and stops admissions on revoke", async () => {
  vi.useFakeTimers();
  const dataDir = mkdtempSync(join(tmpdir(), "murage-telegram-service-"));
  let updates: any[] = [];
  const transport = { getMe: vi.fn(async () => ({ id: "123", username: "fixture_bot" })),
    getUpdates: vi.fn(async () => updates), sendMessage: vi.fn(async () => ({ chatId: "7", messageId: 9 })) };
  const enqueue = vi.fn(() => ({ id: "run" })), revokeRuns = vi.fn(async () => {});
  const service = new TelegramService({ dataDir, transport: () => transport as unknown as TelegramTransport,
    enqueue, revokeRuns, runResult: () => ({ status: "completed", output: "Done" }) });
  const update = (id: number, text: string) => ({ update_id: id, message: { message_id: id, date: 1,
    from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" }, text } });
  try {
    expect(transport.getUpdates).not.toHaveBeenCalled();
    const paired = await service.pair("fake", "chief");
    expect(transport.getMe).toHaveBeenCalledOnce();
    updates = [update(1, "/pair " + paired.code)];
    await vi.advanceTimersByTimeAsync(1500);
    expect(service.status().paired).toBe(true);
    updates = [update(2, "help")];
    await vi.advanceTimersByTimeAsync(1500);
    expect(enqueue).toHaveBeenCalledWith("123", "chief", expect.objectContaining({ deliveryId: "telegram:123:2" }));
    expect(transport.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: "7", text: "Done" }));
    await service.revoke();
    expect(revokeRuns).toHaveBeenCalledWith("123");
    updates = [update(3, "do not run")];
    await vi.advanceTimersByTimeAsync(3000);
    expect(enqueue).toHaveBeenCalledTimes(1);
  } finally { service.stop(); vi.useRealTimers(); rmSync(dataDir, { recursive: true, force: true }); }
});
