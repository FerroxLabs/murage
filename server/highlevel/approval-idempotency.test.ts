import { removeTempDirSync } from "../testing/cleanup.ts";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FileApprovalJournal, runApprovedWrite } from "./approval-idempotency.ts";

function fixture() { const dir = mkdtempSync(join(tmpdir(), "hl-f02-")); return { dir, journal: new FileApprovalJournal(dir), cleanup: () => removeTempDirSync(dir) }; }
const applied = { status: "applied", result: { recordId: "approved-record" } } as const;
it("same approval twice and across journal reopen dispatches once", async () => {
  const f = fixture();
  try {
    const dispatch = vi.fn(async () => applied), reconcile = vi.fn(async () => applied);
    expect(await runApprovedWrite(f.journal, "approval-1", "digest", { dispatch, reconcile })).toEqual(applied);
    expect(await runApprovedWrite(new FileApprovalJournal(f.dir), "approval-1", "digest", { dispatch, reconcile })).toEqual(applied);
    expect(dispatch).toHaveBeenCalledTimes(1); expect(reconcile).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
it("pending after crash performs a reconcile read and never resends", async () => {
  const f = fixture();
  try {
    expect(f.journal.claim("approval-crash", "digest")).toBe(true);
    const dispatch = vi.fn(async () => applied), reconcile = vi.fn(async () => applied);
    expect(await runApprovedWrite(new FileApprovalJournal(f.dir), "approval-crash", "digest", { dispatch, reconcile })).toEqual(applied);
    expect(reconcile).toHaveBeenCalledTimes(1); expect(dispatch).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
it("dispatch exceptions retain pending; failed reconcile never dispatches", async () => {
  const f = fixture();
  try {
    const dispatch = vi.fn(async () => { throw new Error("transport interrupted"); });
    await expect(runApprovedWrite(f.journal, "approval-1", "digest", { dispatch, reconcile: async () => applied })).rejects.toThrow();
    expect(f.journal.get("approval-1")?.state).toBe("pending");
    const conflict = { status: "conflict", reason: "unconfirmed" } as const;
    expect(await runApprovedWrite(f.journal, "approval-1", "digest", { dispatch, reconcile: async () => conflict })).toEqual(conflict);
    expect(await runApprovedWrite(f.journal, "approval-1", "digest", { dispatch, reconcile: async () => applied })).toEqual(conflict);
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally { f.cleanup(); }
});
it("reusing approval with different request digest fails closed", async () => {
  const f = fixture();
  try {
    const dispatch = vi.fn(async () => applied), reconcile = vi.fn(async () => applied);
    await runApprovedWrite(f.journal, "approval-1", "digest", { dispatch, reconcile });
    expect(await runApprovedWrite(f.journal, "approval-1", "other", { dispatch, reconcile })).toEqual({ status: "conflict", reason: "approval_binding" });
    expect(dispatch).toHaveBeenCalledTimes(1); expect(reconcile).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
it("concurrent calls share one outcome; pending is durable before dispatch", async () => {
  const f = fixture();
  try {
    const dispatch = vi.fn(async () => { expect(new FileApprovalJournal(f.dir).get("approval-1")?.state).toBe("pending"); await Promise.resolve(); return applied; });
    const reconcile = vi.fn(async () => applied);
    expect(await Promise.all([runApprovedWrite(f.journal, "approval-1", "digest", { dispatch, reconcile }), runApprovedWrite(new FileApprovalJournal(f.dir), "approval-1", "digest", { dispatch, reconcile })])).toEqual([applied, applied]);
    expect(dispatch).toHaveBeenCalledTimes(1); expect(reconcile).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});

it("corrupt pending and terminal journal entries refuse without dispatch", async () => {
  for (const terminal of [false, true]) {
    const f = fixture();
    try {
      f.journal.claim("approval-corrupt", "digest");
      if (terminal) f.journal.settle("approval-corrupt", "digest", applied);
      const file = readdirSync(f.dir).find(name => name.endsWith(terminal ? ".outcome.json" : ".pending.json"))!;
      writeFileSync(join(f.dir, file), "{torn");
      const dispatch = vi.fn(async () => applied), reconcile = vi.fn(async () => applied);
      await expect(runApprovedWrite(new FileApprovalJournal(f.dir), "approval-corrupt", "digest", { dispatch, reconcile })).rejects.toThrow("journal refused");
      expect(dispatch).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
    } finally { f.cleanup(); }
  }
});
it("terminal result is immutable and caller mutation cannot change stored replay", async () => {
  const f = fixture();
  try {
    f.journal.claim("approval-1", "digest");
    expect(f.journal.settle("approval-1", "digest", applied)).toEqual(applied);
    expect(f.journal.settle("approval-1", "digest", { status: "conflict", reason: "unconfirmed" })).toEqual(applied);
    const record = f.journal.get("approval-1")!;
    if (record.state === "applied") (record.result as Record<string, string>).recordId = "mutated";
    expect(f.journal.get("approval-1")).toMatchObject({ result: { recordId: "approved-record" } });
  } finally { f.cleanup(); }
});
it("read reconciliation exceptions retain pending and forbid dispatch on later replay", async () => {
  const f = fixture();
  try {
    f.journal.claim("approval-1", "digest");
    const dispatch = vi.fn(async () => applied);
    await expect(runApprovedWrite(f.journal, "approval-1", "digest", { dispatch, reconcile: async () => { throw new Error("read failed"); } })).rejects.toThrow("read failed");
    expect(f.journal.get("approval-1")?.state).toBe("pending");
    await runApprovedWrite(f.journal, "approval-1", "digest", { dispatch, reconcile: async () => applied });
    expect(dispatch).not.toHaveBeenCalled();
    for (const file of readdirSync(f.dir)) expect(readFileSync(join(f.dir, file), "utf8")).not.toContain("read failed");
  } finally { f.cleanup(); }
});
it("journal write failure occurs before any dispatch", async () => {
  const f = fixture();
  try {
    const dispatch = vi.fn(async () => applied), reconcile = vi.fn(async () => applied);
    vi.spyOn(f.journal, "claim").mockImplementation(() => { throw new Error("disk refused"); });
    await expect(runApprovedWrite(f.journal, "approval-1", "digest", { dispatch, reconcile })).rejects.toThrow("disk refused");
    expect(dispatch).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
it("accepted provider write then crash reconciles the effect with a real read, never a second write", async () => {
  const { createServer } = await import("node:http");
  const f = fixture();
  let writes = 0, reads = 0, effect: unknown;
  const provider = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST") { writes++; effect = applied.result; res.end(JSON.stringify(effect)); }
    else { reads++; res.end(JSON.stringify(effect ?? null)); }
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address() as import("node:net").AddressInfo;
  const url = `http://127.0.0.1:${address.port}/approved-effect`;
  try {
    const dispatch = vi.fn(async (): Promise<typeof applied> => {
      await fetch(url, { method: "POST" }).then(r => r.json());
      throw new Error("crash after provider accepted, before terminal journal write");
    });
    const reconcile = vi.fn(async () => {
      const read = await fetch(url).then(r => r.json()) as { recordId?: string } | null;
      return read?.recordId === "approved-record" ? applied : { status: "conflict", reason: "unconfirmed" } as const;
    });
    await expect(runApprovedWrite(f.journal, "approval-provider", "digest", { dispatch, reconcile })).rejects.toThrow("crash after provider");
    expect(await runApprovedWrite(new FileApprovalJournal(f.dir), "approval-provider", "digest", { dispatch, reconcile })).toEqual(applied);
    expect(await runApprovedWrite(new FileApprovalJournal(f.dir), "approval-provider", "digest", { dispatch, reconcile })).toEqual(applied);
    expect(writes).toBe(1); expect(reads).toBe(1); expect(dispatch).toHaveBeenCalledTimes(1);
  } finally { await new Promise<void>(resolve => provider.close(() => resolve())); f.cleanup(); }
});
