import { FileRpcApprovalJournal, runRpcApprovedWrite, type RpcApprovalBinding } from "../rpc-approval-replay.ts";
const [directory, url, json, stage] = process.argv.slice(2);
const binding = JSON.parse(json) as RpcApprovalBinding;
const journal = new FileRpcApprovalJournal(directory);
let authorization = 0;
await runRpcApprovedWrite(journal, binding.rpcId, binding.rpcDigest, {
  prepare: async () => binding,
  authorize: async () => {
    if (++authorization === 2 && stage === "before-claim") {
      if (!journal.getRpc(binding.rpcId) || journal.get(binding.approvalId)) process.exit(24);
      process.exit(23);
    }
    return true;
  },
  dispatch: async () => {
    await fetch(`${url}${binding.readTargets[0].path}`, { method: "PUT", body: JSON.stringify({ firstName: "safe" }) });
    process.exit(23);
  },
  reconcile: async () => { throw new Error("fresh worker must dispatch"); },
});
