import { FileRpcApprovalJournal, runRpcApprovedWrite, type RpcApprovalBinding } from "../rpc-approval-replay.ts";
const [directory, url, json, body] = process.argv.slice(2);
const binding = JSON.parse(json) as RpcApprovalBinding;
const journal = new FileRpcApprovalJournal(directory);
await runRpcApprovedWrite(journal, binding.rpcId, binding.rpcDigest, {
  prepare: async () => binding,
  authorize: async () => true,
  dispatch: async () => {
    if (new FileRpcApprovalJournal(directory).get(binding.approvalId)?.state !== "pending") process.exit(25);
    await fetch(`${url}/opportunities/pipelines`, { method: "POST", headers: { "content-type": "application/json" }, body });
    process.exit(24);
  },
  reconcile: async () => { throw new Error("fresh worker must send"); },
});
