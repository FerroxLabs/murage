import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalBindingJson } from "./binding-json.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./operations/manifest.ts";
import { reconciliationReadsFor } from "./operations/reconciliation.ts";
import { highlevelIdSchema } from "./operations/schemas/common.ts";
import type { OperationId } from "../../shared/highlevel.ts";
import { FileApprovalJournal, runApprovedWrite, type ApprovalJournal, type ApprovalOutcome } from "./approval-idempotency.ts";
import { runApprovedInvocation } from "./approval-invocations.ts";

export interface RpcApprovalBinding {
  readonly rpcId: string;
  readonly rpcDigest: string;
  readonly approvalId: string;
  readonly requestDigest: string;
  readonly actionId: string;
  readonly authorityDigest: string;
  readonly operation: OperationId;
  readonly readTargets: readonly { readonly operation: OperationId; readonly path: string }[];
  /** Hash of the operation-specific approved effect, never raw review values. */
  readonly effectDigest: string;
}
export interface RpcApprovalJournal extends ApprovalJournal {
  getRpc(rpcId: string): RpcApprovalBinding | undefined;
  bindRpc(binding: RpcApprovalBinding): boolean;
}
const refuse = (): never => { throw new Error("HighLevel RPC approval journal refused"); };
const validKey = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 1024;
const validDigest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
function validateBinding(value: unknown): RpcApprovalBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
  const r = value as RpcApprovalBinding;
  const keys = ["rpcId", "rpcDigest", "approvalId", "requestDigest", "actionId", "authorityDigest", "operation", "readTargets", "effectDigest"];
  if (Object.keys(r).length !== keys.length || Object.keys(r).some(k => !keys.includes(k))
    || ![r.rpcId, r.approvalId, r.actionId].every(validKey)
    || ![r.rpcDigest, r.requestDigest, r.authorityDigest, r.effectDigest].every(validDigest)) return refuse();
  const mutation = HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === r.operation);
  if (!mutation || mutation.disposition !== "ready" || mutation.risk === "R" || !Array.isArray(r.readTargets) || r.readTargets.length === 0 || r.readTargets.length > (r.operation === 'contacts.tags.bulk' ? 500 : 100)) return refuse();
  const allowedReads = reconciliationReadsFor(r.operation);
  for (const target of r.readTargets) {
    if (!target || typeof target !== "object" || Object.keys(target).length !== 2 || !Object.hasOwn(target, "operation") || !Object.hasOwn(target, "path")) return refuse();
    const row = HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === target.operation);
    if (!row || row.disposition !== "ready" || row.risk !== "R" || !allowedReads.includes(row.id) || typeof target.path !== "string") return refuse();
    const actual = target.path.split("/"), template = row.path.split("/");
    if (actual.length !== template.length || template.some((part, i) => part.startsWith(":")
      ? !highlevelIdSchema.safeParse(actual[i]).success : part !== actual[i])) return refuse();
  }
  canonicalBindingJson(r);
  return structuredClone(r);
}
/** Same approval subjournal, separate immutable RPC index. Publication uses the
 * F0.2 hard-link/fsync durability contract; no TTL, overwrite or delete path. */
export class FileRpcApprovalJournal extends FileApprovalJournal implements RpcApprovalJournal {
  #path(rpcId: string): string {
    if (!validKey(rpcId)) return refuse();
    return join(this.key, `${createHash("sha256").update(rpcId).digest("hex")}.rpc.json`);
  }
  getRpc(rpcId: string): RpcApprovalBinding | undefined {
    let text: string;
    try { text = readFileSync(this.#path(rpcId), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return refuse(); }
    let binding: RpcApprovalBinding;
    try { binding = validateBinding(JSON.parse(text)); } catch { return refuse(); }
    if (binding.rpcId !== rpcId) return refuse();
    return binding;
  }
  bindRpc(binding: RpcApprovalBinding): boolean {
    const record = validateBinding(binding);
    if (this.getRpc(record.rpcId)) return false;
    const temp = join(this.key, `.rpc-${randomUUID()}.tmp`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      try { writeFileSync(fd, canonicalBindingJson(record)); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(temp, this.#path(record.rpcId)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
      const directory = openSync(this.key, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return true;
    } finally { unlinkSync(temp); }
  }
}
export interface RpcApprovedWriteCallbacks {
  /** Review/verify once. MUST NOT dispatch. Build targets from approved held bytes. */
  prepare(): Promise<RpcApprovalBinding>;
  /** Caller verifies current authority before any read/send/result release. */
  authorize(binding: RpcApprovalBinding): Promise<boolean>;
  dispatch(binding: RpcApprovalBinding): Promise<ApprovalOutcome>;
  /** Read durable targets and compare the actual effect to effectDigest. Never resend. */
  reconcile(binding: RpcApprovalBinding): Promise<ApprovalOutcome>;
}
const inFlight = new Map<string, { digest: string; work: Promise<ApprovalOutcome> }>();
const conflict = (reason: "approval_binding" | "authority_changed" | "unconfirmed"): ApprovalOutcome => ({ status: "conflict", reason });
/** Resolve RPC -> original approval BEFORE attempting a new review. A recovered
 * association always takes the read-only path, even if the process died before
 * publishing the approval's pending entry. The approval terminal is the only
 * outcome cache; there is no outer RPC terminal to mask a pending approval.
 * Live approval ownership spans authorization AND claim/settlement. The RPC map
 * additionally covers preparation, before an approval identity is available. */
export async function runRpcApprovedWrite(journal: RpcApprovalJournal, rpcId: string, rpcDigest: string, callbacks: RpcApprovedWriteCallbacks): Promise<ApprovalOutcome> {
  if (!validKey(rpcId) || !validDigest(rpcDigest)) return conflict("approval_binding");
  const key = JSON.stringify([journal.key, rpcId]);
  const running = inFlight.get(key);
  if (running) {
    if (running.digest !== rpcDigest) return conflict("approval_binding");
    const outcome = await running.work;
    const saved = journal.getRpc(rpcId);
    return saved && await callbacks.authorize(structuredClone(saved)) ? structuredClone(outcome) : conflict("authority_changed");
  }
  const work = Promise.resolve().then(async (): Promise<ApprovalOutcome> => {
    const execute = async (binding: RpcApprovalBinding, fresh: boolean): Promise<ApprovalOutcome> => {
      if (!await callbacks.authorize(structuredClone(binding))) return conflict("authority_changed");
      return runApprovedWrite(journal, binding.approvalId, binding.requestDigest, {
        dispatch: () => fresh ? callbacks.dispatch(structuredClone(binding)) : callbacks.reconcile(structuredClone(binding)),
        reconcile: () => callbacks.reconcile(structuredClone(binding)),
      });
    };
    const recover = (binding: RpcApprovalBinding) => runApprovedInvocation(journal, binding.approvalId, binding.requestDigest, () => execute(binding, false));
    let saved = journal.getRpc(rpcId);
    let outcome: ApprovalOutcome;
    if (!saved) {
      // Legacy outer-RPC claims have no recoverable approval association. Do not
      // terminalize them, re-review or resend: a lane may recover their mapping.
      if (journal.get(rpcId)) return conflict("unconfirmed");
      const proposed = validateBinding(await callbacks.prepare());
      if (proposed.rpcId !== rpcId || proposed.rpcDigest !== rpcDigest) return conflict("approval_binding");
      let joined = true;
      outcome = await runApprovedInvocation(journal, proposed.approvalId, proposed.requestDigest, async () => {
        joined = false;
        if (!await callbacks.authorize(structuredClone(proposed))) return conflict("authority_changed");
        const fresh = journal.bindRpc(proposed);
        saved = journal.getRpc(rpcId);
        if (!saved || saved.rpcDigest !== rpcDigest) return conflict("approval_binding");
        if (saved.approvalId !== proposed.approvalId) return recover(saved);
        if (saved.requestDigest !== proposed.requestDigest) return conflict("approval_binding");
        return execute(saved, fresh);
      });
      // A different RPC can join an already-live approval before publishing its
      // own alias. Persist that association after joining, without claiming or
      // dispatching. Its own authority still gates both publication and release.
      if (!saved) {
        if (!joined) return outcome;
        if (outcome.status === "conflict" && outcome.reason === "approval_binding") return outcome;
        if (!await callbacks.authorize(structuredClone(proposed))) return conflict("authority_changed");
        journal.bindRpc(proposed);
        saved = journal.getRpc(rpcId);
        if (!saved || saved.rpcDigest !== rpcDigest || saved.approvalId !== proposed.approvalId || saved.requestDigest !== proposed.requestDigest) return conflict("approval_binding");
      }
    } else {
      if (saved.rpcDigest !== rpcDigest) return conflict("approval_binding");
      outcome = await recover(saved);
    }
    return await callbacks.authorize(structuredClone(saved)) ? outcome : conflict("authority_changed");
  });
  inFlight.set(key, { digest: rpcDigest, work });
  try { return structuredClone(await work); }
  finally { if (inFlight.get(key)?.work === work) inFlight.delete(key); }
}
