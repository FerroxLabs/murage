import { removeTempDirSync } from "../testing/cleanup.ts";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import data from "./operations/manifest-data.json" with { type: "json" };
import { FileRpcApprovalJournal, runRpcApprovedWrite, type RpcApprovalBinding } from "./rpc-approval-replay.ts";
import { canonicalBindingJson } from "./binding-json.ts";

const rows = data as (typeof data[number] & { reconciliation?: string[]; approvalBlocked?: string })[];
const hash = (value: unknown) => createHash("sha256").update(canonicalBindingJson(value)).digest("hex");
const approved = { name: "Reviewed", stages: [{ name: "New", position: 0 }] };
const binding: RpcApprovalBinding = {
  rpcId: "tool-call-1", rpcDigest: hash("rpc"), approvalId: "approval-1", requestDigest: hash(approved),
  actionId: "action-1", authorityDigest: hash("authority"), operation: "opportunities.pipelines.create",
  readTargets: [{ operation: "opportunities.pipelines.list", path: "/opportunities/pipelines" }], effectDigest: hash(approved),
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hl-f024-"));
  return { dir, journal: new FileRpcApprovalJournal(dir), cleanup: () => removeTempDirSync(dir) };
}
function callbacks(value = binding) {
  return { prepare: vi.fn(async () => value), authorize: vi.fn(async () => true),
    dispatch: vi.fn(async () => ({ status: "applied", result: {} } as const)),
    reconcile: vi.fn(async () => ({ status: "conflict", reason: "unconfirmed" } as const)) };
}
it("F024 every write declares reconciliation; every approvable write authorizes an available read", () => {
  const writes = rows.filter(row => row.risk !== "R");
  expect(writes.length).toBeGreaterThan(100);
  for (const row of writes) {
    expect(row.reconciliation, row.id).toBeDefined();
    // MAIN HL-F10-12:04 / HL-F10-12:04 amendment: courses.import alone has no documented reader.
    if (row.id === "courses.import") { expect(row.reconciliation).toEqual([]); continue; }
    expect(row.reconciliation!.length, row.id).toBeGreaterThan(0);
    for (const id of row.reconciliation!) {
      const read = rows.find(candidate => candidate.id === id);
      expect(read?.risk, `${row.id} -> ${id}`).toBe("R");
      if (row.disposition === "ready" && !row.approvalBlocked) {
        expect(read?.disposition, `${row.id} -> ${id}`).toBe("ready");
        expect(row.preflight, `${row.id} transport authorization`).toContain(id);
      }
    }
  }
});
it.each(["bind", "approve"])("F024 %s refuses empty reconciliation before publication, authorization or send", async mode => {
  const f = fixture();
  try {
    const value = { ...binding, operation: "contacts.update" as const, readTargets: [] };
    const cb = callbacks(value);
    if (mode === "bind") expect(() => f.journal.bindRpc(value)).toThrow(/refused/);
    else await expect(runRpcApprovedWrite(f.journal, value.rpcId, value.rpcDigest, cb)).rejects.toThrow(/refused/);
    expect(readdirSync(f.dir)).toEqual([]);
    expect(cb.authorize).not.toHaveBeenCalled(); expect(cb.dispatch).not.toHaveBeenCalled();
  } finally { f.cleanup(); }
});
it("F024 a prerequisite read cannot stand in for an effect reconciliation read", () => {
  const f = fixture();
  try {
    expect(() => f.journal.bindRpc({ ...binding, operation: "contacts.create",
      readTargets: [{ operation: "location.customFields.list", path: "/locations/loc_1/customFields" }] })).toThrow(/refused/);
  } finally { f.cleanup(); }
});
it("HL-F10-12:04 import has no fabricated reader; the old unavailable courses.list binding still refuses", () => {
  const f = fixture();
  try {
    // The sole exception is now declared; C2 owns acceptance of its exact empty-target v2 binding.
    expect(rows.find(row => row.id === "courses.import")?.approvalBlocked).toBeUndefined();
    expect(rows.find(row => row.id === "courses.import")?.reconciliation).toEqual([]);
    expect(() => f.journal.bindRpc({ ...binding, operation: "courses.import", readTargets: [{ operation: "courses.list", path: "/courses/" }] })).toThrow(/refused/);
  } finally { f.cleanup(); }
});
it.each([true, false])("F024 pipelines.create crash after POST: accepted=%s; one list read, exact name AND stages, no resend", async accepted => {
  const f = fixture(); let reads = 0, posts = 0;
  const provider = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/opportunities/pipelines") { posts++; res.end("{}"); return; }
    if (req.method !== "GET" || req.url !== "/opportunities/pipelines?locationId=loc_1") { res.statusCode = 400; res.end("{}"); return; }
    reads++;
    res.end(JSON.stringify({ pipelines: [
      { id: "wrong_name", name: "Other", stages: approved.stages },
      { id: "wrong_stages", name: approved.name, stages: [{ name: "Other", position: 0 }] },
      ...(accepted ? [{ id: "created_1", ...approved, stages: [{ id: "new_stage_1", ...approved.stages[0] }] }] : []),
    ] }));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(provider.address() as import("node:net").AddressInfo).port}`;
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", "server/highlevel/testing/pipeline-crash-worker.ts", f.dir, url, JSON.stringify(binding), JSON.stringify(approved)], { stdio: "pipe" });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    expect(await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); }), stderr).toBe(24);
    expect(f.journal.get(binding.approvalId)?.state).toBe("pending");
    const cb = callbacks();
    cb.prepare.mockImplementation(async () => { throw new Error("must recover the original approval"); });
    // Lane callback contract: location comes from the authorized durable action;
    // field selection is the approved fields, and values are compared by digest.
    const reconcile = vi.fn(async (saved: RpcApprovalBinding) => {
      expect(saved).toEqual(binding);
      const response = await fetch(`${url}${saved.readTargets[0].path}?locationId=loc_1`).then(r => r.json()) as {
        pipelines: { id: string; name: string; stages: { name: string; position: number }[] }[];
      };
      const matches = response.pipelines.filter(p => hash({ name: p.name,
        stages: p.stages.map(s => ({ name: s.name, position: s.position })) }) === saved.effectDigest);
      if (matches.length > 1) return { status: "conflict", reason: "unconfirmed" } as const;
      return matches.length === 1 ? { status: "applied", result: { actionId: saved.actionId, recordId: matches[0].id } } as const
        : { status: "conflict", reason: "negative_confirmation" } as const;
    });
    const expected = accepted ? { status: "applied", result: { actionId: binding.actionId, recordId: "created_1" } }
      : { status: "conflict", reason: "negative_confirmation" };
    const outcome = await runRpcApprovedWrite(new FileRpcApprovalJournal(f.dir), binding.rpcId, binding.rpcDigest, { ...cb, reconcile });
    expect(outcome).toEqual(expected);
    expect(outcome.status === "applied" ? "applied" : outcome.reason === "negative_confirmation" ? "not_applied" : "outcome_unknown").toBe(accepted ? "applied" : "not_applied");
    expect(await runRpcApprovedWrite(new FileRpcApprovalJournal(f.dir), binding.rpcId, binding.rpcDigest, { ...cb, reconcile })).toEqual(expected);
    expect(posts).toBe(1); expect(reads).toBe(1); expect(reconcile).toHaveBeenCalledTimes(1);
    expect(cb.prepare).not.toHaveBeenCalled(); expect(cb.dispatch).not.toHaveBeenCalled();
  } finally { await new Promise<void>(resolve => provider.close(() => resolve())); f.cleanup(); }
});

it.each(rows.filter(row => row.risk !== "R" && row.disposition === "ready" && !row.approvalBlocked))("F024 $id has an approvable durable read target", row => {
  const f = fixture();
  try {
    for (const id of row.reconciliation!) {
      const read = rows.find(candidate => candidate.id === id)!;
      const value = { ...binding, rpcId: `${row.id}:${id}`, operation: row.id as RpcApprovalBinding["operation"],
        readTargets: [{ operation: id as RpcApprovalBinding["operation"], path: read.path!.replace(/:[A-Za-z][A-Za-z0-9]*/gu, "fixture_1") }] };
      expect(f.journal.bindRpc(value)).toBe(true);
      expect(new FileRpcApprovalJournal(f.dir).getRpc(value.rpcId)).toEqual(value);
    }
  } finally { f.cleanup(); }
});
