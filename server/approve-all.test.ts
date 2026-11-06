// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// APPROVE-ALL (design rev 3): the pure parts. The eligibility allowlist fails closed on every fact, every verdict
// source has an explicit answer, the frozen batch is bound, capped and used once, the batch digest is its own
// domain, and the reply sink behaves like a response for answeredWhere. Plus source checks that the respond
// function refuses every special resolver in bulk before it runs, and that apply answers only through it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPROVE_ALL_THREAD, approvalBatchDigest, approvalBatchDigestInput, approvalDigestInput } from "../shared/approval-digest.ts";
import { REASON_FOLD } from "../shared/fold-scopes.ts";
import { FreshAuthGate, approvalBatchDigestSync } from "./approval-fresh-auth.ts";
import { APPROVE_ALL_BATCH_TTL_MS, APPROVE_ALL_CAP, ApproveAllBatches, BULK_REASON, BULK_SPECIAL_KINDS, CaptureResponse, bulkEligibility, bulkSpecialRefusal, type BulkSpecialKind, type BulkSpecialProbes } from "./approve-all.ts";
import { AnsweredWhere } from "./mobile-push-hooks.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const RID = "req-1";
/** An ordinary card in a turn the owner typed: the only shape that qualifies. */
const ordinary = (extra: Record<string, unknown> = {}, cls: Record<string, unknown> = {}) => ({
  title: "Approval needed", subtitle: "ls -la", options: ["Allow", "Deny"], requestId: RID, tool: "bash",
  cardClass: { reason: "no-grant", unattended: false, automated: false, keys: [], origin: "owner", ...cls },
  ...extra,
});

describe("bulkEligibility: a positive allowlist, fail closed", () => {
  it("an ordinary card in the owner's own turn qualifies", () => {
    expect(bulkEligibility(ordinary(), RID)).toEqual({ ok: true });
  });

  it("every verdict source has an explicit answer, and only no-grant and an attended routine step may qualify", () => {
    expect(Object.keys(BULK_REASON).sort()).toEqual(Object.keys(REASON_FOLD).sort());
    const may = new Set(["no-grant", "routine-allow"]); // APPROVALS-SIMPLE-1018 section 4
    for (const [reason, verdict] of Object.entries(BULK_REASON)) {
      expect(verdict === null).toBe(may.has(reason));
      if (!may.has(reason)) expect(bulkEligibility(ordinary({}, { reason }), RID).ok).toBe(false);
    }
  });

  it.each([
    ["always-ask", {}, { reason: "always-ask" }],
    ["pay", {}, { stop: { kind: "pay", public: false, placed: true, places: 1 } }],
    ["message", {}, { stop: { kind: "message", public: true, placed: true, places: 1 } }],
    ["delete", {}, { stop: { kind: "delete", public: false, placed: true, places: 1 } }],
    ["held", {}, { reason: "destructive-guard" }],
    ["sensitive", {}, { reason: "sensitive-guard" }],
    ["held", {}, { reason: "prompt-guard" }],
    ["held", {}, { reason: "unread-call" }],
    ["held", {}, { reason: "narrow" }],
    ["unattended", {}, { reason: "unattended-block" }],
    ["unattended", {}, { unattended: true }],
    ["unattended", { unattended: true }, {}],
    ["local-computer", {}, { scope: "local-computer" }],
    ["local-computer", { approvalScope: "local-computer" }, {}],
    ["local-computer", {}, { reason: "local-computer-block" }],
    ["origin", {}, { origin: "other" }],
    ["origin", {}, { origin: undefined }],
    ["held", { held: "Murage held this one." }, {}],
    ["truncated", { toolInputTruncated: true }, {}],
    ["needs-look", { kind: "publish" }, {}],
    ["needs-look", { kind: "mcpEnable" }, {}],
    ["needs-look", { kind: "email-trust-offer" }, {}],
    ["message", { kind: "email-send" }, {}],
    ["message", { emailSend: { payloadHash: "x" } }, {}],
    ["needs-look", { publish: {} }, {}],
    ["needs-look", { mcpEnable: {} }, {}],
    ["needs-look", { emailTrustOffer: {} }, {}],
    ["needs-look", { limitOffer: {} }, {}],
    ["needs-look", { browserSetup: {} }, {}],
    ["delete", { browserCardKind: "delete" }, {}],
    ["message", { browserCardKind: "newRecipient" }, {}],
    ["not-approval", { questions: [{ question: "?" }] }, {}],
    ["not-approval", { folderTrust: { key: "k", folder: "/x", sources: [] } }, {}],
    ["not-approval", { intake: {} }, {}],
    ["not-approval", { answerAsSend: true }, {}],
    ["routine", { routineRequest: {} }, {}],
    ["needs-look", { skillRequest: {} }, {}],
    ["not-approval", { tool: undefined }, {}],
    ["not-open", { answered: "allow" }, {}],
    ["not-open", { dismissed: true }, {}],
    ["not-open", { expired: true }, {}],
    ["not-open", { orphaned: true }, {}],
  ])("stays for one-by-one: %s", (reasonKey, extra, cls) => {
    expect(bulkEligibility(ordinary(extra, cls), RID)).toEqual({ ok: false, reasonKey });
  });

  it("special request ids, a missing or foreign class, a mismatched id and junk never qualify", () => {
    for (const id of ["image-1", "publish-1", "limit-1", "email-1"]) expect(bulkEligibility(ordinary({ requestId: id }), id).ok).toBe(false);
    expect(bulkEligibility(ordinary({ cardClass: undefined }), RID).ok).toBe(false);
    expect(bulkEligibility(ordinary({}, { reason: "made-up" }), RID).ok).toBe(false);
    expect(bulkEligibility(ordinary(), "req-2").ok).toBe(false);
    for (const junk of [null, undefined, 1, "card", [], {}]) expect(bulkEligibility(junk, RID).ok).toBe(false);
  });

  it("lowRisk is advisory and never read", () => {
    expect(bulkEligibility(ordinary({ lowRisk: true }, { reason: "destructive-guard" }), RID).ok).toBe(false);
    expect(bulkEligibility(ordinary({ lowRisk: false }), RID).ok).toBe(true);
  });
});

describe("ApproveAllBatches: the frozen list", () => {
  const cards = (n: number) => Array.from({ length: n }, (_, i) => ({ threadId: "t1", requestId: `r${i}`, digest: "d".repeat(64) }));
  it("is bound to its surface, capped, a subset with no repeats, and used once", () => {
    let now = 1_000;
    const batches = new ApproveAllBatches({ now: () => now });
    const batch = batches.create("app:dev-1", "dev-1", cards(30));
    expect(batch.batchId).toMatch(/^aab-[0-9a-f]{32}$/);
    expect(batch.cards).toHaveLength(APPROVE_ALL_CAP);
    expect(batches.open(batch.batchId, "desktop", ["r0"])).toEqual({ ok: false, code: "batch_unknown" });
    expect(batches.open(batch.batchId, "app:dev-2", ["r0"])).toEqual({ ok: false, code: "batch_unknown" });
    expect(batches.open(batch.batchId, "app:dev-1", ["r0", "r0"])).toEqual({ ok: false, code: "bad_selection" });
    expect(batches.open(batch.batchId, "app:dev-1", ["r26"])).toEqual({ ok: false, code: "bad_selection" });
    expect(batches.open(batch.batchId, "app:dev-1", [])).toEqual({ ok: false, code: "bad_selection" });
    expect(batches.open(batch.batchId, "app:dev-1", "r0")).toEqual({ ok: false, code: "bad_selection" });
    const ok = batches.open(batch.batchId, "app:dev-1", ["r3", "r1"]);
    expect(ok.ok && ok.ticked.map((c) => c.requestId)).toEqual(["r1", "r3"]);
    batches.burn(batch.batchId);
    expect(batches.open(batch.batchId, "app:dev-1", ["r1"])).toEqual({ ok: false, code: "batch_used" });
    const late = batches.create("desktop", null, cards(2));
    now += APPROVE_ALL_BATCH_TTL_MS;
    expect(batches.open(late.batchId, "desktop", ["r0"])).toEqual({ ok: false, code: "batch_unknown" });
    expect(batches.open("not-a-batch", "desktop", ["r0"])).toEqual({ ok: false, code: "batch_unknown" });
  });
});

describe("the batch digest and proof", () => {
  const lines = [["t2", "r9", "a".repeat(64)], ["t1", "r1", "b".repeat(64)]] as const;
  it("is order free, matches between page and harness, and never equals a card's", async () => {
    expect(approvalBatchDigestInput("aab-1", "dev", lines)).toBe(approvalBatchDigestInput("aab-1", "dev", [lines[1], lines[0]]));
    expect(await approvalBatchDigest("aab-1", "dev", lines)).toBe(approvalBatchDigestSync("aab-1", "dev", lines));
    expect(approvalBatchDigestSync("aab-1", "dev", lines)).not.toBe(approvalBatchDigestSync("aab-1", "dev", [lines[0]]));
    expect(approvalBatchDigestSync("aab-1", "dev", lines)).not.toBe(approvalBatchDigestSync("aab-1", "dev-2", lines));
    expect(approvalBatchDigestInput("aab-1", "dev", lines).startsWith('["murage-approval-batch/1"')).toBe(true);
    expect(approvalDigestInput("t1", "r1", {}).startsWith('["murage-approval-digest/2"')).toBe(true);
  });

  it("a nonce held for a batch never passes for a single card, and the reverse", () => {
    const device = { id: "11111111-1111-4111-8111-111111111111", cls: "app" as const, key: `B${"A".repeat(86)}` };
    const gate = new FreshAuthGate({ now: () => 5_000, nonce: () => "n".repeat(43) });
    const digest = "c".repeat(64);
    const batch = gate.check({ device, threadId: APPROVE_ALL_THREAD, requestId: "aab-1", decision: "allow", digest, proof: undefined });
    expect(batch.ok).toBe(false);
    const asCard = gate.check({ device, threadId: "t1", requestId: "r1", decision: "allow", digest, proof: { nonce: "n".repeat(43), signature: "AAAAAAAA" } });
    expect(asCard).toMatchObject({ ok: false, body: { code: "fresh_auth_failed" } });
  });
});

describe("CaptureResponse", () => {
  it("records the reply, and answeredWhere drops a refused attempt on it", () => {
    const where = new AnsweredWhere();
    const sink = new CaptureResponse();
    where.attempt("t:r", "desktop", sink);
    sink.writeHead(409);
    sink.end(JSON.stringify({ code: "bulk_skipped", reason: "special-card:peer" }));
    expect(sink.body).toEqual({ code: "bulk_skipped", reason: "special-card:peer" });
    expect(where.take("t:r")).toBe("elsewhere");
  });
});

describe("source: one responder, refusals before every resolver", () => {
  const index = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");
  const between = (from: string, to: string) => {
    const start = index.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    const end = index.indexOf(to, start + from.length);
    expect(end, to).toBeGreaterThan(start);
    return index.slice(start, end);
  };
  const respond = between("async function respondToCard(", "\n}\n");

  it("each special resolver in respondToCard is preceded by its bulk refusal", () => {
    const pairs: Array<[resolver: string, refusal: string]> = [
      ["answerLimitCard(", 'bulkSkip(res, "special-card:limit")'],
      ["answerEmailCard(", 'bulkSkip(res, "special-card:email")'],
      ["answerAsSendReply(", 'bulkSkip(res, "special-card:question")'],
      ["questionReply(", 'bulkSkip(res, "special-card:question")'],
      ["resolveSkillRequest(", 'bulkSkip(res, "special-card:skill")'],
      ["resolveAndSendRoutine(res, {\n      botId: routineBotId", 'bulkSkip(res, "special-card:routine")'],
      ["resolvePeerComms(", 'bulkSkip(res, "special-card:peer")'],
      ["browserExtension?.answerCard(", 'bulkSkip(res, "special-card:extension")'],
      ["resolveHostComputerConsent(", 'bulkSkip(res, "special-card:host-consent")'],
    ];
    for (const [resolver, refusal] of pairs) {
      const at = respond.indexOf(resolver);
      expect(at, resolver).toBeGreaterThan(-1);
      const guard = respond.indexOf(refusal);
      expect(guard, refusal).toBeGreaterThan(-1);
      expect(guard, `${refusal} before ${resolver}`).toBeLessThan(at);
    }
    // the live card is re-read and re-judged before any branch, and fresh auth in bulk does not await
    expect(respond.indexOf("bulkEligibility(cardByRequest(threadId, requestId)?.card, requestId)")).toBeLessThan(respond.indexOf("taskGrantRefusal("));
    expect(respond).toContain("bulk ? freshAuthRefusalBulk(");
    expect(respond).toContain("{ batch: { batchId: bulk.batchId, batchSize: bulk.batchSize } }");
  });

  it("the second fence runs in bulk right after the live re-read, before any resolver, attempt record or await", () => {
    const fence = respond.indexOf("const specialRefusal = bulkSpecialRefusal(special);");
    expect(fence).toBeGreaterThan(-1);
    expect(respond.slice(fence - 40, fence)).toContain("if (bulk) {");
    expect(respond.slice(fence, fence + 120)).toContain("if (specialRefusal) return bulkSkip(res, specialRefusal);");
    expect(fence).toBeGreaterThan(respond.indexOf("bulkEligibility(cardByRequest(threadId, requestId)?.card, requestId)"));
    for (const later of ["answerLimitCard(", "answerEmailCard(", "answeredWhere.attempt(", "answerAsSendReply(", "questionReply(", "resolveSkillRequest(", "resolvePeerComms(", "answerCard(", "resolveHostComputerConsent(", "freshAuthRefusalBulk(", "await "]) {
      const at = respond.indexOf(later);
      expect(at, later).toBeGreaterThan(fence);
    }
    expect(respond.slice(0, fence)).not.toMatch(/\btry\s*\{/);
  });

  it("each probe is the predicate its own branch tests, and every special reason in respondToCard is a listed kind", () => {
    const probes = between("const special: BulkSpecialProbes = {", "\n  };");
    const expected: Record<BulkSpecialKind, string> = {
      limit: 'requestId.startsWith("limit-")',
      email: "isEmailRequestId(requestId)",
      question: "Boolean(cardByRequest(threadId, requestId, (message) => isQuestionCard(message.card)))",
      skill: "Boolean(store.cardForRequest(threadId, requestId, (message) => Boolean(message.card?.skillRequest))?.card?.skillRequest)",
      routine: "Boolean(store.cardForRequest(threadId, requestId, (message) => Boolean(message.card?.routineRequest))?.card?.routineRequest)",
      peer: "Boolean(peerApprovalHolder(requestId))",
      extension: "Boolean(browserExtension?.knowsCard(requestId))",
      "host-consent": "hostComputerConsentPending(requestId)",
    };
    for (const kind of BULK_SPECIAL_KINDS) {
      const key = kind.includes("-") ? `"${kind}"` : kind;
      expect(probes, kind).toContain(`${key}: () => ${expected[kind]},`);
      const call = kind.includes("-") ? `special["${kind}"]()` : `special.${kind}()`;
      expect(respond, kind).toContain(`if (bulk && ${call}) return bulkSkip(res, "special-card:${kind}");`);
    }
    // the branches themselves still test the same thing the probe does
    expect(respond).toContain('requestId.startsWith("limit-") && !mayApprove(req, url)');
    expect(respond).toContain("if (isEmailRequestId(requestId)) {");
    expect(respond).toContain("store.cardForRequest(threadId, requestId, (message) => Boolean(message.card?.skillRequest))");
    expect(respond).toContain("store.cardForRequest(threadId, requestId, (message) => Boolean(message.card?.routineRequest))");
    const reasons = [...respond.matchAll(/"special-card:([a-z-]+)"/g)].map((m) => m[1]);
    for (const reason of reasons) expect(BULK_SPECIAL_KINDS as readonly string[], reason).toContain(reason);
  });

  it("the thread respond route is a call to respondToCard, and apply answers only through it", () => {
    const route = between("m = path.match(/^\\/api\\/threads\\/([\\w-]+)\\/respond$/);", "\n    }\n");
    expect(route).toContain("return await respondToCard({ req, url, res }, threadId, await readBody(req));");
    const applyFn = between("async function approveAllApply(", "\n}\n");
    for (const name of ["answerRequest", "deliverAnswer", "answerLimitCard", "answerEmailCard", "answerAsSendReply", "questionReply", "resolveSkillRequest", "resolveAndSendRoutine", "resolvePeerComms", "answerCard", "resolveHostComputerConsent", "allowForTask"]) {
      expect(applyFn.includes(name), name).toBe(false);
    }
    expect(applyFn).toContain('{ requestId: card.requestId, behavior: "allow" }');
  });

  it("the bot respond route names its bot's own thread and answers only through respondToCard (BOT-RESPOND-ROUTE-UNIFY)", () => {
    const route = between("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/respond$/);", "\n    }\n");
    expect(route).toContain("const bot = requestedDirectBot(m[1], ");
    expect(route).toContain("return await respondToCard({ req, url, res }, bot.threadId, body, undefined, { botId: bot.id });");
    // no second copy of the card rules is left in the route
    for (const name of ["answerRequest", "answerLimitCard", "answerEmailCard", "answerAsSendReply", "questionReply", "resolveSkillRequest", "resolveAndSendRoutine", "resolvePeerComms", "answerCard", "resolveHostComputerConsent", "freshAuthRefusal", "taskGrantRefusal", "mayApprove", "publishAnswerAllowed", "json(res"]) {
      expect(route.includes(name), name).toBe(false);
    }
    // and the one copy is never called in bulk from this route
    expect(route).not.toContain("bulk");
    // undo, skill and routine answers are decided for the route's own bot, as before the move (Astra r1 Medium)
    expect(respond).toContain("route ? route.botId : cardBotId ?? store.botByThread(threadId)?.id");
    for (const kind of ["undo", "skill", "routine"]) expect(respond, kind).toMatch(new RegExp(`const ${kind}BotId = cardOwner\\(`));
  });

  it("a card's origin is owner only in the owner's own typed turn: a peer ask, delegation, wake or continuation reads other (Astra R1 H2)", () => {
    expect(index).toContain("...(permission ? { origin: approveAllTurnOrigin(event.threadId) } : {}),");
    expect(index).not.toContain("origin: fullAccessTurnOrigin(event.threadId)");
    const fn = between("function approveAllTurnOrigin(", "\n}\n");
    expect(fn).toContain('if (origin !== "owner") return origin;');
    expect(fn).toContain('return internalTurnOwners.get(threadId)?.ownerTyped === true ? "owner" : "other";');
    const typed = between("const ownerTyped = ", ";\n");
    for (const part of ["directOwnerAudience", "isOwnerOrigin(opts?.origin)", "!routineOrigin", "opts?.automationSource === undefined", "opts?.automation === undefined",
      "!opts?.unattended", "!opts?.via", "!commsDepth", "!opts?.delegationRun", "!opts?.cardContinuation", "!opts?.askerWake", "!opts?.projectCardRun",
      "!opts?.sharedWorkRun", "!opts?.queuedDrain", "!opts?.memoryRedispatch", "opts?.memorySkillSource === undefined"]) expect(typed, part).toContain(part);
    expect(index).toContain("beginInternalTurn(bot.id, threadId, dispatchClaimId, commsDepth, skillAuthoring, eventId, requestCoordination, memoryNotOwner, directOwnerAudience, ownerTyped);");
    // the bot-to-bot ask starts its turn with a comms depth and an ask automation, so it can never be ownerTyped
    const ask = between('automation:{kind:"ask"},', "onDispatchError");
    expect(index).toContain("commsDepth: depth + 1,\n      automation:{kind:\"ask\"},");
    expect(ask).toContain("peerRoutineTurnOptions(");
    // every other internal turn begin leaves ownerTyped false
    expect([...index.matchAll(/beginInternalTurn\(/g)].length).toBe(3);
    expect(index).toContain("beginInternalTurn(bot.id, threadId, internalGeneration, hop, skillAuthoring, undefined, undefined, !roomOwnerAudience, roomOwnerAudience);");
  });

  it("the respond route awaits respondToCard and refuses a body that is not an object (Astra R1 H1)", () => {
    expect(respond).toContain('if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400,');
    expect(respond.indexOf("typeof body !== \"object\"")).toBeLessThan(respond.indexOf("body.behavior"));
  });

  it("bot learning reads only user-approved and user-denied, so a bulk yes is never a lesson", () => {
    const hook = readFileSync(join(SERVER_DIR, "memory", "outcomes-routes.ts"), "utf8");
    expect(hook).toMatch(/row\.decision !== "user-approved" && row\.decision !== "user-denied"\) [^\n]*return;/);
  });
});

describe("bulkSpecialRefusal (probes only)", () => {
  const none = (): BulkSpecialProbes => Object.fromEntries(BULK_SPECIAL_KINDS.map((kind) => [kind, () => false])) as unknown as BulkSpecialProbes;
  it("lists all eight kinds in branch order", () => {
    expect([...BULK_SPECIAL_KINDS]).toEqual(["limit", "email", "question", "skill", "routine", "peer", "extension", "host-consent"]);
  });
  it("no kind set passes", () => {
    expect(bulkSpecialRefusal(none())).toBeNull();
  });
  it.each(BULK_SPECIAL_KINDS.map((kind) => [kind]))("%s alone refuses the card", (kind) => {
    expect(bulkSpecialRefusal({ ...none(), [kind]: () => true })).toBe(`special-card:${kind}`);
  });
  it("the first match in branch order wins, and later probes are not asked", () => {
    const asked: string[] = [];
    const probes = Object.fromEntries(BULK_SPECIAL_KINDS.map((kind) => [kind, () => { asked.push(kind); return kind === "question" || kind === "peer"; }])) as unknown as BulkSpecialProbes;
    expect(bulkSpecialRefusal(probes)).toBe("special-card:question");
    expect(asked).toEqual(["limit", "email", "question"]);
  });
  it("a probe that throws propagates: nothing is decided as eligible", () => {
    expect(() => bulkSpecialRefusal({ ...none(), skill: () => { throw new Error("store gone"); } })).toThrow("store gone");
  });
  it("fails closed: any truthy probe result refuses", () => {
    expect(bulkSpecialRefusal({ ...none(), peer: (() => ({})) as unknown as () => boolean })).toBe("special-card:peer");
  });
});
