import { FileRpcApprovalJournal, runRpcApprovedWrite } from "../rpc-approval-replay.ts";
import type { RpcApprovalBinding } from "../rpc-approval-replay.ts";
const [directory, url, json, stage] = process.argv.slice(2);
const binding = JSON.parse(json) as RpcApprovalBinding;
const journal = new FileRpcApprovalJournal(directory);
if (stage === "after-outcome") {
  const settle = journal.settle.bind(journal);
  journal.settle = (...args) => { settle(...args); process.exit(19); };
}
await runRpcApprovedWrite(journal, binding.rpcId, binding.rpcDigest, {
  prepare: async () => binding,
  authorize: async () => true,
  dispatch: async () => {
    const reopened = new FileRpcApprovalJournal(directory);
    if (reopened.getRpc(binding.rpcId)?.approvalId !== binding.approvalId || reopened.get(binding.approvalId)?.state !== "pending") process.exit(20);
    await fetch(url, { method: "PUT" });
    if (stage === "after-dispatch") process.exit(19);
    return { status: "applied", result: { actionId: binding.actionId, recordId: "c1" } };
  },
  reconcile: async () => { throw new Error("fresh worker must dispatch"); },
});
