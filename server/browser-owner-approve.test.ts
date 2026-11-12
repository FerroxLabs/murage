// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// R3.1 (INT1019-CLOUD-MERGE-PLAN group 3): the Cloud owner browser's gates, driven through the REAL respondToCard.
//
// Both respond routes (POST /api/threads/:t/respond and POST /api/bots/:id/respond) are one call into respondToCard, so the gates
// live there once. server/index.ts is a monolith that starts a server on import, so this test cuts the real source of respondToCard
// and the helpers it calls out of index.ts, strips the types, and runs them over the REAL gate modules (browser-owner-gates,
// host-computer-consent, publish-ops, approval-fresh-auth, owner-app, cloud-owner-surface). Only the card store, the answer
// delivery and the question reader are stubbed. A symbol the cut needs and this test did not stub throws by name.
//
// MURAGE_CLOUD_ROLE=home, and the request is an owner browser (scope browser, remembered-owner factor), as the gates tests do.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { APPROVE_ALL_THREAD } from "../shared/approval-digest.ts";
import { FRESH_AUTH_COPY, approvalDigestSync } from "./approval-fresh-auth.ts";
import { browserCardGate, browserNoComputer, onOwnerBrowser, ownerCodeGate, ownerProvenFor, setBrowserOwnerAct } from "./browser-owner-gates.ts";
import { bulkSpecialRefusal } from "./approve-all.ts";
import { cardActDigest } from "./cloud-home/owner-code.ts";
import type { CloudOwnerAct } from "./cloud-request-auth.ts";
import { cloudPhoneHighRiskRefusal, isDesktopApp, isOwnersComputer, skipsFreshAuth } from "./cloud-owner-surface.ts";
import { cloudIdentity, setCloudIdentity } from "./cloud-request-identity.ts";
import { decide as outsideAuthority } from "./outside-authority.ts";
import type { CloudDevice } from "./cloud-sessions.ts";
import { awaitHostComputerConsent, HOST_CONSENT_TOOL, hostComputerConsentPending, hostConsentPending, resolveHostComputerConsent } from "./host-computer-consent.ts";
import { ownerAppSurface } from "./owner-app.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import { publishAnswerAllowed } from "./publish/publish-ops.ts";
import { Store } from "./store.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

/** The source of one top-level function declaration in index.ts. */
function cut(name: string): string {
  const found = new RegExp(`^(?:async )?function ${name}\\b`, "m").exec(source);
  expect(found, `function ${name} in index.ts`).not.toBeNull();
  const end = source.indexOf("\n}\n", found!.index);
  expect(end).toBeGreaterThan(found!.index);
  return source.slice(found!.index, end + 3);
}
const stringConst = (name: string): string => {
  const found = new RegExp(`^const ${name} = "([^"]+)";`, "m").exec(source);
  expect(found, `const ${name} in index.ts`).not.toBeNull();
  return found![1]!;
};

type Reply = { status?: number; body?: any };
type Call = { threadId: string; instanceId: string; requestId: string; behavior: string; options?: Record<string, unknown> };
const CUT = ["respondToCard", "freshAuthRefusal", "browserFreshAuth", "folderTrustBrowserGate", "freshAuthRefusalBulk", "approveAllSurface", "requestBehavior", "botAnswerSurface"] as const;
const THREAD = "t1";

interface Fixture {
  respondToCard: (io: { req: IncomingMessage; url: URL; res: Reply }, threadId: string, body: Record<string, unknown>, bulk?: unknown, route?: { botId: string }) => Promise<void>;
  approveAllSurface: (req: IncomingMessage, url: URL) => { ok: boolean; status?: number; body?: Record<string, unknown> };
  answers: Call[];
  questionCalls: unknown[][];
  remembered: unknown[][];
  cards: Map<string, Record<string, any>>;
}

function fixture(): Fixture {
  const cards = new Map<string, Record<string, any>>();
  const answers: Call[] = [];
  const questionCalls: unknown[][] = [];
  const remembered: unknown[][] = [];
  const key = (threadId: string, requestId: string) => `${threadId}:${requestId}`;
  const isQuestionCard = (card: any) => Boolean(card && Array.isArray(card.questions) && card.questions.length);
  const overrides: Record<string, unknown> = {
    // real gate modules
    onOwnerBrowser, ownerCodeGate, browserCardGate, browserNoComputer, ownerProvenFor, hostConsentPending, hostComputerConsentPending, resolveHostComputerConsent,
    publishAnswerAllowed, approvalDigestSync, cardActDigest, FRESH_AUTH_COPY, ownerAppSurface, cloudPhoneHighRiskRefusal, isDesktopApp, skipsFreshAuth, APPROVE_ALL_THREAD,
    isOwnersComputer, cloudIdentity, outsideAuthority,
    PUBLISH_NEEDS_COMPUTER: stringConst("PUBLISH_NEEDS_COMPUTER"), APPROVAL_NEEDS_OWNER: stringConst("APPROVAL_NEEDS_OWNER"),
    // stubs: the reply, the card store, the question reader, the delivery
    json: (res: Reply, status: number, body: unknown) => { res.status = status; res.body = body; },
    mayApprove: () => true,
    requestSurface: () => "desktop",
    requestOrigin: () => "owner",
    companionAuthorized: () => false,
    pushCard: (threadId: string, requestId: string) => cards.get(key(threadId, requestId)),
    pushCardOpen: (threadId: string, requestId: string) => cards.has(key(threadId, requestId)),
    cardByRequest: (threadId: string, requestId: string, pick?: (m: { card: any }) => boolean) => {
      const card = cards.get(key(threadId, requestId));
      return card && (!pick || pick({ card })) ? { card } : undefined;
    },
    isQuestionCard, questionsForCard: (card: any) => card.questions,
    questionReply: (...args: unknown[]) => {
      questionCalls.push(args);
      const card = cards.get(key(args[0] as string, args[1] as string));
      return isQuestionCard(card) ? { kind: "deliver", behavior: "answer", message: "", answers: { 0: "yes" } } : { kind: "none" };
    },
    stopHitByRequest: new Map(),
    peerApprovalHolder: () => undefined,
    browserExtension: undefined,
    store: { botByThread: () => ({ id: "b1", name: "Bot" }), bot: () => ({ id: "b1", name: "Bot" }), cardForRequest: () => undefined },
    taskGrantRefusal: () => undefined,
    answerLimitCard: () => null,
    isEmailRequestId: () => false,
    isVenuePostRequestId: () => false,
    answerAsSendReply: async () => null,
    outsideFlights: new Set<string>(),
    answeredWhere: { attempt: () => undefined, forget: () => undefined },
    pushWarn: () => undefined,
    bulkEligibility: () => ({ ok: true }), bulkSpecialRefusal,
    bulkSkip: (res: Reply, reason: string) => { res.status = 409; res.body = { code: "bulk_skipped", reason }; },
    resolvePeerComms: () => false,
    approvalBus: {},
    rememberHostComputerConsent: (...args: unknown[]) => { remembered.push(args); },
    threadRequestOwner: () => ({ owner: { id: "b1", name: "Bot" }, pending: undefined, instanceId: "claude", decidedFor: { id: "b1", name: "Bot" } }),
    answerRequest: async (threadId: string, instanceId: string, requestId: string, behavior: string, _message: unknown, _decidedFor: unknown, _answers: unknown, options?: Record<string, unknown>) => {
      answers.push({ threadId, instanceId, requestId, behavior, ...(options ? { options } : {}) });
      return behavior === "allow" ? "allowed-once" : "rejected";
    },
  };
  const scope = new Proxy(overrides, {
    has: () => true,
    get(target, name) {
      if (typeof name === "symbol") return undefined;
      if (name in target) return target[name];
      if (name in globalThis) return (globalThis as Record<string, unknown>)[name];
      return () => { throw new Error(`index.ts symbol not stubbed by browser-owner-approve.test.ts: ${name}`); };
    },
  });
  const code = CUT.map((name) => stripTypeScriptTypes(cut(name))).join("\n");
  const made = new Function("scope", `with (scope) {\n${code}\nreturn { respondToCard, approveAllSurface };\n}`)(scope) as Pick<Fixture, "respondToCard" | "approveAllSurface">;
  return { ...made, answers, questionCalls, remembered, cards };
}

const pem = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "pem", type: "spki" }).toString();
const device = (scope: string, factor?: string): CloudDevice & { accessHash: string } =>
  ({ id: "dev-1", account: "owner", scope, publicKey: pem(), assertionKey: pem(), revoked: 0, ...(factor ? { factor } : {}), accessHash: "hash-1" }) as never;
/** A request from a Cloud home caller. The owner browser is scope browser with a live remembered-owner factor. */
const request = (who: "owner-browser" | "owner-desktop", proof?: string): IncomingMessage => {
  const headers = { ...(proof ? { "x-murage-owner-proof": proof } : {}) } as IncomingMessage["headers"];
  setCloudIdentity(headers, who === "owner-browser" ? device("browser", "remembered-owner") : device("owner-desktop"));
  return { headers } as IncomingMessage;
};
const URL_ = new URL("http://home.example/api/threads/t1/respond");
const service = (): CloudOwnerAct => {
  const spent = new Set<string>();
  return {
    token: (input) => `tok:${input.label}:${input.act}`, doorFresh: () => false,
    verifyProof: (req, _device, act) => { const ok = req.headers["x-murage-owner-proof"] === `ok:${act}` && !spent.has(act); if (ok) spent.add(act); return ok; },
  };
};
beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); setBrowserOwnerAct(service()); });
afterEach(() => { vi.unstubAllEnvs(); setBrowserOwnerAct(undefined); });

const HIGH_RISK = { requestId: "req-1", tool: "Bash", summary: "rm -rf ~/Documents", approvalScope: "computer", riskReason: "credential" };
const OTHER_HIGH_RISK = { ...HIGH_RISK, requestId: "req-2" };
const PUBLISH = { requestId: "publish-1", tool: "publish_site", summary: "Put a site online" };
const actOf = (refused: Reply): string => String(refused.body.actToken).split(":").slice(2).join(":");
const BULK = { desktop: false, proven: true, previewDigest: "digest", batchId: "batch-1", batchSize: 1 };

/** Each entry shape: the thread route, and the bot route that names the bot (BOT-RESPOND-ROUTE-UNIFY). */
const ROUTES = [
  { name: "POST /api/threads/:t/respond", route: undefined },
  { name: "POST /api/bots/:id/respond", route: { botId: "b1" } },
] as const;

describe.each(ROUTES)("R3.1 $name from the owner's browser", ({ route }) => {
  const respond = async (f: Fixture, who: "owner-browser" | "owner-desktop", body: Record<string, unknown>, proof?: string, bulk?: unknown): Promise<Reply> => {
    const res: Reply = {};
    await f.respondToCard({ req: request(who, proof), url: URL_, res }, THREAD, body, bulk, route);
    return res;
  };

  test("a high-risk Allow with no proof answers 403 email_code and the card stays open", async () => {
    const f = fixture(); f.cards.set(`${THREAD}:req-1`, { ...HIGH_RISK });
    const res = await respond(f, "owner-browser", { requestId: "req-1", behavior: "allow" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "email_code", label: "allow_request" });
    expect(f.answers).toEqual([]);
    expect(f.cards.has(`${THREAD}:req-1`)).toBe(true);
  });

  test("with a valid proof for that exact card and decision the card is answered; a proof for another card is refused", async () => {
    const f = fixture(); f.cards.set(`${THREAD}:req-1`, { ...HIGH_RISK }); f.cards.set(`${THREAD}:req-2`, { ...OTHER_HIGH_RISK });
    const first = await respond(f, "owner-browser", { requestId: "req-1", behavior: "allow" });
    const second = await respond(f, "owner-browser", { requestId: "req-2", behavior: "allow" });
    // a proof minted for req-2 does not open req-1
    const crossed = await respond(f, "owner-browser", { requestId: "req-1", behavior: "allow" }, `ok:${actOf(second)}`);
    expect(crossed.status).toBe(403);
    expect(crossed.body).toMatchObject({ code: "fresh_auth_changed" });
    expect(f.answers).toEqual([]);
    const answered = await respond(f, "owner-browser", { requestId: "req-1", behavior: "allow" }, `ok:${actOf(first)}`);
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ ok: true, outcome: "allowed-once" });
    expect(f.answers).toHaveLength(1);
    expect(f.answers[0]).toMatchObject({ requestId: "req-1", behavior: "allow" });
  });

  test("Deny needs no code: the owner's browser can always decline", async () => {
    const f = fixture(); f.cards.set(`${THREAD}:req-1`, { ...HIGH_RISK });
    const res = await respond(f, "owner-browser", { requestId: "req-1", behavior: "deny" });
    expect(res.status).toBe(200);
    expect(f.answers).toHaveLength(1);
    expect(f.answers[0]).toMatchObject({ behavior: "deny" });
  });

  test("a publish Allow with no proof is 403 email_code (publish_allow); with the proof it is delivered as proven; a wrong proof is refused", async () => {
    const f = fixture(); f.cards.set(`${THREAD}:publish-1`, { ...PUBLISH });
    const none = await respond(f, "owner-browser", { requestId: "publish-1", behavior: "allow" });
    expect(none.status).toBe(403);
    expect(none.body).toMatchObject({ code: "email_code", label: "publish_allow" });
    expect(f.answers).toEqual([]);
    const wrong = await respond(f, "owner-browser", { requestId: "publish-1", behavior: "allow" }, "ok:some-other-act");
    expect(wrong.body).toMatchObject({ code: "fresh_auth_changed" });
    expect(f.answers).toEqual([]);
    const ok = await respond(f, "owner-browser", { requestId: "publish-1", behavior: "allow" }, `ok:${actOf(none)}`);
    expect(ok.status).toBe(200);
    expect(f.answers).toHaveLength(1);
    expect(f.answers[0]!.options).toMatchObject({ desktop: "proven" });
  });

  test("control: the desktop app needs no code and delivers as desktop", async () => {
    const f = fixture(); f.cards.set(`${THREAD}:publish-1`, { ...PUBLISH });
    const res = await respond(f, "owner-desktop", { requestId: "publish-1", behavior: "allow" });
    expect(res.status).toBe(200);
    expect(f.answers).toHaveLength(1);
    expect(f.answers[0]!.options).toMatchObject({ desktop: true });
  });

  test("Approve all from the owner's browser is refused 403 approve_on_computer, with or without a proof, and nothing is answered", async () => {
    const f = fixture(); f.cards.set(`${THREAD}:req-1`, { ...HIGH_RISK });
    for (const proof of [undefined, "ok:anything"]) {
      const res = await respond(f, "owner-browser", { requestId: "req-1", behavior: "allow" }, proof, BULK);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "approve_on_computer" });
    }
    expect(f.answers).toEqual([]);
  });

  test("a standing computer grant: Allow needs a code and then answers 403 no_computer and remembers nothing; Decline still settles the card", async () => {
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
    const bot = store.createBot({}, { seedMessages: false });
    const bus: ApprovalBus = { store, broadcast: () => {} };
    const waiting = awaitHostComputerConsent(bus, bot, bot.threadId, 5_000);
    const card = store.messagesFor(bot.threadId).find((m) => m.card?.tool === HOST_CONSENT_TOOL)!.card!;
    const f = fixture(); f.cards.set(`${THREAD}:${card.requestId}`, { ...card });
    // the card names the local computer, so the code gate runs first; no code opens the grant after it
    const none = await respond(f, "owner-browser", { requestId: card.requestId, behavior: "allow" });
    expect(none.status).toBe(403);
    expect(none.body).toMatchObject({ code: "email_code" });
    const allow = await respond(f, "owner-browser", { requestId: card.requestId, behavior: "allow" }, `ok:${actOf(none)}`);
    expect(allow.status).toBe(403);
    expect(allow.body).toMatchObject({ code: "no_computer" });
    expect(hostConsentPending(card.requestId!)).toBe(true);
    expect(f.remembered).toEqual([]);
    expect(f.answers).toEqual([]);
    const decline = await respond(f, "owner-browser", { requestId: card.requestId, behavior: "deny" });
    expect(decline.status).toBe(200);
    expect(hostConsentPending(card.requestId!)).toBe(false);
    await waiting;
  });

  test("a folder-trust answer without a code answers 403 email_code before anything writes the trust", async () => {
    const f = fixture();
    f.cards.set(`${THREAD}:ask-folder`, { requestId: "ask-folder", questions: [{ question: "Trust this folder?" }], folderTrust: { folder: "/home/murage/project", key: "folder-key" } });
    const body = { requestId: "ask-folder", behavior: "answer", answers: { 0: "yes" } };
    const none = await respond(f, "owner-browser", body);
    expect(none.status).toBe(403);
    expect(none.body).toMatchObject({ code: "email_code", label: "folder_trust" });
    expect(f.answers).toEqual([]);
    // only the gate's own read ran (it writes no trust); the answering read after it did not
    expect(f.questionCalls).toHaveLength(1);
    const ok = await respond(f, "owner-browser", body, `ok:${actOf(none)}`);
    expect(ok.status).toBe(200);
    expect(f.answers).toHaveLength(1);
    expect(f.questionCalls.length).toBeGreaterThan(1);
  });
});

describe("R3.1 Approve all preview and apply from the owner's browser", () => {
  test("the surface check refuses an owner browser 403 approve_on_computer, with or without a proof", () => {
    const f = fixture();
    for (const proof of [undefined, "ok:anything"]) {
      const surface = f.approveAllSurface(request("owner-browser", proof), URL_);
      expect(surface).toMatchObject({ ok: false, status: 403, body: { code: "approve_on_computer" } });
    }
  });
  test("preview and apply both start from that surface check, before anything is read or answered", () => {
    for (const path of ["/api/inbox/approve-all/preview", "/api/inbox/approve-all/apply"]) {
      const at = source.indexOf(`path === "${path}"`);
      expect(at, path).toBeGreaterThan(-1);
      const route = source.slice(at, at + 400);
      expect(route.indexOf("approveAllSurface(req, url)"), path).toBeGreaterThan(-1);
      expect(route.indexOf("if (!surface.ok) return json(res, surface.status, surface.body);"), path).toBeGreaterThan(route.indexOf("approveAllSurface(req, url)"));
    }
  });
});
