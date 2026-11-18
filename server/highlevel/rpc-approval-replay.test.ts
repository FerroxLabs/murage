import { removeTempDirSync } from "../testing/cleanup.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { FileRpcApprovalJournal, runRpcApprovedWrite, type RpcApprovalBinding } from "./rpc-approval-replay.ts";
import type { ApprovalOutcome } from "./approval-idempotency.ts";
import { canonicalBindingJson } from "./binding-json.ts";
const hash = (value: unknown) => createHash("sha256").update(canonicalBindingJson(value)).digest("hex");
const binding: RpcApprovalBinding = { rpcId: "rpc-1", rpcDigest: hash("rpc"), approvalId: "approval-1", requestDigest: hash("request"), actionId: "action-1", authorityDigest: hash("authority"), operation: "contacts.update", readTargets: [{ operation: "contacts.get", path: "/contacts/c1" }], effectDigest: hash({ firstName: "Approved" }) };
const applied = { status: "applied", result: { actionId: "action-1", recordId: "c1" } } as const;
const notApplied = { status: "conflict", reason: "negative_confirmation" } as const;
function fixture() { const dir = mkdtempSync(join(tmpdir(), "hl-f022-")); return { dir, journal: new FileRpcApprovalJournal(dir), cleanup: () => removeTempDirSync(dir) }; }
function callbacks() { return { prepare: vi.fn(async () => binding), authorize: vi.fn(async () => true), dispatch: vi.fn(async (_binding: RpcApprovalBinding): Promise<ApprovalOutcome> => applied), reconcile: vi.fn(async (_binding: RpcApprovalBinding): Promise<ApprovalOutcome> => applied) }; }
it.each([true, false])("F022 actual process exit after dispatch; accepted=%s: one durable-target read, no resend", async accepted => {
  const f = fixture(); let reads = 0, writes = 0;
  const provider = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "PUT") { writes++; res.end("{}"); }
    else { reads++; expect(req.url).toBe("/contacts/c1"); res.end(JSON.stringify({ contact: { id: "c1", firstName: accepted ? "Approved" : "Before" } })); }
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(provider.address() as import("node:net").AddressInfo).port}`;
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", "server/highlevel/testing/rpc-crash-worker.ts", f.dir, `${url}/contacts/c1`, JSON.stringify(binding), "after-dispatch"], { stdio: "pipe" });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    expect(code, stderr).toBe(19);
    const cb = callbacks();
    cb.prepare.mockImplementation(async () => { throw new Error("restart must recover approval, not prepare another"); });
    cb.reconcile.mockImplementation(async (saved: RpcApprovalBinding) => {
      expect(saved).toEqual(binding);
      const response = await fetch(`${url}${saved.readTargets[0].path}`).then(r => r.json()) as { contact: { id: string; firstName: string } };
      expect(response.contact.id).toBe("c1");
      return hash({ firstName: response.contact.firstName }) === saved.effectDigest ? applied : notApplied;
    });
    const reopened = new FileRpcApprovalJournal(f.dir);
    const expected = accepted ? applied : notApplied;
    expect(await runRpcApprovedWrite(reopened, "rpc-1", binding.rpcDigest, cb)).toEqual(expected);
    expect(await runRpcApprovedWrite(new FileRpcApprovalJournal(f.dir), "rpc-1", binding.rpcDigest, cb)).toEqual(expected);
    expect(writes).toBe(1); expect(reads).toBe(1); expect(cb.dispatch).not.toHaveBeenCalled(); expect(cb.prepare).not.toHaveBeenCalled();
  } finally { await new Promise<void>(resolve => provider.close(() => resolve())); f.cleanup(); }
});
it("F022 crash after approval outcome before RPC return returns persisted result without a read", async () => {
  const f = fixture(); let writes = 0;
  const provider = createServer((_req, res) => { writes++; res.end("{}"); });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(provider.address() as import("node:net").AddressInfo).port}/contacts/c1`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "server/highlevel/testing/rpc-crash-worker.ts", f.dir, url, JSON.stringify(binding), "after-outcome"], { stdio: "pipe" });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    expect(await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); }), stderr).toBe(19);
    const cb = callbacks();
    expect(await runRpcApprovedWrite(new FileRpcApprovalJournal(f.dir), "rpc-1", binding.rpcDigest, cb)).toEqual(applied);
    expect(writes).toBe(1); expect(cb.reconcile).not.toHaveBeenCalled(); expect(cb.prepare).not.toHaveBeenCalled(); expect(cb.dispatch).not.toHaveBeenCalled();
  } finally { await new Promise<void>(resolve => provider.close(() => resolve())); f.cleanup(); }
});
it("F022 crash between association and approval claim still reconciles", async () => {
  const f = fixture();
  try {
    expect(f.journal.bindRpc(binding)).toBe(true);
    const cb = callbacks();
    expect(await runRpcApprovedWrite(new FileRpcApprovalJournal(f.dir), "rpc-1", binding.rpcDigest, cb)).toEqual(applied);
    expect(cb.reconcile).toHaveBeenCalledExactlyOnceWith(binding); expect(cb.prepare).not.toHaveBeenCalled(); expect(cb.dispatch).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
it("F022 concurrent fresh RPCs prepare once, associate before dispatch, then replay immutably", async () => {
  const f = fixture();
  try {
    const cb = callbacks();
    cb.dispatch.mockImplementation(async () => { expect(new FileRpcApprovalJournal(f.dir).getRpc("rpc-1")).toEqual(binding); expect(f.journal.get(binding.approvalId)?.state).toBe("pending"); return applied; });
    expect(await Promise.all([runRpcApprovedWrite(f.journal, "rpc-1", binding.rpcDigest, cb), runRpcApprovedWrite(new FileRpcApprovalJournal(f.dir), "rpc-1", binding.rpcDigest, cb)])).toEqual([applied, applied]);
    expect(cb.prepare).toHaveBeenCalledTimes(1); expect(cb.dispatch).toHaveBeenCalledTimes(1); expect(cb.reconcile).not.toHaveBeenCalled();
    const read = f.journal.getRpc("rpc-1")!;
    (read.readTargets as unknown as { path: string }[])[0].path = "/contacts/foreign";
    expect(f.journal.getRpc("rpc-1")).toEqual(binding);
    expect(f.journal.bindRpc({ ...binding, approvalId: "different" })).toBe(false);
  } finally { f.cleanup(); }
});
it("F022 association write failure prevents dispatch", async () => {
  const f = fixture();
  try {
    vi.spyOn(f.journal, "bindRpc").mockImplementation(() => { throw new Error("disk refused"); });
    const cb = callbacks();
    await expect(runRpcApprovedWrite(f.journal, "rpc-1", binding.rpcDigest, cb)).rejects.toThrow("disk refused");
    expect(cb.dispatch).not.toHaveBeenCalled(); expect(cb.reconcile).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
it("F022 RPC digest mismatch and changed authority cannot read, dispatch or release a cached outcome", async () => {
  const f = fixture();
  try {
    f.journal.bindRpc(binding); f.journal.claim(binding.approvalId, binding.requestDigest); f.journal.settle(binding.approvalId, binding.requestDigest, applied);
    const cb = callbacks();
    expect(await runRpcApprovedWrite(f.journal, "rpc-1", hash("other"), cb)).toEqual({ status: "conflict", reason: "approval_binding" });
    cb.authorize.mockResolvedValue(false);
    expect(await runRpcApprovedWrite(f.journal, "rpc-1", binding.rpcDigest, cb)).toEqual({ status: "conflict", reason: "authority_changed" });
    expect(cb.dispatch).not.toHaveBeenCalled(); expect(cb.reconcile).not.toHaveBeenCalled(); expect(cb.prepare).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
it("F022 torn association fails closed and cannot become a fresh RPC", async () => {
  const f = fixture();
  try {
    f.journal.bindRpc(binding);
    const file = readdirSync(f.dir).find(name => name.endsWith(".rpc.json"))!;
    expect(JSON.parse(readFileSync(join(f.dir, file), "utf8"))).toEqual(binding);
    writeFileSync(join(f.dir, file), "{torn");
    const cb = callbacks();
    await expect(runRpcApprovedWrite(new FileRpcApprovalJournal(f.dir), "rpc-1", binding.rpcDigest, cb)).rejects.toThrow();
    expect(cb.prepare).not.toHaveBeenCalled(); expect(cb.dispatch).not.toHaveBeenCalled(); expect(cb.reconcile).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
it.each(["write-target", "foreign-route", "unknown-field"])("F022 invalid association %s refuses before publication", fault => {
  const f = fixture();
  try {
    const bad = fault === "write-target" ? { ...binding, readTargets: [{ operation: "contacts.update", path: "/contacts/c1" }] }
      : fault === "foreign-route" ? { ...binding, readTargets: [{ operation: "contacts.get", path: "https://foreign.invalid/contacts/c1" }] }
      : { ...binding, rawResponse: "private" };
    expect(() => f.journal.bindRpc(bad as RpcApprovalBinding)).toThrow();
    expect(f.journal.getRpc("rpc-1")).toBeUndefined();
  } finally { f.cleanup(); }
});
it("F022 failed reconciliation leaves original approval pending and the next replay remains read-only", async () => {
  const f = fixture();
  try {
    f.journal.bindRpc(binding);
    const cb = callbacks();
    cb.reconcile.mockRejectedValueOnce(new Error("read unavailable"));
    await expect(runRpcApprovedWrite(f.journal, "rpc-1", binding.rpcDigest, cb)).rejects.toThrow("read unavailable");
    expect(f.journal.get(binding.approvalId)?.state).toBe("pending");
    expect(await runRpcApprovedWrite(new FileRpcApprovalJournal(f.dir), "rpc-1", binding.rpcDigest, cb)).toEqual(applied);
    expect(cb.reconcile).toHaveBeenCalledTimes(2); expect(cb.dispatch).not.toHaveBeenCalled(); expect(cb.prepare).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
it("F022 legacy pending RPC without an association is never blanket-settled or resent", async () => {
  const f = fixture();
  try {
    f.journal.claim("rpc-1", binding.rpcDigest);
    const cb = callbacks();
    expect(await runRpcApprovedWrite(f.journal, "rpc-1", binding.rpcDigest, cb)).toEqual({ status: "conflict", reason: "unconfirmed" });
    expect(f.journal.get("rpc-1")?.state).toBe("pending");
    expect(cb.prepare).not.toHaveBeenCalled(); expect(cb.dispatch).not.toHaveBeenCalled(); expect(cb.reconcile).not.toHaveBeenCalled();
    // A lane can recover the durable approval's mapping without altering the old RPC record.
    f.journal.bindRpc(binding);
    expect(await runRpcApprovedWrite(f.journal, "rpc-1", binding.rpcDigest, cb)).toEqual(applied);
    expect(cb.reconcile).toHaveBeenCalledTimes(1); expect(cb.dispatch).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
it("F022 changed authority after reconciliation withholds persisted result", async () => {
  const f = fixture();
  try {
    f.journal.bindRpc(binding);
    const cb = callbacks();
    cb.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await runRpcApprovedWrite(f.journal, "rpc-1", binding.rpcDigest, cb)).toEqual({ status: "conflict", reason: "authority_changed" });
    expect(f.journal.get(binding.approvalId)?.state).toBe("applied");
    expect(cb.reconcile).toHaveBeenCalledTimes(1); expect(cb.dispatch).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
