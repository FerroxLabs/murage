import { afterEach, expect, it, vi } from "vitest";
import { startRoomShareMaintenance } from "./room-share-maintenance.ts";
afterEach(() => vi.useRealTimers());
it("starts off the boot path, guards each yielding batch, drains and recurs daily", async () => {
  vi.useFakeTimers();
  const batch = vi.fn().mockReturnValueOnce(500).mockReturnValueOnce(500).mockReturnValue(3);
  const entered = vi.fn();
  const stop = startRoomShareMaintenance(batch, (_name, run) => async () => { entered(); run(); });
  expect(batch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(batch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2);
  expect(batch).toHaveBeenCalledTimes(3);
  expect(entered).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(86_400_000);
  expect(batch).toHaveBeenCalledTimes(4);
  stop();
});
it("retries contention promptly, including a guard which cannot enter the callback", async () => {
  vi.useFakeTimers();
  const batch = vi.fn().mockReturnValueOnce(null).mockReturnValue(0);
  let held = true;
  const stop = startRoomShareMaintenance(batch, (_name, run) => async () => { if (!held) run(); });
  await vi.advanceTimersByTimeAsync(1);
  expect(batch).not.toHaveBeenCalled(); held = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(batch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(batch).toHaveBeenCalledTimes(2);
  stop();
});

it("uses the exported batch limit, not a duplicate number", async () => {
  vi.useFakeTimers(); vi.resetModules();
  vi.doMock("./room-shares.ts", async original => ({ ...await original<typeof import("./room-shares.ts")>(), ROOM_SHARE_PRUNE_BATCH: 7 }));
  const { startRoomShareMaintenance: start } = await import("./room-share-maintenance.ts");
  const prune = vi.fn().mockReturnValueOnce(7).mockReturnValue(0);
  const stop = start(prune, (_name, run) => async () => { run(); });
  try { await vi.advanceTimersByTimeAsync(2); expect(prune).toHaveBeenCalledTimes(2); }
  finally { stop(); vi.doUnmock("./room-shares.ts"); vi.resetModules(); }
});
it("boot settles sharing before scheduling pruning and the server calls that boot entry", async () => {
  vi.useFakeTimers(); vi.setSystemTime(100 * 86400000);
  const { DatabaseSync } = await import("node:sqlite");
  const { initializeRoomShares } = await import("./room-shares-schema.ts");
  const shares = await import("./room-shares.ts");
  const { readFileSync } = await import("node:fs");
  const db = new DatabaseSync(":memory:"); initializeRoomShares(db);
  for (const status of ["sharing", "shared"]) db.prepare("INSERT INTO room_shares VALUES (?, 'bot', 'room', 'thread', 'origin', 'q', '[]', 'h', 'n', ?, ?, 1, 1)").run(status, status, status);
  const hasLine = vi.fn(() => true), prune = vi.fn();
  let stop: (() => void) | undefined;
  try {
    stop = shares.bootRoomShares(db, hasLine, (_name, run) => async () => { prune(); run(); });
    expect(hasLine).toHaveBeenCalledWith("thread", "sharing");
    expect(shares.roomShare(db, "sharing")?.status).toBe("shared");
    expect(shares.roomShare(db, "shared")).not.toBeNull(); expect(prune).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(prune).toHaveBeenCalledOnce(); expect(shares.roomShare(db, "shared")).toBeNull();
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source.slice(source.indexOf('{ name: "roomShares"'), source.indexOf('{ name: "browserEngineCheck"'))).toContain("bootRoomShares(database(),");
  } finally { stop?.(); db.close(); }
});
