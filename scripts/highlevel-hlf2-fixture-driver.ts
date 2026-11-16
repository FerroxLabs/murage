import { defaultHighLevelFamilies } from "../shared/highlevel.ts";
// Isolated server instrumentation: real host/registry with a fake in-memory provider.
import assert from "node:assert/strict";
import { join } from "node:path";
import { highLevelHarness } from "../server/testing/fake-highlevel.ts";
import { HighLevelHost } from "../server/highlevel/host.ts";
import { FileRpcApprovalJournal as FileApprovalJournal } from "../server/highlevel/rpc-approval-replay.ts";
import { fixtureReadSpec } from "../server/testing/highlevel-r4-fixtures.ts";
import { operationSpec } from "../server/highlevel/operations/registry.ts";

export async function runFixtureEvidence(dataDir: string) {
  const h = highLevelHarness();
  const approvalJournal = new FileApprovalJournal(join(dataDir, "hlf2-approvals"));
  const callJournal = new FileApprovalJournal(join(dataDir, "hlf2-calls"));
  h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2, denyRules: [],
    grants: [{ ...h.grant(), families: { ...defaultHighLevelFamilies(), opportunities: "full" } }] };
  h.api.always("GET", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A", pipelineId: "pipe_A" } } });
  h.api.always("GET", /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: [{ id: "pipe_A", stages: [] }] } });
  h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A", name: "Fixture update" } } });
  const host = new HighLevelHost({ ...h, bot: () => h.bot, approvalJournal: approvalJournal, callJournal: callJournal,
    operationSpec: id => id === "users.get" ? fixtureReadSpec(id) : operationSpec(id),
    onReview: (_claim, review) => { h.actions.approve(review.actionId, review.reviewDigest); }, operationScopes: () => ["opportunities.readonly", "opportunities.write", "pipelines.create", "pipelines.write"], approvalBasis: () => "owner_no_limits" });
  const request = (id: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "HIGHLEVEL_OPPORTUNITIES",
    arguments: { operation: "opportunities.update", args: { opportunityId: "opp_A", name: "Fixture update" } } } });
  const results: unknown[] = [];
  try {
    const first = await host.handle(h.claim, request("fixture-write"));
    assert.equal((first.result as { structuredContent: { outcome: string } }).structuredContent.outcome, "applied");
    assert.deepEqual(await host.handle(h.claim, request("fixture-write")), first);
    assert.equal(h.api.calls("PUT").length, 1);
    results.push({ case: "applied and RPC replay", result: first, writes: 1 });
    h.api.first("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A", contact: { contactId: "foreign" } } } });
    const conflict = await host.handle(h.claim, request("fixture-conflict"));
    assert.equal((conflict.result as { structuredContent: { outcome: string } }).structuredContent.outcome, "outcome_unknown");
    assert.deepEqual(await host.handle(h.claim, request("fixture-conflict")), conflict);
    results.push({ case: "nested alias withheld and replayed", result: conflict });
    // Use a distinct reviewed change for the negative-confirmation case.
    const negative = { ...request("fixture-negative"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: {
      operation: "opportunities.update", args: { opportunityId: "opp_A", name: "Different reviewed value" } } } };
    h.api.first("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A", success: false } } });
    const declined = await host.handle(h.claim, negative);
    assert.equal((declined.result as { structuredContent: { outcome: string } }).structuredContent.outcome, "not_applied");
    results.push({ case: "nested negative withheld", result: declined });
    assert.equal(h.api.calls("PUT").length, 3);
    for (const returnedId of ["opp_A", "opp_B"]) {
      h.api.first("POST", /^\/opportunities\/upsert$/, { status: 200, body: {
        new: false, opportunity: { id: returnedId, followers: [] },
      } });
      const upsert = { ...request(`fixture-upsert-${returnedId}`), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: {
        operation: "opportunities.upsert", args: { id: "opp_A", pipelineId: "pipe_A", name: `Reviewed ${returnedId}` },
      } } };
      const result = await host.handle(h.claim, upsert);
      const content = (result.result as { structuredContent: { outcome: string; actionId: string } }).structuredContent;
      assert.equal(content.outcome, returnedId === "opp_A" ? "applied" : "outcome_unknown");
      const row = h.actions.get(content.actionId)!;
      assert.equal(row.resource, "location:loc_fixture_01");
      assert.equal(approvalJournal.get(row.approvalId!)?.state, returnedId === "opp_A" ? "applied" : "conflict");
      assert.equal(row.receipt?.recordId, returnedId === "opp_A" ? "opp_A" : undefined);
      assert.deepEqual(await host.handle(h.claim, upsert), result);
      results.push({ case: `existing-ID upsert ${returnedId === "opp_A" ? "applied" : "conflict"} and replay`, result });
    }
    assert.equal(h.api.calls("POST").length, 2);
    const crashRequest = { ...request("fixture-crash-upsert"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: {
      operation: "opportunities.upsert", args: { id: "opp_A", pipelineId: "pipe_A", name: "Crash reviewed" },
    } } };
    h.api.first("POST", /^\/opportunities\/upsert$/, { status: 200, body: { new: false, opportunity: { id: "opp_A", followers: [] } } });
    const settle = approvalJournal.settle.bind(approvalJournal);
    approvalJournal.settle = () => { throw new Error("fixture interruption before terminal fsync"); };
    const interrupted = await host.handle(h.claim, crashRequest);
    approvalJournal.settle = settle;
    const crashAction = (interrupted.result as { structuredContent: { actionId: string } }).structuredContent.actionId;
    assert.equal(approvalJournal.get(h.actions.get(crashAction)!.approvalId!)?.state, "pending");
    const readsBefore = h.api.calls("GET").length;
    h.api.first("GET", /^\/opportunities\/opp_A$/, { status: 200, body: {
      opportunity: { id: "opp_A", pipelineId: "pipe_A", name: "Crash reviewed", status: "open", followers: [] },
    } });
    const reconciled = await host.handle(h.claim, crashRequest);
    assert.equal((reconciled.result as { structuredContent: { outcome: string } }).structuredContent.outcome, "applied");
    assert.equal(h.api.calls("GET").length - readsBefore, 1);
    assert.equal(h.api.calls("POST").length, 3);
    assert.deepEqual(await host.handle(h.claim, crashRequest), reconciled);
    assert.equal(h.api.calls("GET").length - readsBefore, 1);
    results.push({ case: "location-scoped upsert interruption/replay", result: reconciled, reconciliationReads: 1, resends: 0 });

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const awaitDecision = h.actions.awaitDecision.bind(h.actions);
    let paused = false;
    h.actions.awaitDecision = async (...args) => { const answer = await awaitDecision(...args); paused = true; await gate; return answer; };
    const duplicateRequest = request("fixture-concurrent");
    const original = host.handle(h.claim, duplicateRequest);
    for (let turn = 0; !paused && turn < 500; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(paused, true);
    const duplicate = host.handle(h.claim, duplicateRequest);
    release();
    const [firstResult, secondResult] = await Promise.all([original, duplicate]);
    h.actions.awaitDecision = awaitDecision;
    assert.deepEqual(firstResult, secondResult);
    assert.equal((firstResult.result as { structuredContent: { outcome: string } }).structuredContent.outcome, "applied");
    assert.equal(h.api.calls("PUT").length, 4);
    results.push({ case: "duplicate joins before approval claim", result: firstResult, callers: 2, writes: 1 });
    for (const accepted of [true, false]) {
      const pipelineRequest = { ...request(`fixture-pipeline-crash-${accepted}`), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: {
        operation: "opportunities.pipelines.create", args: { name: `Reviewed ${accepted}`, stages: [{ name: "New", position: 0 }] },
      } } };
      h.api.first("POST", /^\/opportunities\/pipelines$/, { status: 200, body: { pipeline: { id: "new_pipe", stages: [{ id: "new_stage" }] } } });
      approvalJournal.settle = () => { throw new Error("fixture pipeline crash before settlement"); };
      await host.handle(h.claim, pipelineRequest);
      approvalJournal.settle = settle;
      h.api.first("GET", /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: accepted ? [{ id: "pipe_A", stages: [] }, { id: "new_pipe", name: `Reviewed ${accepted}`, stages: [{ id: "new_stage", name: "New", position: 0 }] }] : [] } });
      const before = h.api.calls("GET").length;
      const result = await host.handle(h.claim, pipelineRequest);
      assert.equal((result.result as { structuredContent: { outcome: string } }).structuredContent.outcome, accepted ? "applied" : "not_applied");
      assert.deepEqual(h.api.calls("GET").slice(before).map(r => r.path), ["/opportunities/pipelines"]);
      assert.deepEqual(await host.handle(h.claim, pipelineRequest), result);
      assert.equal(h.api.calls("GET").length - before, 1);
      results.push({ case: `pipeline crash accepted=${accepted}`, result, reconciliationReads: 1, resends: 0 });
    }
    const deleteRequest = { ...request("fixture-delete-crash"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: {
      operation: "opportunities.pipelines.delete", args: { pipelineId: "pipe_A" },
    } } };
    h.api.first("DELETE", /^\/opportunities\/pipelines\/pipe_A$/, { status: 200, body: { success: true } });
    approvalJournal.settle = () => { throw new Error("fixture deletion crash"); };
    await host.handle(h.claim, deleteRequest);
    approvalJournal.settle = settle;
    h.api.first("GET", /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: [{ id: "other_pipe", stages: [] }] } });
    const deleteReads = h.api.calls("GET").length;
    const deleted = await host.handle(h.claim, deleteRequest);
    assert.equal((deleted.result as { structuredContent: { outcome: string } }).structuredContent.outcome, "applied");
    assert.equal(h.api.calls("GET").length - deleteReads, 1);
    assert.equal(h.api.calls("DELETE").length, 1);
    assert.deepEqual(await host.handle(h.claim, deleteRequest), deleted);
    results.push({ case: "pipeline deletion with unrelated pipeline", result: deleted, reconciliationReads: 1, resends: 0 });
    // MAIN (1) / RULE A: recovery negatives are uncertainty, including when
    // they occur outside the matching effect or beside an absent delete target.
    for (const mode of ["negative unrelated", "negative error", "negative sibling", "hidden negative deletion"]) {
      const deleting = mode === "hidden negative deletion";
      const method = deleting ? "DELETE" : "POST";
      const name = `Reviewed ${mode}`;
      const recoveryRequest = { ...request(`fixture-rv7-${mode}`), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: {
        operation: deleting ? "opportunities.pipelines.delete" : "opportunities.pipelines.create",
        args: deleting ? { pipelineId: "pipe_A" } : { name, stages: [{ name: "New", position: 0 }] },
      } } };
      h.api.first(method, deleting ? /^\/opportunities\/pipelines\/pipe_A$/ : /^\/opportunities\/pipelines$/, {
        status: 200, body: deleting ? { success: true } : { pipeline: { id: "new_pipe", stages: [{ id: "new_stage" }] } },
      });
      const sends = h.api.calls(method).length;
      approvalJournal.settle = () => { throw new Error("fixture RV7 crash before settlement"); };
      await host.handle(h.claim, recoveryRequest);
      approvalJournal.settle = settle;
      const unrelated = { id: "other_pipe", ...(mode === "negative unrelated" ? { extra: [{ success: false }] }
        : mode === "negative error" ? { extra: [{ errors: ["failed"] }] }
        : deleting ? { extra: [{ ok: false }] } : {}) };
      h.api.first("GET", /^\/opportunities\/pipelines$/, { status: 200, body: {
        pipelines: deleting ? [unrelated] : [unrelated, { id: "new_pipe", name, stages: [{ id: "new_stage", name: "New", position: 0 }] }],
        meta: { total: deleting ? 1 : 2 }, ...(mode === "negative sibling" ? { extra: [{ success: false }] } : {}),
      } });
      const reads = h.api.calls("GET").length;
      const result = await host.handle(h.claim, recoveryRequest);
      assert.equal((result.result as { structuredContent: { outcome: string } }).structuredContent.outcome, "outcome_unknown");
      assert.deepEqual(h.api.calls("GET").slice(reads).map(r => r.path), ["/opportunities/pipelines"]);
      assert.deepEqual(await host.handle(h.claim, recoveryRequest), result);
      assert.equal(h.api.calls("GET").length - reads, 1);
      assert.equal(h.api.calls(method).length - sends, 1);
      results.push({ case: `RV7 ${mode}`, result, reconciliationReads: 1, resends: 0 });
    }
    h.api.always("GET", /^\/users\/user_\d+$/, req => ({ status: 200, body: { id: req.path.split("/").at(-1), roles: { locationIds: ["loc_fixture_01"] } } }));
    for (const count of [4, 10]) {
      const followers = Array.from({ length: count }, (_, i) => `user_${i}`);
      h.api.first("POST", /^\/opportunities\/opp_A\/followers$/, { status: 200, body: { followersAdded: followers } });
      const followerRequest = { ...request(`fixture-followers-${count}`), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: {
        operation: "opportunities.followers.add", args: { opportunityId: "opp_A", followers },
      } } };
      const before = h.api.calls("GET", /^\/users\//).length;
      const result = await host.handle(h.claim, followerRequest);
      assert.equal((result.result as { structuredContent: { outcome: string } }).structuredContent.outcome, "applied");
      assert.equal(h.api.calls("GET", /^\/users\//).length - before, count * 2);
      assert.deepEqual(await host.handle(h.claim, followerRequest), result);
      results.push({ case: `host follower boundary ${count}`, result, ownershipReads: count * 2, writes: 1 });
    }
    assert.equal(h.api.unexpected.length, 0);
    return { results, requests: h.api.requests.map(({ method, path }) => ({ method, path })), writes: h.api.requests.filter(r => r.method !== "GET").length };
  } finally { h.stop(); }
}
