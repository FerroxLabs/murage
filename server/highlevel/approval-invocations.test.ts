import { removeTempDirSync } from "../testing/cleanup.ts";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { expect, it, vi } from "vitest";
import { runApprovedInvocation } from "./approval-invocations.ts";
import { runApprovedWrite, type ApprovalOutcome } from "./approval-idempotency.ts";
import { FileRpcApprovalJournal, runRpcApprovedWrite, type RpcApprovalBinding } from "./rpc-approval-replay.ts";
import { canonicalBindingJson } from "./binding-json.ts";

const hash = (value: unknown) => createHash("sha256").update(canonicalBindingJson(value)).digest("hex");
const binding: RpcApprovalBinding = {
  rpcId: "tool-call-1", rpcDigest: hash({ operation: "contacts.update", args: { contactId: "contact_1", firstName: "safe" } }),
  approvalId: "approval-1", requestDigest: hash({ method: "PUT", path: "/contacts/contact_1", body: { firstName: "safe" } }),
  actionId: "action-1", authorityDigest: hash("fixture-authority"), operation: "contacts.update",
  readTargets: [{ operation: "contacts.get", path: "/contacts/contact_1" }], effectDigest: hash({ firstName: "safe" }),
};
const applied: ApprovalOutcome = { status: "applied", result: { actionId: "action-1", recordId: "contact_1", firstName: "safe" } };
const unconfirmed: ApprovalOutcome = { status: "conflict", reason: "unconfirmed" };
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hl-f023-"));
  return { dir, journal: new FileRpcApprovalJournal(dir), cleanup: () => removeTempDirSync(dir) };
}
async function provider() {
  let writes = 0, reads = 0, firstName = "before";
  const server = createServer(async (req, res) => {
    expect(req.url).toBe("/contacts/contact_1");
    if (req.method === "PUT") {
      writes++; let body = ""; for await (const part of req) body += part;
      expect(JSON.parse(body)).toEqual({ firstName: "safe" }); firstName = "safe";
    } else { expect(req.method).toBe("GET"); reads++; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ contact: { id: "contact_1", firstName } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  return {
    url, counts: () => ({ writes, reads }),
    dispatch: vi.fn(async () => { await fetch(`${url}/contacts/contact_1`, { method: "PUT", body: JSON.stringify({ firstName: "safe" }) }); return applied; }),
    reconcile: vi.fn(async (saved: RpcApprovalBinding) => {
      const value = await fetch(`${url}${saved.readTargets[0].path}`).then(r => r.json()) as { contact: { id: string; firstName: string } };
      return value.contact.id === "contact_1" && hash({ firstName: value.contact.firstName }) === saved.effectDigest ? applied : unconfirmed;
    }),
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

it("F023 reviewer interleaving: original pauses after approval; duplicate authorizes first while journal is absent", async () => {
  const f = fixture(), p = await provider(), paused = gate(), resume = gate();
  const order: string[] = [];
  const authorize = async (original: boolean) => {
    if (original) { paused.release(); await resume.wait; }
    order.push(original ? "original authorized" : "duplicate authorized");
  };
  // Host has assigned the same approval to both RPCs. Register the original
  // BEFORE its post-approval await; the replay's missing-entry path is read-only.
  const original = runApprovedInvocation(f.journal, binding.approvalId, binding.requestDigest, async () => {
    await authorize(true);
    return runApprovedWrite(f.journal, binding.approvalId, binding.requestDigest, { dispatch: p.dispatch, reconcile: () => p.reconcile(binding) });
  });
  await paused.wait;
  expect(f.journal.get(binding.approvalId)).toBeUndefined();
  let completed = false;
  const duplicate = (async () => {
    await authorize(false);
    const result = await runApprovedInvocation(new FileRpcApprovalJournal(f.dir), binding.approvalId, binding.requestDigest, () =>
      runApprovedWrite(new FileRpcApprovalJournal(f.dir), binding.approvalId, binding.requestDigest, {
        dispatch: async () => unconfirmed, reconcile: () => p.reconcile(binding),
      }));
    completed = true; return result;
  })();
  try {
    await drain();
    const beforeResume = { completed, entry: f.journal.get(binding.approvalId), counts: p.counts() };
    resume.release();
    const outcomes = await Promise.all([original, duplicate]);
    expect(order).toEqual(["duplicate authorized", "original authorized"]);
    expect(p.counts()).toEqual({ writes: 1, reads: 0 });
    expect(outcomes).toEqual([applied, applied]);
    expect(beforeResume).toEqual({ completed: false, entry: undefined, counts: { writes: 0, reads: 0 } });
    expect(f.journal.get(binding.approvalId)?.state).toBe("applied");
  } finally { resume.release(); await Promise.allSettled([original, duplicate]); await p.close(); f.cleanup(); }
});

it.each([true, false])("F023 RPC paths sharing an approval join before post-approval authorization and journal claim; bound=%s", async bound => {
  const f = fixture(), p = await provider(), paused = gate(), resume = gate();
  // A second durable RPC reference to the same approved action must use the
  // approval registry, even though it does not share the RPC-keyed registry.
  const alias = { ...binding, rpcId: "same-approved-action" };
  if (bound) f.journal.bindRpc(alias);
  let authorization = 0;
  const original = runRpcApprovedWrite(f.journal, binding.rpcId, binding.rpcDigest, {
    prepare: async () => binding,
    authorize: async () => { if (++authorization === 2) { paused.release(); await resume.wait; } return true; },
    dispatch: p.dispatch, reconcile: p.reconcile,
  });
  await paused.wait;
  const duplicateAuthorize = vi.fn(async () => true);
  const duplicate = runRpcApprovedWrite(new FileRpcApprovalJournal(f.dir), alias.rpcId, alias.rpcDigest, {
    prepare: async () => { if (bound) throw new Error("already approved"); return alias; }, authorize: duplicateAuthorize, dispatch: p.dispatch, reconcile: p.reconcile,
  });
  try {
    await drain();
    // All queued promise continuations have run: a replay that did not join has
    // already claimed the absent approval, even if its GET is still in flight.
    resume.release();
    expect(await Promise.all([original, duplicate])).toEqual([applied, applied]);
    expect(p.counts()).toEqual({ writes: 1, reads: 0 });
    expect(duplicateAuthorize).toHaveBeenCalled();
    expect(f.journal.getRpc(alias.rpcId)).toEqual(alias);
  } finally { resume.release(); await Promise.allSettled([original, duplicate]); await p.close(); f.cleanup(); }
});

it("F023 live approval rejects a different digest even before any journal entry exists", async () => {
  const f = fixture(), resume = gate();
  const original = runApprovedInvocation(f.journal, binding.approvalId, binding.requestDigest, async () => { await resume.wait; return applied; });
  try {
    const invoke = vi.fn(async () => unconfirmed);
    expect(await runApprovedInvocation(new FileRpcApprovalJournal(f.dir), binding.approvalId, hash("different"), invoke)).toEqual({ status: "conflict", reason: "approval_binding" });
    expect(invoke).not.toHaveBeenCalled(); expect(f.journal.get(binding.approvalId)).toBeUndefined();
  } finally { resume.release(); await original; f.cleanup(); }
});

it.each(["journal", "approval"])("F023 distinct %s identities do not join", async distinct => {
  const f = fixture(), other = fixture(), resume = gate();
  const original = runApprovedInvocation(f.journal, binding.approvalId, binding.requestDigest, async () => { await resume.wait; return applied; });
  try {
    const invoke = vi.fn(async () => unconfirmed);
    expect(await runApprovedInvocation(distinct === "journal" ? other.journal : f.journal, distinct === "approval" ? "approval-2" : binding.approvalId, binding.requestDigest, invoke)).toEqual(unconfirmed);
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally { resume.release(); await original; f.cleanup(); other.cleanup(); }
});

it("F023 join returns independent result copies and completion removes live ownership", async () => {
  const f = fixture(), resume = gate();
  const original = runApprovedInvocation(f.journal, binding.approvalId, binding.requestDigest, async () => { await resume.wait; return applied; });
  const invoke = vi.fn(async () => unconfirmed);
  const duplicate = runApprovedInvocation(new FileRpcApprovalJournal(f.dir), binding.approvalId, binding.requestDigest, invoke);
  try {
    resume.release();
    const [first, second] = await Promise.all([original, duplicate]);
    expect(invoke).not.toHaveBeenCalled();
    if (first.status === "applied") (first.result as { firstName: string }).firstName = "caller mutation";
    expect(second).toEqual(applied);
    expect(await runApprovedInvocation(f.journal, binding.approvalId, binding.requestDigest, invoke)).toEqual(unconfirmed);
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally { resume.release(); await Promise.allSettled([original, duplicate]); f.cleanup(); }
});

it("F023 failed live invocation rejects both callers and leaves pending replay read-only", async () => {
  const f = fixture(), resume = gate(), paused = gate();
  const original = runApprovedInvocation(f.journal, binding.approvalId, binding.requestDigest, () =>
    runApprovedWrite(f.journal, binding.approvalId, binding.requestDigest, {
      dispatch: async () => { paused.release(); await resume.wait; throw new Error("possible send interrupted"); }, reconcile: async () => unconfirmed,
    }));
  await paused.wait;
  const invoke = vi.fn(async () => applied);
  const duplicate = runApprovedInvocation(new FileRpcApprovalJournal(f.dir), binding.approvalId, binding.requestDigest, invoke);
  const results = Promise.allSettled([original, duplicate]);
  try {
    resume.release();
    expect((await results).map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(invoke).not.toHaveBeenCalled(); expect(f.journal.get(binding.approvalId)?.state).toBe("pending");
    const reconcile = vi.fn(async () => applied);
    expect(await runApprovedInvocation(f.journal, binding.approvalId, binding.requestDigest, () =>
      runApprovedWrite(f.journal, binding.approvalId, binding.requestDigest, { dispatch: invoke, reconcile }))).toEqual(applied);
    expect(invoke).not.toHaveBeenCalled(); expect(reconcile).toHaveBeenCalledTimes(1);
  } finally { resume.release(); await results; f.cleanup(); }
});

it("F023 a joined RPC still checks its own authority before releasing the original's result", async () => {
  const f = fixture(), resume = gate(), paused = gate();
  const cb = {
    prepare: async () => binding, authorize: async () => true,
    dispatch: vi.fn(async () => { paused.release(); await resume.wait; return applied; }), reconcile: vi.fn(async () => unconfirmed),
  };
  const original = runRpcApprovedWrite(f.journal, binding.rpcId, binding.rpcDigest, cb);
  await paused.wait;
  const authorize = vi.fn(async () => false);
  const duplicate = runRpcApprovedWrite(new FileRpcApprovalJournal(f.dir), binding.rpcId, binding.rpcDigest, { ...cb, authorize });
  try {
    resume.release();
    expect(await original).toEqual(applied);
    expect(await duplicate).toEqual({ status: "conflict", reason: "authority_changed" });
    expect(cb.dispatch).toHaveBeenCalledTimes(1); expect(cb.reconcile).not.toHaveBeenCalled(); expect(authorize).toHaveBeenCalledTimes(1);
    expect(f.journal.get(binding.approvalId)?.state).toBe("applied");
  } finally { resume.release(); await Promise.allSettled([original, duplicate]); f.cleanup(); }
});

it("F023 exact same RPC joins during prepare and before approval claim", async () => {
  const f = fixture(), p = await provider(), paused = gate(), resume = gate();
  const prepare = vi.fn(async () => { paused.release(); await resume.wait; return binding; });
  const cb = { prepare, authorize: async () => true, dispatch: p.dispatch, reconcile: p.reconcile };
  const original = runRpcApprovedWrite(f.journal, binding.rpcId, binding.rpcDigest, cb);
  await paused.wait;
  const duplicate = runRpcApprovedWrite(new FileRpcApprovalJournal(f.dir), binding.rpcId, binding.rpcDigest, cb);
  try {
    await drain(); expect(f.journal.get(binding.approvalId)).toBeUndefined(); resume.release();
    expect(await Promise.all([original, duplicate])).toEqual([applied, applied]);
    expect(p.counts()).toEqual({ writes: 1, reads: 0 }); expect(prepare).toHaveBeenCalledTimes(1);
  } finally { resume.release(); await Promise.allSettled([original, duplicate]); await p.close(); f.cleanup(); }
});

it.each(["before-claim", "after-send"])("F023 actual crash %s drops live ownership; restart reconciles and never resends", async stage => {
  const f = fixture(), p = await provider();
  try {
    const child = spawn(process.execPath, ["--experimental-strip-types", "server/highlevel/testing/invocation-crash-worker.ts", f.dir, p.url, JSON.stringify(binding), stage], { stdio: "pipe" });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
    expect(await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); }), stderr).toBe(23);
    const reopened = new FileRpcApprovalJournal(f.dir);
    expect(reopened.getRpc(binding.rpcId)).toEqual(binding);
    expect(reopened.get(binding.approvalId)?.state).toBe(stage === "before-claim" ? undefined : "pending");
    const cb = { prepare: vi.fn(async () => binding), authorize: async () => true, dispatch: p.dispatch, reconcile: p.reconcile };
    const expected = stage === "before-claim" ? unconfirmed : applied;
    expect(await runRpcApprovedWrite(reopened, binding.rpcId, binding.rpcDigest, cb)).toEqual(expected);
    expect(await runRpcApprovedWrite(reopened, binding.rpcId, binding.rpcDigest, cb)).toEqual(expected);
    expect(p.counts()).toEqual({ writes: stage === "before-claim" ? 0 : 1, reads: 1 });
    expect(cb.prepare).not.toHaveBeenCalled(); expect(p.dispatch).not.toHaveBeenCalled();
  } finally { await p.close(); f.cleanup(); }
});
