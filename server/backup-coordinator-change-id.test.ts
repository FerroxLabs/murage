// HB (settings v10, v9 H2): the backup schedule's change id is saved inside the coordinator's own save, so a change that committed and then
// lost its reply (or its log row) is answered again from the stored receipt, not refused as BACKUP_SCHEDULE_CHANGED.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";

const writes: string[] = [];
vi.mock("./atomic.ts", async (original) => {
  const real = await original<typeof import("./atomic.ts")>();
  return { ...real, writeFileAtomic: (file: string, bytes: string | Buffer, options?: unknown) => { writes.push(String(bytes)); return (real.writeFileAtomic as (...a: unknown[]) => unknown)(file, bytes, options); } };
});
const { BackupCoordinator } = await import("./backup-coordinator.ts");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); writes.length = 0; });
const choices = { enabled: true, installationRef: "installation-one", destinationRef: "destination-one", recoveryRef: "recovery-one", timezone: "Asia/Bangkok", time: "09:00", catchupMs: 3 * 86400000, maxBytes: 100000, maxDurationMs: 1000, selection: { scope: "application-data" as const, credentialPolicy: "preserve-in-encrypted-fidelity" as const }, preUpgrade: false };
const open = (dir?: string) => {
  const stateDirectory = dir ?? mkdtempSync(join(tmpdir(), "murage-backup-change-id-"));
  if (!dir) roots.push(stateDirectory);
  return { stateDirectory, coordinator: new BackupCoordinator({ stateDirectory, now: () => Date.parse("2026-09-13T01:00:00Z") }) };
};
const stateOf = (dir: string) => JSON.parse(readFileSync(join(dir, "backup-coordinator.json"), "utf8"));

describe("backup schedule change receipts", () => {
  it("the change id is durable before the new revision, never after it, and the strict state file gains no key (a v1.0.20 rollback still reads it)", () => {
    const { coordinator, stateDirectory } = open();
    writes.length = 0;
    coordinator.configure(0, choices, "change-1");
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[0])).toMatchObject({ receipts: [{ changeId: "change-1", revision: 1 }] });
    expect(JSON.parse(writes[1])).toMatchObject({ revision: 1 });
    expect(Object.keys(stateOf(stateDirectory)).sort()).toEqual(["configuredAt", "revision", "schedule", "seen", "version", "watermark"]);
  });

  it("death between the receipt write and the state save: the id is not counted as applied, the retry applies it once", () => {
    const { coordinator, stateDirectory } = open();
    coordinator.configure(0, choices, "change-1");
    // put the state back to revision 0 as if the second write never happened
    const state = stateOf(stateDirectory);
    writeFileSync(join(stateDirectory, "backup-coordinator.json"), JSON.stringify({ ...state, revision: 0, configuredAt: 0 }));
    expect(coordinator.changeReceipts()).toEqual([]);
    coordinator.configure(0, choices, "change-1");
    expect(coordinator.status().revision).toBe(1);
    expect(coordinator.changeReceipts()).toHaveLength(1);
  });

  it("death after the save, restart, retry with the same id: the stored result, one receipt, no BACKUP_SCHEDULE_CHANGED", () => {
    const first = open();
    first.coordinator.configure(0, choices, "change-1");
    // the host died before it published its log row or answered the window; a new process retries the same change
    const reborn = open(first.stateDirectory).coordinator;
    expect(() => reborn.configure(0, choices, "change-1")).not.toThrow();
    expect(reborn.status().revision).toBe(1);
    expect(reborn.changeReceipts()).toEqual([expect.objectContaining({ changeId: "change-1", revision: 1 })]);
    expect(stateOf(first.stateDirectory).revision).toBe(1);
  });

  it("a change that never saved is not inherited by a later change that reaches its revision (no id, then retry of the first)", () => {
    const { coordinator, stateDirectory } = open();
    const file = join(stateDirectory, "backup-coordinator.json");
    coordinator.configure(0, choices); // state now at revision 1; keep a copy of it
    const before = readFileSync(file, "utf8");
    coordinator.configure(1, { ...choices, time: "10:00" }, "change-A"); // receipt {A, revision 2}, then the process dies before the state save
    writeFileSync(file, before);
    expect(coordinator.changeReceipts()).toEqual([]);
    coordinator.configure(1, { ...choices, time: "11:00" }); // another caller (no id) commits revision 2
    expect(coordinator.changeReceipts()).toEqual([]);
    expect(coordinator.status().schedule.time).toBe("11:00");
    // the retry of A is a new change at the right revision, applied once, not answered as if it had landed
    coordinator.configure(2, { ...choices, time: "10:00" }, "change-A");
    expect(coordinator.status().schedule.time).toBe("10:00");
    expect(coordinator.status().revision).toBe(3);
  });

  it("a known id is answered before the revision check; a new id at a stale revision is still refused", () => {
    const { coordinator } = open();
    coordinator.configure(0, choices, "change-1");
    expect(() => coordinator.configure(0, { ...choices, time: "10:00" }, "change-2")).toThrow("BACKUP_SCHEDULE_CHANGED");
    expect(() => coordinator.configure(0, choices, "change-1")).not.toThrow();
    expect(coordinator.status().schedule.time).toBe("09:00");
    expect(coordinator.status().revision).toBe(1);
  });

  it("a known id reused for different input is refused, never answered as if that input had been applied", () => {
    const { coordinator } = open();
    coordinator.configure(0, choices, "change-1");
    expect(() => coordinator.configure(0, { ...choices, time: "10:00" }, "change-1")).toThrow("BACKUP_CHANGE_ID_REUSED");
    expect(coordinator.status().schedule.time).toBe("09:00");
  });

  it("keeps the last 32 receipts, oldest first out", () => {
    const { coordinator } = open();
    for (let i = 0; i < 40; i++) coordinator.configure(i, { ...choices, time: i % 2 ? "09:00" : "10:00" }, `change-${i}`);
    const ids = coordinator.changeReceipts().map((r: { changeId: string }) => r.changeId);
    expect(ids).toHaveLength(32);
    expect(ids[0]).toBe("change-8");
    expect(ids.at(-1)).toBe("change-39");
  });

  it("without a change id nothing is recorded and the old behaviour holds", () => {
    const { coordinator, stateDirectory } = open();
    coordinator.configure(0, choices);
    expect(() => coordinator.configure(0, choices)).toThrow("BACKUP_SCHEDULE_CHANGED");
    expect(existsSync(join(stateDirectory, "backup-change-receipts.json"))).toBe(false);
    expect(coordinator.changeReceipts()).toEqual([]);
  });

  it("refuses a malformed change id before changing anything", () => {
    const { coordinator } = open();
    for (const bad of ["", "x".repeat(129), "has space", "a\nb"]) expect(() => coordinator.configure(0, choices, bad)).toThrow();
    expect(coordinator.status().revision).toBe(0);
  });
});
