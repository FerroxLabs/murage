import { defaultHighLevelFamilies } from "../../shared/highlevel.ts";
import { createHash } from 'node:crypto';
import { canonicalBindingJson } from './binding-json.ts';
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { highLevelHarness, until } from "../testing/fake-highlevel.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { HighLevelHost, type HighLevelOutcomeRecord } from "./host.ts";
import { HighLevelActions, reviewDigestFor, type ActionContext, type ActionReview } from "./actions.ts";
import { FileActionJournal, parseIntent } from "./journal-file.ts";
import { highlevelOutcomeLine } from "./review-cards.ts";
import { fixtureReadSpec } from "../testing/highlevel-r4-fixtures.ts";
import { HeldRequest } from "./held-request.ts";
import { operationSpec } from "./operations/registry.ts";
import * as identityGate from "./returned-identities.ts";
import { FileRpcApprovalJournal as FileApprovalJournal } from "./rpc-approval-replay.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });
function fixture(options: { policy?: boolean; disk?: boolean; deadlineMs?: number } = {}) {
  const journalDir = mkdtempSync(join(tmpdir(), "hlf2-approvalJournal-"));
  cleanups.push(() => removeTempDir(journalDir));
  const approvalJournal = new FileApprovalJournal(join(journalDir, "approvals"));
  const callJournal = new FileApprovalJournal(join(journalDir, "calls"));
  const h = highLevelHarness({ deadlineMs: options.deadlineMs ?? 500 });
  cleanups.push(() => h.stop());
  const reviews: ActionReview[] = [], outcomes: HighLevelOutcomeRecord[] = [];
  let actions = h.actions, file = "";
  if (options.disk !== false) {
    const dir = mkdtempSync(join(tmpdir(), "hlf2-dispatch-")); cleanups.push(() => removeTempDir(dir));
    file = join(dir, "actions.jsonl"); actions = new HighLevelActions({ journal: new FileActionJournal(file) });
  }
  h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2, denyRules: [],
    grants: [{ ...h.grant(), families: { ...defaultHighLevelFamilies(), opportunities: "full" } }] };
  h.api.always("GET", /^\/opportunities\/opp_[AB]$/, req => ({ status: 200, body: { opportunity: { id: req.path.split("/").at(-1), pipelineId: "pipe_A" } } }));
  h.api.always("GET", /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: [{ id: "pipe_A", stages: [] }] } });
  h.api.always("GET", /^\/users\/user_A$/, { status: 200, body: { id: "user_A", roles: { locationIds: ["loc_fixture_01"] } } });
  h.api.always("GET", /^\/contacts\/contact_A$/, { status: 200, body: { contact: { id: "contact_A", locationId: "loc_fixture_01" } } });
  const facts = { policy: options.policy ?? false };
  const host = new HighLevelHost({ ...h, actions, approvalJournal, callJournal, bot: () => h.bot,
    operationSpec: id => (id === "users.get" || id === "contacts.get") ? fixtureReadSpec(id) : operationSpec(id),
    operationScopes: () => ["opportunities.write", "opportunities.readonly", "pipelines.write", "pipelines.create"],
    approvalBasis: () => facts.policy ? "owner_no_limits" : "owner_exact_review",
    onReview: (_claim, review) => reviews.push(review), onOutcome: (_claim, outcome) => outcomes.push(outcome),
  });
  const call = (operation = "opportunities.update", args: Record<string, unknown> = { opportunityId: "opp_A", name: "Reviewed" }) =>
    host.call(h.claim, "HIGHLEVEL_OPPORTUNITIES", { operation, args });
  const approve = async () => { await until(() => reviews.length > 0); const review = reviews.at(-1)!; actions.approve(review.actionId, review.reviewDigest); return review; };
  return { ...h, approvalJournal, callJournal, actions, reviews, outcomes, file, host, facts, call, approve };
}

it.each([
  ["opportunities.update", { opportunityId: "opp_A", name: "Reviewed" }, "/opportunities/opp_A", { opportunity: { id: "opp_B", name: "UNREVIEWED_RESPONSE" } }],
  ["opportunities.pipelines.update", { pipelineId: "pipe_A", name: "Reviewed" }, "/opportunities/pipelines/pipe_A", { pipeline: { id: "pipe_B", name: "UNREVIEWED_RESPONSE" } }],
] as const)("dispatch withholds wrong target: %s", async (operation, args, path, raw) => {
  const h = fixture(); h.api.always("PUT", new RegExp(`^${path}$`), { status: 200, body: raw });
  const pending = h.call(operation, args); const review = await h.approve(); const result = await pending;
  expect(result).toMatchObject({ isError: true, structuredContent: { outcome: "outcome_unknown" } });
  expect(JSON.stringify(result)).not.toContain("UNREVIEWED_RESPONSE");
  expect(h.actions.get(review.actionId)).toMatchObject({ phase: "outcome_unknown", dispatchAttempts: 1 });
  expect(h.actions.get(review.actionId)?.receipt).toBeUndefined();
  expect(h.api.calls("PUT")).toHaveLength(1);
  expect(h.outcomes).toHaveLength(1);
});

for (const verb of ["add", "remove"]) it.each([{}, { success: false }])(`dispatch followers.${verb} ambiguous response: %j`, async raw => {
  const h = fixture(); const method = verb === "add" ? "POST" : "DELETE";
  h.api.always(method, /^\/opportunities\/opp_A\/followers$/, { status: 200, body: raw });
  const pending = h.call(`opportunities.followers.${verb}`, { opportunityId: "opp_A", followers: ["user_A"] });
  const review = await h.approve();
  expect(await pending).toMatchObject({ isError: true, structuredContent: { outcome: "success" in raw ? "not_applied" : "outcome_unknown" } });
  expect(h.actions.get(review.actionId)?.receipt).toBeUndefined(); expect(h.api.calls(method)).toHaveLength(1);
});

it("approval records are bound into the review digest and survive durable recovery separately from the receipt", async () => {
  const h = fixture({ disk: true }); h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A" } } });
  const pending = h.call(); const review = await h.approve(); const row = h.actions.get(review.actionId)!;
  const result = await pending;
  expect(reviewDigestFor({ ...row, recordRefs: ["opp_B"] } as typeof row)).not.toBe(row.reviewDigest);
  expect(result).toMatchObject({ structuredContent: { outcome: "applied" } });
  const recovered = new HighLevelActions({ journal: new FileActionJournal(h.file) }); recovered.recover();
  expect(recovered.get(row.actionId)).toMatchObject({ recordRefs: ["opp_A"], receipt: { recordId: "opp_A" }, phase: "applied" });
  expect(parseIntent({ ...recovered.get(row.actionId), unreviewedIds: ["opp_B"] })).toBeNull();
  expect(readFileSync(h.file, "utf8")).not.toContain("Reviewed");
  expect(h.outcomes[0]).toMatchObject({ recordIds: ["opp_A"], approvedRecordIds: ["opp_A"], providerRecordIds: ["opp_A"] });
  expect(highlevelOutcomeLine(h.outcomes[0]!)).toContain("Approved records: opp_A. Provider records: opp_A.");
});

it.each(["add", "remove"])("production followers.%s confirms a no-ID change exactly once", async verb => {
  const h = fixture(); const method = verb === "add" ? "POST" : "DELETE";
  h.api.always(method, /^\/opportunities\/opp_A\/followers$/, { status: 200, body: verb === "add"
    ? { followers: ["user_A"], followersAdded: ["user_A"] } : { followersRemoved: ["user_A"] } });
  const pending = h.call(`opportunities.followers.${verb}`, { opportunityId: "opp_A", followers: ["user_A"] });
  const review = await h.approve(); expect(await pending).toMatchObject({ structuredContent: { outcome: "applied" } });
  expect(h.actions.get(review.actionId)?.receipt?.recordId).toBe("");
  expect(h.outcomes[0]).toMatchObject({ approvedRecordIds: ["opp_A", "user_A"], providerRecordIds: [] });
  expect(h.api.calls(method)).toHaveLength(1);
});

it("provider errors stay out of durable history through production dispatch", async () => {
  const h = fixture({ disk: true }); h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 422, body: { message: "PRIVATE_PROVIDER_DETAIL" } });
  const pending = h.call(); const review = await h.approve();
  expect(await pending).toMatchObject({ isError: true, structuredContent: { outcome: "not_applied" } });
  expect(JSON.stringify(h.actions.statusFor(h.bot.id, review.actionId))).not.toContain("PRIVATE_PROVIDER_DETAIL");
  expect(readFileSync(h.file, "utf8")).not.toContain("PRIVATE_PROVIDER_DETAIL");
  expect(h.api.calls("PUT")).toHaveLength(1);
});

it("a lost policy basis after send withholds the response and receipt", async () => {
  const h = fixture({ policy: true }); h.api.always("PUT", /^\/opportunities\/opp_A$/, () => {
    h.facts.policy = false;
    return { status: 200, body: { opportunity: { id: "opp_A", name: "WITHHOLD_AFTER_REVOKE" } } };
  });
  const result = await h.call();
  expect(result).toMatchObject({ isError: true, structuredContent: { outcome: "outcome_unknown" } });
  expect(JSON.stringify(result)).not.toContain("WITHHOLD_AFTER_REVOKE");
  expect(h.outcomes[0]).toMatchObject({ providerRecordIds: [] });
  expect(h.api.calls("PUT")).toHaveLength(1);
});

it("a terminal stale decision survives a valid provider reply and late settlement", async () => {
  const h = fixture(); h.api.always("PUT", /^\/opportunities\/opp_A$/, () => {
    h.actions.markStale(h.reviews[0]!.actionId, "request_changed");
    return { status: 200, body: { opportunity: { id: "opp_A", name: "STALE_REPLY" } } };
  });
  const pending = h.call(); const review = await h.approve(); const result = await pending;
  expect(result).toMatchObject({ isError: true, structuredContent: { outcome: "stale" } });
  expect(JSON.stringify(result)).not.toContain("STALE_REPLY");
  h.actions.applied(review.actionId, { recordId: "opp_A", fields: ["name"] });
  expect(h.actions.get(review.actionId)?.phase).toBe("stale");
  expect(h.actions.get(review.actionId)?.receipt).toBeUndefined();
  expect(h.outcomes).toHaveLength(1);
});

it("restart during dispatch preserves the approved IDs and never revives the in-flight send", async () => {
  const h = fixture({ disk: true }); let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  h.api.always("PUT", /^\/opportunities\/opp_A$/, async () => { await hold; return { status: 200, body: { opportunity: { id: "opp_A" } } }; });
  const pending = h.call(); const review = await h.approve();
  await until(() => h.api.calls("PUT").length === 1);
  const recovered = new HighLevelActions({ journal: new FileActionJournal(h.file) }); recovered.recover();
  // Stop the old process's turn before releasing its simulated provider reply.
  h.stop(); release(); await pending;
  expect(recovered.get(review.actionId)).toMatchObject({ phase: "outcome_unknown", recordRefs: ["opp_A"], dispatchAttempts: 1 });
  expect(() => recovered.approve(review.actionId, review.reviewDigest)).toThrow();
  expect(() => recovered.beginDispatch(review.actionId, {} as ActionContext)).toThrow();
  expect(h.api.calls("PUT")).toHaveLength(1);
});

it.each([false, true])("production dispatch requires exact approval or current policy (policy %s)", async policy => {
  const h = fixture({ policy }); h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A" } } });
  const pending = h.call();
  if (!policy) {
    await until(() => h.reviews.length > 0); expect(h.api.calls("PUT")).toHaveLength(0);
    expect(() => h.actions.approve(h.reviews[0]!.actionId, "wrong")).toThrow();
    await h.approve();
  }
  expect(await pending).toMatchObject({ structuredContent: { outcome: "applied" } }); expect(h.api.calls("PUT")).toHaveLength(1);
});

it("concurrent calls cannot spend a pending approval twice", async () => {
  const h = fixture(); h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A" } } });
  const first = h.call(); await until(() => h.reviews.length > 0);
  expect(await h.call()).toMatchObject({ isError: true });
  const review = await h.approve(); expect(await first).toMatchObject({ structuredContent: { outcome: "applied" } });
  expect(() => h.actions.beginDispatch(review.actionId, {} as ActionContext)).toThrow();
  expect(h.api.calls("PUT")).toHaveLength(1);
});

it("changed authority after approval prevents send", async () => {
  const h = fixture(); const pending = h.call(); await until(() => h.reviews.length > 0);
  (h.bot.highlevelAccess as { revision: number }).revision++;
  await h.approve(); expect(await pending).toMatchObject({ isError: true, structuredContent: { outcome: "stale" } });
  expect(h.api.calls("PUT")).toHaveLength(0);
});

it("timeout is durable outcome_unknown; recovery and approval replay never resend", async () => {
  const h = fixture({ disk: true, deadlineMs: 25 }); h.api.always("PUT", /^\/opportunities\/opp_A$/, "timeout");
  const pending = h.call(); const review = await h.approve();
  expect(await pending).toMatchObject({ structuredContent: { outcome: "outcome_unknown" } });
  const recovered = new HighLevelActions({ journal: new FileActionJournal(h.file) }); recovered.recover();
  expect(recovered.get(review.actionId)?.phase).toBe("outcome_unknown");
  expect(() => recovered.approve(review.actionId, review.reviewDigest)).toThrow();
  expect(() => recovered.beginDispatch(review.actionId, {} as ActionContext)).toThrow();
  expect(h.api.calls("PUT")).toHaveLength(1);
});

it("host validates recordId then project with the identical dispatched frozen request before settlement", async () => {
  const h = fixture(); h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A" } } });
  const spec = operationSpec("opportunities.update")!; if (spec.risk === "R") throw new Error("mutation");
  let sent: HeldRequest | undefined;
  const send = h.client.sendHeld.bind(h.client);
  vi.spyOn(h.client, "sendHeld").mockImplementation((ctx, held, digest) => { if (digest) sent = held; return send(ctx, held, digest); });
  // Registry specs are frozen: use the public host seam with unchanged registered hooks.
  const order: string[] = [];
  const wrapped = { ...spec,
    recordId: (value: unknown, frozen?: Parameters<typeof spec.project>[1]) => {
      expect(frozen).toBe(sent?.frozen); order.push("recordId"); return spec.recordId!(value, frozen!);
    },
    project: (value: unknown, frozen?: Parameters<typeof spec.project>[1]) => {
      expect(frozen).toBe(sent?.frozen); order.push("project");
      expect(h.actions.get(h.reviews[0]!.actionId)?.phase).toBe("dispatching");
      return spec.project(value, frozen!);
    },
  };
  const host = new HighLevelHost({ ...h, bot: () => h.bot, operationSpec: id => id === spec.id ? wrapped : operationSpec(id),
    operationScopes: () => ["opportunities.write", "opportunities.readonly"], onReview: (_claim, review) => h.reviews.push(review) });
  const pending = host.call(h.claim, "HIGHLEVEL_OPPORTUNITIES", { operation: spec.id, args: { opportunityId: "opp_A", name: "Reviewed" } });
  await h.approve(); expect(await pending).toMatchObject({ structuredContent: { outcome: "applied" } }); expect(order).toEqual(["recordId", "project"]);
});

// F0.2 reviewer regressions go through the production dispatcher.
const replayRequest = (id: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: {
  name: "HIGHLEVEL_OPPORTUNITIES", arguments: { operation: "opportunities.update", args: { opportunityId: "opp_A", name: "Reviewed" } },
} });
it.each([
  ["approved ID", "opp_A", false, "applied"],
  ["different existing ID", "opp_B", false, "conflict"],
  ["different new ID", "opp_B", true, "conflict"],
] as const)("P2 upsert with an approved existing ID: %s", async (_label, returnedId, isNew, state) => {
  const h = fixture();
  h.api.always("POST", /^\/opportunities\/upsert$/, { status: 200, body: {
    new: isNew, opportunity: { id: returnedId, followers: [], name: "PROVIDER_RESPONSE" },
  } });
  const request = { ...replayRequest("upsert-existing"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: {
    operation: "opportunities.upsert", args: { id: "opp_A", pipelineId: "pipe_A", name: "Reviewed" },
  } } };
  const pending = h.host.handle(h.claim, request);
  // Fail promptly if preparation refuses before opening the owner review.
  await Promise.race([until(() => h.reviews.length > 0), pending.then(() => {
    expect(h.reviews).toHaveLength(1);
  })]);
  expect(h.api.calls("POST")).toHaveLength(0);
  const review = await h.approve();
  const response = await pending;
  const outcome = state === "applied" ? "applied" : "outcome_unknown";
  expect(response.result).toMatchObject({ structuredContent: { outcome } });
  const row = h.actions.get(review.actionId)!;
  expect(row).toMatchObject({ resource: "location:loc_fixture_01", phase: outcome, dispatchAttempts: 1 });
  expect(row.recordRefs).toContain("opp_A");
  expect(h.approvalJournal.get(row.approvalId!)).toMatchObject({ state });
  if (state === "applied") expect(row.receipt).toMatchObject({ recordId: "opp_A" });
  else {
    expect(row.receipt).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain("PROVIDER_RESPONSE");
    expect(h.approvalJournal.get(row.approvalId!)).toMatchObject({ reason: "identity_conflict" });
  }
  expect(await h.host.handle(h.claim, request)).toEqual(response);
  expect(h.api.calls("POST")).toHaveLength(1);
  expect(h.api.unexpected).toHaveLength(0);
});
it.each([
  ["nested contactId alias", { opportunity: { id: "opp_A", contact: { contactId: "contact_other" } } }, "outcome_unknown"],
  ["related contact", { opportunity: { id: "opp_A", contactId: "contact_A", contact: { id: "contact_other" } } }, "outcome_unknown"],
  ["related pipeline", { opportunity: { id: "opp_A", pipeline: [{ id: "pipe_other" }] } }, "outcome_unknown"],
  ["nested location", { locationId: "loc_fixture_01", opportunity: { id: "opp_A", locationId: "foreign" } }, "outcome_unknown"],
  ["nested negative", { opportunity: { id: "opp_A", success: false } }, "not_applied"],
  ["array negative", { opportunity: { id: "opp_A" }, nested: [{ detail: { error: "PRIVATE_DETAIL" } }] }, "not_applied"],
] as const)("F02 dispatch %s is withheld and journaled", async (_label, body, outcome) => {
  const h = fixture({ policy: true }); h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body });
  const response = await h.host.handle(h.claim, replayRequest("finding"));
  expect(response.result).toMatchObject({ isError: true, structuredContent: { outcome } });
  const row = h.outcomes[0]!;
  expect(h.actions.get(row.actionId)?.receipt).toBeUndefined();
  const approvalId = h.actions.get(row.actionId)!.approvalId!;
  expect(h.approvalJournal.get(approvalId)).toMatchObject({ state: "conflict", reason: outcome === "not_applied" ? "negative_confirmation" : "identity_conflict" });
  expect(await h.host.handle(h.claim, replayRequest("finding"))).toEqual(response);
  expect(h.api.calls("PUT")).toHaveLength(1);
});
it.each(["add", "remove"])("F02 dispatch followers.%s binds exact approved set", async verb => {
  const h = fixture({ policy: true }); const method = verb === "add" ? "POST" : "DELETE";
  h.api.always(method, /^\/opportunities\/opp_A\/followers$/, { status: 200, body: { [verb === "add" ? "followersAdded" : "followersRemoved"]: ["user_other"] } });
  expect(await h.call(`opportunities.followers.${verb}`, { opportunityId: "opp_A", followers: ["user_A"] })).toMatchObject({ isError: true, structuredContent: { outcome: "outcome_unknown" } });
  expect(h.api.calls(method)).toHaveLength(1);
});
it("F02 tool-call replay returns durable applied outcome with one dispatch", async () => {
  const h = fixture({ policy: true });
  h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A" } } });
  const first = await h.host.handle(h.claim, replayRequest("same-call"));
  expect(first.result).toMatchObject({ structuredContent: { outcome: "applied" } });
  const row = h.actions.get(h.outcomes[0]!.actionId)!;
  expect(h.approvalJournal.get(row.approvalId!)).toMatchObject({ state: "applied", requestDigest: row.requestDigest });
  expect(await h.host.handle(h.claim, replayRequest("same-call"))).toEqual(first);
  expect(h.api.calls("PUT")).toHaveLength(1);
  expect(h.outcomes).toHaveLength(1);
});
it("F02 crash pending replay reconciles by GET and never resends", async () => {
  const h = fixture({ policy: true });
  h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A" } } });
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("simulated crash before terminal fsync"); });
  await h.host.handle(h.claim, replayRequest("pending-call"));
  const row = h.actions.get(h.outcomes[0]!.actionId)!;
  expect(h.approvalJournal.get(row.approvalId!)).toMatchObject({ state: "pending" });
  const reads = h.api.calls("GET").length;
  const result = await h.host.handle(h.claim, replayRequest("pending-call"));
  expect(result.result).toMatchObject({ isError: true, structuredContent: { outcome: "outcome_unknown" } });
  expect(h.api.calls("GET").length).toBeGreaterThan(reads);
  expect(h.api.calls("PUT")).toHaveLength(1);
  expect(h.approvalJournal.get(row.approvalId!)).toMatchObject({ state: "conflict", reason: "unconfirmed" });
});

const writeRows = [
  ["create", { pipelineId: "pipe_A", contactId: "contact_A", name: "New" }, "POST", "/opportunities/", { opportunity: { id: "new_opp" } }],
  ["update", { opportunityId: "opp_A", name: "Updated" }, "PUT", "/opportunities/opp_A", { opportunity: { id: "opp_A" } }],
  ["status", { opportunityId: "opp_A", status: "won" }, "PUT", "/opportunities/opp_A/status", { succeeded: true }],
  ["upsert", { pipelineId: "pipe_A", name: "New" }, "POST", "/opportunities/upsert", { new: true, opportunity: { id: "new_opp", followers: [] } }],
  ["delete", { opportunityId: "opp_A" }, "DELETE", "/opportunities/opp_A", { succeeded: true }],
  ["followers.add", { opportunityId: "opp_A", followers: ["user_A"] }, "POST", "/opportunities/opp_A/followers", { followersAdded: ["user_A"] }],
  ["followers.remove", { opportunityId: "opp_A", followers: ["user_A"] }, "DELETE", "/opportunities/opp_A/followers", { followersRemoved: ["user_A"] }],
  ["pipelines.create", { name: "New", stages: [{ name: "New", position: 0 }] }, "POST", "/opportunities/pipelines", { pipeline: { id: "new_pipe", stages: [{ id: "new_stage" }] } }],
  ["pipelines.update", { pipelineId: "pipe_A", name: "Updated" }, "PUT", "/opportunities/pipelines/pipe_A", { pipeline: { id: "pipe_A" } }],
  ["pipelines.delete", { pipelineId: "pipe_A" }, "DELETE", "/opportunities/pipelines/pipe_A", { success: true }],
] as const;
it.each(writeRows)("F02 every write %s records pending before send and binds before settlement", async (verb, args, method, path, body) => {
  const h = fixture();
  const bind = vi.spyOn(identityGate, "bindReturnedIdentities");
  h.api.always(method, new RegExp(`^${path}$`), () => {
    const row = h.actions.get(h.reviews[0]!.actionId)!;
    expect(h.approvalJournal.get(row.approvalId!)).toMatchObject({ state: "pending", requestDigest: row.requestDigest });
    return { status: 200, body };
  });
  const request = { ...replayRequest(`write-${verb}`), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: { operation: `opportunities.${verb}`, args } } };
  const pending = h.host.handle(h.claim, request); const review = await h.approve();
  const response = await pending;
  expect(response.result).toMatchObject({ structuredContent: { outcome: "applied" } });
  expect(bind.mock.calls.filter(([, frozen]) => frozen.operation === `opportunities.${verb}`)).toHaveLength(3);
  expect(h.approvalJournal.get(h.actions.get(review.actionId)!.approvalId!)).toMatchObject({ state: "applied" });
  expect(await h.host.handle(h.claim, request)).toEqual(response);
  expect(h.api.calls(method)).toHaveLength(1);
});
function restartedHost(h: ReturnType<typeof fixture>, dropActions = false) {
  return new HighLevelHost({ ...h, actions: dropActions ? new HighLevelActions() : (() => { const actions = new HighLevelActions({ journal: new FileActionJournal(h.file) }); actions.recover(); return actions; })(),
    approvalJournal: new FileApprovalJournal(h.approvalJournal.key), callJournal: new FileApprovalJournal(h.callJournal.key),
    bot: () => h.bot, operationScopes: () => ["opportunities.write", "opportunities.readonly", "pipelines.write", "pipelines.create"], approvalBasis: () => "owner_no_limits",
  });
}
it("F02 create RPC replay survives host restart and action cleanup", async () => {
  const h = fixture({ policy: true });
  h.api.always("POST", /^\/opportunities\/$/, { status: 200, body: { opportunity: { id: "new_opp" } } });
  const request = { ...replayRequest("create-once"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: { operation: "opportunities.create", args: { pipelineId: "pipe_A", contactId: "contact_A", name: "New" } } } };
  const first = await h.host.handle(h.claim, request);
  expect(first.result).toMatchObject({ structuredContent: { outcome: "applied" } });
  const restarted = restartedHost(h, true);
  expect(await restarted.handle(h.claim, request)).toEqual(first);
  expect(h.api.calls("POST")).toHaveLength(1);
});
it("F02 pending restart uses durable target metadata for a read and withholds ambiguous effect", async () => {
  const h = fixture({ policy: true });
  h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A" } } });
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash"); });
  await h.host.handle(h.claim, replayRequest("restart-pending"));
  const reads = h.api.calls("GET").length;
  expect((await restartedHost(h).handle(h.claim, replayRequest("restart-pending"))).result).toMatchObject({ structuredContent: { outcome: "outcome_unknown" } });
  expect(h.api.calls("GET").length).toBeGreaterThan(reads);
  expect(h.api.calls("PUT")).toHaveLength(1);
});
it("F02 replay cannot release after revocation or retarget a used RPC id", async () => {
  const h = fixture({ policy: true });
  h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A", name: "WITHHELD" } } });
  await h.host.handle(h.claim, replayRequest("revoked"));
  const changed = replayRequest("revoked"); changed.params.arguments.args.name = "Different";
  expect((await h.host.handle(h.claim, changed)).result).toMatchObject({ isError: true });
  h.facts.policy = false;
  const replay = await h.host.handle(h.claim, replayRequest("revoked"));
  expect(replay.result).toMatchObject({ isError: true }); expect(JSON.stringify(replay)).not.toContain("WITHHELD");
  expect(h.api.calls("PUT")).toHaveLength(1);
});
it("F02 RPC writes without a stable identity refuse before send", async () => {
  const h = fixture({ policy: true });
  const request = { ...replayRequest("missing"), id: null };
  expect(await h.host.handle(h.claim, request)).toHaveProperty("error");
  expect(h.api.calls("PUT")).toHaveLength(0);
});

it.each([true, false])("CFIX5 location-scoped upsert crash replay reads the approved target (accepted=%s)", async accepted => {
  const h = fixture({ policy: true, disk: true });
  h.api.always("POST", /^\/opportunities\/upsert$/, { status: 200, body: { new: false, opportunity: { id: "opp_A", followers: [] } } });
  const request = { ...replayRequest("crashed-upsert"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: {
    operation: "opportunities.upsert", args: { id: "opp_A", pipelineId: "pipe_A", name: "Reviewed" },
  } } };
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash before terminal publication"); });
  await h.host.handle(h.claim, request);
  const row = h.actions.get(h.outcomes[0]!.actionId)!;
  expect(row.resource).toBe("location:loc_fixture_01");
  expect(h.approvalJournal.get(row.approvalId!)).toMatchObject({ state: "pending" });
  h.api.first("GET", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: {
    id: "opp_A", pipelineId: "pipe_A", name: accepted ? "Reviewed" : "Unchanged", status: "open", followers: [],
  } } });
  const reads = h.api.calls("GET").length;
  const result = await restartedHost(h).handle(h.claim, request);
  expect(h.api.calls("POST")).toHaveLength(1);
  expect(h.api.calls("GET").slice(reads).map(r => r.path)).toEqual(["/opportunities/opp_A"]);
  expect(result.result).toMatchObject({ structuredContent: { outcome: accepted ? "applied" : "outcome_unknown" } });
  expect(h.approvalJournal.get(row.approvalId!)).toMatchObject({ state: accepted ? "applied" : "conflict" });
  expect(h.api.unexpected).toHaveLength(0);
});

it("CFIX5 duplicate RPC joins the approved original before its approval journal claim", async () => {
  const h = fixture();
  h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A" } } });
  let release!: () => void, paused = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const awaitDecision = h.actions.awaitDecision.bind(h.actions);
  vi.spyOn(h.actions, "awaitDecision").mockImplementation(async (...args) => {
    const answer = await awaitDecision(...args);
    paused = true; await gate; return answer;
  });
  const request = replayRequest("tool-call-1");
  const first = h.host.handle(h.claim, request);
  const review = await h.approve(); await until(() => paused);
  expect(h.approvalJournal.get(h.actions.get(review.actionId)!.approvalId!)).toBeUndefined();
  const duplicate = restartedHost(h).handle(h.claim, request);
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  const results = await Promise.all([first, duplicate]);
  expect(h.api.calls("PUT")).toHaveLength(1);
  expect(h.reviews).toHaveLength(1);
  for (const result of results) expect(result.result).toMatchObject({ structuredContent: { outcome: "applied" } });
  expect(results[1]).toEqual(results[0]);
});


it.each([
  ["opportunities.update", { opportunityId: "opp_A", name: "Reviewed" }, "PUT", "/opportunities/opp_A", { opportunity: { id: "opp_A", name: "Reviewed" } }],
  ["opportunities.status", { opportunityId: "opp_A", status: "won" }, "PUT", "/opportunities/opp_A/status", { opportunity: { id: "opp_A", status: "won" } }],
  ["opportunities.followers.add", { opportunityId: "opp_A", followers: ["user_A"] }, "POST", "/opportunities/opp_A/followers", { opportunity: { id: "opp_A", followers: ["user_A"] } }],
] as const)("CFIX5 recovery proves the approved effect for %s", async (operation, args, method, path, read) => {
  const h = fixture({ policy: true });
  h.api.always(method, new RegExp(`^${path}$`), { status: 200, body: operation.endsWith(".add") ? { followersAdded: ["user_A"] } : { succeeded: true } });
  const request = { ...replayRequest("effect"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: { operation, args } } };
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash"); });
  await h.host.handle(h.claim, request);
  h.api.first("GET", /^\/opportunities\/opp_A$/, { status: 200, body: read });
  const reads = h.api.calls("GET").length;
  const host = restartedHost(h);
  const result = await host.handle(h.claim, request);
  expect(result.result).toMatchObject({ structuredContent: { outcome: "applied" } });
  expect(h.api.calls("GET").length - reads).toBe(1);
  expect(await host.handle(h.claim, request)).toEqual(result);
  expect(h.api.calls("GET").length - reads).toBe(1);
  expect(h.api.calls(method)).toHaveLength(1);
});

it.each([{ deep: [{ contactId: "foreign" }] }, { deep: [{ success: false }] }])("CFIX5 recovery runs the whole-response identity/negative gate: %j", async extra => {
  const h = fixture({ policy: true });
  h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A" } } });
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash"); });
  await h.host.handle(h.claim, replayRequest("unsafe-recovery"));
  h.api.first("GET", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A", name: "Reviewed" }, ...extra } });
  const result = await restartedHost(h).handle(h.claim, replayRequest("unsafe-recovery"));
  expect(result.result).toMatchObject({ isError: true });
  expect(h.api.calls("PUT")).toHaveLength(1);
  expect(h.actions.get(h.outcomes[0]!.actionId)?.receipt).toBeUndefined();
});

it("CFIX5 terminal approval recovery settles the original action without another GET", async () => {
  const h = fixture({ policy: true });
  h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A" } } });
  vi.spyOn(h.actions, "applied").mockImplementationOnce(() => { throw new Error("crash after approval fsync"); });
  await h.host.handle(h.claim, replayRequest("terminal-crash"));
  const row = h.actions.get(h.outcomes[0]!.actionId)!;
  expect(h.approvalJournal.get(row.approvalId!)).toMatchObject({ state: "applied" });
  const reads = h.api.calls("GET").length;
  expect((await restartedHost(h).handle(h.claim, replayRequest("terminal-crash"))).result).toMatchObject({ structuredContent: { actionId: row.actionId, outcome: "applied" } });
  const recovered = new HighLevelActions({ journal: new FileActionJournal(h.file) });
  expect(recovered.get(row.actionId)).toMatchObject({ phase: "applied", approvalId: row.approvalId, receipt: { recordId: "opp_A" } });
  expect(recovered.statusFor(h.bot.id, row.actionId)?.outcomeCode).toBeUndefined();
  expect(h.api.calls("GET")).toHaveLength(reads);
  expect(h.api.calls("PUT")).toHaveLength(1);
});


it.each([
  ["opportunities.followers.remove", { opportunityId: "opp_A", followers: ["user_A"] }, "DELETE", "/opportunities/opp_A/followers"],
  ["opportunities.upsert", { id: "opp_A", pipelineId: "pipe_A", name: "Reviewed", followers: ["user_A"], followersActionType: "remove" }, "POST", "/opportunities/upsert"],
] as const)("CFIX5 recovery never mistakes a removal delta still present for applied: %s", async (operation, args, method, path) => {
  const h = fixture({ policy: true });
  h.api.always(method, new RegExp(`^${path}$`), { status: 200, body: { followersRemoved: ["user_A"], opportunity: { id: "opp_A" } } });
  const request = { ...replayRequest("remove-effect"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: { operation, args } } };
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash"); });
  await h.host.handle(h.claim, request);
  const row = h.actions.get(h.outcomes[0]!.actionId)!;
  expect(h.approvalJournal.get(row.approvalId!)).toMatchObject({ state: "pending" });
  h.api.first("GET", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: {
    id: "opp_A", followers: ["user_A"],
    ...(operation === "opportunities.upsert" ? { pipelineId: "pipe_A", name: "Reviewed", status: "open" } : {}),
  } } });
  expect((await restartedHost(h).handle(h.claim, request)).result).toMatchObject({ structuredContent: { outcome: "outcome_unknown" } });
  expect(h.api.calls(method)).toHaveLength(1);
  expect(h.approvalJournal.get(row.approvalId!)).toMatchObject({ state: "conflict" });
});


it.each([
  ["opportunities.create", { pipelineId: "pipe_A", contactId: "contact_A", name: "Reviewed" }, "/opportunities/", { opportunity: { id: "new_opp" } }, "opportunities.search", "/opportunities/search"],
  ["opportunities.upsert", { pipelineId: "pipe_A", name: "Reviewed" }, "/opportunities/upsert", { new: true, opportunity: { id: "new_opp", followers: [] } }, "opportunities.search", "/opportunities/search"],
  ["opportunities.pipelines.create", { name: "Reviewed", stages: [{ name: "New", position: 0 }] }, "/opportunities/pipelines", { pipeline: { id: "new_pipe", stages: [{ id: "new_stage" }] } }, "opportunities.pipelines.list", "/opportunities/pipelines"],
] as const)("CFIX6 nonempty declared recovery target before POST: %s", async (operation, args, path, response, readOperation, readPath) => {
  const h = fixture({ policy: true });
  h.api.always("GET", /^\/opportunities\/search$/, { status: 200, body: { opportunities: [], meta: { total: 0 } } });
  h.api.always("POST", new RegExp(`^${path}$`), () => {
    const names = readdirSync(h.approvalJournal.key).filter(name => name.endsWith(".rpc.json"));
    expect(names).toHaveLength(1);
    const binding = JSON.parse(readFileSync(join(h.approvalJournal.key, names[0]!), "utf8"));
    expect(binding.readTargets).toEqual([{ operation: readOperation, path: readPath }]);
    return { status: 200, body: response };
  });
  const request = { ...replayRequest("declared"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: { operation, args } } };
  const result = await h.host.handle(h.claim, request);
  expect(result.result).toMatchObject({ structuredContent: { outcome: "applied" } });
  expect(h.api.calls("POST")).toHaveLength(1);
});

it.each([true, false])("CFIX6 exact reviewed location upsert has one durable GET and terminal replay (accepted=%s)", async accepted => {
  const h = fixture({ policy: true });
  const request = { ...replayRequest("exact-location-upsert"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: {
    operation: "opportunities.upsert", args: { id: "opp_A", pipelineId: "pipe_A", name: "Reviewed" },
  } } };
  h.api.always("POST", /^\/opportunities\/upsert$/, { status: 200, body: { new: false, opportunity: { id: "opp_A", followers: [] } } });
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash after POST before settlement"); });
  await h.host.handle(h.claim, request);
  const row = h.actions.get(h.outcomes[0]!.actionId)!;
  expect(row.resource).toBe("location:loc_fixture_01");
  const binding = JSON.parse(readFileSync(join(h.approvalJournal.key, readdirSync(h.approvalJournal.key).find(name => name.endsWith(".rpc.json"))!), "utf8"));
  expect(binding.readTargets).toEqual([{ operation: "opportunities.get", path: "/opportunities/opp_A" }]);
  expect(JSON.stringify(binding)).not.toContain("Reviewed");
  h.api.first("GET", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: {
    id: "opp_A", pipelineId: "pipe_A", name: accepted ? "Reviewed" : "Unchanged", status: "open", followers: [],
  } } });
  const reads = h.api.calls("GET").length;
  const host = restartedHost(h);
  const result = await host.handle(h.claim, request);
  expect(result.result).toMatchObject({ structuredContent: { outcome: accepted ? "applied" : "outcome_unknown" } });
  expect(h.api.calls("GET").slice(reads).map(r => r.path)).toEqual(["/opportunities/opp_A"]);
  expect(await host.handle(h.claim, request)).toEqual(result);
  expect(h.api.calls("GET")).toHaveLength(reads + 1);
  expect(h.api.calls("POST")).toHaveLength(1);
});


it.each(["upsert", "pipeline"])("CFIX6 real process crash after POST and durable replay: %s", async kind => {
  for (const accepted of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), "hlf2-process-"));
    cleanups.push(() => removeTempDir(dir));
    const run = async (stage: string) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "server/highlevel/testing/opportunity-crash-worker.ts", dir, stage, kind, String(accepted)], { stdio: "pipe" });
      let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
      return { code, stderr };
    };
    const sent = await run("send");
    expect(sent.code, sent.stderr).toBe(24);
    const resumed = await run("recover");
    expect(resumed.code, resumed.stderr).toBe(0);
    const { result, repeated } = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    expect(result.result).toMatchObject({ structuredContent: { outcome: accepted ? "applied" : kind === "pipeline" ? "not_applied" : "outcome_unknown" } });
    expect(repeated).toEqual(result);
    const requests = readFileSync(join(dir, "trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(requests.filter(r => r.method === "POST")).toHaveLength(1);
    expect(requests.filter(r => r.stage === "recover")).toEqual([expect.objectContaining({ method: "GET", path: kind === "pipeline" ? "/opportunities/pipelines" : "/opportunities/opp_A" })]);
    if (kind === "pipeline") expect(requests.find(r => r.stage === "recover").query).toBe("locationId=loc_fixture_01");
  }
}, 30000);


it.each([
  ["exact", { pipelines: [{ id: "new_pipe", name: "Reviewed", stages: [{ id: "new_stage", name: "New", position: 0, showInFunnel: true }] }] }, "applied"],
  ["envelope collision", { pipelines: [{ id: "new_pipe", name: "Reviewed", stages: [{ id: "new_stage", name: "New", position: 0, showInFunnel: true }] }], pipeline: { locationId: "foreign" } }, "outcome_unknown"],
  ["wrong name", { pipelines: [{ id: "new_pipe", name: "Other", stages: [{ id: "new_stage", name: "New", position: 0, showInFunnel: true }] }] }, "outcome_unknown"],
  ["wrong stage", { pipelines: [{ id: "new_pipe", name: "Reviewed", stages: [{ id: "new_stage", name: "Other", position: 0, showInFunnel: true }] }] }, "outcome_unknown"],
  ["wrong position", { pipelines: [{ id: "new_pipe", name: "Reviewed", stages: [{ id: "new_stage", name: "New", position: 1, showInFunnel: true }] }] }, "outcome_unknown"],
  ["wrong optional field", { pipelines: [{ id: "new_pipe", name: "Reviewed", stages: [{ id: "new_stage", name: "New", position: 0, showInFunnel: false }] }] }, "outcome_unknown"],
  ["missing field", { pipelines: [{ id: "new_pipe", name: "Reviewed", stages: [{ id: "new_stage", name: "New", position: 0 }] }] }, "outcome_unknown"],
  ["incomplete page", { pipelines: [{ id: "new_pipe", name: "Reviewed", stages: [{ id: "new_stage", name: "New", position: 0, showInFunnel: true }] }], meta: { total: 2 } }, "outcome_unknown"],
  ["negative sibling", { pipelines: [{ id: "new_pipe", name: "Reviewed", stages: [{ id: "new_stage", name: "New", position: 0, showInFunnel: true }] }], extra: [{ success: false }] }, "outcome_unknown"],
  ["foreign array identity", { pipelines: [{ id: "new_pipe", name: "Reviewed", stages: [{ id: "new_stage", name: "New", position: 0, showInFunnel: true }] }], extra: [{ locationId: "foreign" }] }, "outcome_unknown"],
  ["empty with hidden identity", { pipelines: [], extra: [{ locationId: "foreign" }] }, "outcome_unknown"],
  ["complete absence", { pipelines: [] }, "not_applied"],
] as const)("CFIX6 pipeline recovery compares every approved stage field and retains all response content: %s", async (_label, read, expected) => {
  const h = fixture({ policy: true });
  h.api.always("POST", /^\/opportunities\/pipelines$/, { status: 200, body: { pipeline: { id: "new_pipe", stages: [{ id: "new_stage" }] } } });
  const request = { ...replayRequest("pipeline-fields"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: {
    operation: "opportunities.pipelines.create", args: { name: "Reviewed", stages: [{ name: "New", position: 0, showInFunnel: true }] },
  } } };
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash"); });
  await h.host.handle(h.claim, request);
  h.api.first("GET", /^\/opportunities\/pipelines$/, { status: 200, body: read });
  const before = h.api.calls("GET").length;
  const host = restartedHost(h);
  const result = await host.handle(h.claim, request);
  expect(result.result).toMatchObject({ structuredContent: { outcome: expected } });
  expect(h.api.calls("GET").slice(before).map(r => r.path)).toEqual(["/opportunities/pipelines"]);
  expect(await host.handle(h.claim, request)).toEqual(result);
  expect(h.api.calls("GET")).toHaveLength(before + 1);
  expect(h.api.calls("POST")).toHaveLength(1);
});

it.each(["new", "preexisting", "duplicate", "incomplete", "existing marker"])("CFIX6 no-ID upsert search requires a unique new complete effect: %s", async mode => {
  const h = fixture({ policy: true });
  const record = { id: "new_opp", pipelineId: "pipe_A", name: "Reviewed", status: "open", followers: [] };
  h.api.always("GET", /^\/opportunities\/search$/, { status: 200, body: { opportunities: mode === "preexisting" ? [record] : [], meta: { total: mode === "preexisting" ? 1 : 0 } } });
  h.api.always("POST", /^\/opportunities\/upsert$/, { status: 200, body: { new: true, opportunity: { id: "new_opp", followers: [] } } });
  const request = { ...replayRequest("upsert-search"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: { operation: "opportunities.upsert", args: { pipelineId: "pipe_A", name: "Reviewed" } } } };
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash"); });
  await h.host.handle(h.claim, request);
  h.api.first("GET", /^\/opportunities\/search$/, { status: 200, body: { ...(mode === "existing marker" ? { new: false } : {}), opportunities: mode === "duplicate" ? [record, { ...record, id: "other_opp" }] : [record], meta: { total: ["duplicate", "incomplete"].includes(mode) ? 2 : 1 } } });
  const before = h.api.calls("GET").length;
  const result = await restartedHost(h).handle(h.claim, request);
  expect(result.result).toMatchObject({ structuredContent: { outcome: mode === "new" ? "applied" : "outcome_unknown" } });
  const reads = h.api.calls("GET").slice(before);
  expect(reads.map(r => r.path)).toEqual(["/opportunities/search"]);
  expect(reads[0]!.query.get("location_id")).toBe("loc_fixture_01");
  expect(h.api.calls("POST")).toHaveLength(1);
});

it.each(["missing claim", "tampered metadata"])("CFIX6 durable recovery after %s", async mode => {
  const h = fixture({ policy: true });
  h.api.always("PUT", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A" } } });
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash"); });
  const request = replayRequest("durable-metadata");
  await h.host.handle(h.claim, request);
  const names = readdirSync(h.approvalJournal.key);
  if (mode === "missing claim") unlinkSync(join(h.approvalJournal.key, names.find(name => name.endsWith(".pending.json"))!));
  else {
    const path = join(h.approvalJournal.key, names.find(name => name.endsWith(".opportunity.json"))!);
    const plan = JSON.parse(readFileSync(path, "utf8"));
    expect(JSON.stringify(plan)).not.toContain("Reviewed");
    plan.shape = {}; writeFileSync(path, JSON.stringify(plan));
  }
  h.api.first("GET", /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: "opp_A", name: "Reviewed" } } });
  const before = h.api.calls("GET").length;
  const result = await restartedHost(h).handle(h.claim, request);
  expect(result.result).toMatchObject({ structuredContent: { outcome: mode === "missing claim" ? "applied" : "outcome_unknown" } });
  expect(h.api.calls("GET").length - before).toBe(mode === "missing claim" ? 1 : 0);
  expect(h.api.calls("PUT")).toHaveLength(1);
});


it.each([
  ["update", { pipelineId: "pipe_A", name: "Reviewed" }, "PUT", { pipelines: [{ id: "pipe_A", name: "Reviewed" }] }],
  ["delete", { pipelineId: "pipe_A" }, "DELETE", { pipelines: [] }],
] as const)("CFIX6 pipeline %s recovers the approved ID/effect without resending", async (verb, args, method, read) => {
  const h = fixture();
  h.api.always(method, /^\/opportunities\/pipelines\/pipe_A$/, { status: 200, body: { success: true, pipeline: { id: "pipe_A" } } });
  const request = { ...replayRequest("pipeline-existing"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: { operation: `opportunities.pipelines.${verb}`, args } } };
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash"); });
  const pending = h.host.handle(h.claim, request); await h.approve(); await pending;
  h.api.first("GET", /^\/opportunities\/pipelines$/, { status: 200, body: read });
  const before = h.api.calls("GET").length;
  const result = await restartedHost(h).handle(h.claim, request);
  expect(result.result).toMatchObject({ structuredContent: { outcome: "applied" } });
  expect(h.api.calls("GET").slice(before).map(r => r.path)).toEqual(["/opportunities/pipelines"]);
  expect(h.api.calls(method)).toHaveLength(1);
});

it('MAIN integration preserves the frozen hlf2 durable RPC identity', async () => {
  const h = fixture({ policy: true });
  h.api.always('PUT', /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: 'opp_A', name: 'Reviewed' } } });
  const request = replayRequest('existing-format');
  expect((await h.host.handle(h.claim, request)).result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  const rpcId = createHash('sha256').update(canonicalBindingJson([h.claim.botId, h.claim.threadId, h.claim.generation, JSON.stringify(['string', request.id])])).digest('hex');
  expect(h.approvalJournal.getRpc(rpcId)).toMatchObject({ operation: 'opportunities.update' });
});

it.each(["add", "remove"])("RV6 host followers.%s accepts 3, 4 and 10 checked users before exact review", async verb => {
  for (const count of [3, 4, 10]) {
    const h = fixture();
    const followers = Array.from({ length: count }, (_, i) => `user_${i}`);
    h.api.always("GET", /^\/users\/user_\d+$/, req => ({ status: 200, body: { id: req.path.split("/").at(-1), roles: { locationIds: ["loc_fixture_01"] } } }));
    const method = verb === "add" ? "POST" : "DELETE";
    h.api.always(method, /^\/opportunities\/opp_A\/followers$/, { status: 200, body: { [verb === "add" ? "followersAdded" : "followersRemoved"]: followers } });
    const pending = h.call(`opportunities.followers.${verb}`, { opportunityId: "opp_A", followers });
    // Assert the actual host result even if the budget prevents review.
    const approved = pending.then(() => false);
    const reviewed = until(() => h.reviews.length > 0).then(() => true);
    expect(await Promise.race([approved, reviewed])).toBe(true);
    expect(h.api.calls("GET", /^\/users\//)).toHaveLength(count * 2);
    expect(h.api.calls(method)).toHaveLength(0);
    await h.approve();
    expect(await pending).toMatchObject({ structuredContent: { outcome: "applied" } });
    expect(h.api.calls(method)).toHaveLength(1);
  }
});

it.each(["eleven", "foreign last"])("RV6 host followers refuses %s before review or dispatch", async mode => {
  const h = fixture();
  const followers = Array.from({ length: mode === "eleven" ? 11 : 10 }, (_, i) => `user_${i}`);
  h.api.always("GET", /^\/users\/user_\d+$/, req => ({ status: 200, body: { id: req.path.split("/").at(-1), roles: { locationIds: [mode === "foreign last" && req.path.endsWith("user_9") ? "foreign" : "loc_fixture_01"] } } }));
  expect(await h.call("opportunities.followers.add", { opportunityId: "opp_A", followers })).toMatchObject({ isError: true });
  expect(h.reviews).toHaveLength(0); expect(h.api.calls("POST")).toHaveLength(0);
  expect(h.api.calls("GET", /^\/users\//)).toHaveLength(mode === "eleven" ? 0 : 10);
});

it("RV6 host upsert checks ten followers plus a distinct assignee and opportunity/pipeline", async () => {
  const h = fixture();
  const followers = Array.from({ length: 10 }, (_, i) => `user_${i}`);
  h.api.always("GET", /^\/users\/user_\d+$/, req => ({ status: 200, body: { id: req.path.split("/").at(-1), roles: { locationIds: ["loc_fixture_01"] } } }));
  h.api.always("POST", /^\/opportunities\/upsert$/, { status: 200, body: { new: false, opportunity: { id: "opp_A", assignedTo: "user_10", followers } } });
  const pending = h.call("opportunities.upsert", { id: "opp_A", pipelineId: "pipe_A", name: "Reviewed", followers, assignedTo: "user_10" });
  expect(await Promise.race([pending.then(() => false), until(() => h.reviews.length > 0).then(() => true)])).toBe(true);
  // The host runs ownership and preparation with independent bounded requesters.
  expect(h.api.calls("GET")).toHaveLength(26);
  await h.approve(); expect(await pending).toMatchObject({ structuredContent: { outcome: "applied" } });
  expect(h.api.calls("POST")).toHaveLength(1);
});

it.each([
  ["pipelines.create", { name: "Reviewed", stages: [{ name: "New", position: 0 }] }, "POST", "/opportunities/pipelines", { pipeline: { id: "new_pipe", stages: [{ id: "new_stage" }] } }, { id: "new_pipe", name: "Reviewed", stages: [{ id: "new_stage", name: "New", position: 0 }] }],
  ["pipelines.update", { pipelineId: "pipe_A", name: "Reviewed" }, "PUT", "/opportunities/pipelines/pipe_A", { pipeline: { id: "pipe_A" } }, { id: "pipe_A", name: "Reviewed" }],
  ["pipelines.delete", { pipelineId: "pipe_A" }, "DELETE", "/opportunities/pipelines/pipe_A", { success: true }, null],
  ["create", { pipelineId: "pipe_A", contactId: "contact_A", name: "Reviewed" }, "POST", "/opportunities/", { opportunity: { id: "new_opp" } }, { id: "new_opp", pipelineId: "pipe_A", contactId: "contact_A", name: "Reviewed", status: "open" }],
  ["upsert", { pipelineId: "pipe_A", name: "Reviewed" }, "POST", "/opportunities/upsert", { new: true, opportunity: { id: "new_opp", followers: [] } }, { id: "new_opp", pipelineId: "pipe_A", name: "Reviewed", status: "open", followers: [] }],
] as const)("RV7 host crash replay of %s tolerates unrelated records and never resends", async (verb, args, method, path, body, record) => {
  const h = fixture();
  const pipeline = verb.startsWith("pipelines.");
  const unrelated = pipeline ? { id: "other_pipe", name: "Other", stages: [{ id: "other_stage", name: "Other", position: 0 }] }
    : { id: "other_opp", pipelineId: "other_pipe", contactId: "other_contact", name: "Other", status: "open" };
  h.api.always("GET", /^\/opportunities\/search$/, { status: 200, body: { opportunities: [unrelated], meta: { total: 1 } } });
  h.api.always(method, new RegExp(`^${path}$`), { status: 200, body });
  const request = { ...replayRequest(`rv7-${verb}`), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: { operation: `opportunities.${verb}`, args } } };
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash before settlement"); });
  const pending = h.host.handle(h.claim, request); await h.approve(); await pending;
  const records = record ? [unrelated, record] : [unrelated];
  const readPath = pipeline ? "/opportunities/pipelines" : "/opportunities/search";
  h.api.first("GET", new RegExp(`^${readPath}$`), { status: 200, body: { [pipeline ? "pipelines" : "opportunities"]: records, meta: { total: records.length } } });
  const before = h.api.calls("GET").length;
  const host = restartedHost(h), result = await host.handle(h.claim, request);
  expect(result.result).toMatchObject({ structuredContent: { outcome: "applied" } });
  expect(h.api.calls("GET").slice(before).map(r => r.path)).toEqual([readPath]);
  expect(await host.handle(h.claim, request)).toEqual(result);
  expect(h.api.calls("GET")).toHaveLength(before + 1);
  expect(h.api.calls(method)).toHaveLength(1);
});

it.each([
  ["foreign record", { id: "other_pipe", locationId: "foreign" }, {}, "outcome_unknown"],
  ["hidden foreign location", { id: "other_pipe", extra: [{ location_id: "foreign" }] }, {}, "outcome_unknown"],
  ["hidden unknown identity", { id: "other_pipe", extra: [{ contactId: "foreign" }] }, {}, "outcome_unknown"],
  ["conflicting alias", { id: "other_pipe", pipelineId: "wrong_pipe" }, {}, "outcome_unknown"],
  // MAIN (1): negative recovery flags are unconfirmed; see
  // docs/verification/hlint1-CHANGED-EXPECTATIONS.md, RV7 adoption.
  ["negative unrelated", { id: "other_pipe", extra: [{ success: false }] }, {}, "outcome_unknown"],
  ["negative with foreign sibling", { id: "other_pipe", ok: false }, { extra: [{ locationId: "foreign" }] }, "outcome_unknown"],
  ["negative error", { id: "other_pipe", extra: [{ errors: ["failed"] }] }, {}, "outcome_unknown"],
  ["malformed confirmation", { id: "other_pipe", ok: "yes" }, {}, "outcome_unknown"],
  ["duplicate primary", { id: "new_pipe", name: "Other" }, {}, "outcome_unknown"],
  ["second matching effect", { id: "other_pipe", name: "Reviewed", stages: [{ id: "other_stage", name: "New", position: 0 }] }, {}, "outcome_unknown"],
  ["incomplete collection", { id: "other_pipe" }, { meta: { total: 3 } }, "outcome_unknown"],
  ["next page", { id: "other_pipe" }, { meta: { total: 2, nextPage: 2 } }, "outcome_unknown"],
  ["foreign sibling", { id: "other_pipe" }, { extra: [{ locationId: "foreign" }] }, "outcome_unknown"],
  ["negative sibling", { id: "other_pipe" }, { extra: [{ success: false }] }, "outcome_unknown"],
] as const)("RV7 host collection replay retains refusal for %s", async (_label, unrelated, siblings, expected) => {
  const h = fixture({ policy: true });
  h.api.always("POST", /^\/opportunities\/pipelines$/, { status: 200, body: { pipeline: { id: "new_pipe", stages: [{ id: "new_stage" }] } } });
  const request = { ...replayRequest("rv7-refusals"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: {
    operation: "opportunities.pipelines.create", args: { name: "Reviewed", stages: [{ name: "New", position: 0 }] },
  } } };
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash"); });
  await h.host.handle(h.claim, request);
  h.api.first("GET", /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: [unrelated, { id: "new_pipe", name: "Reviewed", stages: [{ id: "new_stage", name: "New", position: 0 }] }], meta: { total: 2 }, ...siblings } });
  const before = h.api.calls("GET").length;
  const host = restartedHost(h), result = await host.handle(h.claim, request);
  expect(result.result).toMatchObject({ structuredContent: { outcome: expected } });
  expect(h.api.calls("GET").slice(before).map(r => r.path)).toEqual(["/opportunities/pipelines"]);
  expect(await host.handle(h.claim, request)).toEqual(result);
  expect(await restartedHost(h).handle(h.claim, request)).toEqual(result);
  expect(h.api.calls("GET")).toHaveLength(before + 1); expect(h.api.calls("POST")).toHaveLength(1);
});

it.each(["present", "foreign", "duplicate", "truncated", "hidden negative", "contradictory envelope"])("RV7 host deletion cannot prove absence from %s collection", async mode => {
  const h = fixture();
  h.api.always("DELETE", /^\/opportunities\/pipelines\/pipe_A$/, { status: 200, body: { success: true } });
  const request = { ...replayRequest("rv7-delete-refusal"), params: { name: "HIGHLEVEL_OPPORTUNITIES", arguments: { operation: "opportunities.pipelines.delete", args: { pipelineId: "pipe_A" } } } };
  vi.spyOn(h.approvalJournal, "settle").mockImplementationOnce(() => { throw new Error("crash"); });
  const pending = h.host.handle(h.claim, request); await h.approve(); await pending;
  const other = { id: "other_pipe", ...(mode === "foreign" ? { locationId: "foreign" } : {}), ...(mode === "hidden negative" ? { extra: [{ ok: false }] } : {}) };
  h.api.first("GET", /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: mode === "present" ? [other, { id: "pipe_A" }] : mode === "duplicate" ? [other, other] : [other], ...(mode === "truncated" ? { meta: { total: 2 } } : {}), ...(mode === "contradictory envelope" ? { pipeline: { id: "pipe_A" } } : {}) } });
  const before = h.api.calls("GET").length;
  const host = restartedHost(h), result = await host.handle(h.claim, request);
  // Only a confirmed present target disproves deletion. A negative provider
  // flag cannot prove absence (MAIN (1), RV7 adoption in changed expectations).
  expect(result.result).toMatchObject({ structuredContent: { outcome: mode === "present" ? "not_applied" : "outcome_unknown" } });
  expect(h.api.calls("GET").slice(before).map(r => r.path)).toEqual(["/opportunities/pipelines"]);
  expect(await host.handle(h.claim, request)).toEqual(result);
  expect(await restartedHost(h).handle(h.claim, request)).toEqual(result);
  expect(h.api.calls("GET")).toHaveLength(before + 1);
  expect(h.api.calls("DELETE")).toHaveLength(1);
});

it.each([
  ["opportunities.followers.add", 13], ["opportunities.followers.remove", 13], ["opportunities.upsert", 13], ["opportunities.update", 5],
] as const)("RV6 preflight budget stays bounded for %s", async (id, limit) => {
  const { createPreflightRequester } = await import("./client.ts");
  const h = fixture();
  const send = vi.spyOn(h.client, "sendHeld").mockResolvedValue({});
  const pre = createPreflightRequester(h.client, { connection: [...h.leases.views.values()][0]!, signal: h.signals.signalFor(h.claim), assertActive() {} },
    { id, preflight: ["opportunities.get"] });
  for (let i = 0; i < limit; i++) await pre.read("opportunities.get", { path: "/opportunities/opp_A" });
  await expect(pre.read("opportunities.get", { path: "/opportunities/opp_A" })).rejects.toMatchObject({ code: "request_shape" });
  await expect(pre.read("opportunities.pipelines.list", { path: "/opportunities/pipelines", query: { locationId: "loc_fixture_01" } })).rejects.toMatchObject({ code: "request_shape" });
  expect(send).toHaveBeenCalledTimes(limit);
});
