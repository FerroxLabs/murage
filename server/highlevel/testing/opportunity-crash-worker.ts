import { defaultHighLevelFamilies } from "../../../shared/highlevel.ts";
// Real host process-exit witness; every provider response is an isolated fake.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { highLevelHarness } from "../../testing/fake-highlevel.ts";
import { HighLevelHost } from "../host.ts";
import { HighLevelActions } from "../actions.ts";
import { FileActionJournal } from "../journal-file.ts";
import { FileRpcApprovalJournal } from "../rpc-approval-replay.ts";
const [directory, stage, kind, acceptedText] = process.argv.slice(2);
const accepted = acceptedText === "true", pipeline = kind === "pipeline";
const h = highLevelHarness();
const actions = new HighLevelActions({ journal: new FileActionJournal(join(directory, "actions.jsonl")) });
if (stage === "recover") actions.recover();
const approvalJournal = new FileRpcApprovalJournal(join(directory, "approvals"));
h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2, denyRules: [], grants: [{ ...h.grant(), families: { ...defaultHighLevelFamilies(), opportunities: "full" } }] };
const trace = (method: string, path: string, query?: URLSearchParams) => appendFileSync(join(directory, "trace.jsonl"), `${JSON.stringify({ stage, method, path, query: query?.toString() })}\n`);
h.api.always("GET", /^\/opportunities\/pipelines$/, req => {
  trace(req.method, req.path, req.query);
  return { status: 200, body: pipeline ? { pipelines: stage === "recover" && accepted ? [{ id: "new_pipe", name: "Reviewed", stages: [{ id: "new_stage", name: "New", position: 0 }] }] : [] }
    : { pipelines: [{ id: "pipe_A", stages: [] }] } };
});
h.api.always("GET", /^\/opportunities\/opp_A$/, req => {
  trace(req.method, req.path, req.query);
  return { status: 200, body: { opportunity: { id: "opp_A", pipelineId: "pipe_A", name: stage === "recover" && accepted ? "Reviewed" : "Unchanged", status: "open", followers: [] } } };
});
h.api.always("POST", pipeline ? /^\/opportunities\/pipelines$/ : /^\/opportunities\/upsert$/, req => {
  trace(req.method, req.path);
  const row = actions.get((JSON.parse(readFileSync(join(directory, "action.json"), "utf8")) as { actionId: string }).actionId)!;
  if (approvalJournal.get(row.approvalId!)?.state !== "pending") process.exit(25);
  process.exit(24);
});
const host = new HighLevelHost({ ...h, actions, approvalJournal: approvalJournal, bot: () => h.bot,
  operationScopes: () => ["opportunities.readonly", "opportunities.write", "pipelines.create", "pipelines.write"],
  approvalBasis: () => "owner_exact_review", onReview: (_claim, review) => {
    writeFileSync(join(directory, "action.json"), JSON.stringify({ actionId: review.actionId }));
    actions.approve(review.actionId, review.reviewDigest);
  },
});
const request = { jsonrpc: "2.0", id: "original-rpc", method: "tools/call", params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: pipeline
  ? { operation: "opportunities.pipelines.create", args: { name: "Reviewed", stages: [{ name: "New", position: 0 }] } }
  : { operation: "opportunities.upsert", args: { id: "opp_A", pipelineId: "pipe_A", name: "Reviewed" } } } };
try {
  const result = await host.handle(h.claim, request);
  if (stage !== "recover") { writeFileSync(join(directory, "failed-send.json"), JSON.stringify(result)); process.exitCode = 26; }
  else {
    const repeated = await host.handle(h.claim, request);
    writeFileSync(join(directory, "result.json"), JSON.stringify({ result, repeated }));
  }
} finally { h.stop(); }
