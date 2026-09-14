import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TelegramService } from "./telegram-service.ts";
import type { TelegramTransport } from "./telegram-transport.ts";
import * as atomic from "./atomic.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(clean => clean()); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
  vi.useFakeTimers();
  const dataDir = mkdtempSync(join(tmpdir(), "telegram-chief-"));
  let chief: string | null = "chief", updates: unknown[] = [];
  const transport = {
    getMe: vi.fn(async () => ({ id: "123", username: "fake_bot" })),
    getUpdates: vi.fn(async () => updates),
    sendMessage: vi.fn(async () => ({ chatId: "7", messageId: 9 })),
  };
  const enqueue = vi.fn(() => ({ id: "run" })), revokeRuns = vi.fn(async () => {});
  const services: TelegramService[] = [];
  const make = () => { const service = new TelegramService({ dataDir, transport: () => transport as unknown as TelegramTransport,
    isCurrentTarget: id => chief === id, enqueue, revokeRuns, runResult: () => ({ status: "completed", output: "done" }) }); services.push(service); return service; };
  cleanups.push(() => { services.forEach(service => service.stop()); rmSync(dataDir, { recursive: true, force: true }); });
  const update = (id: number, text: string) => ({ update_id: id, message: { message_id: id, date: 1, from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" }, text } });
  const pair = async () => { const service = make(), pairing = await service.pair("FAKE_TOKEN", "chief"); updates = [update(1, "/pair " + pairing.code)]; await vi.advanceTimersByTimeAsync(1500); updates = []; return service; };
  return { dataDir, transport, enqueue, revokeRuns, make, pair, update, setChief: (id: string | null) => { chief = id; }, setUpdates: (value: unknown[]) => { updates = value; } };
}

it("rejects arbitrary recipients and a Chief changed during getMe before writing pairing state", async () => {
  const f = fixture(), service = f.make();
  await expect(service.pair("FAKE_TOKEN", "team-chief")).rejects.toThrow("workspace Chief");
  expect(f.transport.getMe).not.toHaveBeenCalled();
  let resolve!: (value: { id: string; username: string }) => void;
  f.transport.getMe.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pairing = service.pair("FAKE_TOKEN", "chief"); f.setChief("replacement");
  resolve({ id: "123", username: "fake_bot" });
  await expect(pairing).rejects.toThrow("Chief changed");
  expect(existsSync(join(f.dataDir, "telegram", "connection.json"))).toBe(false);
  expect(f.transport.getUpdates).not.toHaveBeenCalled();
});

it.each([null, "replacement"])("durably pauses unavailable/replaced Chief %s without altering owner, records or selecting a replacement", async nextChief => {
  const f = fixture(), service = await f.pair();
  f.setUpdates([f.update(2, "work")]); await vi.advanceTimersByTimeAsync(1500);
  const file = join(f.dataDir, "telegram", "123.json"), before = readFileSync(file, "utf8");
  f.setChief(nextChief); await service.revalidateTarget();
  expect(service.status()).toMatchObject({ resumeState: "blocked", paired: false, requiresRevoke: true });
  expect(readFileSync(file, "utf8")).toBe(before);
  expect(JSON.parse(readFileSync(join(f.dataDir, "telegram", "connection.json"), "utf8"))).toMatchObject({ targetBotId: "chief", enabled: true, paused: true });
  expect(f.revokeRuns).toHaveBeenCalledWith("123");
  f.setChief("chief"); expect(await service.resume("FAKE_TOKEN", "chief")).toBe(false);
  expect(await f.make().resume("FAKE_TOKEN", "chief")).toBe(false);
  await expect(service.pair("FAKE_TOKEN", "chief")).rejects.toThrow("Revoke");
  await service.revoke(); await service.pair("FAKE_TOKEN", "chief");
  expect(JSON.parse(readFileSync(file, "utf8")).records).toHaveLength(1);
});

it("stops in-flight polling and fences a transient Chief change during pairing even if restored", async () => {
  const f = fixture(), service = await f.pair();
  let resolve!: (value: unknown[]) => void;
  f.transport.getUpdates.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await vi.advanceTimersByTimeAsync(1500);
  f.setChief(null); await service.revalidateTarget(); f.setChief("chief");
  resolve([f.update(2, "old recipient")]); await vi.advanceTimersByTimeAsync(3000);
  expect(f.enqueue).not.toHaveBeenCalled(); expect(f.transport.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: expect.stringContaining("Telegram is paired") }));
  await service.revoke();
  let identity!: (value: { id: string; username: string }) => void;
  f.transport.getMe.mockImplementationOnce(() => new Promise(done => { identity = done; }));
  const pairing = service.pair("FAKE_TOKEN", "chief");
  f.setChief(null); await service.revalidateTarget(); f.setChief("chief");
  identity({ id: "123", username: "fake_bot" }); await expect(pairing).rejects.toThrow("cancelled");
});

it("keeps a failed durable pause stopped with an explicit error and no same-process resume", async () => {
  const f = fixture(), service = await f.pair(); f.setChief(null);
  vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(() => { throw new Error("isolated write failure"); });
  await expect(service.revalidateTarget()).rejects.toThrow("isolated write failure");
  expect(service.status()).toMatchObject({ resumeState: "blocked", enabled: false });
  expect(service.status().resumeMessage).toContain("could not be saved");
  expect(f.revokeRuns).toHaveBeenCalledWith("123");
  f.setChief("chief"); expect(await service.resume("FAKE_TOKEN", "chief")).toBe(false);
});

it("a late send completion cannot settle or send another old-Chief record after pause", async () => {
  const f = fixture(), service = await f.pair();
  let resolve!: (value: { chatId: string; messageId: number }) => void;
  f.transport.sendMessage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  f.setUpdates([f.update(2, "first"), f.update(3, "second")]);
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.transport.sendMessage).toHaveBeenCalledTimes(2); // pairing confirmation + in-flight work reply
  f.setChief("replacement"); await service.revalidateTarget();
  resolve({ chatId: "7", messageId: 9 }); await vi.advanceTimersByTimeAsync(3000);
  expect(f.transport.sendMessage).toHaveBeenCalledTimes(2);
  expect(f.enqueue).toHaveBeenCalledTimes(1);
  const records = JSON.parse(readFileSync(join(f.dataDir, "telegram", "123.json"), "utf8")).records;
  expect(records.map((record: { state: string }) => record.state)).toEqual(["sending", "accepted"]);
});

it("actual pair route resolves the workspace Chief and rejects supplied other recipients", async () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf('      const body = await readBody(req);', source.indexOf('if (path === "/api/telegram/pair"'));
  const end = source.indexOf('\n    }', start);
  const route = new Function("readBody", "req", "store", "json", "res", "cfg", "telegram", "saveConfig", `return (async () => {${source.slice(start, end)}})()`);
  const pair = vi.fn(async () => ({ code: "fake" })), cfg = { telegram: { botToken: "FAKE_TOKEN" } };
  for (const targetBotId of ["other", "team-chief"]) {
    const result = await route(async () => ({ targetBotId }), {}, { workspaceChief: () => ({ id: "chief" }) }, (_res: unknown, status: number) => status, {}, cfg, { pair }, vi.fn());
    expect(result).toBe(409);
  }
  expect(pair).not.toHaveBeenCalled();
  expect(await route(async () => ({}), {}, { workspaceChief: () => ({ id: "chief" }) }, (_res: unknown, status: number) => status, {}, cfg, { pair }, vi.fn())).toBe(200);
  expect(pair).toHaveBeenCalledWith("FAKE_TOKEN", "chief");
});
