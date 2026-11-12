// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The handler call sites of the owner's browser on a Cloud home (DESIGN 3.2, 4). The handlers live inside server/index.ts's request closure,
// which needs a control plane to host an owner browser, so these tests use the REAL gate, the REAL host-consent module and the REAL publish rule,
// and read index.ts to pin the order the call sites run them in. The gate semantics themselves are in browser-owner-gates.test.ts.
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { browserNoComputer, onOwnerBrowser, ownerCodeGate, setBrowserOwnerAct } from "./browser-owner-gates.ts";
import type { CloudOwnerAct } from "./cloud-request-auth.ts";
import { setCloudIdentity } from "./cloud-request-identity.ts";
import type { CloudDevice } from "./cloud-sessions.ts";
import { awaitHostComputerConsent, HOST_CONSENT_TOOL, hostConsentPending, resolveHostComputerConsent } from "./host-computer-consent.ts";
import type { ApprovalBus } from "./peer-approval.ts";
import { publishAnswerAllowed } from "./publish/publish-ops.ts";
import { Store } from "./store.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const pem = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "pem", type: "spki" }).toString();
const owner = (): CloudDevice & { accessHash: string } => ({ id: "dev-1", account: "owner", scope: "browser", publicKey: pem(), assertionKey: pem(), revoked: 0, factor: "remembered-owner", accessHash: "hash-1" });
const request = (proof?: string): IncomingMessage => {
  const headers = { ...(proof ? { "x-murage-owner-proof": proof } : {}) } as IncomingMessage["headers"];
  setCloudIdentity(headers, owner());
  return { headers } as IncomingMessage;
};
const service = (): CloudOwnerAct => {
  const spent = new Set<string>();
  return { token: (input) => `tok:${input.label}:${input.act}`, doorFresh: () => false,
    verifyProof: (req, _device, act) => { const ok = req.headers["x-murage-owner-proof"] === `ok:${act}` && !spent.has(act); if (ok) spent.add(act); return ok; } };
};
beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); setBrowserOwnerAct(service()); });
afterEach(() => { vi.unstubAllEnvs(); setBrowserOwnerAct(undefined); });
const at = (needle: string, from = 0) => { const found = source.indexOf(needle, from); expect(found, needle).toBeGreaterThan(-1); return found; };
const selection = () => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("take down and assign a published site", () => {
  test("without a proof the answer is 403 email_code for take_down_site, with a token for exactly the act", async () => {
    const refused = await ownerCodeGate(request(), "act-takedown", "take_down_site");
    expect(refused).toMatchObject({ status: 403, body: { code: "email_code", label: "take_down_site", actToken: "tok:take_down_site:act-takedown" } });
  });
  test("a proof for another request is refused, the matching proof passes", async () => {
    expect(await ownerCodeGate(request("ok:other"), "act-takedown", "take_down_site")).toMatchObject({ status: 403, body: { code: "fresh_auth_changed" } });
    expect(await ownerCodeGate(request("ok:act-takedown"), "act-takedown", "take_down_site")).toBeNull();
  });
  test("the call site runs the gate before the take-down and the assign, and a non-browser caller still gets the computer refusal", () => {
    const site = at('path.match(/^\\/api\\/bots\\/([\\w-]+)\\/published-sites');
    const gate = at('"take_down_site"', site), down = at("publishOperations.ownerTakeDown(", site);
    expect(gate).toBeLessThan(down);
    expect(source.slice(gate - 260, gate + 80)).toContain("PUBLISH_NEEDS_COMPUTER");
    expect(source.slice(site, gate)).toContain("!isDesktopApp(req.headers, url.searchParams)");
  });
});

describe("publish Allow", () => {
  test("only a desktop or a browser with a verified code may allow; the phone and a browser without a proof may not; decline always can", () => {
    expect(publishAnswerAllowed("publish-1", "allow", "elsewhere")).toBe(false);
    expect(publishAnswerAllowed("publish-1", "allow", "proven")).toBe(true);
    expect(publishAnswerAllowed("publish-1", "allow", "desktop")).toBe(true);
    expect(publishAnswerAllowed("publish-1", "deny", "elsewhere")).toBe(true);
    expect(publishAnswerAllowed("req-1", "allow", "elsewhere")).toBe(true);
  });
  // BOT-RESPOND-ROUTE-UNIFY: both routes are one call into respondToCard, so each gate below exists once, inside it.
  const respondToCardSpan = (): [number, number] => {
    const start = source.indexOf("async function respondToCard(");
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    return [start, end];
  };
  test("the one call site (respondToCard, which both the bot respond route and the thread respond route call) takes proven only from a code verified for this card", () => {
    const sites = [...source.matchAll(/const provenHere = !onComputer && ownerProvenFor\(req\.headers, `card:\$\{([^}]+)\}:\$\{([^}]+)\}`\);/g)];
    expect(sites).toHaveLength(1);
    const [start, end] = respondToCardSpan();
    for (const site of sites) {
      expect(site.index!).toBeGreaterThan(start);
      expect(site.index!).toBeLessThan(end);
      const next = source.indexOf("publishAnswerAllowed(", site.index!);
      expect(next).toBeGreaterThan(site.index!);
      expect(source.slice(next, next + 260)).toContain('onComputer ? "desktop" : provenHere ? "proven" : "elsewhere"');
    }
  });
  test("the proven mark is set only by a passing card gate, never by a bare request", async () => {
    const req = request();
    expect(await ownerCodeGate(req, "card-act", "publish_allow")).toMatchObject({ status: 403 });
    expect(source).not.toContain("markOwnerProven(");
  });
});

describe("host computer consent from the owner's browser", () => {
  const bus = (store: Store): ApprovalBus => ({ store, broadcast: () => {} });
  test("Allow leaves the card waiting and persists nothing; Decline still settles it", async () => {
    const store = new Store(selection);
    const bot = store.createBot({}, { seedMessages: false });
    const waiting = awaitHostComputerConsent(bus(store), bot, bot.threadId, 5_000);
    const card = store.messagesFor(bot.threadId).find((m) => m.card?.tool === HOST_CONSENT_TOOL)!.card!;
    const remembered: string[] = [];
    // what the handler does for an owner's browser: Allow is answered before resolveHostComputerConsent can run
    expect(onOwnerBrowser(request().headers)).toBe(true);
    expect(hostConsentPending(card.requestId!)).toBe(true);
    expect(browserNoComputer()).toMatchObject({ status: 403, body: { code: "no_computer" } });
    expect(remembered).toEqual([]);
    expect(hostConsentPending(card.requestId!)).toBe(true);
    // Decline passes the guard and is remembered as declined
    expect(resolveHostComputerConsent(card.requestId!, "deny", (_id, consent) => remembered.push(consent))).toBe(true);
    expect(await waiting).toBe("declined");
    expect(remembered).toEqual(["declined"]);
    expect(hostConsentPending(card.requestId!)).toBe(false);
  });
  test("the one call site (inside respondToCard) refuses an owner browser's Allow before it can resolve the consent", () => {
    const guards = [...source.matchAll(/if \(behavior === "allow" && onOwnerBrowser\(req\.headers\) && hostConsentPending\(.+?\)\) return json\(res, browserNoComputer\(\)\.status, browserNoComputer\(\)\.body\);/g)];
    const resolves = [...source.matchAll(/if \(resolveHostComputerConsent\(requestId, behavior, \(botId, consent\) => \{ if \(consent === 'declined' \|\| outsideAuthority\(\{ kind: 'grant', sink: 'host_consent', route: 'owner_answer' \}, \{ surface: bulk \? 'bulk' : botAnswerSurface\(req, url\) \}\)\[0\] === 'write'\) rememberHostComputerConsent\(botId, consent\); \}\)\)/g)];
    expect(guards).toHaveLength(1);
    expect(resolves).toHaveLength(1);
    guards.forEach((guard, index) => expect(guard.index!).toBeLessThan(resolves[index]!.index!));
    const start = source.indexOf("async function respondToCard(");
    const end = source.indexOf("\n}\n", start);
    for (const site of [guards[0]!, resolves[0]!]) { expect(site.index!).toBeGreaterThan(start); expect(site.index!).toBeLessThan(end); }
  });
});

describe("a working-folder change from an owner's browser writes no folder trust", () => {
  test("every rememberPickedFolder caller passes isDesktopApp, which an owner browser is not", () => {
    const callers = [...source.matchAll(/rememberPickedFolder\(([^;]*)\);/g)].filter((m) => !m[1]!.includes("cwd: string"));
    expect(callers.length).toBe(6);
    for (const call of callers) expect(call[1], call[0]).toMatch(/isDesktopApp\(req\.headers, ?url\.searchParams\)$/);
  });
  test("the task create and the task PATCH are among them", () => {
    expect(source).toContain("rememberPickedFolder(startFolder, isDesktopApp(req.headers, url.searchParams))");
    expect(source).toMatch(/patch\.rewound=true;rememberPickedFolder\(checked\.cwd,isDesktopApp\(req\.headers,url\.searchParams\)\)/);
  });
});

describe("a folder-trust question answered from an owner's browser", () => {
  test("the gate runs before questionReply can write folderTrust.remember, and a skip or decline is not gated", () => {
    const fn = at("async function folderTrustBrowserGate(");
    const end = at("\n}\n", fn);
    const body = source.slice(fn, end);
    expect(body).toContain('skip || body.behavior === "deny"');
    expect(body.indexOf("questionReply(")).toBeLessThan(body.indexOf("ownerCodeGate("));
    expect(body).toContain("questionReply(threadId, requestId, body, false, true)");
    expect(body).toContain('riskReason: "folder-trust"');
    expect(body).toContain('"folder_trust"');
  });
  test("without a proof the answer is a 403 email_code and with a proof for another act it is refused", async () => {
    expect(await ownerCodeGate(request(), "folder-act", "folder_trust")).toMatchObject({ status: 403, body: { code: "email_code", label: "folder_trust" } });
    expect(await ownerCodeGate(request("ok:another-act"), "folder-act", "folder_trust")).toMatchObject({ status: 403, body: { code: "fresh_auth_changed" } });
  });
});
